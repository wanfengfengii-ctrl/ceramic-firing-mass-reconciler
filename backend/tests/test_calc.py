"""纯计算规则测试：全部 Decimal，不触网不触库。"""

from __future__ import annotations

from decimal import Decimal

import pytest

from app.calc import (
    MAX_WEIGHT,
    WeightValidationError,
    prepare_entries,
    prepare_entry,
    reckon,
    reckon_prepared,
)


def group(unit: str, count: int) -> dict:
    return {"mode": "group", "unit_weight": unit, "count": count}


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


# ---------------------------------------------------------------------------
# 成组录入：单份重量 × 份数（份数为 2–999 的整数）
# ---------------------------------------------------------------------------


def test_group_entry_expands_to_decimal_product() -> None:
    e = prepare_entry(group("12.500", 8), kind="issued", seq=1)
    assert e.mode == "group"
    assert e.unit_weight == Decimal("12.500")
    assert e.count == 8
    assert e.weight == Decimal("100.000")


def test_group_and_single_rows_mix_in_one_batch() -> None:
    prepared = prepare_entries(
        {
            "issued": ["1000.000", group("12.500", 8)],
            "returned": [group("10.000", 5)],
            "product": ["1040.000"],
            "scrap": ["60.000"],
        }
    )
    r = reckon_prepared(prepared)
    # 领料 1000 + 12.5*8(=100) = 1100；退料 10*5 = 50；净投入 1050
    assert r.issued_total == Decimal("1100.000")
    assert r.returned_total == Decimal("50.000")
    assert r.net_input == Decimal("1050.000")
    # 产出 1040 + 60 = 1100；差额 +50；允许差 ROUND_HALF_UP(2.1)=2 -> 5 -> 不闭合
    assert r.output_total == Decimal("1100.000")
    assert r.difference == Decimal("50.000")
    assert r.tolerance == Decimal("5")
    assert r.closed is False


def test_group_product_is_decimal_not_float() -> None:
    # 0.001 g × 3 = 0.003 g：二进制浮点会算出 0.003000000000000000...
    e = prepare_entry(group("0.001", 3), kind="scrap", seq=1)
    assert e.weight == Decimal("0.003")


def test_group_product_precision_boundary_matches_storage() -> None:
    # 乘积刚好达到 Numeric(14,3) 精度边界 99999999999.999 g：合法
    e = prepare_entry(group("33333333333.333", 3), kind="issued", seq=1)
    assert e.weight == Decimal("99999999999.999")
    # 同值成品对抵，合计精确落在边界列上，差额为 0 即闭合
    prepared = prepare_entries({"issued": [e.weight], "product": [MAX_WEIGHT]})
    r = reckon_prepared(prepared)
    assert r.issued_total == MAX_WEIGHT
    assert r.product_total == MAX_WEIGHT
    assert r.difference == Decimal("0.000")
    assert r.closed is True


def test_group_product_one_milligram_over_limit_rejected() -> None:
    # 单份本身合法，但乘积越过存储上限 1 毫克
    with pytest.raises(WeightValidationError, match="存储范围"):
        prepare_entry(group("50000000000.000", 2), kind="issued", seq=1)


@pytest.mark.parametrize("bad_count", [1, 0, -2, 1000])
def test_group_count_out_of_range_rejected(bad_count: int) -> None:
    with pytest.raises(WeightValidationError, match="份数"):
        prepare_entry(group("12.500", bad_count), kind="issued", seq=1)


@pytest.mark.parametrize("bad_count", [2.0, "2", True, None])
def test_group_count_must_be_plain_integer(bad_count: object) -> None:
    with pytest.raises(WeightValidationError, match="份数"):
        prepare_entry(group("12.500", bad_count), kind="issued", seq=1)  # type: ignore[arg-type]


@pytest.mark.parametrize(
    "bad_unit",
    ["0", "-1", "1.0001", "abc", "NaN", "Infinity", "", 1.1, 12, None],
)
def test_group_unit_weight_must_be_valid_decimal_string(bad_unit: object) -> None:
    with pytest.raises(WeightValidationError):
        prepare_entry(group(bad_unit, 2), kind="issued", seq=1)  # type: ignore[arg-type]


def test_group_error_points_to_partition_and_row() -> None:
    with pytest.raises(WeightValidationError) as info:
        prepare_entries({"issued": ["100", "200"], "returned": [group("10", 1)]})
    assert "退料 第 1 笔" in str(info.value)
    assert "份数" in str(info.value)

    with pytest.raises(WeightValidationError) as info2:
        prepare_entries({"product": [group("0", 2)]})
    assert "成品 第 1 笔" in str(info2.value)


def test_group_object_field_conflicts_rejected() -> None:
    # 缺字段
    with pytest.raises(WeightValidationError, match="字段矛盾"):
        prepare_entry({"mode": "group", "count": 2}, kind="issued", seq=1)  # type: ignore[arg-type]
    # 多字段
    with pytest.raises(WeightValidationError, match="字段矛盾"):
        prepare_entry(
            {"mode": "group", "unit_weight": "1", "count": 2, "weight": "2"},
            kind="issued",
            seq=1,
        )
    # mode 不是 group
    with pytest.raises(WeightValidationError, match="录入方式"):
        prepare_entry(
            {"mode": "single", "unit_weight": "1", "count": 2},
            kind="issued",
            seq=1,
        )


def test_single_weight_over_storage_range_rejected() -> None:
    with pytest.raises(WeightValidationError, match="存储范围"):
        prepare_entry("100000000000.000", kind="issued", seq=1)


def test_unknown_partition_rejected_at_prepare() -> None:
    with pytest.raises(WeightValidationError, match="未知分区"):
        prepare_entries({"issued": ["1"], "bogus": ["2"]})


def test_group_rows_do_not_expand_into_individual_entries() -> None:
    # 一个成组对象只占一行（一份纸单依据），份数不改变行序与行数
    prepared = prepare_entries({"issued": [group("10.000", 999), "5.000"]})
    assert len(prepared["issued"]) == 2
    assert prepared["issued"][0].weight == Decimal("9990.000")
    assert prepared["issued"][1].weight == Decimal("5.000")

