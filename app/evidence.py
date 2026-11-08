"""Доказательства изменения расписания: фото/скриншот, документ, голос → ТЕКСТ.

Здесь только «чтение» доказательства. Понимание (какой день, какой урок, тип
изменения), сравнение с расписанием и конфликты — на устройстве ученика
(frontend/src/lib/nlu.ts + schedule.ts): так текст и голос разбираются без
сервера и работают офлайн, а сервер нужен только там, где без него нельзя.

Фото: 1) ИИ-зрение (если задан ключ Groq) — структурные уроки + текст;
      2) Tesseract OCR (rus+eng) на сервере — если установлен;
      3) иначе честная 503: «вставь текст / скажи голосом».
Голос: Groq Whisper через multipart /audio/transcriptions. Аудио нигде не сохраняется — только в памяти
запроса. На устройстве с Web Speech API фронт распознаёт речь сам и сюда не ходит.
Уверенность (legibility 0..1) возвращается всегда: низкая → фронт не даёт применить молча.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import io
import logging
import shutil
import subprocess
from typing import Any


from app import ai_engine, metrics

logger = logging.getLogger("sferumfocus.evidence")

MAX_IMAGE_B64 = 14_000_000
MAX_IMAGE_PIXELS = 20_000_000
MAX_AUDIO_B64 = 20_000_000
MAX_DOC_B64 = 6_000_000

_OCR_PROMPT = (
    "Ты читаешь фото/скриншот школьного расписания или сообщения учителя об изменении. "
    'Верни СТРОГО JSON: {"text": дословный текст с фото построчно, '
    '"day_hint": день недели или дата, если они ЯВНО написаны на фото, иначе null, '
    '"lessons": [{"lesson_number": int|null, "subject": str, "start_time": "HH:MM"|null, '
    '"end_time": "HH:MM"|null, "room": str|null, "teacher": str|null}], '
    '"legibility": число 0..1 — насколько уверенно читается}. '
    "Не придумывай уроки, которых не видно. Если это сообщение об изменении, а не таблица — lessons: []."
)


class EvidenceError(ai_engine.AIServiceError):
    """status 422 — плохой вход (размер/формат), 503 — распознавание недоступно."""

    def __init__(self, message: str, status: int = 422) -> None:
        super().__init__(message)
        self.status = status


def tesseract_available() -> bool:
    return shutil.which("tesseract") is not None


def builtin_ocr_available() -> bool:
    """v3.2 · OCR-02: встроенный распознаватель печатного текста (Pillow + атлас глифов, без бинарников)."""
    from app import glyph_ocr
    return glyph_ocr.available()


def _decode(b64: str, limit: int) -> bytes:
    if not b64:
        raise EvidenceError("Пустой файл")
    if len(b64) > limit:
        raise EvidenceError("Файл слишком большой")
    try:
        return base64.b64decode(b64, validate=False)
    except (binascii.Error, ValueError) as exc:
        raise EvidenceError("Файл повреждён") from exc


def _prep_image(raw: bytes) -> bytes:
    """Серый + апскейл мелких скриншотов: Tesseract заметно точнее. Без декодера — безопасная ошибка, без передачи сырого файла в OCR."""
    try:
        from PIL import Image, ImageOps  # type: ignore
    except ImportError as exc:
        raise EvidenceError("OCR требует установленный Pillow", 503) from exc
    try:
        im = Image.open(io.BytesIO(raw))
        # Compressed byte limits do not bound decoded memory. Check dimensions
        # before EXIF transpose/convert triggers pixel allocation.
        width, height = im.size
        if width <= 0 or height <= 0 or width * height > MAX_IMAGE_PIXELS:
            im.close()
            raise EvidenceError(
                "Слишком большое разрешение фото — уменьши его до 20 Мп"
            )
        im = ImageOps.exif_transpose(im).convert("L")
        if max(im.size) < 1400:
            k = 1400 / max(im.size)
            im = im.resize((int(im.width * k), int(im.height * k)))
        out = io.BytesIO()
        im.save(out, format="PNG")
        return out.getvalue()
    except EvidenceError:
        raise
    except Image.DecompressionBombError as exc:
        raise EvidenceError("Слишком большое разрешение фото") from exc
    except Exception as exc:  # noqa: BLE001 — не передаём непроверенные байты в OCR
        raise EvidenceError("Не удалось прочитать изображение") from exc


def ocr_tesseract(raw: bytes) -> tuple[str, float]:
    """(текст, средняя уверенность 0..1) по TSV-выводу Tesseract."""
    img = _prep_image(raw)
    try:
        r = subprocess.run(
            ["tesseract", "stdin", "stdout", "-l", "rus+eng", "--psm", "6", "tsv"],
            input=img,
            capture_output=True,
            timeout=40,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise EvidenceError(
            "OCR не ответил — попробуй ещё раз или вставь текст", 503
        ) from exc
    if r.returncode != 0:
        raise EvidenceError("Не удалось прочитать изображение")
    lines: dict[tuple[int, int, int], list[str]] = {}
    confs: list[float] = []
    for row in r.stdout.decode("utf-8", "replace").splitlines()[1:]:
        cols = row.split("\t")
        if len(cols) < 12 or not cols[11].strip():
            continue
        try:
            conf = float(cols[10])
        except ValueError:
            continue
        if conf < 0:
            continue
        confs.append(conf)
        lines.setdefault((int(cols[2]), int(cols[3]), int(cols[4])), []).append(
            cols[11]
        )
    text = "\n".join(" ".join(ws) for _, ws in sorted(lines.items()))
    legibility = round(sum(confs) / len(confs) / 100, 2) if confs else 0.0
    return text.strip(), legibility


def _clean_lessons(raw: Any) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for it in raw if isinstance(raw, list) else []:
        if not isinstance(it, dict) or not str(it.get("subject") or "").strip():
            continue
        n = it.get("lesson_number")
        out.append(
            {
                "lesson_number": n if isinstance(n, int) and 1 <= n <= 8 else None,
                "subject": str(it["subject"]).strip()[:60],
                "start_time": it.get("start_time")
                if isinstance(it.get("start_time"), str)
                else None,
                "end_time": it.get("end_time")
                if isinstance(it.get("end_time"), str)
                else None,
                "room": str(it["room"])[:20] if it.get("room") else None,
                "teacher": str(it["teacher"])[:60] if it.get("teacher") else None,
            }
        )
    return out[:10]


async def read_image(
    b64: str, mime: str | None, hint: str | None, user_id: str = ""
) -> dict[str, Any]:
    raw = _decode(b64, MAX_IMAGE_B64)
    if ai_engine.has_vision():
        # v15: тот же скриншот тем же пользователем — без повторного вызова ИИ.
        key = ai_engine._cache_key(
            "ocr", user_id, hashlib.sha256(raw).hexdigest(), (hint or "")[:200]
        )  # noqa: SLF001
        cached = ai_engine.cache_get(key)
        metrics.cache("ocr", cached is not None)
        if cached is not None:
            return dict(cached)
        try:
            safe = (mime or "image/jpeg").split(";")[0].strip() or "image/jpeg"
            content: list[dict[str, Any]] = [
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:{safe};base64,{b64}"},
                },
                {
                    "type": "text",
                    "text": "Комментарий ученика: " + (hint or "нет")[:200],
                },
            ]
            out = ai_engine._extract_json(
                await ai_engine._chat(  # noqa: SLF001 — общий клиент
                    [
                        {"role": "system", "content": _OCR_PROMPT},
                        {"role": "user", "content": content},
                    ],
                    json_mode=True,
                    temperature=0.0,
                    max_tokens=900,
                    rate_key=user_id,
                    feature="ocr",
                )
            )
            if not isinstance(out, dict):
                raise ai_engine.HomeworkParseError("OCR: ответ не объект")
            if isinstance(out, dict):
                try:
                    leg = max(0.0, min(1.0, float(out.get("legibility", 0.6))))
                except (TypeError, ValueError):
                    leg = 0.6
                res = {
                    "engine": "ai",
                    "text": str(out.get("text") or "")[:4000],
                    "lessons": _clean_lessons(out.get("lessons")),
                    "day_hint": str(out["day_hint"])[:40]
                    if out.get("day_hint")
                    else None,
                    "legibility": leg,
                }
                ai_engine.cache_put(key, res, ai_engine.CACHE_TTL_PARSE)
                return res
        except ai_engine.RateLimitError:
            raise
        except ai_engine.AIServiceError as exc:
            logger.warning(
                "read_image: ИИ недоступен (%s), пробуем Tesseract",
                ai_engine.failure_reason(exc),
            )
            ai_engine._note_fallback("ocr", exc)  # noqa: SLF001
    else:
        ai_engine._note_fallback("ocr", None)  # noqa: SLF001
    if tesseract_available():
        metrics.rules("ocr_tesseract")
        from app.ocr_pool import recognize, OCRBusy, OCRUnavailable
        try:
            text, leg = await recognize(raw)
        except OCRBusy as exc:
            raise EvidenceError("Все места распознавания заняты — попробуй чуть позже или вставь текст", 503) from exc
        except OCRUnavailable as exc:
            raise EvidenceError("Фото не удалось прочитать вовремя — попробуй ещё раз или вставь текст", 503) from exc
        return {
            "engine": "tesseract",
            "text": text[:4000],
            "lessons": [],
            "day_hint": None,
            "legibility": leg,
        }
    # v3.2 · OCR-02: без tesseract и без ИИ — встроенный детерминированный распознаватель печатного текста
    # (app/glyph_ocr.py). Низкая уверенность честно уходит во фронт: применить молча такой текст нельзя.
    if builtin_ocr_available():
        metrics.rules("ocr_builtin")
        from app import glyph_ocr
        try:
            res = await asyncio.wait_for(asyncio.to_thread(glyph_ocr.recognize, raw), timeout=8)
        except (ValueError, OSError) as exc:
            raise EvidenceError("Файл не похож на фото — пришли снимок или скриншот", 422) from exc
        except asyncio.TimeoutError as exc:
            raise EvidenceError("Фото не удалось прочитать вовремя — попробуй ещё раз или вставь текст", 503) from exc
        return {"engine": res["engine"], "text": res["text"][:4000], "lessons": [], "day_hint": None,
                "legibility": res["legibility"]}
    raise EvidenceError(
        "Распознавание фото на сервере не настроено. Вставь текст расписания или скажи голосом.",
        503,
    )


def read_document(b64: str, mime: str | None) -> dict[str, Any]:
    raw = _decode(b64, MAX_DOC_B64)
    m = (mime or "").lower()
    if m.startswith("text/") or m in ("", "application/octet-stream"):
        for enc in ("utf-8", "cp1251"):
            try:
                return {
                    "engine": "text",
                    "text": raw.decode(enc)[:6000],
                    "lessons": [],
                    "day_hint": None,
                    "legibility": 1.0,
                }
            except UnicodeDecodeError:
                continue
    if m == "application/pdf":
        try:
            from pypdf import PdfReader  # type: ignore
        except ImportError as exc:
            raise EvidenceError(
                "PDF на сервере не читается — сделай скриншот страницы"
            ) from exc
        try:
            text = "\n".join(
                (pg.extract_text() or "") for pg in PdfReader(io.BytesIO(raw)).pages[:3]
            )
        except Exception as exc:  # noqa: BLE001
            raise EvidenceError("PDF повреждён") from exc
        return {
            "engine": "pdf",
            "text": text[:6000],
            "lessons": [],
            "day_hint": None,
            "legibility": 0.9 if text.strip() else 0.0,
        }
    if m.startswith("image/"):
        raise EvidenceError("Это изображение — отправь его как фото")
    raise EvidenceError(
        "Формат не поддерживается: пришли фото, скриншот, PDF или текст"
    )


async def transcribe(b64: str, mime: str | None, user_id: str = "") -> dict[str, Any]:
    """Голос → текст. Аудио не сохраняется. Без ключа ИИ — честная 503 (фронт предложит текст)."""
    _decode(b64, MAX_AUDIO_B64)
    if not ai_engine.has_stt():
        raise EvidenceError(
            "Распознавание речи на сервере недоступно — напиши текстом", 503
        )
    text = await ai_engine.transcribe_audio(b64, mime, user_id=user_id)
    return {"engine": "ai", "text": text.strip().strip('"')[:1000]}
