"""SQLAlchemy 表结构：批次主表 + 每笔原始称重行。"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class Batch(Base):
    __tablename__ = "batches"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    batch_no: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)

    # 两侧各分区合计（三位小数字符串语义，单位克）
    issued_total: Mapped[Decimal] = mapped_column(Numeric(14, 3), nullable=False)
    returned_total: Mapped[Decimal] = mapped_column(Numeric(14, 3), nullable=False)
    product_total: Mapped[Decimal] = mapped_column(Numeric(14, 3), nullable=False)
    scrap_total: Mapped[Decimal] = mapped_column(Numeric(14, 3), nullable=False)

    # 裁决快照
    net_input: Mapped[Decimal] = mapped_column(Numeric(14, 3), nullable=False)
    output_total: Mapped[Decimal] = mapped_column(Numeric(14, 3), nullable=False)
    difference: Mapped[Decimal] = mapped_column(Numeric(14, 3), nullable=False)
    tolerance: Mapped[Decimal] = mapped_column(Numeric(10, 0), nullable=False)
    closed: Mapped[bool] = mapped_column(nullable=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    entries: Mapped[list["WeightEntry"]] = relationship(
        back_populates="batch",
        cascade="all, delete-orphan",
        order_by="WeightEntry.kind, WeightEntry.seq",
    )


class WeightEntry(Base):
    __tablename__ = "weight_entries"
    __table_args__ = (
        CheckConstraint("kind in ('issued','returned','product','scrap')", name="kind_check"),
        CheckConstraint("weight > 0", name="weight_positive_check"),
        UniqueConstraint("batch_id", "kind", "seq", name="uq_batch_kind_seq"),
        Index("ix_weight_entries_batch_id", "batch_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    batch_id: Mapped[int] = mapped_column(
        ForeignKey("batches.id", ondelete="CASCADE"), nullable=False
    )
    kind: Mapped[str] = mapped_column(String(10), nullable=False)
    seq: Mapped[int] = mapped_column(Integer, nullable=False)
    # 每笔原始重量，三位小数，单位克
    weight: Mapped[Decimal] = mapped_column(Numeric(14, 3), nullable=False)

    batch: Mapped[Batch] = relationship(back_populates="entries")
