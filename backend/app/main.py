"""FastAPI 入口：分区称重提交、称重文件导入预检、批次列表、可复算详情。"""

from __future__ import annotations

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from .calc import WeightValidationError
from .db import get_session, init_db
from .importer import ImportRejectedError, preview_import
from .schemas import (
    BatchCompare,
    BatchDetail,
    BatchIn,
    BatchSummary,
    ImportPreviewIn,
    ImportPreviewOut,
)
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


@app.exception_handler(ImportRejectedError)
async def _import_rejected_handler(
    request: Request, exc: ImportRejectedError
) -> JSONResponse:
    # 整份拒绝：给出 CSV 行号（文件级错误为 null）与原因，供页面定位
    return JSONResponse(
        status_code=400,
        content={"detail": str(exc), "line": exc.line, "reason": exc.reason},
    )


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/batches", response_model=BatchDetail, status_code=201)
async def post_batch(
    payload: BatchIn, session: AsyncSession = Depends(get_session)
) -> BatchDetail:
    return await create_batch(session, payload.batch_no.strip(), payload.entries)


@app.post("/api/batches/import-preview", response_model=ImportPreviewOut)
async def post_import_preview(payload: ImportPreviewIn) -> ImportPreviewOut:
    """称重文件预检：解析 CSV 并返回规范化行与核算预览，不写数据库。

    用户在页面确认后，仍通过 POST /api/batches 提交保存。
    """

    return preview_import(payload.content)


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
