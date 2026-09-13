"""FastAPI 入口：分区称重提交、批次列表、可复算详情。"""

from __future__ import annotations

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from .calc import WeightValidationError
from .db import get_session, init_db
from .schemas import BatchCompare, BatchDetail, BatchIn, BatchSummary
from .service import (
    BatchNotFoundError,
    DuplicateBatchError,
    SelfCompareError,
    compare_batches,
    create_batch,
    get_batch,
    list_batches,
)

app = FastAPI(title="试烧窑批次核算站", version="1.0.0")


@app.on_event("startup")
async def _startup() -> None:
    await init_db()


@app.exception_handler(WeightValidationError)
async def _weight_error_handler(request: Request, exc: WeightValidationError) -> JSONResponse:
    # 语义非法：400 整体拒绝（事务已回滚，不留记录）
    return JSONResponse(status_code=400, content={"detail": str(exc)})


@app.exception_handler(RequestValidationError)
async def _validation_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    return JSONResponse(
        status_code=400,
        content={"detail": "请求格式不合法", "errors": jsonable_encoder(exc.errors())},
    )


@app.exception_handler(DuplicateBatchError)
async def _duplicate_handler(request: Request, exc: DuplicateBatchError) -> JSONResponse:
    return JSONResponse(status_code=409, content={"detail": str(exc)})


@app.exception_handler(BatchNotFoundError)
async def _batch_not_found_handler(request: Request, exc: BatchNotFoundError) -> JSONResponse:
    # 明确给出缺失的是当前批次还是基准批次以及其标识
    return JSONResponse(status_code=404, content={"detail": str(exc)})


@app.exception_handler(SelfCompareError)
async def _self_compare_handler(request: Request, exc: SelfCompareError) -> JSONResponse:
    return JSONResponse(status_code=400, content={"detail": str(exc)})


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/batches", response_model=BatchDetail, status_code=201)
async def post_batch(
    payload: BatchIn, session: AsyncSession = Depends(get_session)
) -> BatchDetail:
    return await create_batch(session, payload.batch_no.strip(), payload.entries)


@app.get("/api/batches", response_model=list[BatchSummary])
async def get_batches(session: AsyncSession = Depends(get_session)) -> list[BatchSummary]:
    return await list_batches(session)


@app.get("/api/batches/{batch_id}", response_model=BatchDetail)
async def get_one(batch_id: int, session: AsyncSession = Depends(get_session)) -> BatchDetail:
    detail = await get_batch(session, batch_id)
    if detail is None:
        raise HTTPException(status_code=404, detail="批次不存在")
    return detail


@app.get("/api/batches/{batch_id}/compare", response_model=BatchCompare)
async def compare(
    batch_id: int, base_id: int, session: AsyncSession = Depends(get_session)
) -> BatchCompare:
    return await compare_batches(session, batch_id, base_id)
