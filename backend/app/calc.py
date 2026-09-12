"""纯 Decimal 核算规则。

所有重量单位均为克（g），输入最多三位小数且必须大于零。
本模块不允许出现 float：合计、差额、允许差全部由 decimal.Decimal 完成。
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, ROUND_HALF_UP, localcontext

# 四个录入分区（浏览器界面与 API 均使用同一组英文键）
KINDS: tuple[str, ...] = ("issued", "returned", "product", "scrap")
REQUIRED_KINDS: tuple[str, ...] = ("issued",)

GRAM = Decimal("0.001")          # 合计/差额保留三位小数
WHOLE_GRAM = Decimal("1")        # 百分比结果取整到整数克
FLOOR_TOLERANCE = Decimal("5")   # 允许差下限：5 克
TOLERANCE_RATE = Decimal("0.002")  # 净投入的 0.2%


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


def parse_weight(raw: object, *, kind: str, seq: int) -> Decimal:
    """把一笔外部输入解析为克重 Decimal。

    规则：必须是有限十进制数、大于零、小数位不超过三位。
    禁止 NaN/Infinity，禁止二进制浮点参与（str/int 才是合法外部表示）。
    """

    if isinstance(raw, bool) or isinstance(raw, float):
        raise WeightValidationError(
            f"{kind} 第 {seq} 笔：只接受十进制字符串，不接受二进制浮点"
        )
    try:
        text = str(raw).strip()
        value = Decimal(text)
    except Exception as exc:  # InvalidOperation 等
        raise WeightValidationError(f"{kind} 第 {seq} 笔：无法识别的重量 {raw!r}") from exc

    if not value.is_finite():
        raise WeightValidationError(f"{kind} 第 {seq} 笔：重量必须是有限数")
    if value <= 0:
        raise WeightValidationError(f"{kind} 第 {seq} 笔：重量必须大于零")
    if value.as_tuple().exponent < -3:
        raise WeightValidationError(f"{kind} 第 {seq} 笔：最多三位小数")
    return value


def _sum(weights: list[Decimal]) -> Decimal:
    total = Decimal("0")
    for w in weights:
        total += w
    return total.quantize(GRAM, rounding=ROUND_HALF_UP)


def reckon(weights: dict[str, list[Decimal]]) -> Reckoning:
    """按业务规则核算一个合法批次。

    净投入 = 领料合计 - 退料合计
    产出   = 成品合计 + 废料合计
    差额   = 产出 - 净投入（带符号）
    允许差 = max(5 克, ROUND_HALF_UP(净投入 * 0.2%) 整数克)
    |差额| <= 允许差 即闭合。
    """

    for kind in REQUIRED_KINDS:
        if not weights.get(kind):
            raise WeightValidationError(f"{kind}：至少需要一笔称重")

    parsed: dict[str, list[Decimal]] = {}
    for kind in KINDS:
        rows = weights.get(kind) or []
        parsed[kind] = [parse_weight(w, kind=kind, seq=i + 1) for i, w in enumerate(rows)]

    issued_total = _sum(parsed["issued"])
    returned_total = _sum(parsed["returned"])
    product_total = _sum(parsed["product"])
    scrap_total = _sum(parsed["scrap"])

    if returned_total > issued_total:
        raise WeightValidationError("同批退料总量不得大于领料总量")

    with localcontext() as ctx:
        ctx.prec = 28
        net_input = (issued_total - returned_total).quantize(GRAM)
        output_total = (product_total + scrap_total).quantize(GRAM)
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
