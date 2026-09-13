"""纯 Decimal 核算规则。

所有重量单位均为克（g），输入最多三位小数且必须大于零。
本模块不允许出现 float：合计、差额、允许差全部由 decimal.Decimal 完成。

称重行支持两种录入方式：
- 单笔：一个十进制字符串，如 "1200.500"；
- 成组：``{"mode": "group", "unit_weight": "12.5", "count": 8}``，
  采用重量 = 单份重量 × 份数（份数为 2–999 的整数）。
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, ROUND_HALF_UP, localcontext
from typing import Any

# 四个录入分区（浏览器界面与 API 均使用同一组英文键）
KINDS: tuple[str, ...] = ("issued", "returned", "product", "scrap")
REQUIRED_KINDS: tuple[str, ...] = ("issued",)

KIND_LABELS: dict[str, str] = {
    "issued": "领料",
    "returned": "退料",
    "product": "成品",
    "scrap": "废料",
}

GRAM = Decimal("0.001")          # 合计/差额保留三位小数
WHOLE_GRAM = Decimal("1")        # 百分比结果取整到整数克
FLOOR_TOLERANCE = Decimal("5")   # 允许差下限：5 克
TOLERANCE_RATE = Decimal("0.002")  # 净投入的 0.2%

# 成组录入：份数允许范围（纸单“单桶重量×桶数”至少两桶起）
MIN_GROUP_COUNT = 2
MAX_GROUP_COUNT = 999
# 现有重量列 Numeric(14,3) 的存储上限；单笔值与成组乘积都不得越过它
MAX_WEIGHT = Decimal("99999999999.999")

GROUP_KEYS = frozenset({"mode", "unit_weight", "count"})


class WeightValidationError(ValueError):
    """单笔重量或整批输入不合法。"""


@dataclass(frozen=True)
class Reckoning:
    """一次核算的完整结果（单位均为克）。"""

    issued_total: Decimal
    returned_total: Decimal
    product_total: Decimal
    scrap_total: Decimal
    net_input: Decimal
    output_total: Decimal
    difference: Decimal
    tolerance: Decimal
    closed: bool


@dataclass(frozen=True)
class PreparedEntry:
    """一行外部输入展开后的结果（成组已乘出采用重量，同时保留依据）。"""

    weight: Decimal  # 参与核算的采用重量（单笔值或单份×份数）
    mode: str        # "single" | "group"
    unit_weight: Decimal | None = None
    count: int | None = None


def _row_label(kind: str, seq: int) -> str:
    return f"{KIND_LABELS[kind]} 第 {seq} 笔"


def parse_weight(raw: object, *, kind: str, seq: int, noun: str = "重量") -> Decimal:
    """把一笔外部输入解析为克重 Decimal。

    规则：必须是有限十进制数、大于零、小数位不超过三位。
    禁止 NaN/Infinity，禁止二进制浮点参与（str/int 才是合法外部表示）。
    """

    label = _row_label(kind, seq)
    if isinstance(raw, bool) or isinstance(raw, float):
        raise WeightValidationError(
            f"{label}：{noun}只接受十进制字符串，不接受二进制浮点"
        )
    if not isinstance(raw, str | int | Decimal):
        raise WeightValidationError(f"{label}：{noun}必须是十进制字符串")
    try:
        text = str(raw).strip()
        value = Decimal(text)
    except Exception as exc:  # InvalidOperation 等
        raise WeightValidationError(
            f"{label}：无法识别的{noun} {raw!r}"
        ) from exc

    if not value.is_finite():
        raise WeightValidationError(f"{label}：{noun}必须是有限数")
    if value <= 0:
        raise WeightValidationError(f"{label}：{noun}必须大于零")
    if value.as_tuple().exponent < -3:
        raise WeightValidationError(f"{label}：{noun}最多三位小数")
    return value


def _parse_count(raw: Any, *, kind: str, seq: int) -> int:
    label = _row_label(kind, seq)
    # bool 是 int 的子类，必须先排除；JSON 数字 3 才是 int，3.0/"3" 都不行
    if isinstance(raw, bool) or not isinstance(raw, int):
        raise WeightValidationError(
            f"{label}：份数必须是 {MIN_GROUP_COUNT}–{MAX_GROUP_COUNT} 的整数"
        )
    if not MIN_GROUP_COUNT <= raw <= MAX_GROUP_COUNT:
        raise WeightValidationError(
            f"{label}：份数必须在 {MIN_GROUP_COUNT} 与 {MAX_GROUP_COUNT} 之间"
        )
    return raw


def prepare_entry(raw: Any, *, kind: str, seq: int) -> PreparedEntry:
    """展开一行输入：单笔字符串直接解析；成组对象校验后做十进制乘法。"""

    label = _row_label(kind, seq)

    if isinstance(raw, dict):
        keys = set(raw)
        if keys != GROUP_KEYS:
            missing = sorted(GROUP_KEYS - keys)
            extra = sorted(keys - GROUP_KEYS)
            detail = []
            if missing:
                detail.append(f"缺少字段 {missing}")
            if extra:
                detail.append(f"多余字段 {extra}")
            raise WeightValidationError(
                f"{label}：成组录入字段矛盾（{'，'.join(detail)}；"
                "需要且只能提供 mode/unit_weight/count）"
            )
        if raw["mode"] != "group":
            raise WeightValidationError(
                f"{label}：录入方式必须为 \"group\"（单笔请直接提交重量字符串）"
            )

        unit_raw = raw["unit_weight"]
        # 成组依据必须原样保留为十进制文本（纸单克重），不接受 int/浮点等表示
        if isinstance(unit_raw, bool) or not isinstance(unit_raw, str):
            raise WeightValidationError(f"{label}：单份重量必须是十进制字符串")
        unit = parse_weight(unit_raw, kind=kind, seq=seq, noun="单份重量")
        if unit > MAX_WEIGHT:
            raise WeightValidationError(
                f"{label}：单份重量超出存储范围（≤ {MAX_WEIGHT} g）"
            )
        count = _parse_count(raw["count"], kind=kind, seq=seq)

        # 整数份数 × 三位小数单份，结果仍是精确的三位小数十进制数
        with localcontext() as ctx:
            ctx.prec = 28
            product = (unit * Decimal(count)).quantize(GRAM)
        if product > MAX_WEIGHT:
            raise WeightValidationError(
                f"{label}：采用重量 {product:.3f} g 超出存储范围"
                f"（{unit:.3f} g × {count}，上限 {MAX_WEIGHT} g）"
            )
        return PreparedEntry(weight=product, mode="group", unit_weight=unit, count=count)

    weight = parse_weight(raw, kind=kind, seq=seq)
    if weight > MAX_WEIGHT:
        raise WeightValidationError(
            f"{label}：重量超出存储范围（≤ {MAX_WEIGHT} g）"
        )
    return PreparedEntry(weight=weight, mode="single")


def prepare_entries(raw_entries: object) -> dict[str, list[PreparedEntry]]:
    """把整批外部行展开成 PreparedEntry；任何一行非法都抛 WeightValidationError。"""

    if not isinstance(raw_entries, dict):
        raise WeightValidationError("entries 必须是以分区为键的称重行对象")

    unknown = set(raw_entries) - set(KINDS)
    if unknown:
        raise WeightValidationError(f"未知分区：{sorted(unknown)}")

    prepared: dict[str, list[PreparedEntry]] = {kind: [] for kind in KINDS}
    for kind in KINDS:
        rows = raw_entries.get(kind) or []
        if not isinstance(rows, list):
            raise WeightValidationError(f"{KIND_LABELS[kind]}：必须是称重行数组")
        prepared[kind] = [
            prepare_entry(row, kind=kind, seq=i + 1) for i, row in enumerate(rows)
        ]
    return prepared


def _sum(weights: list[Decimal]) -> Decimal:
    total = Decimal("0")
    for w in weights:
        total += w
    return total.quantize(GRAM, rounding=ROUND_HALF_UP)


def _compute(weights: dict[str, list[Decimal]]) -> Reckoning:
    """对已解析为 Decimal 的采用重量执行核算。"""

    for kind in REQUIRED_KINDS:
        if not weights.get(kind):
            raise WeightValidationError(f"{KIND_LABELS[kind]}：至少需要一笔称重")

    for kind in KINDS:
        for w in weights.get(kind) or []:
            if w > MAX_WEIGHT:
                raise WeightValidationError(
                    f"{KIND_LABELS[kind]}：重量超出存储范围（≤ {MAX_WEIGHT} g）"
                )

    issued_total = _sum(weights["issued"])
    returned_total = _sum(weights["returned"])
    product_total = _sum(weights["product"])
    scrap_total = _sum(weights["scrap"])

    # 合计同样落在 Numeric(14,3) 列内，提前以语义错误拒绝而不是让数据库报错
    for label, total in (
        ("领料合计", issued_total),
        ("退料合计", returned_total),
        ("成品合计", product_total),
        ("废料合计", scrap_total),
    ):
        if total > MAX_WEIGHT:
            raise WeightValidationError(
                f"{label} {total:.3f} g 超出存储范围（≤ {MAX_WEIGHT} g）"
            )

    if returned_total > issued_total:
        raise WeightValidationError("同批退料总量不得大于领料总量")

    with localcontext() as ctx:
        ctx.prec = 28
        net_input = (issued_total - returned_total).quantize(GRAM)
        output_total = (product_total + scrap_total).quantize(GRAM)

        # 产出合计同样要落进 Numeric(14,3) 列：成品、废料各自合法不代表合计合法，
        # 在整批校验时明确拒绝，而不是留到保存阶段由数据库报数值溢出
        if output_total > MAX_WEIGHT:
            raise WeightValidationError(
                f"产出合计 {output_total:.3f} g 超出存储范围（≤ {MAX_WEIGHT} g）"
            )

        difference = (output_total - net_input).quantize(GRAM)
        percent = net_input * TOLERANCE_RATE
        percent_whole = percent.quantize(WHOLE_GRAM, rounding=ROUND_HALF_UP)
        tolerance = max(FLOOR_TOLERANCE, percent_whole)

    closed = abs(difference) <= tolerance
    return Reckoning(
        issued_total=issued_total,
        returned_total=returned_total,
        product_total=product_total,
        scrap_total=scrap_total,
        net_input=net_input,
        output_total=output_total,
        difference=difference,
        tolerance=tolerance,
        closed=closed,
    )


def reckon(weights: dict[str, list[Decimal | str]]) -> Reckoning:
    """按业务规则核算一个合法批次（输入为单笔十进制字符串/Decimal）。

    净投入 = 领料合计 - 退料合计
    产出   = 成品合计 + 废料合计
    差额   = 产出 - 净投入（带符号）
    允许差 = max(5 克, ROUND_HALF_UP(净投入 * 0.2%) 整数克)
    |差额| <= 允许差 即闭合。
    """

    parsed: dict[str, list[Decimal]] = {}
    for kind in KINDS:
        rows = weights.get(kind) or []
        parsed[kind] = [parse_weight(w, kind=kind, seq=i + 1) for i, w in enumerate(rows)]
    return _compute(parsed)


def reckon_prepared(prepared: dict[str, list[PreparedEntry]]) -> Reckoning:
    """对已展开（含成组乘积）的行执行核算。"""

    return _compute(
        {kind: [entry.weight for entry in prepared.get(kind) or []] for kind in KINDS}
    )
