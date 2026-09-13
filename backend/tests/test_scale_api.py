"""真实 PostgreSQL 集成测试：日常秤检台账的保存、倒序恢复、非法/重复不留痕。

运行方式（见 README）：
  DATABASE_URL='postgresql+psycopg://postgres@/kilntest?host=%2Ftmp' pytest
本文件要求必须连通真实 PostgreSQL —— 秤检是独立于批次表的新资源。
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

pytestmark = pytest.mark.asyncio(loop_scope="session")

SCALE_URL = "/api/scale-checks"


@pytest_asyncio.fixture(scope="session")
async def engine_fixture():
    from app.db import engine, init_db

    await init_db()
    yield engine
    await engine.dispose()


@pytest_asyncio.fixture
async def clean_scale(engine_fixture):
    from app.db import engine

    # 秤检台账独立于批次：只清秤检表，批次表数据不影响这些用例，反之亦然
    async with engine.begin() as conn:
        await conn.execute(text("TRUNCATE scale_checks RESTART IDENTITY"))
    yield


@pytest_asyncio.fixture
def client_fixture(engine_fixture):
    from app.main import app

    with TestClient(app) as client:
        yield client


def scale_payload(
    device: str,
    day: str,
    points: list[tuple[str, str]] | None = None,
) -> dict:
    points = points or [
        ("1000.000", "1000.100"),
        ("500.000", "499.600"),
        ("200.000", "200.300"),
    ]
    return {
        "device_no": device,
        "check_date": day,
        "points": [{"standard": s, "measured": m} for s, m in points],
    }


async def _scale_count() -> int:
    from app.db import engine

    async with AsyncSession(engine) as s:
        return (await s.execute(text("SELECT count(*) FROM scale_checks"))).scalar_one()


async def test_healthz(client_fixture, clean_scale) -> None:
    assert client_fixture.get("/healthz").json() == {"status": "ok"}


async def test_create_passing_scale_check_and_restore(client_fixture, clean_scale) -> None:
    resp = client_fixture.post(SCALE_URL, json=scale_payload("DC-01", "2026-09-13"))
    assert resp.status_code == 201, resp.text
    d = resp.json()
    assert d["device_no"] == "DC-01"
    assert d["check_date"] == "2026-09-13"
    assert d["passed"] is True
    assert d["verdict"] == "合格"

    # 标准/实测规范化为三位小数；偏差带符号、实测 − 标准
    assert d["points"] == [
        {"seq": 1, "standard": "1000.000", "measured": "1000.100", "deviation": "+0.100"},
        {"seq": 2, "standard": "500.000", "measured": "499.600", "deviation": "-0.400"},
        {"seq": 3, "standard": "200.000", "measured": "200.300", "deviation": "+0.300"},
    ]

    # 同一资源查询契约：刷新后可恢复
    got = client_fixture.get(SCALE_URL).json()
    assert len(got) == 1
    assert got[0] == d


async def test_failed_check_is_still_saved_with_fail_verdict(client_fixture, clean_scale) -> None:
    # 单点超差（+0.501）：合法但不合格，照常保存并展示“不合格”
    resp = client_fixture.post(
        SCALE_URL,
        json=scale_payload(
            "DC-02",
            "2026-09-13",
            [("100.000", "100.500"), ("100.000", "99.500"), ("100.000", "100.501")],
        ),
    )
    assert resp.status_code == 201, resp.text
    d = resp.json()
    assert d["passed"] is False
    assert d["verdict"] == "不合格"
    assert [p["deviation"] for p in d["points"]] == ["+0.500", "-0.500", "+0.501"]


async def test_critical_deviation_boundary(client_fixture, clean_scale) -> None:
    # 三组偏差都恰好 ±0.500 g：临界合格
    resp = client_fixture.post(
        SCALE_URL,
        json=scale_payload(
            "DC-03",
            "2026-09-13",
            [("100.000", "100.500"), ("100.000", "99.500"), ("100.000", "100.000")],
        ),
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["passed"] is True

    # 任意一点 0.501 g 即不合格（正向与负向各验一次）
    over = client_fixture.post(
        SCALE_URL,
        json=scale_payload(
            "DC-04",
            "2026-09-13",
            [("100.000", "100.000"), ("100.000", "100.000"), ("100.000", "99.499")],
        ),
    )
    assert over.status_code == 201
    assert over.json()["passed"] is False


async def test_list_ordered_by_date_desc(client_fixture, clean_scale) -> None:
    client_fixture.post(SCALE_URL, json=scale_payload("DC-01", "2026-09-11"))
    client_fixture.post(SCALE_URL, json=scale_payload("DC-01", "2026-09-13"))
    client_fixture.post(SCALE_URL, json=scale_payload("DC-01", "2026-09-12"))

    rows = client_fixture.get(SCALE_URL).json()
    assert [(r["device_no"], r["check_date"]) for r in rows] == [
        ("DC-01", "2026-09-13"),
        ("DC-01", "2026-09-12"),
        ("DC-01", "2026-09-11"),
    ]


async def test_duplicate_device_date_conflicts_and_keeps_one(client_fixture, clean_scale) -> None:
    ok = client_fixture.post(SCALE_URL, json=scale_payload("DC-09", "2026-09-13"))
    assert ok.status_code == 201

    dup = client_fixture.post(SCALE_URL, json=scale_payload("DC-09", "2026-09-13"))
    assert dup.status_code == 409
    body = dup.json()
    assert "DC-09" in body["detail"]
    assert "2026-09-13" in body["detail"]

    # 重复提交回滚：台账里只剩第一条
    assert len(client_fixture.get(SCALE_URL).json()) == 1
    assert await _scale_count() == 1

    # 同设备不同日期、不同设备同日期都允许
    assert (
        client_fixture.post(SCALE_URL, json=scale_payload("DC-09", "2026-09-14"))
    ).status_code == 201
    assert (
        client_fixture.post(SCALE_URL, json=scale_payload("DC-10", "2026-09-13"))
    ).status_code == 201
    assert await _scale_count() == 3


async def test_invalid_inputs_rejected_without_partial_records(
    client_fixture, clean_scale
) -> None:
    bad_cases: list[tuple[str, dict, str]] = [
        ("非正标准", scale_payload("X-1", "2026-09-13", [("0", "1"), ("1", "1"), ("1", "1")]), "第 1 测点"),
        ("负实测", scale_payload("X-2", "2026-09-13", [("1", "1"), ("1", "-2"), ("1", "1")]), "第 2 测点"),
        ("标准四位小数", scale_payload("X-3", "2026-09-13", [("1", "1"), ("1", "1"), ("1.0001", "1")]), "第 3 测点"),
        ("实测非十进制", scale_payload("X-4", "2026-09-13", [("1", "x"), ("1", "1"), ("1", "1")]), "实测重量"),
        ("非法日期", scale_payload("X-5", "2026-02-30"), "日期"),
        ("错误日期格式", scale_payload("X-6", "2026/09/13"), "YYYY-MM-DD"),
    ]
    for name, payload, match in bad_cases:
        resp = client_fixture.post(SCALE_URL, json=payload)
        assert resp.status_code == 400, (name, resp.text)
        assert match in resp.json()["detail"], (name, resp.json())

    # 测点数不对（2 组 / 4 组 / 空数组）
    for points in (
        [("1", "1"), ("1", "1")],
        [("1", "1")] * 4,
        [],
    ):
        resp = client_fixture.post(SCALE_URL, json=scale_payload("X-7", "2026-09-13", points))
        assert resp.status_code == 400, resp.text

    # 空设备编号
    resp = client_fixture.post(SCALE_URL, json=scale_payload("  ", "2026-09-13"))
    assert resp.status_code == 400

    # 重量以 JSON 数字给出：strict 模式拒绝，绝不悄悄转浮点
    resp = client_fixture.post(
        SCALE_URL,
        json={
            "device_no": "X-8",
            "check_date": "2026-09-13",
            "points": [
                {"standard": 1.0, "measured": "1"},
                {"standard": "1", "measured": "1"},
                {"standard": "1", "measured": "1"},
            ],
        },
    )
    assert resp.status_code == 400

    # 测点对象多余/缺失字段：400
    resp = client_fixture.post(
        SCALE_URL,
        json={
            "device_no": "X-9",
            "check_date": "2026-09-13",
            "points": [{"standard": "1", "measured": "1", "x": 1}] * 3,
        },
    )
    assert resp.status_code == 400
    resp = client_fixture.post(
        SCALE_URL,
        json={
            "device_no": "X-10",
            "check_date": "2026-09-13",
            "points": [{"standard": "1"}] * 3,
        },
    )
    assert resp.status_code == 400

    # 所有失败请求都不留下部分记录
    assert await _scale_count() == 0
    assert client_fixture.get(SCALE_URL).json() == []


async def test_scale_checks_are_independent_of_batches(client_fixture, clean_scale) -> None:
    # 一条秤检 + 一个批次：两个资源互不引用、互不影响
    scale = client_fixture.post(SCALE_URL, json=scale_payload("DC-11", "2026-09-13"))
    assert scale.status_code == 201
    batch = client_fixture.post(
        "/api/batches",
        json={
            "batch_no": "SCL-B-1",
            "entries": {"issued": ["1000.000"], "product": ["1000.000"]},
        },
    )
    assert batch.status_code == 201, batch.text

    assert len(client_fixture.get(SCALE_URL).json()) == 1
    batches = client_fixture.get("/api/batches").json()
    assert any(b["batch_no"] == "SCL-B-1" for b in batches)

    # 批次核算的闭合结果不依赖秤检合格与否；秤检表不出现批次外键
    from app.db import engine

    async with AsyncSession(engine) as s:
        n_scale = (await s.execute(text("SELECT count(*) FROM scale_checks"))).scalar_one()
        mine = (
            await s.execute(
                text("SELECT count(*) FROM batches WHERE batch_no = :no"),
                {"no": "SCL-B-1"},
            )
        ).scalar_one()
    assert n_scale == 1
    assert mine == 1
