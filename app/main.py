"""FastAPI-приложение «СферумФокус»: 15 роутов фронта + /health + статика.

Каждый роут реализует ровно тот контракт, который читает index.html
(версия v6.2). Роль определяет только сервер: проверенная подпись MAX + справочник школы
(или одноразовое приглашение учителя, app.teacher_invites), либо подписанный токен демо-песочницы.
Заголовки клиента X-User-Id / X-User-Role доказательством личности или прав не являются;
общий TEACHER_TOKEN / X-Teacher-Token удалён (v2.4 Step 1).

Ошибки ИИ-слоя обрабатываются ГЛОБАЛЬНО (exception handlers ниже):
RateLimitError → 429 с Retry-After, ContentFlaggedError → 422-предупреждение
(задание/опрос не засчитываются), HomeworkParseError → 422,
AIServiceError → 503. Роуты проверяют только собственные 400/413/503-кейсы.

Оценка времени заданий: process-media отдаёт planned_minutes из
нормативной таблицы (класс × предмет × число единиц, см. academic.py);
нецензурный ввод → 422 с предупреждением, задание в список д/з не попадает.

Блиц-дуэль: три источника вопросов — ИИ (Active Recall), фото параграфа
(blitz-quiz) и свой опрос ученика (blitz-quiz-manual: ИИ нормализует
черновик, без ключа — детерминированный парсер «* верный»).

Прогресс: POST /progress/event — события фронта (задание выполнено,
дуэль закрыта, план собран, шпаргалка) → стрик/очки/достижения;
GET /my-week — «Моя неделя» ученика. Rate-limit ИИ → честный 429.
"""
from __future__ import annotations

from starlette.concurrency import run_in_threadpool

import hmac
import base64
import json
import secrets
import hashlib
import re
import os
import time

import logging
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response

from app import ai_engine, day_engine, diary_service, evidence, focus_remind, metrics, mock_diary, progress, rewards, schedule, schedule_feed, scheduler, teacher, teacher_mode
from app import __release__, __version__
from app.ephemeral import ResourceLimitError, ResourceOwnerError
from app.config import MAX_AUTH_MAX_AGE, MAX_BOT_NAME, MAX_BOT_TOKEN, MAX_REQUIRE_AUTH, TEACHER_MAX_IDS
from app.max_auth import MaxAuthMiddleware, auth_mode
from app import demo_sandbox
from app.socratic_guide import guide_for
from app.demo_sandbox import DemoSandboxGate
from app.deployment import DeploymentPolicy, DeploymentGate, classify_errors, max_reason_class
from app.models import (CloseQuizCheckRequest, CloseQuizStartRequest, ScheduleBuilderRequest,
    BlitzRequest, BlitzResponse, CalculateRequest, Capabilities, CalculateResponse,
    DayScheduleResponse, FlashcardRequest, FocusReminderRequest, FocusReminderResponse, FlashcardResponse, HeatmapResponse,
    HintRequest, HintResponse, InitialState, ManualQuizRequest, MediaRequest,
    MediaResponse, MyWeekResponse, ProgressEventRequest, QuizRequest,
    QuizResponse, TriageRequest, TriageResponse,
    EvidenceImageRequest, EvidenceRead, ScheduleSyncRequest, TranscribeRequest, TranscribeResponse,
    ClientMetricsRequest, ScheduleImportConfirmRequest, ScheduleImportPreviewRequest,
)
from datetime import date as _date, timedelta as _timedelta

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("sferumfocus")

from contextlib import asynccontextmanager
import asyncio
from app.platform_auth import PlatformAuthMiddleware, enabled as platform_enabled

@asynccontextmanager
async def platform_lifespan(app):
    task = None
    if platform_enabled() and os.getenv("ENABLE_DIARY_WATCHER", "").lower() in {"1", "true"}:
        from app.diary_worker import run
        task = asyncio.create_task(run())
    try:
        from app.max_webhook import webhook_lifespan
        async with webhook_lifespan(app):
            yield
    finally:
        from app.ocr_pool import shutdown as shutdown_ocr
        shutdown_ocr()
        if task:
            task.cancel()
            try: await task
            except asyncio.CancelledError: pass

def _api_docs_enabled() -> bool:
    """R-12 / P0-03: Swagger, ReDoc и openapi.json — только в профилях demo/test, в production никогда.
    SFERUM_API_DOCS=0 скрывает их и на стенде."""
    if os.getenv("SFERUM_API_DOCS", "").strip().lower() in {"0", "false", "no", "off"}:
        return False
    return os.getenv("SFERUM_ENV", "production").strip().lower() in {"demo", "test"}


_DOCS = _api_docs_enabled()
app = FastAPI(title="СферумФокус API", version=__version__, lifespan=platform_lifespan,
              docs_url="/docs" if _DOCS else None, redoc_url="/redoc" if _DOCS else None,
              openapi_url="/openapi.json" if _DOCS else None)
from app.platform_routes import router as platform_router
app.include_router(platform_router)
from app.sandbox_page import router as sandbox_router
app.include_router(sandbox_router)
from app.max_webhook import router as max_webhook_router
app.include_router(max_webhook_router)
# v2: живая демо-песочница жюри + блиц-опросы/смешанный класс. До assignment_router:
# у него есть catch-all /student/assignments/{id}/{action}.
from app.demo_routes import router as demo_router
app.include_router(demo_router)
from app.teacher_report_routes import router as teacher_report_router
app.include_router(teacher_report_router)
from app.teacher_toolkit_routes import router as teacher_toolkit_router
app.include_router(teacher_toolkit_router)
from app.class_routes import router as class_router
app.include_router(class_router)
# v2.4 Step 1: одноразовые приглашения учителя вместо общего TEACHER_TOKEN.
from app.teacher_invite_routes import router as teacher_invite_router  # noqa: E402
app.include_router(teacher_invite_router)
# Recovery 2: teacher -> individual student assignments (server timer, history).
from app.assignment_routes import router as assignment_router
app.include_router(assignment_router)
# v2.1: /api/v1/health/deep и учения SWR «СГО упал» — телеметрия жюри; обычный /api/* (те же слои входа).
from app.deep_health import router as deep_health_router
app.include_router(deep_health_router)
# v3.0: «Практикумы СферумФокус» — развилка предмета, каталог, лаборатории, карта освоения, квиз-опросы.
from app.practicum_routes import router as practicum_router  # noqa: E402
app.include_router(practicum_router)
# v3.0: черновик — OCR (Tesseract офлайн, Vision закрыт шлюзом К1) и проверка шагов с рамкой ошибки.
from app.ocr_routes import router as ocr_router  # noqa: E402
app.include_router(ocr_router)
# v3.2: учитель ↔ СГО — нагрузка, журнал, предпросмотр/выгрузка ДЗ и оценок (запись — только SGO_TEACHER_WRITE=1 + confirm).
from app.sgo_teacher_client import router as sgo_teacher_router  # noqa: E402
app.include_router(sgo_teacher_router)

# Production is fail-closed; demo/test must be explicitly selected.
# Configuration is selected once at startup, before handling signed launch data.
if os.getenv('TELEGRAM_BOT_TOKEN') and not platform_enabled():
    from app.auth_diagnostics import report as _auth_report
    _auth_report('legacy_max_selected_for_telegram')
from app.config import ENV_FILE_REPORT
deployment_policy = DeploymentPolicy(env_file=ENV_FILE_REPORT)
# ENV-01: одна строка журнала при старте — что приложение реально получило (repr несекретных значений,
# источник: окружение процесса/.env и номера строк). journalctl -u sferumfocus -b | grep deployment_config
(logger.warning if deployment_policy.errors() else logger.info)("%s", deployment_policy.startup_line())
# v2.3.2 · ЕСИА: одна строка о состоянии провайдера (disabled|misconfigured|awaiting_official_credentials|ready),
# только имена переменных, без значений. Сети нет.
from app.esia_provider import log_startup_state as _esia_startup
_esia_startup(logger)
# v2.3.2 · Единый конверт ошибок {detail, code, error_code, retry_after?} + no-store/Retry-After.
from app.api_errors import install as _install_coded_errors
_install_coded_errors(app)
# v2.1: какой транспорт получил Groq — адрес прокси без логина/пароля, причина отказа без значения.
from app.config import GROQ_PROXY_ERROR as _GROQ_PROXY_ERROR, GROQ_PROXY_LABEL as _GROQ_PROXY_LABEL
if _GROQ_PROXY_ERROR:
    logger.warning("groq_transport proxy=off reason=GROQ_PROXY_URL_%s", _GROQ_PROXY_ERROR)
else:
    logger.info("groq_transport proxy=%s", _GROQ_PROXY_LABEL or "off")
_CORS = deployment_policy.cors
# v2: DemoSandboxGate оборачивает прежний слой входа. Без X-Demo-Session запрос идёт в него без изменений
# (кроме того, что пространство идентификаторов «demo:» клиенту недоступно); с валидным токеном песочницы
# личность и роль задаёт только подписанный сервером токен.
app.add_middleware(DemoSandboxGate, auth=PlatformAuthMiddleware if platform_enabled() else MaxAuthMiddleware,
                   bot_token=MAX_BOT_TOKEN, required=MAX_REQUIRE_AUTH, max_age=MAX_AUTH_MAX_AGE)
from app.config import LEGACY_TEACHER_TOKEN_PRESENT as _LEGACY_TEACHER_TOKEN
if _LEGACY_TEACHER_TOKEN:
    # v2.4 Step 1: the shared teacher token no longer protects anything (production refuses to start the API).
    logger.warning("TEACHER_TOKEN задан, но общий токен учителя удалён и игнорируется: используйте "
                   "одноразовые приглашения (scripts/teacher_invites.py)")
if auth_mode(MAX_BOT_TOKEN, MAX_REQUIRE_AUTH) == "verified" and not platform_enabled():
    # v18.1 (D-06): «токен есть, подпись не обязательна» выглядит защищённым, но пускает неподписанных как демо
    logger.warning("MAX_BOT_TOKEN задан, но MAX_REQUIRE_AUTH=0: запросы без подписи MAX принимаются как демо "
                   "(X-User-Id клиента). Для прода задайте MAX_REQUIRE_AUTH=1.")
app.add_middleware(
    CORSMiddleware,
    allow_origins=_CORS,
    allow_credentials="*" not in _CORS,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    expose_headers=["X-Idempotency-Replayed", "X-Error-Domain"],
    allow_headers=(["Content-Type", "X-Max-Init-Data", "X-Telegram-Init-Data", "X-Web-Bootstrap", "X-CSRF-Token", "Accept", "X-Idempotency-Key", "X-Demo-Session"]
                   if deployment_policy.production else ["*"]),
)
app.add_middleware(DeploymentGate, policy=deployment_policy)
# v16: сжатие ответов (бандл ~430 КБ → ~130 КБ по сети). Маленькие JSON не трогаем.
app.add_middleware(GZipMiddleware, minimum_size=1024)

def _security_extras(path: str) -> list[tuple[bytes, bytes]]:
    """Заголовки безопасности для КАЖДОГО ответа (включая 500 из ServerErrorMiddleware — см. _unhandled_error)."""
    extras = [(b"x-content-type-options", b"nosniff"),
              (b"referrer-policy", b"no-referrer"),
              (b"content-security-policy", _content_security_policy().encode("ascii")),
              # v3.2.1 · камера (фото ДЗ) и микрофон (голосовой ввод) — только своему origin.
              (b"permissions-policy", b"camera=(self), microphone=(self), geolocation=(), payment=(), usb=()")]
    # v3.2.1 · HSTS: за Caddy/TLS в production; браузеры игнорируют его на http (локальная разработка).
    if os.getenv("SFERUM_ENV", "production").strip().lower() == "production":
        extras.append((b"strict-transport-security", b"max-age=31536000"))
    if path.startswith("/api/"):
        extras.append((b"cache-control", b"no-store"))
    return extras


class SecurityHeaders:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        async def secured(message):
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                names = {k.lower() for k, _ in headers}
                extras = _security_extras(scope["path"])
                if scope["path"].startswith("/api/"):
                    headers = [(k, v) for k, v in headers if k.lower() != b"cache-control"]
                    names.discard(b"cache-control")
                headers.extend((k, v) for k, v in extras if k not in names)
                message = {**message, "headers": headers}
            await send(message)
        return await self.app(scope, receive, secured)


def _body_limit() -> int:
    try:
        return max(1024, int(os.getenv("SFERUM_MAX_BODY_BYTES", str(32 * 1024 * 1024))))
    except ValueError:
        return 32 * 1024 * 1024


class _BodyTooLarge(Exception):
    pass


class BodyLimit:
    """P0-03: общий потолок тела запроса (по умолчанию 32 МиБ — выше лимита фото 20 МБ base64).
    Проверяет Content-Length и, для chunked-тел, фактически прочитанные байты."""

    def __init__(self, app, limit: int):
        self.app, self.limit = app, limit

    async def _reject(self, send) -> None:
        body = json.dumps({"detail": "Слишком большой запрос", "reason_code": "body_too_large", "limit_bytes": self.limit},
                          ensure_ascii=False).encode()
        await send({"type": "http.response.start", "status": 413,
                    "headers": [(b"content-type", b"application/json; charset=utf-8"), (b"content-length", str(len(body)).encode())]})
        await send({"type": "http.response.body", "body": body})

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] in ("GET", "HEAD", "OPTIONS"):
            return await self.app(scope, receive, send)
        for k, v in scope.get("headers", []):
            if k.lower() == b"content-length":
                try:
                    if int(v) > self.limit:
                        return await self._reject(send)
                except ValueError:
                    return await self._reject(send)
        seen, started, rejected = 0, False, False

        async def limited():
            # Chunked body over the limit: answer 413 right here and tell the app the client is gone.
            # Raising instead would be re-wrapped by FastAPI's body parser (400) or by an inner error
            # middleware (500); whatever the app sends after that is dropped by ``tracked``.
            nonlocal seen, rejected
            if rejected:
                return {"type": "http.disconnect"}
            message = await receive()
            if message["type"] == "http.request":
                seen += len(message.get("body", b""))
                if seen > self.limit:
                    rejected = True
                    if not started:
                        await self._reject(send)
                    raise _BodyTooLarge()
            return message

        async def tracked(message):
            nonlocal started
            if rejected:
                return
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, limited, tracked)
        except Exception:  # noqa: BLE001 — after a 413 the app's own failure is irrelevant
            if not rejected:
                raise


# P0 MAX: обезличенные сигналы ES5-сторожа загрузки — снаружи слоёв авторизации (личность не нужна и не принимается),
# но внутри BodyLimit/SecurityHeaders. См. app/boot_diagnostics.py.
from app.boot_diagnostics import BootDiagnostics
app.add_middleware(BootDiagnostics)
app.add_middleware(BodyLimit, limit=_body_limit())
app.add_middleware(SecurityHeaders)


STATIC_DIR = Path(__file__).resolve().parent / "static"
INDEX_FILE = STATIC_DIR / "index.html"

# --------------------- глобальные обработчики ИИ-ошибок ---------------------
# Порядок MRO: ContentFlaggedError → HomeworkParseError → AIServiceError.
# Starlette выбирает самый специфичный зарегистрированный класс, поэтому
# модерация даёт 422-предупреждение, а не общий 503.

@app.exception_handler(ai_engine.RateLimitError)
async def _rate_limit_handler(
    request: Request, exc: ai_engine.RateLimitError,
) -> JSONResponse:
    return JSONResponse(
        {"detail": str(exc)},
        status_code=429,
        headers={"Retry-After": str(exc.retry_after)},
    )

@app.exception_handler(ai_engine.ContentFlaggedError)
async def _content_flagged_handler(
    request: Request, exc: ai_engine.ContentFlaggedError,
) -> JSONResponse:
    return JSONResponse(
        {"detail": f"Предупреждение: не засчитано — {exc.reason}. "
                   "Исправь и попробуй снова."},
        status_code=422,
    )

@app.exception_handler(ai_engine.HomeworkParseError)
async def _homework_parse_handler(
    request: Request, exc: ai_engine.HomeworkParseError,
) -> JSONResponse:
    return JSONResponse({"detail": str(exc)}, status_code=422)

@app.exception_handler(evidence.EvidenceError)
async def _evidence_handler(request: Request, exc: evidence.EvidenceError) -> JSONResponse:
    return JSONResponse({"detail": str(exc)}, status_code=exc.status)

@app.exception_handler(ai_engine.AIServiceError)
async def _ai_service_handler(
    request: Request, exc: ai_engine.AIServiceError,
) -> JSONResponse:
    return JSONResponse({"detail": str(exc)}, status_code=503)

@app.exception_handler(ResourceLimitError)
async def resource_limit_error(request: Request, exc: ResourceLimitError):
    return JSONResponse(status_code=429, content={"detail": str(exc)})

@app.exception_handler(ResourceOwnerError)
async def resource_owner_error(request: Request, exc: ResourceOwnerError):
    return JSONResponse(status_code=409, content={"detail": "Ключ временного ресурса занят"})

@app.exception_handler(Exception)
async def _unhandled_error(request: Request, exc: Exception) -> JSONResponse:
    """P0-03: непредвиденная ошибка → JSON с error_id (без трассировки и данных запроса наружу)."""
    error_id = secrets.token_hex(6)
    route = request.scope.get("route")
    logger.error("unhandled_error id=%s method=%s route=%s type=%s", error_id, request.method,
                 getattr(route, "path", "?"), type(exc).__name__)
    # Обработчик Exception работает в ServerErrorMiddleware — СНАРУЖИ SecurityHeaders: заголовки ставим сами.
    headers = {k.decode(): v.decode() for k, v in _security_extras(request.url.path)}
    headers["Cache-Control"] = "no-store"
    return JSONResponse(status_code=500, content={"detail": "Внутренняя ошибка сервера. Повторите чуть позже.",
                                                  "error_id": error_id, "reason_code": "internal_error"},
                        headers=headers)


@app.exception_handler(RecursionError)
async def _too_deep(request: Request, exc: RecursionError) -> JSONResponse:
    """v3.2.1 · JSON с вложенностью ~1000+ уровней: json.loads → RecursionError. Это ошибка клиента (400), не 500."""
    logger.info("request_rejected reason=json_too_deep method=%s", request.method)
    return JSONResponse(status_code=400, content={"detail": "Слишком глубокая вложенность JSON",
                                                  "reason_code": "json_too_deep"})


@app.exception_handler(progress.IdempotencyConflict)
async def idempotency_conflict(request: Request, exc: progress.IdempotencyConflict):
    return JSONResponse(status_code=409, content={"detail": str(exc)})

def _mutation_key(request: Request) -> str | None:
    values = request.headers.getlist("x-idempotency-key")
    if not values:
        if deployment_policy.production:
            raise HTTPException(428, "Для изменения нужен X-Idempotency-Key (UUIDv4)")
        return None  # Explicit demo/test legacy compatibility only.
    if len(values) != 1:
        raise HTTPException(422, "Нужен один X-Idempotency-Key")
    try:
        return progress.validate_mutation_key(values[0])
    except progress.IdempotencyKeyError as exc:
        raise HTTPException(422, str(exc)) from exc

def _mutation(request: Request, response: Response, endpoint: str, body: dict, operation):
    key = _mutation_key(request)
    try:
        if key is None:
            return operation()
        uid = request.headers.get("x-user-id", "demo-user")
        result, replayed = progress.STORE.mutation(uid, endpoint, key, body, operation)
    except OSError as exc:
        logger.error("Mutation storage unavailable: %s", type(exc).__name__)
        raise HTTPException(503, "Не удалось надёжно сохранить результат. Повтори запрос с тем же ключом.") from exc
    response.headers["X-Idempotency-Replayed"] = "true" if replayed else "false"
    return result

@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}

@app.get("/ready")
async def readiness():
    result = deployment_policy.readiness()
    if os.getenv('MAX_BOT_MODE', 'disabled') == 'webhook':
        status = getattr(app.state, 'max_subscription_status', 'not_started')
        result['max_webhook'] = {'subscription': status,
            'reason': getattr(app.state, 'max_subscription_reason', None),
            'live_delivery_verified': False}
        result['max_webhook']['reason_class'] = max_reason_class(status, result['max_webhook']['reason'])
        if status not in {'registered', 'operator_managed'}:
            result['errors'].append('max_subscription_not_ready')
            result['status'] = 'not_ready'
            result['error_classes'] = classify_errors(result['errors'])
    return JSONResponse(status_code=503 if result["errors"] else 200, content=result)

@app.get("/api/v1/metrics")
async def metrics_snapshot() -> dict:
    """v15: счётчики ИИ-вызовов, фоллбеков, кэша, токенов и задержек (без user id и текстов)."""
    return metrics.snapshot()

@app.get("/api/v1/webapp/capabilities", response_model=Capabilities)
async def capabilities() -> dict:
    """Что доступно на сервере: фронт честно выключает фото-режимы без ключа ИИ."""
    return {"ai": ai_engine.has_key(), "bot": bool(MAX_BOT_TOKEN), "version": __version__, "release": __release__,
            "auth": "required" if (MAX_REQUIRE_AUTH and MAX_BOT_TOKEN) else ("verified" if MAX_BOT_TOKEN else "demo"),
            "bot_name": MAX_BOT_NAME or None,
            "ocr": ai_engine.has_vision() or evidence.tesseract_available() or evidence.builtin_ocr_available(), "stt": ai_engine.has_stt(),
            "school_tz": schedule_feed.school_tz(), "schedule_demo": schedule_feed.demo_enabled(),
            "demo_sandbox": demo_sandbox.enabled(), "teacher_ai": ai_engine.has_key()}

_INDEX_CACHE: dict[str, Any] = {}


def _index_bytes() -> tuple[bytes, bytes, str] | None:
    """v17.1 (PERFORMANCE_BASELINE): index.html (~540 КБ) раньше сжимался GZipMiddleware на КАЖДЫЙ
    запрос — ~30 мс CPU сервера. Теперь gzip один раз на версию файла (mtime) + ETag → 304."""
    import gzip as _gz
    import hashlib as _hl
    try:
        st = INDEX_FILE.stat()
    except OSError:
        return None
    key = f"{st.st_mtime_ns}:{st.st_size}"
    if _INDEX_CACHE.get("key") != key:
        raw = INDEX_FILE.read_bytes()
        _INDEX_CACHE.update(key=key, raw=raw, gz=_gz.compress(raw, 6, mtime=0), etag='"' + _hl.sha256(raw).hexdigest()[:20] + '"')
    return _INDEX_CACHE["raw"], _INDEX_CACHE["gz"], _INDEX_CACHE["etag"]


def _content_security_policy() -> str:
    got = _index_bytes()
    raw = got[0] if got else b""
    key = got[2] if got else "missing"
    if _INDEX_CACHE.get("csp_key") != key:
        # Exact hashes permit this shipped inline bundle, not arbitrary inline JS.
        hashes = ["'sha256-" + base64.b64encode(hashlib.sha256(s).digest()).decode() + "'"
                  for s in re.findall(rb"<script\b[^>]*>(.*?)</script\s*>", raw, re.I | re.S) if s.strip()]
        policy = ("default-src 'self'; base-uri 'none'; object-src 'none'; "
                  "script-src 'self' https://st.max.ru/js/max-web-app.js https://telegram.org/js/telegram-web-app.js " + " ".join(hashes) + "; "
                  "style-src 'self' 'unsafe-inline'; font-src 'self' data:; "
                  "img-src 'self' data: blob: https:; media-src 'self' blob: data:; "
                  "connect-src 'self'; worker-src 'self' blob:; form-action 'self'; "
                  # P0 MAX: официальный max-web-app.js доверяет родительским окнам ^https://*.(max|oneme).ru —
                  # клиент MAX может встраивать мини-приложение с любого своего поддомена, не только web.max.ru.
                  "frame-ancestors 'self' https://max.ru https://*.max.ru https://*.oneme.ru https://web.telegram.org https://*.telegram.org")
        _INDEX_CACHE.update(csp_key=key, csp=policy)
    return _INDEX_CACHE["csp"]

@app.get("/favicon.ico", include_in_schema=False)
async def favicon() -> Response:
    """P0 MAX: раньше SPA-фоллбек отдавал на /favicon.ico весь index.html (2 МБ, text/html).
    Иконки нет — 204 без тела; в HTML стоит <link rel="icon" href="data:,">, браузеры её не запрашивают."""
    return Response(status_code=204, headers={"Cache-Control": "public, max-age=86400"})


FONTS_DIR = STATIC_DIR / "fonts"
_FONT_NAME = re.compile(r"sf-[a-z]+(?:-[a-z]+)*\.[0-9a-f]{8}\.woff")


@app.get("/fonts/{name}", include_in_schema=False)
async def font_file(name: str) -> Response:
    """Master v2.0 · Feature 4: OFL-шрифты «Персонализации» (scripts/build_fonts.py).
    Только имена вида sf-<имя>.<8 hex>.woff из app/static/fonts — без путей и обхода каталогов;
    имя содержит хеш содержимого, поэтому кэш «навсегда» (immutable). Иначе — честный 404, не index.html."""
    path = FONTS_DIR / name
    if not _FONT_NAME.fullmatch(name) or not path.is_file():
        return JSONResponse({"detail": "Not Found"}, status_code=404, headers={"Cache-Control": "no-store"})
    return FileResponse(path, media_type="font/woff",
                        headers={"Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff"})


ASSETS_DIR = STATIC_DIR / "assets"
# v3.2 · PERF-01: чанки сборки (frontend/build.mjs). Имя содержит хеш содержимого → кэш «навсегда».
_ASSET_NAME = re.compile(r"[A-Za-z0-9_-]{1,80}-[A-Za-z0-9]{8,12}\.(js|css|woff2)")
_ASSET_TYPES = {"js": "text/javascript; charset=utf-8", "css": "text/css; charset=utf-8", "woff2": "font/woff2"}
_ASSET_CACHE: dict[str, tuple[str, bytes, bytes | None, str]] = {}


@app.get("/assets/{name}", include_in_schema=False)
async def asset_file(name: str, request: Request) -> Response:
    """Только плоские имена вида <имя>-<хеш>.(js|css|woff2) из app/static/assets — без путей и обхода каталогов.
    JS/CSS сжимаются один раз на версию файла (gzip + ETag → 304); неизвестное имя — честный 404, не index.html."""
    m = _ASSET_NAME.fullmatch(name)
    path = ASSETS_DIR / name
    if not m or not path.is_file():
        return JSONResponse({"detail": "Not Found"}, status_code=404, headers={"Cache-Control": "no-store"})
    import gzip as _gz
    st = path.stat()
    key = f"{st.st_mtime_ns}:{st.st_size}"
    got = _ASSET_CACHE.get(name)
    if not got or got[0] != key:
        raw = path.read_bytes()
        gz = _gz.compress(raw, 6, mtime=0) if m.group(1) != "woff2" else None
        got = (key, raw, gz, '"' + hashlib.sha256(raw).hexdigest()[:20] + '"')
        if len(_ASSET_CACHE) > 256:
            _ASSET_CACHE.clear()
        _ASSET_CACHE[name] = got
    _, raw, gz, etag = got
    h = {"ETag": etag, "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff", "Vary": "Accept-Encoding"}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=h)
    if gz is not None and "gzip" in request.headers.get("accept-encoding", ""):
        return Response(gz, media_type=_ASSET_TYPES[m.group(1)], headers={**h, "Content-Encoding": "gzip"})
    return Response(raw, media_type=_ASSET_TYPES[m.group(1)], headers=h)


@app.get("/", response_class=HTMLResponse)
async def index(request: Request) -> Any:
    got = _index_bytes()
    if got:
        raw, gz, etag = got
        h = {"ETag": etag, "Cache-Control": "no-cache", "Vary": "Accept-Encoding"}
        if request.headers.get("if-none-match") == etag:
            return Response(status_code=304, headers=h)
        if "gzip" in request.headers.get("accept-encoding", ""):
            return Response(gz, media_type="text/html; charset=utf-8", headers={**h, "Content-Encoding": "gzip"})
        return Response(raw, media_type="text/html; charset=utf-8", headers=h)
    return HTMLResponse(
        "<meta charset='utf-8'><body style='background:#07070B;color:#F5F5FA;"
        "font-family:sans-serif;padding:24px'>"
        "<h2>СферумФокус: фронт не найден</h2>"
        "<p>Положи актуальный <code>index.html</code> в <code>app/static/index.html</code>"
        " и перезагрузи страницу. API и <code>/health</code> работают уже сейчас.</p>"
        "</body>",
        status_code=200,
    )

# --------------------------- initial-state ---------------------------

def _with_teacher_tasks(request: Request, state: dict, day: _date) -> dict:
    """Recovery 2: individual teacher assignments join the evening plan as source="teacher".
    Read-only merge: storage trouble never breaks the diary (the list just lacks teacher work)."""
    from app import assignments
    from app.assignment_routes import student_identity
    who = student_identity(request)
    if not who:
        return state
    try:
        tasks, infos = assignments.plan_tasks(who[0], who[1], day, {t.get("title") for t in state.get("diary_tasks", [])})
    except assignments.HwError as exc:
        logger.warning("Teacher assignments unavailable for the plan: %s", exc.detail)
        return state
    return {**state, "diary_tasks": list(state.get("diary_tasks", [])) + diary_service._annotated(tasks),  # noqa: SLF001
            "teacher_assignments": infos}


@app.get("/api/v1/webapp/initial-state", response_model=InitialState)
async def initial_state(request: Request, date: str | None = Query(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")) -> dict:
    """date — учебный день по часам ТЕЛЕФОНА (часовой пояс ученика), по умолчанию — сегодня сервера."""
    user_id = request.headers.get("x-user-id", "demo-user")
    day = _parse_day(date)
    return _with_teacher_tasks(request, diary_service.initial_state(user_id, day), day or _date.today())

def _parse_day(v: str | None) -> _date:
    try:
        return _date.fromisoformat(v) if v else _date.today()
    except ValueError:
        raise HTTPException(422, "Дата в формате ГГГГ-ММ-ДД")

# --------------------------- расписание (v13) ---------------------------

@app.get("/api/v1/schedule/week")
async def schedule_week(request: Request, start: str | None = Query(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
                        days: int = Query(default=7, ge=1, le=14)) -> dict:
    """Неделя: база провайдера (real|demo) + подтверждённые изменения ученика, с источниками."""
    return schedule.week(request.headers.get("x-user-id", "demo-user"), _parse_day(start), days)

@app.get("/api/v1/schedule/overrides")
async def schedule_overrides(request: Request) -> dict:
    return schedule.load_doc(request.headers.get("x-user-id", "demo-user"))

@app.put("/api/v1/schedule/overrides")
async def schedule_sync(body: ScheduleSyncRequest, request: Request) -> dict:
    """Синхронизация изменений с телефона (офлайн-очередь): объединение по id, без дублей."""
    return schedule.merge_changes(request.headers.get("x-user-id", "demo-user"),
                                  [c.model_dump() for c in body.changes], body.school_week)

# --------------------------- v17.1: инструменты ученика ---------------------------

@app.get("/api/v1/webapp/task-details")
async def task_details_route(request: Request, title: str = Query(min_length=1, max_length=300)) -> dict:
    """Подробности задания: источник, текст, тема урока (демо-«Сетевой город»), срок и оценка времени."""
    from app import student_tools
    uid = _uid(request)
    st = _with_teacher_tasks(request, diary_service.initial_state(uid, None), _date.today())
    hit = next((a for a in st.get("teacher_assignments", []) if a["task_title"] == title), None)
    if hit:
        return {"title": title, "subject": hit["subject"], "text": hit["instructions"] or hit["title"], "refs": [],
                "source": "Учитель" + (" · DEMO" if hit["is_demo"] else ""), "teacher": hit["teacher_name"],
                "issued_on": (hit["issued_at"] or "")[:10] or None, "due": hit["due_date"],
                "due_source": "срок от учителя" if hit["due_date"] else None, "topic": None,
                "topic_source": "тему учитель не указал", "planned_minutes": hit["planned_minutes"],
                "estimate_source": "время задал учитель", "type": hit["type"], "is_demo": hit["is_demo"],
                "notice": "Демо-режим: учитель и класс синтетические." if hit["is_demo"] else None}
    rs = schedule.ResolvedSchedule(uid)
    return student_tools.task_details(title, st["diary_tasks"], st["diary_mode"], rs.lessons, _date.today(),
                                      diary_service.student_grade_number(uid))


@app.post("/api/v1/webapp/close-quiz")
async def close_quiz_start(body: CloseQuizStartRequest, request: Request) -> dict:
    """Блиц для закрытия задания: вопросы по теме урока; верные ответы остаются на сервере."""
    from app import student_tools
    from app.academic import subject_of
    st = diary_service.initial_state(_uid(request), None)
    topic, _src = student_tools.lesson_topic(subject_of(body.task_title), body.task_title, st["diary_mode"])
    return student_tools.close_quiz(_uid(request), body.task_title, topic)


@app.post("/api/v1/webapp/close-quiz/check")
async def close_quiz_check(body: CloseQuizCheckRequest, request: Request) -> dict:
    from app import student_tools
    r = student_tools.check_quiz(_uid(request), body.quiz_id, body.answers)
    if not r.get("ok"):
        raise HTTPException(409, r["error"])
    return r


@app.post("/api/v1/webapp/schedule-builder")
async def schedule_builder(body: ScheduleBuilderRequest) -> dict:
    """Собрать расписание по параметрам ученика + прогноз до сна. Ничего не сохраняет:
    применение — через /schedule/import/preview → confirm (PREVIEW → CONFIRM → APPLY)."""
    from app import student_tools
    if body.long_break_after is not None and body.long_break_after >= body.lessons:
        raise HTTPException(422, "Большая перемена должна быть между уроками")
    return student_tools.build_schedule(body.model_dump())


# --------------------------- расписание v16: статус, синхронизация, импорт ---------------------------

def _uid(request: Request) -> str:
    return request.headers.get("x-user-id", "demo-user")


@app.get("/api/v1/schedule/status")
async def schedule_status(request: Request) -> dict:
    """Статус синхронизации: fresh|stale|partial|conflict|imported|demo|unavailable|none + время."""
    rs = schedule.ResolvedSchedule(_uid(request))
    return rs.info()


_last_force_sync = [0.0]


@app.post("/api/v1/schedule/sync")
async def schedule_force_sync(request: Request) -> dict:
    """Обновить источник школы сейчас (не чаще раза в минуту на процесс). Ошибка не стирает прошлое."""
    import asyncio
    if platform_enabled():
        from app.platform_routes import account, vault
        from app.sgo_routes import sync as sync_diary
        connection=vault().get(account(request)['uid'])
        if connection and connection['provider']=='netschool':
            await sync_diary(request)
            return schedule.ResolvedSchedule(_uid(request)).info()
    force = time.time() - _last_force_sync[0] > 60
    if force:
        _last_force_sync[0] = time.time()
    await asyncio.to_thread(schedule_feed.sync_feed, force=force)
    return schedule.ResolvedSchedule(_uid(request)).info()


@app.post("/api/v1/schedule/import/preview")
async def schedule_import_preview(body: ScheduleImportPreviewRequest, request: Request) -> dict:
    """PARSE → VALIDATE → PREVIEW: «было → станет». Ничего не сохраняет."""
    uid = _uid(request)
    rs = schedule.ResolvedSchedule(uid)
    return schedule_feed.preview_import(uid, body.payload, body.format, _date.today(), rs.lessons)


@app.post("/api/v1/schedule/import/confirm")
async def schedule_import_confirm(body: ScheduleImportConfirmRequest, request: Request) -> dict:
    """CONFIRM → APPLY (атомарно) → VERIFY. Повтор того же token не создаёт дублей."""
    r = schedule_feed.confirm_import(_uid(request), body.token)
    if not r.get("ok"):
        raise HTTPException(409, r.get("error") or "Превью устарело")
    return r


@app.delete("/api/v1/schedule/import")
async def schedule_import_revert(request: Request) -> dict:
    return schedule_feed.revert_import(_uid(request))


@app.get("/api/v1/day/state")
async def day_state(request: Request,
                    now: str = Query(..., description="ISO-время устройства с поясом, напр. 2026-10-07T10:00:00Z"),
                    offset: int = Query(0, ge=-840, le=840, description="смещение пояса телефона, мин (UTC+3 → 180)"),
                    bedtime: str = Query("22:00", pattern=r"^\d{1,2}:\d{2}$"),
                    travel: int = Query(45, ge=0, le=240)) -> dict:
    """Серверный расчёт состояния дня тем же движком, что и телефон (паритет — tests/test_v16_day_parity.py).
    Время передаётся ЯВНО: сервер не подставляет своё «сейчас» в бизнес-логику."""
    t0 = time.perf_counter()
    try:
        clock = day_engine.resolve_clock(now, offset, schedule_feed.school_tz())
    except ValueError:
        raise HTTPException(422, "now — ISO-8601, например 2026-10-07T10:00:00Z")
    uid = _uid(request)
    sdate, _ = day_engine.school_date(clock["now_local"])
    rs = schedule.ResolvedSchedule(uid)
    changes = schedule.load_doc(uid)["changes"]
    days = {}
    for i in (0, 1):
        d = _date.fromisoformat(sdate) + _timedelta(days=i)
        v = schedule.day_view(d, rs.lessons(d), changes)
        days[d.isoformat()] = {"available": v["available"], "lessons": v["lessons"]}
    info = rs.info()
    initial = _with_teacher_tasks(request, diary_service.initial_state(uid, _date.fromisoformat(sdate)), _date.fromisoformat(sdate))
    tasks = initial["diary_tasks"]
    try:
        out = day_engine.compute_day({"now_local": clock["now_local"], "days": days, "clock_warning": clock["warning"],
                                      "settings": {"travel_minutes": travel, "bedtime": bedtime},
                                      "schedule": {"status": info["status"], "is_demo": info["is_demo"],
                                                   "last_sync_at": info["last_sync_at"]},
                                      "tasks": tasks,
                                      # Recovery 2: teacher work completed today (server-confirmed) is done in the plan.
                                      "done": [a["task_title"] for a in initial.get("teacher_assignments", [])
                                               if a["status"] == "completed"]})
    except Exception:  # noqa: BLE001
        metrics.op("day_engine", "error", (time.perf_counter() - t0) * 1000)
        raise
    metrics.op("day_engine", "ok", (time.perf_counter() - t0) * 1000)
    out["timezone"] = {k: clock[k] for k in ("offset_min", "source", "school_tz", "device_offset_min")}
    return out


_SCENE = {"svg", "static", "reduced", "error"}


@app.post("/api/v1/metrics/client")
async def client_metrics(body: ClientMetricsRequest) -> dict:
    """Клиентские замеры без PII: время до полезного контента, расчёт дня, режим сцены."""
    if body.ttuc_ms is not None:
        metrics.op("ttuc", "ok", body.ttuc_ms)
    if body.day_engine_ms is not None:
        metrics.op("day_engine_client", "error" if body.day_engine_error else "ok", body.day_engine_ms)
    elif body.day_engine_error:
        metrics.op("day_engine_client", "error")
    if body.scene in _SCENE:
        metrics.op("scene", body.scene)
    return {"ok": True}


@app.post("/api/v1/schedule/evidence/read", response_model=EvidenceRead)
async def evidence_read(body: EvidenceImageRequest, request: Request) -> dict:
    """Фото/скриншот/документ → текст (+ уроки, если читало ИИ). Ничего не меняет в расписании."""
    uid = request.headers.get("x-user-id", "demo-user")
    if body.kind == "file" and not (body.mime or "").startswith("image/"):
        return await run_in_threadpool(evidence.read_document, body.base64, body.mime)
    return await evidence.read_image(body.base64, body.mime, body.hint, uid)

@app.post("/api/v1/speech/transcribe", response_model=TranscribeResponse)
async def speech_transcribe(body: TranscribeRequest, request: Request) -> dict:
    return await evidence.transcribe(body.base64, body.mime, request.headers.get("x-user-id", "demo-user"))

# --------------------------- process-media ---------------------------

@app.post("/api/v1/webapp/process-media", response_model=MediaResponse)
async def process_media(body: MediaRequest, request: Request) -> dict:
    user_id = _uid(request)
    grade = diary_service.student_grade_number(user_id)
    meta: dict = {}
    t0 = time.monotonic()
    try:
        tasks = await _process_media(body, grade, user_id, meta)
    except Exception:
        metrics.op("process_media", "error", (time.monotonic() - t0) * 1000)
        raise
    metrics.op("process_media", "ok" if tasks else "empty", (time.monotonic() - t0) * 1000)
    notice = meta.get("notice")
    if grade is None:
        notice = ((notice + " ") if notice else "") + "Класс неизвестен: время оценено приблизительно. Проверь минуты перед добавлением."
    return {"tasks": tasks, "source": meta.get("source"), "notice": notice}

async def _process_media(body: MediaRequest, grade: int, user_id: str, meta: dict) -> list:
    if body.media_type == "photo":
        if not body.base64:
            raise HTTPException(400, "Фото пустое: приложи изображение")
        if len(body.base64) > ai_engine.MAX_IMAGE_BYTES:
            raise HTTPException(413, "Фото слишком большое (лимит 20 МБ base64)")
        return await ai_engine.parse_homework_input(
            media_type="photo", base64=body.base64, mime=body.mime, text=body.text,
            grade=grade, user_id=user_id, meta=meta)
    elif body.media_type == "voice":
        if not body.text or not body.text.strip():
            raise HTTPException(400, "Пустая расшифровка голосового")
        return await ai_engine.parse_homework_input(
            media_type="voice", text=body.text.strip(),
            grade=grade, user_id=user_id, meta=meta)
    else:  # audio
        if not body.base64:
            raise HTTPException(400, "Аудио пустое: перезапиши голосовое")
        if len(body.base64) > ai_engine.MAX_AUDIO_BYTES:
            raise HTTPException(413, "Аудио слишком большое (лимит 20 МБ base64)")
    return await ai_engine.parse_audio_homework(
        audio_b64=body.base64, mime=body.mime,
        grade=grade, user_id=user_id, meta=meta)

# --------------------------- calculate ---------------------------

@app.post("/api/v1/webapp/calculate", response_model=CalculateResponse)
async def calculate(body: CalculateRequest, request: Request, response: Response) -> dict:
    if not body.tasks:
        raise HTTPException(400, "Нет задач для планирования")

    def build() -> dict:
        t0 = time.monotonic()
        try:
            plan = _build_plan(body)
        except Exception:
            metrics.op("calculate", "error", (time.monotonic() - t0) * 1000)
            raise
        metrics.op("calculate", "deficit" if plan["deficit_minutes"] > 0 else "ok", (time.monotonic() - t0) * 1000)
        metrics.rules("calculate")
        return CalculateResponse.model_validate(_calculate_response(body, plan)).model_dump(mode="json")
    return _mutation(request, response, "calculate", body.model_dump(mode="json"), build)

def _build_plan(body: CalculateRequest) -> dict:
    return scheduler.build_plan(
        tasks=[t.model_dump() for t in body.tasks],
        start_time=body.start_time,
        bedtime=body.bedtime,
        rest_slots=[r.model_dump() for r in body.rest_slots],
        personal_activities=[p.model_dump() for p in body.personal_activities],
        survival=body.survival,
        compact_breaks=body.compact_breaks,
        order=body.order,
        post_school_rest_minutes=body.post_school_rest_minutes,
    )

def _calculate_response(body: CalculateRequest, plan: dict) -> dict:
    tasks_payload = [t.model_dump() for t in body.tasks]
    reasoning = ai_engine.generate_plan_reasoning(
        plan=plan, tasks=tasks_payload,
        deficit_minutes=plan["deficit_minutes"],
        suggestions=plan["tradeoff_suggestions"],
    )

    negotiator: str | None = None
    if plan["deficit_minutes"] > 0:
        context = (f"Окно {plan['summary']['window_start']}–"
                   f"{plan['summary']['window_end']}; задач: {len(tasks_payload)}; "
                   f"выживание: {'да' if body.survival else 'нет'}")
        negotiator = ai_engine.generate_tradeoff_message(
            deficit_minutes=plan["deficit_minutes"],
            suggestions=plan["tradeoff_suggestions"],
            context=context,
        )

    return {"plan": plan, "ai_reasoning": reasoning,
            "negotiator_message": negotiator}

# --------------------------- socratic-hint ---------------------------

@app.post("/api/v1/webapp/socratic-hint", response_model=HintResponse)
async def socratic_hint(body: HintRequest, request: Request) -> dict:
    meta: dict = {}
    hint = await ai_engine.generate_socratic_hint(
        task_context=body.task_context,
        student_query=body.student_query,
        history=body.history,
        image_b64=body.image_base64,
        user_id=request.headers.get("x-user-id", "demo-user"),
        meta=meta,
    )
    degraded = meta.get("source") == "fallback"
    return {"hint": hint, "source": meta.get("source"), "notice": meta.get("notice"),
            "status": "degraded_gracefully" if degraded else "ok",
            "guide": guide_for(body.task_context, body.student_query) if degraded else None}

# --------------------------- blitz ---------------------------

@app.post("/api/v1/webapp/blitz", response_model=BlitzResponse)
async def blitz(body: BlitzRequest, request: Request) -> dict:
    user_id = request.headers.get("x-user-id", "demo-user")
    if body.mode == "start":
        res = await ai_engine.generate_blitz_turn(
            task_title=body.task_title, history=[], user_id=user_id)
        return {"question": res.get("question"),
                "verdict": None, "feedback": None, "progress": 0, "done": False,
                "source": res.get("source"), "notice": res.get("notice")}

    answer = body.answer or {}
    text = answer.get("text")
    audio_b64 = answer.get("audio_base64")
    if not text and not audio_b64:
        raise HTTPException(400, "Пустой ответ: напиши текст или запиши голос")

    res = await ai_engine.generate_blitz_turn(
        task_title=body.task_title,
        history=body.history,
        answer_text=text,
        answer_audio=({"base64": audio_b64, "mime": answer.get("mime", "audio/wav")}
                      if audio_b64 else None),
        current_question=body.current_question,
        user_id=user_id,
    )
    verdict = res.get("verdict", "partial")
    history = list(body.history) + [{
        "question": body.current_question or "",
        "answer": text if text else "[голосовой ответ]",
        "verdict": verdict,
    }]
    progress_count = sum(1 for h in history if h.get("verdict") == "correct")
    done = progress_count >= 3
    question = None if done else (res.get("next_question") or body.current_question)
    return {"question": question, "verdict": verdict,
            "feedback": res.get("feedback"),
            "progress": progress_count, "done": done,
            "source": res.get("source"), "notice": res.get("notice")}

# --------------------------- blitz-quiz (фото параграфа) ---------------------------

@app.post("/api/v1/webapp/blitz-quiz", response_model=QuizResponse)
async def blitz_quiz(body: QuizRequest, request: Request) -> dict:
    user_id = request.headers.get("x-user-id", "demo-user")
    if not ai_engine.has_vision():
        # v2.4 Step 1 (K1): photos never leave the process, so the external photo quiz is unavailable.
        raise HTTPException(
            503,
            "Фото-викторина недоступна: фото не отправляются во внешний ИИ (К1). "
            "Создайте вопросы текстом — это работает локально.",
        )
    raw = await ai_engine.generate_quiz_from_images(
        images=[img.model_dump() for img in body.images],
        question_count=body.question_count, user_id=user_id,
    )
    questions = ai_engine.sanitize_quiz_questions(
        raw.get("questions"), body.question_count)
    if not questions:
        raise HTTPException(422, "ИИ не собрал корректные вопросы — попробуй другие фото")
    return {"questions": questions}

# --------------------------- blitz-quiz-manual (свой опрос) ---------------------------

@app.post("/api/v1/webapp/blitz-quiz-manual", response_model=QuizResponse)
async def blitz_quiz_manual(body: ManualQuizRequest, request: Request) -> dict:
    """Свой опрос ученика: черновик вопросов → ТГ-опрос.

    С ключом ИИ нормализует черновик; без ключа работает детерминированный
    парсер (верный вариант — строка со «*»). Нецензурный черновик → 422,
    неразбираемый → 422 с подсказкой формата.
    """
    user_id = request.headers.get("x-user-id", "demo-user")
    raw = await ai_engine.generate_quiz_from_text(
        topic=body.topic, raw_text=body.raw_text,
        question_count=body.question_count, user_id=user_id,
    )
    questions = ai_engine.sanitize_quiz_questions(
        raw.get("questions"), body.question_count)
    if not questions:
        raise HTTPException(422, "Не удалось собрать корректные вопросы — проверь формат")
    return {"questions": questions, "source": raw.get("source")}

# --------------------------- flashcard ---------------------------

@app.post("/api/v1/webapp/flashcard", response_model=FlashcardResponse)
async def flashcard(body: FlashcardRequest, request: Request) -> dict:
    return await ai_engine.generate_flashcard(
        body.task_title,
        user_id=request.headers.get("x-user-id", "demo-user"))

# --------------------------- triage ---------------------------

@app.post("/api/v1/webapp/triage", response_model=TriageResponse)
async def triage(body: TriageRequest) -> dict:
    if not body.tasks:
        raise HTTPException(400, "Нет задач для распределения")
    metrics.rules("triage")
    return ai_engine.generate_triage(
        tasks=[t.model_dump() for t in body.tasks],
        horizon_days=body.horizon_days,
    )

# --------------------------- progress ---------------------------

@app.post("/api/v1/webapp/progress/event")
async def progress_event(body: ProgressEventRequest, request: Request, response: Response) -> dict:
    """События прогресса от фронта: стрик/очки/достижения пересчитываются
    на бэкенде по правилам ТЗ (65% порог, блиц-продолжение, 3 пропуска)."""
    user_id = request.headers.get("x-user-id", "demo-user")
    def apply_event():
        from app.completion_clock import completion_day
        try:
            day = completion_day(body.payload, school_tz=schedule_feed.school_tz()) if body.kind == "task_done" else None
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        except LookupError as exc:
            raise HTTPException(409, str(exc)) from exc
        return progress.STORE.event(user_id, body.kind, body.payload, today=day)
    return _mutation(request, response, "progress_event", body.model_dump(mode="json"), apply_event)

@app.post("/api/v1/webapp/focus-reminder", response_model=FocusReminderResponse)
async def focus_reminder(body: FocusReminderRequest, request: Request) -> dict:
    """Фокус-сессия: старт/продолжение → бот MAX напомнит в чате, когда время выйдет;
    пауза/финиш → напоминание снимается. Только для подписанного max:<id>."""
    uid = focus_remind.max_uid(request.state.platform_principal if hasattr(getattr(request,"state",None),"platform_account") and request.state.platform_auth=="max" else None if hasattr(getattr(request,"state",None),"platform_account") else request.headers.get("x-user-id"))
    if uid is None:
        return {"scheduled": False}
    if body.cancel or body.ends_in_sec is None:
        focus_remind.REMINDERS.cancel(uid)
        return {"scheduled": False}
    return {"scheduled": focus_remind.REMINDERS.schedule(uid, body.subject or "задание", body.ends_in_sec)}

@app.get("/api/v1/webapp/my-week", response_model=MyWeekResponse)
async def my_week(
    request: Request,
    days: int = Query(default=7, ge=1, le=31),
) -> dict:
    """«Моя неделя» ученика: минуты учёбы по дням, дуэли, средний блиц."""
    user_id = request.headers.get("x-user-id", "demo-user")
    return progress.STORE.my_week(user_id, days=days)

# --------------------------- teacher ---------------------------

_TRUE_FLAGS = {"1", "true", "yes", "on"}


def legacy_demo_roles() -> bool:
    """Synthetic identity harness of the automated TEST profile only (pytest, local E2E runners).

    v2.4 Step 1: production and demo profiles never read X-User-Role / X-Demo-Teacher, and there is
    no flag that could make them (the former SFERUM_LEGACY_DEMO_ROLES opt-in for demo was removed).
    A demo teacher exists only through the server-signed demo sandbox token; a real teacher only through
    a verified MAX signature + school directory or a one-time invitation. In the test profile the harness
    can additionally be switched off with SFERUM_LEGACY_DEMO_ROLES=0 (used by negative tests)."""
    if deployment_policy.production or MAX_REQUIRE_AUTH or deployment_policy.profile != "test":
        return False
    return os.getenv("SFERUM_LEGACY_DEMO_ROLES", "1").strip().lower() in _TRUE_FLAGS


def resolve_role(request: Request) -> tuple[str, str]:
    """Verified MAX always uses school authority, never the client demo role.
    Unique school directory mapping wins; legacy allowlist applies without a directory.
    A demo sandbox role comes only from its server-signed token.
    Header role is synthetic-only and opt-in (``legacy_demo_roles``)."""
    sb = demo_sandbox.state_of(request)
    if sb:
        return ("teacher" if sb["role"] == "teacher" else "student"), "sandbox"
    if hasattr(getattr(request,"state",None),"platform_account"):
        from app.user_roles import get_user_role, view_role, teacher_session
        from app.platform_auth import store as role_store
        account_uid = request.state.platform_account['uid']
        if get_user_role(role_store(), account_uid) == 'teacher':
            return view_role(role_store(), account_uid), 'sgo' if teacher_session(role_store(), account_uid) else 'preference'
        principal=request.state.platform_principal
        if request.state.platform_auth=="max":
            mapped=teacher_mode.resolve("school", max_uid=principal[4:])
            yes=bool(mapped) if teacher_mode.school_directory() else principal[4:] in TEACHER_MAX_IDS
            return ("teacher" if yes else "student"), "school"
        return "student", "school"
    uid = request.headers.get("x-user-id", "")
    if request.headers.get("x-auth") == "max" and uid.startswith("max:"):
        mapped = teacher_mode.resolve("school", max_uid=uid[4:])
        is_teacher = bool(mapped) if teacher_mode.school_directory() else uid[4:] in TEACHER_MAX_IDS
        return ("teacher" if is_teacher else "student"), "school"
    if MAX_REQUIRE_AUTH or deployment_policy.production:
        # v17: в проде (подпись обязательна) роль из заголовка клиента не принимается никогда.
        return "student", "school"
    if not legacy_demo_roles():
        return "student", "demo"
    r = request.headers.get("x-user-role", "student")
    return ("teacher" if r == "teacher" else "student"), "demo"


def _clean_name(*parts: Any) -> str | None:
    text = " ".join(str(p).strip() for p in parts if isinstance(p, str) and p.strip())
    text = "".join(ch for ch in text if ch.isprintable())[:80].strip()
    return text or None


def identity_profile(request: Request, role: str) -> dict:
    """ФИО и школа только из доверенного источника; клиентский ввод сюда не попадает.
    Порядок: демо-песочница (вымышленный персонаж) → справочник школы (учитель) → ФИО из подключённого СГО
    (v2.2) → имя, подтверждённое учителем при приёме в класс (ученик) → подписанный профиль MAX → нет данных."""
    sb = demo_sandbox.state_of(request)
    if sb:
        classes = [sb["class"]] if sb.get("class") else []
        if sb["role"] == "teacher":
            t = teacher_mode.resolve("demo", demo_teacher=sb["teacher"])
            classes = teacher_mode._pub(t)["classes"] if t else []  # noqa: SLF001
        return {"full_name": sb["full_name"], "source": "demo_sandbox", "verified": False, "synthetic": True,
                "school": demo_sandbox.SCHOOL_NAME, "classes": classes,
                "note": "Вымышленный персонаж демо-песочницы"}
    if role == "teacher" and _tsource(request) == "school":
        try:
            t, src = _tctx(request)
        except HTTPException:
            t = None
        if t:
            prof = teacher_mode.profile(t, src)
            return {"full_name": prof.get("full_name"), "source": "school_directory", "verified": True, "synthetic": False,
                    "school": (prof.get("school") or {}).get("name"), "classes": prof.get("classes") or [],
                    "note": "ФИО из справочника школы"}
    # v2.2: ФИО из подключённого СГО (зашифрованная сессия или связь дневника) — раньше его не было,
    # и вошедший в СГО ученик видел «Ученик» и «?» вместо своего имени.
    from app.identity_names import for_request as sgo_name
    got = sgo_name(request)
    if got:
        return {"full_name": got["full_name"], "source": "sgo", "verified": True, "synthetic": False,
                "school": got["school"], "classes": [got["class_name"]] if got["class_name"] else [],
                "note": "ФИО из подключённого школьного дневника (СГО)"}
    if role == "student":
        try:
            from app.assignment_routes import student_identity
            from app import assignments as hw
            ident = student_identity(request)
            items = (hw.memberships(*ident).get("memberships") or []) if ident else []
        except Exception:  # noqa: BLE001 — профиль не должен ронять whoami
            items = []
        active = [m for m in items if m.get("status") == "active"]
        if active:
            return {"full_name": _clean_name(active[0].get("display_name")), "source": "class_roster", "verified": True,
                    "synthetic": ident[0] == "demo", "school": None, "classes": sorted({m["class"] for m in active}),
                    "note": "Имя подтверждено учителем при приёме в класс"}
    mu = getattr(getattr(request, "state", None), "max_user", None)
    if isinstance(mu, dict) and (mu.get("first_name") or mu.get("last_name")):
        return {"full_name": _clean_name(mu.get("first_name"), mu.get("last_name")), "source": "max", "verified": True,
                "synthetic": False, "school": None, "classes": [], "note": "Имя из подписанного профиля MAX"}
    return {"full_name": None, "source": None, "verified": False, "synthetic": False, "school": None, "classes": [],
            "note": "Имя не подтверждено: войдите через MAX или вступите в класс по коду учителя"}


def signed_avatar(request: Request) -> dict | None:
    """Master v2.0 · Feature 1: фото профиля MAX — только из ПОДПИСАННОГО initData этого запроса
    (state.max_user ставит MaxAuthMiddleware после проверки HMAC). Никогда — из заголовков клиента,
    песочницы или демо. Только для оформления; права и личность от него не зависят."""
    mu = getattr(getattr(request, "state", None), "max_user", None)
    url = mu.get("photo_url") if isinstance(mu, dict) else None
    return {"url": url, "source": "max"} if isinstance(url, str) and url.startswith("https://") else None


@app.post("/api/v1/webapp/device-identity")
async def device_identity_mint(request: Request) -> dict:
    """v2.4 Step 1: the server — never the browser — creates the anonymous demo identity.
    Not available where a verified launch is mandatory (production / MAX_REQUIRE_AUTH / platform mode)."""
    from app import device_identity
    if deployment_policy.production or MAX_REQUIRE_AUTH or platform_enabled():
        raise HTTPException(404, "Анонимный демо-профиль на этом сервере недоступен")
    wait = device_identity.allow_mint(request.client.host if request.client else "unknown")
    if wait:
        raise HTTPException(429, "Слишком много новых демо-профилей с этого адреса. Попробуйте позже",
                            headers={"Retry-After": str(wait)})
    return {"device": device_identity.mint(), "kind": "anonymous_demo_device"}


@app.get("/api/v1/webapp/whoami")
async def whoami(request: Request) -> dict:
    sb = demo_sandbox.state_of(request)
    if sb:
        role, source = resolve_role(request)
        return {"auth": "demo", "user": sb["key"], "role": role, "role_source": source, "role_switch": False,
                "sandbox": demo_sandbox.describe(sb["sid"], sb["persona"], sb["expires"]),
                "profile": identity_profile(request, role), "avatar": None}
    if hasattr(getattr(request,"state",None),"platform_account"):
        role, source = resolve_role(request)
        from app.user_roles import get_user_role
        from app.platform_auth import store as role_store
        account_role = 'teacher' if role == 'teacher' else get_user_role(role_store(), request.state.platform_account['uid'])
        return {"auth":request.state.platform_auth,"user":request.state.platform_account['data_key'],"uid":request.state.platform_account['uid'],"role":role,"is_teacher":account_role=='teacher',"account_role":account_role,"role_source":source,"role_switch":account_role=='teacher',
                "profile": identity_profile(request, role),
                "avatar": signed_avatar(request) if request.state.platform_auth == "max" else None}
    auth = "max" if request.headers.get("x-auth") == "max" else "demo"
    role, source = resolve_role(request)
    return {"auth": auth, "user": request.headers.get("x-user-id", "demo") if auth == "max" else "demo",
            "role": role, "role_source": source, "role_switch": source == "demo" and legacy_demo_roles(),
            "profile": identity_profile(request, role), "avatar": signed_avatar(request) if auth == "max" else None}


def _require_teacher(request: Request) -> None:
    role, source = resolve_role(request)
    if source == 'preference':
        raise HTTPException(403, "Роль интерфейса не даёт прав школы. Подключите СГО как учитель.")
    if source == 'sgo':
        if role != 'teacher':
            raise HTTPException(403, "Откройте режим учителя")
        return
    if source == "sandbox":
        if role != "teacher":
            raise HTTPException(403, "Раздел доступен только учителю")
        return
    if source == "school":
        if role != "teacher":
            raise HTTPException(403, "Карта класса доступна только учителю, подтверждённому школой")
        return
    if role != "teacher":
        raise HTTPException(403, "Доступ к карте класса только для teacher_user")
    # Прод-рубеж: роль из заголовка клиента не доверяем — учитель = подписанный MAX-ID из списка.
    if TEACHER_MAX_IDS:
        uid = request.headers.get("x-user-id", "")
        if not uid.startswith("max:") or uid[4:] not in TEACHER_MAX_IDS:
            raise HTTPException(403, "Карта класса доступна только учителю, подтверждённому школой")

@app.get("/api/v1/teacher/heatmap", response_model=HeatmapResponse)
async def teacher_heatmap(request: Request) -> dict:
    _require_teacher(request)
    if _tsource(request) != "demo":
        raise HTTPException(503, "Источник школьной аналитики не подключён; синтетические данные недоступны")
    return teacher.heatmap()

@app.get("/api/v1/teacher/day-schedule", response_model=DayScheduleResponse)
async def teacher_day_schedule(request: Request) -> dict:
    _require_teacher(request)
    if _tsource(request) != "demo":
        raise HTTPException(503, "Источник школьной аналитики не подключён; синтетические данные недоступны")
    return teacher.day_schedule()

# --------------------------- v17 teacher intelligence ---------------------------
from app.models import (TeacherDecideRequest, TeacherImportConfirmRequest, TeacherImportPreviewRequest,  # noqa: E402
                        TeacherMatchRequest, TeacherMaterialRequest, TeacherPlanRequest, TeacherRevertRequest)


def _tsource(request: Request) -> str:
    """school — подписанный MAX-пользователь (или прод с обязательной подписью); иначе demo.
    Демо-песочница всегда demo: её данные синтетические даже на сервере с обязательной подписью."""
    if demo_sandbox.state_of(request):
        return "demo"
    if MAX_REQUIRE_AUTH or hasattr(getattr(request,"state",None),"platform_account"):
        return "school"
    if deployment_policy.production or (request.headers.get("x-auth") == "max" and request.headers.get("x-user-id", "").startswith("max:")):
        return "school"
    return "demo"


def _tctx(request: Request) -> tuple[dict, str]:
    sb = demo_sandbox.state_of(request)
    if sb:
        if sb["role"] != "teacher":
            raise HTTPException(403, "Раздел доступен только учителю")
        t = teacher_mode.resolve("demo", demo_teacher=sb["teacher"])
        if not t:
            raise HTTPException(503, "Демо-учитель песочницы не найден")
        return t, "demo"
    src = _tsource(request)
    if src == "school":
        uid = request.headers.get("x-user-id", "")
        t = teacher_mode.resolve("school", max_uid=(request.state.platform_principal[4:] if hasattr(getattr(request,"state",None),"platform_account") and request.state.platform_auth=="max" else uid[4:] if uid.startswith("max:") and request.headers.get("x-auth") == "max" else None))
        if not t and hasattr(request.state, 'platform_account'):
            from app.teacher_journal import own_teacher_context
            t = own_teacher_context(request.state.platform_account['uid'])
        if not t:
            raise HTTPException(403, "Учительский профиль не подтверждён справочником школы или СГО")
        return t, src
    if not legacy_demo_roles():
        raise HTTPException(403, "Учительский режим демо открывается через «Демо для жюри» (изолированная песочница)")
    t = teacher_mode.resolve("demo", demo_teacher=request.headers.get("x-demo-teacher", ""))
    if not t:
        raise HTTPException(409, "Демо: выберите школу и учителя")
    return t, src


def _sandbox_readonly(request: Request) -> None:
    """План урока, материалы, импорт и согласования учителя хранятся в общих файлах демо-школы — в песочнице
    их можно смотреть, но не менять (иначе сессии жюри мешали бы друг другу)."""
    if demo_sandbox.state_of(request):
        raise HTTPException(403, "В демо-песочнице это только для просмотра: план урока, материалы и расписание общие для всех демо-сессий")


def _tdate(v: str | None) -> _date:
    try:
        return _date.fromisoformat(v) if v else _date.today()
    except ValueError as exc:
        raise HTTPException(422, "Дата в формате ГГГГ-ММ-ДД") from exc


def _tlesson(t: dict, src: str, lesson_id: str) -> dict:
    parts = lesson_id.split(":")
    if len(parts) != 4 or parts[0] != t["school_id"]:
        raise HTTPException(404, "Урок не найден")
    day = teacher_mode.teacher_day(t, src, _tdate(parts[1]))
    hit = next((l for l in day["lessons"] if l["id"] == lesson_id), None)
    if not hit:
        raise HTTPException(404, "Урок не найден в вашем расписании")
    return hit


@app.get("/api/v1/teacher/directory")
async def teacher_directory(request: Request) -> dict:
    src = _tsource(request)
    if src == "school":
        t, _ = _tctx(request)
        return {"source": src, "is_demo": False, "schools": [teacher_mode.profile(t, src)["school"]], "teachers": [teacher_mode._pub(t)]}  # noqa: SLF001
    return {"source": "demo", "is_demo": True, "schools": teacher_mode.DEMO_SCHOOLS,
            "teachers": [teacher_mode._pub(x) for x in teacher_mode.DEMO_TEACHERS],  # noqa: SLF001
            "scenarios": ["normal", "not_loaded", "stale", "unavailable"]}


@app.get("/api/v1/teacher/profile")
async def teacher_profile(request: Request) -> dict:
    t, src = _tctx(request)
    return teacher_mode.profile(t, src)


@app.get("/api/v1/teacher/today")
async def teacher_today(request: Request, date: str | None = Query(default=None), now: str | None = Query(default=None, pattern=r"^\d{2}:\d{2}$"),
                        scenario: str = Query(default="normal", pattern=r"^(normal|not_loaded|stale|unavailable)$")) -> dict:
    t, src = _tctx(request)
    if src == "school":
        scenario = "normal"   # сценарии — только демо
    day = teacher_mode.teacher_day(t, src, _tdate(date), scenario=scenario)
    day["next"] = teacher_mode.next_lesson(day, now)
    day["profile"] = teacher_mode.profile(t, src)
    return day


@app.get("/api/v1/teacher/results")
async def teacher_results(request: Request, cls: str = Query(alias="class", max_length=8), subject: str = Query(max_length=60),
                          order: str = Query(default="best", pattern=r"^(best|alpha)$")) -> dict:
    t, src = _tctx(request)
    if not teacher_mode.can(t, "view_stats", cls, subject):
        raise HTTPException(403, "Нет права на просмотр результатов этого класса по предмету")
    res = teacher_mode.class_results(t, src, cls, subject)
    if res.get("available"):
        res["rows"] = teacher_mode.sort_rows(res["rows"], order)
        res["order"] = order
    return res


@app.get("/api/v1/teacher/prep")
async def teacher_prep(request: Request, lesson_id: str = Query(max_length=120)) -> dict:
    t, src = _tctx(request)
    return teacher_mode.prep(t, src, _tlesson(t, src, lesson_id))


@app.post("/api/v1/teacher/plan/draft")
async def teacher_plan_draft(request: Request, lesson_id: str = Query(max_length=120)) -> dict:
    t, src = _tctx(request)
    lesson = _tlesson(t, src, lesson_id)
    p = teacher_mode.prep(t, src, lesson)
    gaps = [q["topic"] for q in ((p.get("stats") or {}).get("hardest") or []) if q.get("topic_link_confirmed") and q.get("topic")]
    return teacher_mode.plan_draft(lesson, lesson.get("topic"), gaps)


@app.put("/api/v1/teacher/plan")
async def teacher_plan_save(body: TeacherPlanRequest, request: Request) -> dict:
    t, src = _tctx(request)
    _sandbox_readonly(request)
    lesson = _tlesson(t, src, body.lesson_id)
    try:
        return teacher_mode.save_plan(t, src, lesson, body.model_dump())
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.get("/api/v1/teacher/materials")
async def teacher_materials(request: Request, subject: str | None = Query(default=None, max_length=60), cls: str | None = Query(default=None, alias="class", max_length=8)) -> dict:
    t, src = _tctx(request)
    return teacher_mode.materials(t, src, subject, cls)


@app.post("/api/v1/teacher/materials")
async def teacher_material_add(body: TeacherMaterialRequest, request: Request) -> dict:
    t, src = _tctx(request)
    _sandbox_readonly(request)
    try:
        return teacher_mode.add_material(t, src, body.model_dump(by_alias=True))
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.post("/api/v1/teacher/match")
async def teacher_match(body: TeacherMatchRequest, request: Request) -> dict:
    t, src = _tctx(request)
    return teacher_mode.match_teacher(src, teacher_id=body.teacher_id, full_name=body.full_name,
                                      school_id=body.school_id or t["school_id"], subject=body.subject)


@app.post("/api/v1/teacher/import/preview")
async def teacher_import_preview(body: TeacherImportPreviewRequest, request: Request, date: str | None = Query(default=None)) -> dict:
    t, src = _tctx(request)
    _sandbox_readonly(request)
    return teacher_mode.preview_import(t, src, body.payload, source_kind=body.source_kind, legibility=body.legibility, today=_tdate(date))


@app.post("/api/v1/teacher/import/confirm")
async def teacher_import_confirm(body: TeacherImportConfirmRequest, request: Request) -> dict:
    t, src = _tctx(request)
    _sandbox_readonly(request)
    res = teacher_mode.confirm_import(t, src, body.token, body.accept)
    if not res.get("ok") and res.get("error") == "preview_expired":
        raise HTTPException(409, "Предпросмотр устарел — покажите изменения ещё раз")
    return res


@app.get("/api/v1/teacher/import/journal")
async def teacher_import_journal(request: Request) -> dict:
    t, src = _tctx(request)
    return {"entries": teacher_mode.journal(t, src)}


@app.post("/api/v1/teacher/import/revert")
async def teacher_import_revert(body: TeacherRevertRequest, request: Request) -> dict:
    t, src = _tctx(request)
    _sandbox_readonly(request)
    res = teacher_mode.revert_import(t, src, body.journal_id)
    if not res.get("ok"):
        raise HTTPException(409, res.get("message") or "Нечего отменять")
    return res


@app.get("/api/v1/teacher/proposals")
async def teacher_proposals(request: Request) -> dict:
    t, src = _tctx(request)
    items = teacher_mode.proposals(src, t["school_id"])
    visible = [p for p in items if teacher_mode.can(t, "approve_schedule") or p["by"] == t["id"] or t["id"] in p["affected_teachers"]]
    return {"items": visible, "can_approve": teacher_mode.can(t, "approve_schedule")}


@app.post("/api/v1/teacher/proposals/{pid}/decide")
async def teacher_proposal_decide(pid: str, body: TeacherDecideRequest, request: Request) -> dict:
    t, src = _tctx(request)
    _sandbox_readonly(request)
    res = teacher_mode.decide_proposal(t, src, pid[:32], body.approve)
    if res.get("error") == "forbidden":
        raise HTTPException(403, "Утверждать изменения расписания может только уполномоченный (завуч)")
    if not res.get("ok"):
        raise HTTPException(409, res.get("message") or "Предложение не найдено")
    return res


# --------------------------- rewards ---------------------------

@app.get("/api/v1/rewards/profile")
async def rewards_profile(request: Request) -> dict:
    user_id = request.headers.get("x-user-id", "demo-user")
    return rewards.get_profile(user_id)

# --------------------------- quarter ---------------------------

@app.get("/api/v1/webapp/quarter-schedule")
async def quarter_schedule(request: Request, days: int = Query(default=5, ge=1, le=14)) -> dict:
    if diary_service.initial_state(_uid(request)).get("diary_mode") != "mock":
        raise HTTPException(503, "Источник границ четверти не подключён; синтетические даты не показаны")
    return mock_diary.quarter_schedule(days=days)


# --------------------------- SPA-фоллбек ---------------------------
# Мини-апп — одна страница. Любой НЕ-API путь (/main, /index.html, /plan,
# обновление страницы на глубокой ссылке, base path хостинга) отдаёт тот же
# index.html — 404 на «не том» адресе больше невозможен. Неизвестный /api/* —
# по-прежнему честный JSON 404 (фронт по нему уходит в автономный режим).
@app.get("/{path:path}", include_in_schema=False)
async def spa_fallback(path: str, request: Request) -> Any:
    if path.startswith(("api/", "health", "fonts/", "assets/")):
        return JSONResponse({"detail": "Not Found"}, status_code=404)
    resp = await index(request)
    resp.headers["Cache-Control"] = "no-cache"
    return resp
