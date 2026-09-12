"""纯计算规则测试：全部 Decimal，不触网不触库。"""

from __future__ import annotations

from decimal import Decimal

import pytest

from app.calc import WeightValidationError, reckon


def batch(**kw: list[str]) -> dict[str, list[str]]:
    base: dict[str, list[str]] = {
        "issued": [],
        "returned": [],
        "product": [],
        "scrap": [],
    }
    base.update(kw)
    return base


def test_basic_closed_identity() -> None:
    r = reckon(batch(issued=["1000"], product=["1000"]))
    assert r.issued_total == Decimal("1000.000")
    assert r.net_input == Decimal("1000.000")
    assert r.output_total == Decimal("1000.000")
    assert r.difference == Decimal("0.000")
    assert r.tolerance == Decimal("5")
    assert r.closed is True


def test_tolerance_is_max_of_five_and_rounded_percent() -> None:
    # 净投入 2000g：0.2% = 4g -> 取下限 5g
    assert reckon(batch(issued=["2000"], product=["2005"])).tolerance == Decimal("5")
    # 净投入 3000g：0.2% = 6g
    assert reckon(batch(issued=["3000"], product=["3000"])).tolerance == Decimal("6")


def test_percent_round_half_up_to_integer_gram() -> None:
    # 净投入 2750g：0.2% = 5.5g，ROUND_HALF_UP -> 6g（若用银行家舍入会得 6 之外的偶数边界）
    r = reckon(batch(issued=["2750"], product=["2750"]))
    assert r.tolerance == Decimal("6")
    # 净投入 2250g：0.2% = 4.5g，ROUND_HALF_UP -> 5g
    r2 = reckon(batch(issued=["2250"], product=["2250"]))
    assert r2.tolerance == Decimal("5")


def test_difference_is_signed_output_minus_net() -> None:
    r_over = reckon(batch(issued=["1000"], product=["1004.5"]))
    assert r_over.difference == Decimal("4.500")
    assert r_over.closed is True  # |4.5| <= 5

    r_under = reckon(batch(issued=["1000"], product=["995.500"]))
    assert r_under.difference == Decimal("-4.500")
    assert r_under.closed is True

    r_break = reckon(batch(issued=["1000"], product=["1005.001"]))
    assert r_break.difference == Decimal("5.001")
    assert r_break.closed is False


def test_three_decimal_totals_with_returns_scrap() -> None:
    r = reckon(
        batch(
            issued=["1000.001", "500.002"],
            returned=["100.001"],
            product=["1400.004"],
            scrap=["8.001"],
        )
    )
    assert r.issued_total == Decimal("1500.003")
    assert r.returned_total == Decimal("100.001")
    assert r.net_input == Decimal("1400.002")
    assert r.product_total == Decimal("1400.004")
    assert r.scrap_total == Decimal("8.001")
    assert r.output_total == Decimal("1408.005")
    assert r.difference == Decimal("8.003")
    # 允许差 = ROUND_HALF_UP(2.800004) = 3 -> max(5,3) = 5
    assert r.tolerance == Decimal("5")
    assert r.closed is False


@pytest.mark.parametrize(
    "payload",
    [
        batch(issued=["0"]),                     # 零
        batch(issued=["-1"]),                    # 负数
        batch(issued=["1.0001"]),                # 超过三位小数
        batch(issued=["abc"]),                   # 非数字
        batch(issued=["NaN"]),                   # NaN
        batch(issued=["Infinity"]),              # 无穷
        {},                                      # 没有领料
        batch(issued=["100"], returned=["101"]),  # 退料大于领料
        batch(issued=["100"], returned=["100.001"]),
    ],
)
def test_invalid_batches_rejected(payload: dict) -> None:
    with pytest.raises(WeightValidationError):
        reckon(payload)


def test_float_input_is_rejected_not_coerced() -> None:
    # 禁止二进制浮点参与裁决
    with pytest.raises(WeightValidationError):
        reckon(batch(issued=[1.1]))  # type: ignore[list-item]
