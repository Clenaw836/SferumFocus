"""v3.0 · HTTP-контракт черновика: фото → строки с рамками → правка учеником → проверка шагов с рамкой ошибки.

POST /api/v1/ocr/draft  {base64, mime, hint}           — распознавание (Tesseract офлайн; Vision закрыт шлюзом К1)
POST /api/v1/ocr/check  {lines, boxes?, width?, height?} — первая ошибка в шагах + рамка {x,y,w,h} в долях кадра

Фото и текст не сохраняются. Ответ задачи не выдаётся — только «где ошибка» (сократовский принцип).
"""
from __future__ import annotations

import asyncio
from typing import Annotated

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from app import ocr_engine

router = APIRouter(prefix="/api/v1/ocr", tags=["ocr"])


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class DraftBody(_Strict):
    base64: str = Field(min_length=8, max_length=14_000_000)
    mime: str = Field(default="image/jpeg", pattern=r"^image/(jpeg|png|webp|heic|heif)$")
    hint: str = Field(default="", max_length=300)


class CheckBody(_Strict):
    lines: list[Annotated[str, Field(max_length=400)]] = Field(min_length=1, max_length=ocr_engine.MAX_LINES)
    boxes: list[list[float] | None] | None = Field(default=None, max_length=ocr_engine.MAX_LINES)
    width: int | None = Field(default=None, ge=1, le=20_000)
    height: int | None = Field(default=None, ge=1, le=20_000)


def _err(exc: ocr_engine.OcrError) -> JSONResponse:
    return JSONResponse({"detail": exc.message, "code": exc.code, "error_code": exc.code}, status_code=exc.status)


@router.post("/draft")
async def ocr_draft(body: DraftBody):
    try:
        return await ocr_engine.read_draft(body.base64, body.mime, body.hint)
    except ocr_engine.OcrError as exc:
        return _err(exc)


@router.post("/check")
async def ocr_check(body: CheckBody):
    lines = [x[: ocr_engine.MAX_LINE_CHARS] for x in body.lines]
    boxes = [b if b is None or len(b) == 4 else None for b in (body.boxes or [])]
    try:
        return await asyncio.to_thread(ocr_engine.check_steps, lines, boxes, body.width, body.height)
    except ocr_engine.OcrError as exc:
        return _err(exc)
