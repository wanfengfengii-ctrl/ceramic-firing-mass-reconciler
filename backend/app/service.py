"""批次写入/读取服务：校验、核算与保存放在同一个事务里。"""

from __future__ import annotations

from collections import defaultdict
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from .calc import (
    KINDS,
    WeightValidationError,
    prepare_entries,
    reckon_prepared,
)
from .models import Batch, WeightEntry
from .schemas import (
    BatchCompare,
    BatchDetail,
    BatchSummary,
    CompareSide,
    EntryOut,
    GroupEntryIn,
    MetricDelta,
    q3,
)


async def create_batch(session: AsyncSession, batch_no: str, raw_entries: dict) -> BatchDetail:
    """整批校验 + 十进制核算 + 落库。

    成组行在 calc 层用 Decimal 重新乘出采用重量（不信任任何外部乘积），
    任何一步失败都回滚：非法批次不会在库里留下主表行或任何原始称重行。
    """

    try:
        # 单笔字符串原样进入；成组 pydantic 模型转回 dict，交由 calc 层复算
        raw_rows = {
            kind: [
                row.model_dump() if isinstance(row, GroupEntryIn) else row
                for row in (raw_entries.get(kind) or [])
            ]
            for kind in KINDS
        }
        prepared = prepare_entries(raw_rows)
        result = reckon_prepared(prepared)  # 非法输入在此抛 WeightValidationError
    except WeightValidationError:
        await session.rollback()
        raise

    batch = Batch(
        batch_no=batch_no,
        issued_total=result.issued_total,
        returned_total=result.returned_total,
        product_total=result.product_total,
        scrap_total=result.scrap_total,
        net_input=result.net_input,
        output_total=result.output_total,
        difference=result.difference,
        tolerance=result.tolerance,
        closed=result.closed,
    )
    session.add(batch)

    # 每行保存采用重量；成组行另存录入方式/单份/份数，供详情还原算式
    seq_counter: dict[str, int] = defaultdict(int)
    for kind in KINDS:
        for entry in prepared[kind]:
            seq_counter[kind] += 1
            session.add(
                WeightEntry(
                    batch=batch,
                    kind=kind,
                    seq=seq_counter[kind],
                    weight=entry.weight,
                    entry_mode=entry.mode if entry.mode == "group" else None,
                    unit_weight=entry.unit_weight,
                    count=entry.count,
                )
            )

    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise DuplicateBatchError(batch_no) from exc
    except SQLAlchemyError as exc:
        await session.rollback()
        raise

    # 重新查询并预加载原始行（async 会话不允许懒加载触发 IO）
    saved = await session.scalar(
        select(Batch).where(Batch.id == batch.id).options(selectinload(Batch.entries))
    )
    assert saved is not None
    return detail_from_model(saved)


class DuplicateBatchError(Exception):
    def __init__(self, batch_no: str) -> None:
        self.batch_no = batch_no
        super().__init__(f"批次号 {batch_no!r} 已存在")


async def list_batches(session: AsyncSession) -> list[BatchSummary]:
    rows = (await session.scalars(select(Batch).order_by(Batch.id.desc()))).all()
    return [summary_from_model(b) for b in rows]


async def get_batch(session: AsyncSession, batch_id: int) -> BatchDetail | None:
    batch = await session.scalar(
        select(Batch).where(Batch.id == batch_id).options(selectinload(Batch.entries))
    )
    if batch is None:
        return None
    return detail_from_model(batch)


class BatchNotFoundError(Exception):
    """对比涉及的批次不存在；role 指明是“当前批次”还是“基准批次”。"""

    def __init__(self, role: str, batch_id: int) -> None:
        self.role = role
        self.batch_id = batch_id
        super().__init__(f"{role} {batch_id} 不存在")


class SelfCompareError(ValueError):
    """基准批次与当前批次相同：页面本应阻止，服务端同样明确拒绝。"""

    def __init__(self, batch_id: int) -> None:
        self.batch_id = batch_id
        super().__init__(f"批次 {batch_id} 不能与自身对比，请选择另一基准批次")


async def compare_batches(
    session: AsyncSession, batch_id: int, base_id: int
) -> BatchCompare:
    """并排核对两个已保存批次。

    全部指标直接取库内核算快照（合计/差额/允许差/裁决）相减，
    纯只读：不重算称重行，更不修改批次或称重行。
    """

    if base_id == batch_id:
        raise SelfCompareError(batch_id)
    current = await session.scalar(select(Batch).where(Batch.id == batch_id))
    if current is None:
        raise BatchNotFoundError("当前批次", batch_id)
    base = await session.scalar(select(Batch).where(Batch.id == base_id))
    if base is None:
        raise BatchNotFoundError("基准批次", base_id)
    return compare_from_models(current, base)


def _side(batch: Batch) -> CompareSide:
    return CompareSide(
        id=batch.id,
        batch_no=batch.batch_no,
        closed=batch.closed,
        verdict="闭合" if batch.closed else "不闭合",
    )


def _delta(current: Decimal, base: Decimal, *, signed: bool = False) -> MetricDelta:
    # signed：差额本身在详情中带符号展示，对比里双方快照值保持同一形式
    return MetricDelta(
        current=q3(current, signed=signed),
        base=q3(base, signed=signed),
        delta=q3(current - base, signed=True),
    )


def compare_from_models(current: Batch, base: Batch) -> BatchCompare:
    return BatchCompare(
        current=_side(current),
        base=_side(base),
        issued_total=_delta(current.issued_total, base.issued_total),
        returned_total=_delta(current.returned_total, base.returned_total),
        net_input=_delta(current.net_input, base.net_input),
        product_total=_delta(current.product_total, base.product_total),
        scrap_total=_delta(current.scrap_total, base.scrap_total),
        output_total=_delta(current.output_total, base.output_total),
        difference=_delta(current.difference, base.difference, signed=True),
        tolerance=_delta(current.tolerance, base.tolerance),
        verdict_changed=current.closed != base.closed,
    )


def _entries_by_kind(batch: Batch) -> dict[str, list[EntryOut]]:
    grouped: dict[str, list[EntryOut]] = {kind: [] for kind in KINDS}
    for e in batch.entries:
        grouped.setdefault(e.kind, [])
        is_group = e.entry_mode == "group"
        grouped[e.kind].append(
            EntryOut(
                seq=e.seq,
                weight=q3(e.weight),
                mode="group" if is_group else "single",
                unit_weight=q3(e.unit_weight) if is_group and e.unit_weight is not None else None,
                count=e.count if is_group else None,
            )
        )
    return grouped


def detail_from_model(batch: Batch) -> BatchDetail:
    return BatchDetail(
        id=batch.id,
        batch_no=batch.batch_no,
        closed=batch.closed,
        verdict="闭合" if batch.closed else "不闭合",
        issued_total=q3(batch.issued_total),
        returned_total=q3(batch.returned_total),
        product_total=q3(batch.product_total),
        scrap_total=q3(batch.scrap_total),
        net_input=q3(batch.net_input),
        output_total=q3(batch.output_total),
        difference=q3(batch.difference, signed=True),
        tolerance=str(batch.tolerance),
        entries=_entries_by_kind(batch),
        created_at=batch.created_at.isoformat(),
    )


def summary_from_model(batch: Batch) -> BatchSummary:
    return BatchSummary(
        id=batch.id,
        batch_no=batch.batch_no,
        closed=batch.closed,
        verdict="闭合" if batch.closed else "不闭合",
        net_input=q3(batch.net_input),
        difference=q3(batch.difference, signed=True),
        tolerance=str(batch.tolerance),
        created_at=batch.created_at.isoformat(),
    )
