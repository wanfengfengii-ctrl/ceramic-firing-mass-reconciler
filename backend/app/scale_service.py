"""日常秤检台账的写入/读取服务：复算、判定与保存在同一个事务里。

秤检是与批次核算完全独立的资源：不引用批次表，也不被批次流程引用。
非法输入在提交前整体拒绝并回滚，失败请求不会在台账里留下部分记录。
"""

from __future__ import annotations

import re
from datetime import date

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from .models import ScaleCheck
from .scale import SCALE_POINT_COUNT, ScaleValidationError, evaluate_scale_check
from .schemas import ScaleCheckIn, ScaleCheckOut, ScalePointOut, q3

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class DuplicateScaleCheckError(Exception):
    """同一设备同一日期重复秤检。"""

    def __init__(self, device_no: str, check_date: str) -> None:
        self.device_no = device_no
        self.check_date = check_date
        super().__init__(f"设备 {device_no!r} 在 {check_date} 已有秤检记录，每日只能保存一次")


def _parse_date(raw: str) -> date:
    if not _DATE_RE.match(raw):
        raise ScaleValidationError("检验日期必须是 YYYY-MM-DD 格式（如 2026-09-13）")
    try:
        return date.fromisoformat(raw)
    except ValueError as exc:
        raise ScaleValidationError("检验日期不是有效的日历日期") from exc


async def create_scale_check(
    session: AsyncSession, payload: ScaleCheckIn
) -> ScaleCheckOut:
    """校验设备编号/日期、用 Decimal 复算三组测点并落库。

    任何一步失败都回滚：非法或重复请求不会留下部分测点记录。
    """

    try:
        check_date = _parse_date(payload.check_date)
        # ScalePointIn 模型转回 dict，交由纯 Decimal 的 scale 层复算
        raw_points = [point.model_dump() for point in payload.points]
        result = evaluate_scale_check(raw_points)
    except ScaleValidationError:
        await session.rollback()
        raise

    record = ScaleCheck(
        device_no=payload.device_no,
        check_date=check_date,
        passed=result.passed,
    )
    for i, point in enumerate(result.points):
        setattr(record, f"standard_{i + 1}", point.standard)
        setattr(record, f"measured_{i + 1}", point.measured)
        setattr(record, f"deviation_{i + 1}", point.deviation)
    session.add(record)

    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise DuplicateScaleCheckError(payload.device_no, payload.check_date) from exc
    except SQLAlchemyError:
        await session.rollback()
        raise

    saved = await session.scalar(select(ScaleCheck).where(ScaleCheck.id == record.id))
    assert saved is not None
    return scale_out_from_model(saved)


async def list_scale_checks(session: AsyncSession) -> list[ScaleCheckOut]:
    """按检验日期倒序恢复台账；同日多条再按创建先后倒序。"""

    rows = (
        await session.scalars(
            select(ScaleCheck).order_by(
                ScaleCheck.check_date.desc(), ScaleCheck.id.desc()
            )
        )
    ).all()
    return [scale_out_from_model(row) for row in rows]


def scale_out_from_model(row: ScaleCheck) -> ScaleCheckOut:
    points = [
        ScalePointOut(
            seq=i,
            standard=q3(getattr(row, f"standard_{i}")),
            measured=q3(getattr(row, f"measured_{i}")),
            deviation=q3(getattr(row, f"deviation_{i}"), signed=True),
        )
        for i in range(1, SCALE_POINT_COUNT + 1)
    ]
    return ScaleCheckOut(
        id=row.id,
        device_no=row.device_no,
        check_date=row.check_date.isoformat(),
        points=points,
        passed=row.passed,
        verdict="合格" if row.passed else "不合格",
        created_at=row.created_at.isoformat(),
    )
