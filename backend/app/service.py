"""批次写入/读取服务：校验、核算与保存放在同一个事务里。"""

from __future__ import annotations

from collections import defaultdict

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
from .schemas import BatchDetail, BatchSummary, EntryOut, GroupEntryIn, q3


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
