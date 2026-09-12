"""真实 PostgreSQL 集成测试：建表、提交、事务失败不留痕、刷新复算一致。

运行方式（见 README）：
  DATABASE_URL='postgresql+psycopg://postgres@/kilntest?host=%2Ftmp' pytest
本文件要求必须连通真实 PostgreSQL —— 不允许用假接口或内存替身。
"""

from __future__ import annotations

import os

import pytest
import pytest_asyncio
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

pytestmark = pytest.mark.asyncio(loop_scope="session")


@pytest_asyncio.fixture(scope="session")
async def engine_fixture():
    from app.db import engine, init_db

    await init_db()
    yield engine
    await engine.dispose()


@pytest_asyncio.fixture
async def clean(engine_fixture):
    from app.db import engine

    async with engine.begin() as conn:
        await conn.execute(text("TRUNCATE weight_entries, batches RESTART IDENTITY"))
    yield


@pytest_asyncio.fixture
def client_fixture(engine_fixture):
    # ASGI lifespan 会再跑一次 create_all，幂等无副作用
    from app.main import app

    with TestClient(app) as client:
        yield client


def payload(no: str, **entries: list[str]) -> dict:
    return {"batch_no": no, "entries": {k: v for k, v in entries.items()}}


async def test_healthz(client_fixture) -> None:
    assert client_fixture.get("/healthz").json() == {"status": "ok"}


async def test_create_and_get_detail(client_fixture, clean) -> None:
    body = payload(
        "B-001",
        issued=["1000.000", "500.000"],
        returned=["100.000"],
        product=["1395.000"],
        scrap=["10.000"],
    )
    resp = client_fixture.post("/api/batches", json=body)
    assert resp.status_code == 201, resp.text
    d = resp.json()
    assert d["batch_no"] == "B-001"
    assert d["closed"] is True
    assert d["verdict"] == "闭合"
    assert d["issued_total"] == "1500.000"
    assert d["returned_total"] == "100.000"
    assert d["net_input"] == "1400.000"
    assert d["output_total"] == "1405.000"
    assert d["difference"] == "+5.000"
    assert d["tolerance"] == "5"

    # 详情同时呈现原始行，保留分区与抄录顺序
    assert [e["weight"] for e in d["entries"]["issued"]] == ["1000.000", "500.000"]
    assert [e["weight"] for e in d["entries"]["scrap"]] == ["10.000"]
    assert [e["weight"] for e in d["entries"]["returned"]] == ["100.000"]
    assert d["entries"]["product"][0]["seq"] == 1

    got = client_fixture.get("/api/batches/1").json()
    assert got["difference"] == "+5.000"
    assert got["verdict"] == "闭合"
    assert got["entries"]["issued"][1]["seq"] == 2


async def test_open_batch_is_still_saved(client_fixture, clean) -> None:
    # 合法但超差的批次照常保存，详情显示“不闭合”
    resp = client_fixture.post(
        "/api/batches",
        json=payload("B-OPEN", issued=["1000"], product=["1020"]),
    )
    assert resp.status_code == 201, resp.text
    d = resp.json()
    assert d["closed"] is False
    assert d["verdict"] == "不闭合"
    assert d["difference"] == "+20.000"
    assert d["tolerance"] == "5"

    listed = client_fixture.get("/api/batches").json()
    assert any(b["batch_no"] == "B-OPEN" and b["verdict"] == "不闭合" for b in listed)


async def test_invalid_batch_leaves_no_rows(client_fixture, clean) -> None:
    from app.db import engine

    bad_cases = [
        payload("X-1", issued=[]),
        payload("X-2", issued=["0"]),
        payload("X-3", issued=["-3"]),
        payload("X-4", issued=["1.0001"]),
        payload("X-5", issued=["100"], returned=["100.001"]),
        payload("X-6", issued=["NaN"]),
    ]
    for i, bad in enumerate(bad_cases):
        resp = client_fixture.post("/api/batches", json=bad)
        assert resp.status_code == 400, (i, resp.text)

    async with AsyncSession(engine) as s:
        n_batches = (await s.execute(text("SELECT count(*) FROM batches"))).scalar_one()
        n_entries = (
            await s.execute(text("SELECT count(*) FROM weight_entries"))
        ).scalar_one()
    assert n_batches == 0
    assert n_entries == 0


async def test_unknown_partition_rejected(client_fixture, clean) -> None:
    resp = client_fixture.post(
        "/api/batches",
        json={"batch_no": "X-7", "entries": {"issued": ["1"], "bogus": ["2"]}},
    )
    assert resp.status_code == 400
    assert client_fixture.get("/api/batches").json() == []


async def test_numeric_json_rejected_not_coerced(client_fixture, clean) -> None:
    # JSON 数字（二进制浮点边界）必须整体拒绝
    resp = client_fixture.post(
        "/api/batches",
        json={"batch_no": "X-8", "entries": {"issued": [1.1]}},
    )
    assert resp.status_code == 400
    assert client_fixture.get("/api/batches").json() == []


async def test_duplicate_batch_no_conflict(client_fixture, clean) -> None:
    ok = client_fixture.post(
        "/api/batches", json=payload("DUP-1", issued=["100"], product=["100"])
    )
    assert ok.status_code == 201
    dup = client_fixture.post(
        "/api/batches", json=payload("DUP-1", issued=["200"], product=["200"])
    )
    assert dup.status_code == 409
    # 重复提交回滚：只剩第一条
    assert len(client_fixture.get("/api/batches").json()) == 1


async def test_refresh_gives_same_business_result(client_fixture, clean) -> None:
    # 刷新后仍得到同一业务结果：两次 GET 与列表快照完全一致
    client_fixture.post(
        "/api/batches",
        json=payload("R-1", issued=["2750"], product=["2744"], scrap=["0.5"]),
    )
    first = client_fixture.get("/api/batches/1").json()
    second = client_fixture.get("/api/batches/1").json()

    assert first == second
    assert first["difference"] == "-5.500"
    assert first["tolerance"] == "6"          # ROUND_HALF_UP(5.5) = 6
    assert first["closed"] is True            # |-5.5| <= 6
    assert first["verdict"] == "闭合"

    listed = client_fixture.get("/api/batches").json()
    summary = next(b for b in listed if b["batch_no"] == "R-1")
    assert summary["difference"] == first["difference"]
    assert summary["closed"] == first["closed"]


async def test_commit_failure_rolls_back_everything(engine_fixture, clean, monkeypatch) -> None:
    # 模拟事务提交瞬间数据库故障：必须回滚，库里不得残留批次或原始行
    from app.db import engine
    from app.service import create_batch

    async def broken_commit(self) -> None:
        raise SQLAlchemyError("simulated database outage during commit")

    monkeypatch.setattr(AsyncSession, "commit", broken_commit)

    async with AsyncSession(engine) as session:
        with pytest.raises(SQLAlchemyError):
            await create_batch(
                session,
                "TX-1",
                {
                    "issued": ["1000.000", "500.000"],
                    "returned": ["10.000"],
                    "product": ["1480.000"],
                },
            )
    monkeypatch.undo()

    async with AsyncSession(engine) as session:
        n_batches = (await session.execute(text("SELECT count(*) FROM batches"))).scalar_one()
        n_entries = (
            await session.execute(text("SELECT count(*) FROM weight_entries"))
        ).scalar_one()
    assert n_batches == 0
    assert n_entries == 0


async def test_not_closed_roundtrip_with_raw_rows(client_fixture, clean) -> None:
    # 超差但合法的批次：刷新后仍是“不闭合”，且原始行可逐笔复算
    resp = client_fixture.post(
        "/api/batches",
        json=payload(
            "R-2",
            issued=["1000.000", "2000.000"],
            returned=["100.000"],
            product=["2800.000"],
        ),
    )
    assert resp.status_code == 201
    # 净投入 2900，产出 2800，差额 -100，允许差 6
    d = client_fixture.get("/api/batches/1").json()
    assert d["net_input"] == "2900.000"
    assert d["output_total"] == "2800.000"
    assert d["difference"] == "-100.000"
    assert d["tolerance"] == "6"
    assert d["closed"] is False
    assert d["verdict"] == "不闭合"
    assert [e["weight"] for e in d["entries"]["issued"]] == ["1000.000", "2000.000"]
