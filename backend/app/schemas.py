"""请求/响应模型。Decimal 一律以字符串出现在 JSON 中，杜绝二进制浮点传输。"""

from __future__ import annotations

from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

Kind = Literal["issued", "returned", "product", "scrap"]
_ALLOWED_KINDS = {"issued", "returned", "product", "scrap"}


class GroupEntryIn(BaseModel):
    """成组录入：纸单“单桶重量×桶数”。

    mode 固定为 "group"；单份重量为十进制文本，份数为 2–999 的整数。
    乘积合法性（存储范围等）由 calc 层用 Decimal 复算后判定。
    """

    # strict：unit_weight 给 JSON 数字会被拒绝；count 只接受 int（True 除外）
    # extra=forbid：对象字段矛盾（多出纸单之外的键）在入口即整批拒绝
    model_config = ConfigDict(strict=True, extra="forbid")

    mode: Literal["group"]
    # 语义校验（空文本、>0、三位小数、份数 2–999、乘积范围）全部在 calc 层完成，
    # 以便错误信息能定位到“分区 第 n 笔”；这里只固定 JSON 形状与类型。
    unit_weight: str
    count: int


class BatchIn(BaseModel):
    # strict：JSON 里的数字不会悄悄变成字符串，重量必须是十进制文本
    model_config = ConfigDict(strict=True)

    batch_no: str = Field(min_length=1, max_length=64)
    # 每行为单笔十进制字符串（"1200.500"）或成组对象，两种方式可在同批混用
    entries: dict[str, list[str | GroupEntryIn]]

    @field_validator("entries")
    @classmethod
    def _check_kinds(
        cls, value: dict[str, list[str | GroupEntryIn]]
    ) -> dict[str, list[str | GroupEntryIn]]:
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
    # 成组依据（可空）：旧记录与单笔行均不返回这三个字段以外的形式——
    # mode 为 None 即单笔；group 时可据 unit_weight × count 还原算式
    mode: Literal["single", "group"] | None = None
    unit_weight: str | None = None
    count: int | None = None


# 称重文件大小上限（字符）：电子秤明细远远小于 1 MB，超限在入口即拒
MAX_IMPORT_CONTENT_LENGTH = 1_000_000


class ImportPreviewIn(BaseModel):
    """称重文件预检请求：UTF-8 CSV 文本（分区/重量/单份重量/份数四列）。"""

    model_config = ConfigDict(strict=True)

    content: str = Field(min_length=1, max_length=MAX_IMPORT_CONTENT_LENGTH)


class ImportReckoning(BaseModel):
    """导入预检的核算预览：与批次详情相同的十进制字段，不含身份/时间信息。"""

    issued_total: str
    returned_total: str
    product_total: str
    scrap_total: str
    net_input: str
    output_total: str
    difference: str  # 带符号，保留三位小数
    tolerance: str
    closed: bool
    verdict: str  # “闭合” / “不闭合”


class ImportPreviewOut(BaseModel):
    """合法文件的预检结果：规范化行（各分区按文件行序）+ 四分区核算预览。

    纯只读：不落库；用户确认后仍走 POST /api/batches 保存。
    """

    row_count: int  # 参与导入的数据行数（不含表头与被忽略的空行）
    entries: dict[str, list[EntryOut]]
    preview: ImportReckoning


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


class CompareSide(BaseModel):
    """对比中一方的身份与裁决快照。"""

    id: int
    batch_no: str
    closed: bool
    verdict: str


class MetricDelta(BaseModel):
    """单个指标：双方快照值与带符号变化量（当前 − 基准），均保留三位小数。"""

    current: str
    base: str
    delta: str  # 带符号：正为增、负为减


class BatchCompare(BaseModel):
    """两个已保存批次的并排核对结果（只读，由库内核算快照直接相减）。"""

    current: CompareSide
    base: CompareSide
    issued_total: MetricDelta
    returned_total: MetricDelta
    net_input: MetricDelta
    product_total: MetricDelta
    scrap_total: MetricDelta
    output_total: MetricDelta
    difference: MetricDelta
    tolerance: MetricDelta
    verdict_changed: bool  # 双方裁决是否不同（闭合 ↔ 不闭合）


def q3(value: Decimal, *, signed: bool = False) -> str:
    text = f"{value:.3f}"
    if signed and value >= 0:
        text = "+" + text
    return text
