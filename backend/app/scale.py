"""日常秤检：开工前用标准砝码做三组测点的十进制判定。

本模块与批次核算完全独立：秤检结果不进入任何批次合计，也不阻断批次流程。
所有重量单位均为克（g），标准重量与实测重量都是最多三位小数、大于零的
有限十进制文本；偏差 = 实测 − 标准（三位小数、带符号），
任一测点偏差绝对值不超过 0.500 g 即判定合格。全程只允许 Decimal，禁止 float。
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, localcontext
from typing import Any

from .calc import MAX_WEIGHT

GRAM = Decimal("0.001")              # 标准/实测/偏差均保留三位小数
SCALE_TOLERANCE = Decimal("0.500")   # 单测点允许偏差绝对值上限（克）
SCALE_POINT_COUNT = 3                # 每次秤检固定三组标准砝码测点


class ScaleValidationError(ValueError):
    """秤检输入不合法（设备编号、日期或某个测点字段）。"""


@dataclass(frozen=True)
class ScalePointResult:
    """一个测点的十进制复算结果（单位均为克）。"""

    seq: int
    standard: Decimal
    measured: Decimal
    deviation: Decimal  # 实测 − 标准，带符号，三位小数


@dataclass(frozen=True)
class ScaleCheckResult:
    """一次秤检的三个测点与当次结论。"""

    points: list[ScalePointResult]
    passed: bool


def _short_repr(value: object, limit: int = 80) -> str:
    text = repr(value)
    return text if len(text) <= limit else text[:limit] + "…"


def _parse_weight(raw: Any, *, label: str, noun: str) -> Decimal:
    """解析一个测点的克重文本：有限十进制、大于零、小数位不超过三位。"""

    if isinstance(raw, bool) or isinstance(raw, float):
        raise ScaleValidationError(
            f"{label}：{noun}只接受十进制字符串，不接受二进制浮点"
        )
    if not isinstance(raw, str):
        raise ScaleValidationError(f"{label}：{noun}必须是十进制字符串")
    try:
        value = Decimal(raw.strip())
    except Exception as exc:  # InvalidOperation 等
        raise ScaleValidationError(
            f"{label}：无法识别的{noun} {_short_repr(raw)}"
        ) from exc

    if not value.is_finite():
        raise ScaleValidationError(f"{label}：{noun}必须是有限数")
    if value <= 0:
        raise ScaleValidationError(f"{label}：{noun}必须大于零")
    if value.as_tuple().exponent < -3:
        raise ScaleValidationError(f"{label}：{noun}最多三位小数")
    if value > MAX_WEIGHT:
        raise ScaleValidationError(
            f"{label}：{noun}超出存储范围（≤ {MAX_WEIGHT} g）"
        )
    return value


def evaluate_scale_check(raw_points: Any) -> ScaleCheckResult:
    """复算三组测点并给出当次结论。

    每个测点为 {"standard": str, "measured": str}；任何一个字段非法都抛
    ScaleValidationError，并在消息中指出是第几测点的标准重量还是实测重量。
    """

    if not isinstance(raw_points, list):
        raise ScaleValidationError(
            f"每次秤检必须提供 {SCALE_POINT_COUNT} 组标准砝码测点"
        )
    if len(raw_points) != SCALE_POINT_COUNT:
        raise ScaleValidationError(
            f"每次秤检必须提供 {SCALE_POINT_COUNT} 组标准砝码测点"
            f"（当前 {len(raw_points) if isinstance(raw_points, list) else 0} 组）"
        )

    points: list[ScalePointResult] = []
    for i, raw in enumerate(raw_points):
        label = f"第 {i + 1} 测点"
        if not isinstance(raw, dict):
            raise ScaleValidationError(f"{label}：测点必须是标准/实测重量对象")
        standard = _parse_weight(raw.get("standard"), label=label, noun="标准重量")
        measured = _parse_weight(raw.get("measured"), label=label, noun="实测重量")
        # 输入最多三位小数，差值仍精确到三位小数；显式 quantize 固化定点规则
        with localcontext() as ctx:
            ctx.prec = 28
            deviation = (measured - standard).quantize(GRAM)
        points.append(
            ScalePointResult(
                seq=i + 1, standard=standard, measured=measured, deviation=deviation
            )
        )

    passed = all(abs(p.deviation) <= SCALE_TOLERANCE for p in points)
    return ScaleCheckResult(points=points, passed=passed)
