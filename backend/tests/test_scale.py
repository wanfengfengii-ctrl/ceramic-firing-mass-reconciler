"""纯 Decimal 的日常秤检判定单测（不依赖数据库）。"""

from __future__ import annotations

from decimal import Decimal

import pytest

from app.scale import (
    SCALE_POINT_COUNT,
    SCALE_TOLERANCE,
    ScaleValidationError,
    evaluate_scale_check,
)


def pts(*pairs: tuple[str, str]) -> list[dict]:
    return [{"standard": s, "measured": m} for s, m in pairs]


def fill(p1: tuple[str, str]) -> list[dict]:
    # 用同一测点补满三组
    return pts(*([p1] * SCALE_POINT_COUNT))


def test_deviation_is_measured_minus_standard_signed_three_places() -> None:
    r = evaluate_scale_check(
        pts(("1000.000", "1000.300"), ("500.000", "499.700"), ("200.000", "200.000"))
    )
    assert [p.deviation for p in r.points] == [
        Decimal("0.300"),
        Decimal("-0.300"),
        Decimal("0.000"),
    ]
    assert r.passed is True


def test_critical_deviation_boundary() -> None:
    assert SCALE_TOLERANCE == Decimal("0.500")
    # 恰好 +0.500 / -0.500 合格
    assert evaluate_scale_check(fill(("100.000", "100.500"))).passed is True
    assert evaluate_scale_check(fill(("100.000", "99.500"))).passed is True
    # 超过 0.001 g 即不合格（单点超差）
    r = evaluate_scale_check(
        pts(("100.000", "100.500"), ("100.000", "99.500"), ("100.000", "100.501"))
    )
    assert r.passed is False
    assert r.points[2].deviation == Decimal("0.501")
    assert evaluate_scale_check(fill(("100.000", "99.499"))).passed is False


def test_decimal_fixed_point_no_binary_artifact() -> None:
    # 0.4 - 0.1 在二进制浮点里是 0.30000000000000004；Decimal 必须精确为 0.300
    r = evaluate_scale_check(fill(("0.100", "0.400")))
    assert r.points[0].deviation == Decimal("0.300")


def test_must_have_exactly_three_points() -> None:
    with pytest.raises(ScaleValidationError):
        evaluate_scale_check(pts(("1", "1"), ("1", "1")))
    with pytest.raises(ScaleValidationError):
        evaluate_scale_check(pts(*[("1", "1")] * 4))
    with pytest.raises(ScaleValidationError):
        evaluate_scale_check("not-a-list")  # type: ignore[arg-type]


@pytest.mark.parametrize(
    "standard,measured,field",
    [
        ("0", "100", "标准重量"),
        ("-1", "100", "标准重量"),
        ("1", "0", "实测重量"),
        ("1.0001", "1", "标准重量"),
        ("1", "1.0001", "实测重量"),
        ("abc", "1", "标准重量"),
        ("1", "NaN", "实测重量"),
    ],
)
def test_invalid_weights_raise_with_point_and_field(
    standard: str, measured: str, field: str
) -> None:
    with pytest.raises(ScaleValidationError) as exc:
        evaluate_scale_check(fill((standard, measured)))
    message = str(exc.value)
    assert "第 1 测点" in message
    assert field in message


def test_float_and_bool_rejected() -> None:
    # 二进制浮点不允许参与裁决
    with pytest.raises(ScaleValidationError):
        evaluate_scale_check([{"standard": 1.0, "measured": "1"}] * 3)
    # bool 不被当成重量
    with pytest.raises(ScaleValidationError):
        evaluate_scale_check([{"standard": True, "measured": "1"}] * 3)


def test_point_must_be_object() -> None:
    with pytest.raises(ScaleValidationError):
        evaluate_scale_check(["1", "1", "1"])  # type: ignore[list-item]


def test_missing_field_rejected() -> None:
    with pytest.raises(ScaleValidationError):
        evaluate_scale_check(
            [{"standard": "1"}, {"standard": "1"}, {"standard": "1"}]
        )

