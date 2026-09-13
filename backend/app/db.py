"""PostgreSQL 异步引擎与会话。

PostgreSQL 不可替代：每笔原始克重与当次判定都落库保存，
只有在整批校验合法、核算完成后才提交事务。
"""

from __future__ import annotations

import os

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql+psycopg://kiln:kiln@db:5432/kiln",
)

engine = create_async_engine(DATABASE_URL, pool_pre_ping=True)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False)

# 成组录入为 weight_entries 增加的可空依据列（旧库平滑升级：缺列才补）。
# 全新数据库由模型上的约束直接建出；这里仅补列，旧数据三列保持 NULL，解释为单笔。
_GROUP_COLUMNS = (
    ("entry_mode", "VARCHAR(10)"),
    ("unit_weight", "NUMERIC(14, 3)"),
    ("count", "INTEGER"),
)


async def init_db() -> None:
    from .models import Base

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        exists = await conn.execute(
            text(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_name = 'weight_entries'"
            )
        )
        present = {row[0] for row in exists.all()}
        for name, ddl in _GROUP_COLUMNS:
            if name not in present:
                await conn.execute(
                    text(f"ALTER TABLE weight_entries ADD COLUMN {name} {ddl}")
                )


async def get_session() -> AsyncSession:
    async with SessionLocal() as session:
        yield session
