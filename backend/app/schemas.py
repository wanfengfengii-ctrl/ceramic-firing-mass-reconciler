"""请求/响应模型。Decimal 一律以字符串出现在 JSON 中，杜绝二进制浮点传输。"""

from __future__ import annotations

from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

Kind = Literal["issued", "returned", "product", "scrap"]
_ALLOWED_KINDS = {"issued", "returned", "product", "scrap"}


class BatchIn(BaseModel):
    # strict：JSON 里的数字不会悄悄变成字符串，重量必须是十进制文本
    model_config = ConfigDict(strict=True)

    batch_no: str = Field(min_length=1, max_length=64)
    # 每笔重量以十进制字符串提交，例如 "1200.500"
    entries: dict[str, list[str]]

    @field_validator("entries")
    @classmethod
    def _check_kinds(cls, value: dict[str, list[str]]) -> dict[str, list[str]]:
        unknown = set(value) - _ALLOWED_KINDS
        if unknown:
            raise ValueError(f"未知分区：{sorted(unknown)}")
        return value

    @field_validator("batch_no")
    @classmethod
    def _strip_batch_no(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("批次号不能为空")
        return value


class EntryOut(BaseModel):
    seq: int
    weight: str


class BatchDetail(BaseModel):
    id: int
    batch_no: str
    closed: bool
    verdict: str  # “闭合” / “不闭合”
    issued_total: str
    returned_total: str
    product_total: str
    scrap_total: str
    net_input: str
    output_total: str
    difference: str  # 带符号，保留三位小数
    tolerance: str
    entries: dict[str, list[EntryOut]]
    created_at: str


class BatchSummary(BaseModel):
    id: int
    batch_no: str
    closed: bool
    verdict: str
    net_input: str
    difference: str
    tolerance: str
    created_at: str


def q3(value: Decimal, *, signed: bool = False) -> str:
    text = f"{value:.3f}"
    if signed and value >= 0:
        text = "+" + text
    return text
