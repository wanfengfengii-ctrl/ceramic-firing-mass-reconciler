"""称重文件导入预检：解析 CSV、复用十进制校验与四分区核算，只读不写库。

文件格式（UTF-8，电子秤导出的称重明细）：
- 第一个非空行为表头，必须各含一次「分区 / 重量 / 单份重量 / 份数」四列，
  列序不限，可含额外列（忽略）；表头名重复即整份拒绝；
- 数据行按文件行序处理：分区取 领料/退料/成品/废料（或英文键
  issued/returned/product/scrap）；
- 单笔行只填「重量」；成组行只填「单份重量」与「份数」——两种填法
  互相排斥，缺一半或混填都属于字段矛盾；
- 全部单元格为空的行忽略（行号仍按原始文件物理行计数）。

任何一行非法（未知分区、字段矛盾、重量/份数非法）或整批核算不合法
（如无领料、退料大于领料）都整份拒绝，并给出 CSV 行号与原因。
"""

from __future__ import annotations

import csv
import io
import re

from .calc import (
    KINDS,
    KIND_LABELS,
    MAX_GROUP_COUNT,
    MIN_GROUP_COUNT,
    PreparedEntry,
    WeightValidationError,
    prepare_entry,
    reckon_prepared,
)
from .schemas import EntryOut, ImportPreviewOut, ImportReckoning, q3

REQUIRED_HEADERS: tuple[str, ...] = ("分区", "重量", "单份重量", "份数")

# 分区列取值 → 内部分区键：中文标签与 API 英文键均可
KIND_ALIASES: dict[str, str] = {
    **{KIND_LABELS[kind]: kind for kind in KINDS},
    **{kind: kind for kind in KINDS},
}

_COUNT_RE = re.compile(r"[0-9]+")


class ImportRejectedError(ValueError):
    """整份文件拒绝：携带 CSV 行号（文件级错误为 None）与原因。"""

    def __init__(self, reason: str, *, line: int | None = None) -> None:
        self.line = line
        self.reason = reason
        message = f"第 {line} 行：{reason}" if line is not None else reason
        super().__init__(message)


def _is_blank(cells: list[str]) -> bool:
    return all(cell.strip() == "" for cell in cells)


def _parse_header(reader: csv.reader) -> dict[str, int]:
    """读取第一个非空行作为表头，返回 列名 → 下标；非法表头整份拒绝。"""

    for row in reader:
        line = reader.line_num
        if _is_blank(row):
            continue  # 表头前的空行同样忽略
        seen: dict[str, int] = {}
        for idx, name in enumerate(cell.strip() for cell in row):
            if name == "":
                continue  # 无名列视为额外列，忽略
            if name in seen:
                raise ImportRejectedError(f"重复表头：{name!r}", line=line)
            seen[name] = idx
        missing = [h for h in REQUIRED_HEADERS if h not in seen]
        if missing:
            raise ImportRejectedError(
                f"缺少表头列：{'、'.join(missing)}", line=line
            )
        return seen
    raise ImportRejectedError("文件为空：缺少表头（分区/重量/单份重量/份数）")


def _parse_row(
    cells: dict[str, str], *, line: int, prepared: dict[str, list[PreparedEntry]]
) -> None:
    """把一行数据展开为 PreparedEntry 追加到对应分区；非法即整份拒绝。"""

    kind_text = cells["分区"]
    kind = KIND_ALIASES.get(kind_text)
    if kind is None:
        allowed = "、".join(KIND_LABELS[k] for k in KINDS)
        raise ImportRejectedError(
            f"未知分区 {kind_text!r}（应为 {allowed}）", line=line
        )

    # 行号按分区内已有行数递增，与保存后详情里的“第 n 笔”一致
    seq = len(prepared[kind]) + 1
    label = f"{KIND_LABELS[kind]} 第 {seq} 笔"
    weight_text = cells["重量"]
    unit_text = cells["单份重量"]
    count_text = cells["份数"]

    has_weight = weight_text != ""
    has_unit = unit_text != ""
    has_count = count_text != ""

    try:
        if has_weight and not has_unit and not has_count:
            entry = prepare_entry(weight_text, kind=kind, seq=seq)
        elif not has_weight and has_unit and has_count:
            # 份数必须是纯数字整串；范围（2–999）由 calc 层与成组校验一并判定
            if not _COUNT_RE.fullmatch(count_text):
                raise WeightValidationError(
                    f"{label}：份数必须是 {MIN_GROUP_COUNT}–{MAX_GROUP_COUNT} 的整数"
                )
            entry = prepare_entry(
                {
                    "mode": "group",
                    "unit_weight": unit_text,
                    "count": int(count_text),
                },
                kind=kind,
                seq=seq,
            )
        elif has_weight:
            raise WeightValidationError(
                f"{label}：字段矛盾（重量与单份重量/份数只能填写一种）"
            )
        elif has_unit or has_count:
            raise WeightValidationError(
                f"{label}：字段矛盾（成组录入需要同时填写单份重量与份数）"
            )
        else:
            raise WeightValidationError(
                f"{label}：字段矛盾（需要填写重量，或单份重量与份数）"
            )
    except WeightValidationError as exc:
        raise ImportRejectedError(str(exc), line=line) from exc
    prepared[kind].append(entry)


def preview_import(content: str) -> ImportPreviewOut:
    """预检一份称重 CSV：返回规范化行与核算预览，不写数据库。"""

    # 电子秤/Excel 导出的 UTF-8 CSV 常带 BOM，先去掉再按文本解析
    reader = csv.reader(io.StringIO(content.removeprefix("﻿")))
    columns = _parse_header(reader)

    prepared: dict[str, list[PreparedEntry]] = {kind: [] for kind in KINDS}
    row_count = 0
    for row in reader:
        if _is_blank(row):
            continue  # 空行可忽略；reader.line_num 仍按原始物理行计数
        line = reader.line_num
        # 缺尾列按空单元格处理；多出的尾列属于额外列，忽略
        cells = {
            name: (row[idx].strip() if idx < len(row) else "")
            for name, idx in columns.items()
        }
        row_count += 1
        _parse_row(cells, line=line, prepared=prepared)

    try:
        result = reckon_prepared(prepared)
    except WeightValidationError as exc:
        # 整批核算错误（无领料、退料大于领料、合计超范围）不归属单一数据行
        raise ImportRejectedError(str(exc)) from exc

    entries = {
        kind: [
            EntryOut(
                seq=i + 1,
                weight=q3(entry.weight),
                mode="group" if entry.mode == "group" else "single",
                unit_weight=(
                    q3(entry.unit_weight)
                    if entry.mode == "group" and entry.unit_weight is not None
                    else None
                ),
                count=entry.count if entry.mode == "group" else None,
            )
            for i, entry in enumerate(prepared[kind])
        ]
        for kind in KINDS
    }
    preview = ImportReckoning(
        issued_total=q3(result.issued_total),
        returned_total=q3(result.returned_total),
        product_total=q3(result.product_total),
        scrap_total=q3(result.scrap_total),
        net_input=q3(result.net_input),
        output_total=q3(result.output_total),
        difference=q3(result.difference, signed=True),
        tolerance=str(result.tolerance),
        closed=result.closed,
        verdict="闭合" if result.closed else "不闭合",
    )
    return ImportPreviewOut(row_count=row_count, entries=entries, preview=preview)
