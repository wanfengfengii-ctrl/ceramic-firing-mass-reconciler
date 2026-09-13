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


# ---------------------------------------------------------------------------
# 成组录入：单笔与成组混合保存、刷新还原、非法整批回滚、旧格式兼容
# ---------------------------------------------------------------------------


def grp(unit: str, count: int) -> dict:
    return {"mode": "group", "unit_weight": unit, "count": count}


async def test_mixed_single_and_group_rows_saved_and_restored(client_fixture, clean) -> None:
    body = payload(
        "G-1",
        issued=["1000.000", grp("12.500", 8)],   # 1000 + 100 = 1100
        returned=[grp("10.000", 5)],             # 50
        product=["1040.000"],                    # 1040
        scrap=["60.000"],                        # 60
    )
    resp = client_fixture.post("/api/batches", json=body)
    assert resp.status_code == 201, resp.text
    d = resp.json()

    # 预览/裁决与后端一致：净投入 1050，产出 1100，差额 +50，允许差 5 -> 不闭合
    assert d["issued_total"] == "1100.000"
    assert d["returned_total"] == "50.000"
    assert d["net_input"] == "1050.000"
    assert d["output_total"] == "1100.000"
    assert d["difference"] == "+50.000"
    assert d["tolerance"] == "5"
    assert d["closed"] is False

    issued = d["entries"]["issued"]
    # 单笔行
    assert issued[0] == {"seq": 1, "weight": "1000.000", "mode": "single",
                         "unit_weight": None, "count": None}
    # 成组行：采用重量 + 可还原算式的依据
    assert issued[1] == {"seq": 2, "weight": "100.000", "mode": "group",
                         "unit_weight": "12.500", "count": 8}
    assert d["entries"]["returned"][0] == {
        "seq": 1, "weight": "50.000", "mode": "group",
        "unit_weight": "10.000", "count": 5,
    }

    # 刷新详情：算式依据仍在，裁决一致
    got = client_fixture.get(f"/api/batches/{d['id']}").json()
    assert got == d
    assert got["entries"]["issued"][1]["unit_weight"] == "12.500"
    assert got["entries"]["issued"][1]["count"] == 8


async def test_group_product_at_precision_boundary(client_fixture, clean) -> None:
    # 乘积刚好达到 Numeric(14,3) 边界 99999999999.999：前后端十进制结果相同
    body = payload("G-BND", issued=[grp("33333333333.333", 3)])
    resp = client_fixture.post("/api/batches", json=body)
    assert resp.status_code == 201, resp.text
    d = resp.json()
    assert d["entries"]["issued"][0]["weight"] == "99999999999.999"
    assert d["issued_total"] == "99999999999.999"
    # 刷新复算仍是同一值（数据库 NUMERIC 不丢精度）
    got = client_fixture.get(f"/api/batches/{d['id']}").json()
    assert got["entries"]["issued"][0]["weight"] == "99999999999.999"


async def test_invalid_group_data_rolls_back_whole_batch(client_fixture, clean) -> None:
    from app.db import engine

    # 每份非法数据都必须整批拒绝：份数越界 / 单份非法 / 乘积超范围 / 字段矛盾
    bad_cases = [
        payload("GX-1", issued=[grp("12.500", 1)]),            # 份数下限
        payload("GX-2", issued=[grp("12.500", 1000)]),         # 份数上限
        payload("GX-3", issued=[grp("0", 2)]),                 # 单份非正
        payload("GX-4", issued=[grp("1.0001", 2)]),            # 单份超三位小数
        payload("GX-5", issued=[grp("50000000000.000", 2)]),    # 乘积超存储范围
        payload("GX-6", issued=[{"mode": "group",
                                 "unit_weight": "1", "count": 2, "x": 1}]),  # 字段矛盾
        payload("GX-7", issued=[{"mode": "group", "count": 2}]),             # 缺字段
        payload("GX-8", issued=[{"mode": "single",
                                 "unit_weight": "1", "count": 2}]),          # mode 矛盾
        payload("GX-9", issued=[grp("12.500", 2.0)]),         # 份数非整数
    ]
    for i, bad in enumerate(bad_cases):
        resp = client_fixture.post("/api/batches", json=bad)
        assert resp.status_code == 400, (i, resp.text)

    # 非法行混在合法批次里同样整体回滚：批次与称重行均不落库
    mixed = payload(
        "GX-10",
        issued=["1000.000", grp("12.500", 1)],  # 第二行份数非法
        product=["900.000"],
    )
    resp = client_fixture.post("/api/batches", json=mixed)
    assert resp.status_code == 400
    assert "第 2 笔" in resp.json()["detail"]

    async with AsyncSession(engine) as s:
        n_batches = (await s.execute(text("SELECT count(*) FROM batches"))).scalar_one()
        n_entries = (
            await s.execute(text("SELECT count(*) FROM weight_entries"))
        ).scalar_one()
    assert n_batches == 0
    assert n_entries == 0
    assert client_fixture.get("/api/batches").json() == []


async def test_old_string_format_keeps_original_behavior(client_fixture, clean) -> None:
    # 旧格式请求（纯字符串行）结果与成组功能上线前完全一致，依据列为空
    body = payload(
        "OLD-1",
        issued=["1000.000", "500.000"],
        returned=["100.000"],
        product=["1395.000"],
        scrap=["10.000"],
    )
    resp = client_fixture.post("/api/batches", json=body)
    assert resp.status_code == 201, resp.text
    d = resp.json()
    assert d["difference"] == "+5.000"
    assert d["verdict"] == "闭合"
    for e in d["entries"]["issued"]:
        assert e["mode"] == "single"
        assert e["unit_weight"] is None
        assert e["count"] is None

    from app.db import engine

    async with AsyncSession(engine) as s:
        row = (
            await s.execute(
                text(
                    "SELECT entry_mode, unit_weight, count "
                    "FROM weight_entries ORDER BY kind, seq LIMIT 1"
                )
            )
        ).first()
    # 旧记录的成组依据列全部为 NULL（解释为单笔）
    assert row == (None, None, None)


async def test_group_rows_do_not_create_per_copy_rows(client_fixture, clean) -> None:
    # 份数 999 的一行仍是一行：库里不会展开成 999 条称重行
    body = payload("G-999", issued=[grp("10.000", 999), "5.000"])
    resp = client_fixture.post("/api/batches", json=body)
    assert resp.status_code == 201, resp.text
    d = resp.json()
    assert d["issued_total"] == "9995.000"
    assert len(d["entries"]["issued"]) == 2

    from app.db import engine

    async with AsyncSession(engine) as s:
        n = (
            await s.execute(text("SELECT count(*) FROM weight_entries"))
        ).scalar_one()
    assert n == 2
