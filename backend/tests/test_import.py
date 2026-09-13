"""称重文件导入预检的纯解析测试：不触网不触库，只验证 CSV → 规范化行 + 预览。"""

from __future__ import annotations

import pytest

from app.importer import ImportRejectedError, preview_import

HEADER = "分区,重量,单份重量,份数"


def csv_text(*rows: str, header: str = HEADER) -> str:
    return "\n".join([header, *rows]) + "\n"


def test_mixed_single_and_group_rows_normalized_in_file_order() -> None:
    out = preview_import(
        csv_text(
            "领料,1000.000,,",
            "领料,,12.500,8",
            "退料,,10.000,5",
            "成品,1040.000,,",
            "废料,60.000,,",
        )
    )
    assert out.row_count == 5

    issued = out.entries["issued"]
    assert issued[0].model_dump() == {
        "seq": 1,
        "weight": "1000.000",
        "mode": "single",
        "unit_weight": None,
        "count": None,
    }
    # 成组行：十进制乘积 + 可还原算式的依据
    assert issued[1].model_dump() == {
        "seq": 2,
        "weight": "100.000",
        "mode": "group",
        "unit_weight": "12.500",
        "count": 8,
    }
    assert out.entries["returned"][0].model_dump() == {
        "seq": 1,
        "weight": "50.000",
        "mode": "group",
        "unit_weight": "10.000",
        "count": 5,
    }

    # 预览与批次核算同一规则：净投入 1050，产出 1100，差额 +50，允许差 5
    p = out.preview
    assert p.issued_total == "1100.000"
    assert p.returned_total == "50.000"
    assert p.net_input == "1050.000"
    assert p.output_total == "1100.000"
    assert p.difference == "+50.000"
    assert p.tolerance == "5"
    assert p.closed is False
    assert p.verdict == "不闭合"


def test_shuffled_partitions_keep_per_kind_file_order() -> None:
    # 四个分区在文件中交错出现：每个分区内部的行序仍按文件行序
    out = preview_import(
        csv_text(
            "成品,100.000,,",
            "领料,500.000,,",
            "废料,10.000,,",
            "领料,600.000,,",
            "成品,200.000,,",
            "退料,50.000,,",
        )
    )
    assert [e.weight for e in out.entries["issued"]] == ["500.000", "600.000"]
    assert [e.weight for e in out.entries["product"]] == ["100.000", "200.000"]
    assert [e.weight for e in out.entries["scrap"]] == ["10.000"]
    assert [e.weight for e in out.entries["returned"]] == ["50.000"]
    assert [e.seq for e in out.entries["issued"]] == [1, 2]
    assert [e.seq for e in out.entries["product"]] == [1, 2]


def test_english_partition_keys_and_column_permutation_accepted() -> None:
    # 列序不限；分区列也接受 API 英文键；额外列忽略
    out = preview_import(
        csv_text(
            "1000.000,x,issued,,",
            "1005.000,,product,,",
            header="重量,备注,分区,份数,单份重量",
        )
    )
    assert [e.weight for e in out.entries["issued"]] == ["1000.000"]
    assert out.preview.difference == "+5.000"
    assert out.preview.verdict == "闭合"


def test_blank_lines_ignored_and_bom_stripped() -> None:
    out = preview_import("﻿" + csv_text("", "领料,1000.000,,", "  ", ",,,", "成品,1000.000,,"))
    assert out.row_count == 2
    assert out.preview.difference == "+0.000"


def test_crlf_and_quoted_cells_accepted() -> None:
    text = '分区,重量,单份重量,份数\r\n领料,"1000.000",,\r\n成品,1000.000,,\r\n'
    out = preview_import(text)
    assert [e.weight for e in out.entries["issued"]] == ["1000.000"]


def test_error_line_numbers_count_physical_lines() -> None:
    # 表头第 1 行、空行第 3 行：非法重量在第 4 行（原始文件物理行）
    with pytest.raises(ImportRejectedError) as info:
        preview_import(csv_text("领料,1000.000,,", "", "成品,1.0001,,"))
    assert info.value.line == 4
    assert "成品 第 1 笔" in info.value.reason
    assert "最多三位小数" in info.value.reason
    assert str(info.value).startswith("第 4 行：")


@pytest.mark.parametrize(
    ("row", "match"),
    [
        ("原料,100.000,,", "未知分区"),                      # 未知分区
        ("领料,100.000,12.500,", "字段矛盾"),               # 重量与单份混填
        ("领料,100.000,,8", "字段矛盾"),                    # 重量与份数混填
        ("领料,,12.500,", "字段矛盾"),                      # 成组缺份数
        ("领料,,,8", "字段矛盾"),                           # 成组缺单份
        ("领料,,,", "字段矛盾"),                            # 三种重量全空
        ("领料,,12.500,1", "份数"),                         # 份数越界（复用成组校验）
        ("领料,,12.500,8.0", "份数"),                       # 份数非整数
        ("领料,,0,2", "单份重量必须大于零"),                # 单份非法
        ("领料,0,,", "必须大于零"),                         # 单笔非法
        ("领料,NaN,,", "有限数"),                           # 非十进制
        ("领料,100000000000.000,,", "存储范围"),            # 单笔超存储范围
        ("领料,,50000000000.000,2", "存储范围"),            # 乘积超存储范围
    ],
)
def test_row_level_errors_rejected_with_line_2(row: str, match: str) -> None:
    with pytest.raises(ImportRejectedError) as info:
        preview_import(csv_text(row))
    assert info.value.line == 2
    assert match in info.value.reason


def test_error_points_to_later_line_and_partition_seq() -> None:
    # 第二笔领料的份数越界：行号指向原始文件第 3 行，原因含“领料 第 2 笔”
    with pytest.raises(ImportRejectedError) as info:
        preview_import(csv_text("领料,1000.000,,", "领料,,12.500,1000"))
    assert info.value.line == 3
    assert "领料 第 2 笔" in info.value.reason
    assert "份数" in info.value.reason


def test_duplicate_header_rejected() -> None:
    with pytest.raises(ImportRejectedError) as info:
        preview_import(csv_text("领料,1000.000,,", header="分区,重量,重量,份数,单份重量"))
    assert info.value.line == 1
    assert "重复表头" in info.value.reason
    assert "重量" in info.value.reason


def test_missing_header_column_rejected() -> None:
    with pytest.raises(ImportRejectedError) as info:
        preview_import(csv_text("领料,1000.000,", header="分区,重量,单份重量"))
    assert info.value.line == 1
    assert "缺少表头列" in info.value.reason
    assert "份数" in info.value.reason


def test_empty_file_rejected() -> None:
    with pytest.raises(ImportRejectedError, match="缺少表头"):
        preview_import("\n  \n")
    with pytest.raises(ImportRejectedError, match="缺少表头"):
        preview_import("")


def test_header_only_file_fails_whole_batch_reckoning() -> None:
    # 没有任何数据行：整批核算要求至少一笔领料（文件级错误，无单行号）
    with pytest.raises(ImportRejectedError) as info:
        preview_import(csv_text())
    assert info.value.line is None
    assert "领料" in info.value.reason


def test_returned_over_issued_rejected_at_file_level() -> None:
    with pytest.raises(ImportRejectedError) as info:
        preview_import(csv_text("领料,100.000,,", "退料,100.001,,"))
    assert info.value.line is None
    assert "退料" in info.value.reason


def test_output_total_overflow_rejected() -> None:
    with pytest.raises(ImportRejectedError) as info:
        preview_import(
            csv_text(
                "领料,99999999999.999,,",
                "成品,60000000000.000,,",
                "废料,60000000000.000,,",
            )
        )
    assert info.value.line is None
    assert "产出合计" in info.value.reason


def test_group_product_is_decimal_not_float() -> None:
    # 0.001 × 3 = 0.003：预览合计不得出现二进制浮点尾巴
    out = preview_import(csv_text("领料,1000.000,,", "废料,,0.001,3", "成品,999.997,,"))
    assert out.entries["scrap"][0].weight == "0.003"
    assert out.preview.scrap_total == "0.003"
    assert out.preview.difference == "+0.000"


def test_overlong_weight_cell_rejected_with_line_not_crash() -> None:
    # 回归：约 1 MB 的超长重量曾触发 csv 模块 128 KiB 字段上限，
    # _csv.Error 未被捕获导致 500；现在应指出第 2 行重量非法
    with pytest.raises(ImportRejectedError) as info:
        preview_import(csv_text("领料," + "9" * 999_900 + ",,", "成品,1,,"))
    assert info.value.line == 2
    assert "领料 第 1 笔" in info.value.reason
    assert "存储范围" in info.value.reason


def test_overlong_fraction_weight_rejected_with_line() -> None:
    # 超长小数部分：超过三位小数，同样按行拒绝
    with pytest.raises(ImportRejectedError) as info:
        preview_import(csv_text("领料,0." + "9" * 200_000 + ",,"))
    assert info.value.line == 2
    assert "最多三位小数" in info.value.reason


def test_overlong_count_rejected_with_line_not_crash() -> None:
    # 回归：超长份数曾让 int() 触发 Python 整数位数限制（ValueError 变 500）
    with pytest.raises(ImportRejectedError) as info:
        preview_import(csv_text("领料,,12.500," + "9" * 5000))
    assert info.value.line == 2
    assert "份数" in info.value.reason


def test_unparseable_overlong_input_echo_is_truncated() -> None:
    # 超长非法输入不得原样回显：错误消息保持有界，响应不会变成另一个巨型文件
    with pytest.raises(ImportRejectedError) as info:
        preview_import(csv_text("领料," + "9" * 1000 + "x,,"))
    assert info.value.line == 2
    assert "无法识别" in info.value.reason
    assert len(info.value.reason) < 200
