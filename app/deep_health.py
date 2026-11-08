"""v2.1 · Глубокая проверка здоровья и учения «СГО упал» для панели жюри («Инженерная телеметрия»).

GET  /api/v1/health/deep        сводка по четырём подсистемам, без секретов и данных людей:
     groq           ключ задан?, маршрут direct|proxy (без адреса прокси и пароля), предохранитель, исходы ИИ-вызовов
                    с запуска процесса; ?probe=1 — живой GET /models тем же транспортом (кэш 60 с, single-flight)
     school_search  RapidFuzz: время трёх типовых запросов (номер, опечатка, латиница) по справочнику школ
     swr_cache      SQLite-кэш дневника: режим журнала, записи свежие/устаревшие
     max_bridge     HMAC-SHA256 initData MAX: самопроверка на одноразовом токене + счётчики реальных проверок
POST /api/v1/health/swr-drill   учения: временная зашифрованная база и НАСТОЯЩИЕ SGOMultiRegionAdapter.overview +
     onboarding_routes.present: СГО отвечает → СГО 503 → 200 is_stale/stale_cache → 5 одновременных запросов =
     1 поход в СГО → «Скрывать оценки» сильнее устаревшей копии. Реальные пользователи и серверы СГО не затрагиваются.

Оба маршрута — обычные /api/*: проходят те же слои входа (MAX/Telegram/cookie/песочница) и DeploymentGate, что и
остальной API; публичного обхода нет. Оператору без сессии — локальный CLI scripts/deep_health.py (тот же отчёт
в процессе, без сети). Защита: окно запросов по IP, кэш результата, одни учения за раз; SFERUM_DEEP_HEALTH=0
выключает /deep, учения в production — только при явном SFERUM_SWR_DRILL=1.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
import sqlite3
import tempfile
import time
from collections import deque
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlencode

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app import __release__, __version__, metrics

logger = logging.getLogger("sferumfocus.health")
router = APIRouter()

DEEP_PATH = "/api/v1/health/deep"
DRILL_PATH = "/api/v1/health/swr-drill"

OFFICIAL_GROQ = "https://api.groq.com/openai/v1"
REPORT_TTL = 5.0            # повторный /deep в течение 5 с — из кэша (поиск и SQLite не дёргаем)
PROBE_TTL = 60.0            # живой запрос к Groq — не чаще раза в минуту на процесс
PROBE_TIMEOUT = 6.0
SEARCH_BUDGET_MS = 300.0    # три запроса мастера подключения; дольше — «degraded»
SEARCH_PROBES: tuple[tuple[str, str], ...] = (("number", "лицей 1"), ("typo", "гимназя 2"), ("latin", "school 5"))
NO_STORE = {"Cache-Control": "no-store"}
_TRUE = {"1", "true", "yes", "on"}
_FALSE = {"0", "false", "no", "off"}


# ------------------------------------------------------------------ switches & limits
def _env() -> str:
    return os.getenv("SFERUM_ENV", "production").strip().lower()


def deep_enabled() -> bool:
    return os.getenv("SFERUM_DEEP_HEALTH", "").strip().lower() not in _FALSE


def drill_enabled() -> bool:
    """demo/test — включены, пока не SFERUM_SWR_DRILL=0; production — только явный SFERUM_SWR_DRILL=1."""
    flag = os.getenv("SFERUM_SWR_DRILL", "").strip().lower()
    if _env() in {"demo", "test"}:
        return flag not in _FALSE
    return flag in _TRUE


class SlidingWindow:
    """Не больше limit запросов за seconds с одного адреса (память процесса, ограниченная по ключам)."""

    MAX_KEYS = 4096

    def __init__(self, limit: int, seconds: float) -> None:
        self.limit, self.seconds = limit, seconds
        self.hits: dict[str, deque[float]] = {}

    def allow(self, key: str, now: float | None = None) -> bool:
        moment = time.monotonic() if now is None else now
        queue = self.hits.get(key)
        if queue is None:
            if len(self.hits) >= self.MAX_KEYS:
                for stale in [k for k, q in self.hits.items() if not q or q[-1] <= moment - self.seconds]:
                    self.hits.pop(stale, None)
                if len(self.hits) >= self.MAX_KEYS:
                    self.hits.pop(next(iter(self.hits)))
            queue = self.hits[key] = deque()
        while queue and queue[0] <= moment - self.seconds:
            queue.popleft()
        if len(queue) >= self.limit:
            return False
        queue.append(moment)
        return True

    def clear(self) -> None:
        self.hits.clear()


DEEP_LIMIT = SlidingWindow(30, 60.0)
PROBE_LIMIT = SlidingWindow(6, 60.0)
DRILL_LIMIT = SlidingWindow(6, 60.0)


def _peer(request: Request) -> str:
    # Адрес соединения, а не X-Forwarded-For клиента (как platform_routes.rate).
    return request.client.host if request.client else "unknown"


_loop_locks: dict[str, tuple[asyncio.AbstractEventLoop, asyncio.Lock]] = {}


def _lock(name: str) -> asyncio.Lock:
    """asyncio.Lock текущего цикла событий (TestClient и uvicorn могут жить в разных циклах)."""
    loop = asyncio.get_running_loop()
    held = _loop_locks.get(name)
    if held is None or held[0] is not loop:
        held = _loop_locks[name] = (loop, asyncio.Lock())
    return held[1]


def _iso(ts: float | None = None) -> str:
    return datetime.fromtimestamp(time.time() if ts is None else ts, timezone.utc).isoformat(timespec="seconds")


def _ms(start: float) -> float:
    return round((time.perf_counter() - start) * 1000, 2)


# ------------------------------------------------------------------ groq
_probe_cache: dict[str, Any] = {"at": 0.0, "value": None}


async def probe_groq() -> dict[str, Any]:
    """Живой GET /models тем же транспортом, что и чат (прокси/таймауты/повторы соединения). Ключ не печатается."""
    from app import ai_engine as ai

    from app import ai_gate
    if not ai_gate.external_enabled():
        # Central gate: with external AI disabled nothing is sent to the provider, not even a probe.
        return {"status": "skipped", "reason": "external_ai_disabled"}
    if not ai.has_key():
        return {"status": "skipped", "reason": "no_key"}
    if getattr(ai, "GROQ_BASE_URL", OFFICIAL_GROQ) != OFFICIAL_GROQ:
        return {"status": "skipped", "reason": "non_official_base_url"}
    started = time.perf_counter()
    result: dict[str, Any]
    try:
        async with ai.groq_client(PROBE_TIMEOUT) as client:
            response = await client.get(OFFICIAL_GROQ + "/models", headers=ai._headers("models"))
    except httpx.TimeoutException:
        result = {"status": "timeout", "http": None}
    except httpx.HTTPError as exc:
        result = {"status": "network", "http": None, "error": type(exc).__name__}
    else:
        code = response.status_code
        result = {"status": "ok" if code == 200 else ai.classify_status(code), "http": code}
    result.update(ms=_ms(started), checked_at=_iso())
    return result


async def cached_probe() -> dict[str, Any]:
    fresh = _probe_cache["value"] is not None and time.monotonic() - _probe_cache["at"] < PROBE_TTL
    if fresh:
        return {**_probe_cache["value"], "cached": True}
    async with _lock("groq-probe"):
        # Пока ждали замок, соседний запрос мог уже проверить — не идём к Groq второй раз (single-flight).
        if _probe_cache["value"] is not None and time.monotonic() - _probe_cache["at"] < PROBE_TTL:
            return {**_probe_cache["value"], "cached": True}
        value = await probe_groq()
        _probe_cache.update(at=time.monotonic(), value=value)
        return {**value, "cached": False}


def groq_section(probe: dict[str, Any] | None) -> dict[str, Any]:
    from app import ai_engine as ai
    from app import config

    snap = metrics.snapshot()
    outcomes: dict[str, int] = {}
    for counts in snap["ai_calls"].values():
        for outcome, n in counts.items():
            outcomes[outcome] = outcomes.get(outcome, 0) + int(n)
    fallbacks = sum(sum(v.values()) for v in snap["fallback"].values())
    breaker_left = max(0.0, ai._breaker["open_until"] - time.monotonic())
    proxy = ai.proxy_enabled()
    configured = ai.has_key()
    proxy_error = getattr(config, "GROQ_PROXY_ERROR", "") or None
    degraded = (not configured or breaker_left > 0 or bool(proxy_error)
                or (probe is not None and probe.get("status") not in {"ok", "skipped"}))
    return {
        "status": "degraded" if degraded else "ok",
        "configured": configured,
        "route": "proxy" if proxy else "direct",
        "proxy_config_error": proxy_error,
        "breaker": {"state": "open" if breaker_left > 0 else "closed", "retry_in_s": round(breaker_left, 1),
                    "consecutive_failures": int(ai._breaker["fails"])},
        "calls": outcomes,
        "fallbacks": fallbacks,
        # Без ключа/при 403/сбое прокси репетитор отвечает status=degraded_gracefully с планом метода (app/socratic_guide.py).
        "fallback_mode": "socratic_guide",
        "probe": probe,
        "live_verified": bool(probe and probe.get("status") == "ok"),
    }


# ------------------------------------------------------------------ platform store sections
def _platform_on() -> bool:
    from app.platform_auth import enabled

    return enabled()


def _store() -> Any:
    from app.platform_auth import store

    return store()


def _engine() -> str:
    from app import school_fuzzy

    return getattr(school_fuzzy, "ENGINE", "unknown")


def school_search_section() -> dict[str, Any]:
    from app.school_fuzzy import search_schools

    if not _platform_on():
        return {"status": "disabled", "reason": "platform_mode_off", "engine": _engine()}
    try:
        repo = _store()
    except (ValueError, OSError, sqlite3.Error) as exc:
        return {"status": "disabled", "reason": "store_not_configured", "error": type(exc).__name__, "engine": _engine()}
    try:
        with repo.tx() as db:
            indexed = int(db.execute("SELECT COUNT(*) FROM schools_directory s JOIN sgo_hosts_registry h"
                                     " ON s.host_id=h.host_id WHERE h.is_active=1").fetchone()[0])
        timings = []
        for kind, query in SEARCH_PROBES:
            started = time.perf_counter()
            items = search_schools(repo, query, None, 5)
            timings.append({"kind": kind, "query": query, "ms": _ms(started), "results": len(items)})
    except (OSError, sqlite3.Error) as exc:
        logger.warning("deep_health school_search_failed kind=%s", type(exc).__name__)
        return {"status": "fail", "reason": "query_failed", "error": type(exc).__name__, "engine": _engine()}
    worst = max(t["ms"] for t in timings)
    status = "ok" if indexed and worst <= SEARCH_BUDGET_MS else "degraded"
    return {"status": status, "engine": _engine(), "indexed_schools": indexed, "probes": timings,
            "worst_ms": worst, "budget_ms": SEARCH_BUDGET_MS,
            "reason": None if status == "ok" else ("directory_empty" if not indexed else "slow")}


def swr_section() -> dict[str, Any]:
    from app.sgo_adapter import CACHE_FRESH_SECONDS, UPSTREAM_TIMEOUT

    base = {"engine": f"sqlite {sqlite3.sqlite_version}", "fresh_ttl_s": CACHE_FRESH_SECONDS,
            "upstream_timeout_s": UPSTREAM_TIMEOUT, "encrypted_payloads": True}
    if not _platform_on():
        return {"status": "disabled", "reason": "platform_mode_off", **base}
    try:
        repo = _store()
    except (ValueError, OSError, sqlite3.Error) as exc:
        return {"status": "disabled", "reason": "store_not_configured", "error": type(exc).__name__, **base}
    started = time.perf_counter()
    stamp = int(time.time())
    try:
        with repo.tx() as db:
            journal = str(db.execute("PRAGMA journal_mode").fetchone()[0])
            total, fresh = db.execute(
                "SELECT COUNT(*), COALESCE(SUM(expires_at > ?), 0) FROM sgo_data_cache", (stamp,)).fetchone()
    except (OSError, sqlite3.Error) as exc:
        logger.warning("deep_health swr_failed kind=%s", type(exc).__name__)
        return {"status": "fail", "reason": "cache_unreadable", "error": type(exc).__name__, **base}
    total, fresh = int(total), int(fresh or 0)
    return {"status": "ok", **base, "journal_mode": journal, "entries": total, "fresh": fresh, "stale": total - fresh,
            "read_ms": _ms(started)}


# ------------------------------------------------------------------ MAX bridge (HMAC)
def _launch(fields: dict[str, str], digest: str) -> str:
    # decodeURIComponent-совместимо: пробел → %20 (как у официального клиента MAX), не «+».
    return urlencode({**fields, "hash": digest}, quote_via=quote)


def max_section() -> dict[str, Any]:
    from app import config
    from app.max_auth import InitDataError, auth_mode, sign, validate

    token = secrets.token_urlsafe(32)             # одноразовый: настоящий MAX_BOT_TOKEN в самопроверке не участвует
    now = int(time.time())

    def fields(uid: int, stamp: int) -> dict[str, str]:
        user = json.dumps({"id": uid, "first_name": "Self test"}, separators=(",", ":"))
        return {"auth_date": str(stamp), "query_id": "deep-health", "user": user}

    def rejected(launch: str, key: str) -> bool:
        try:
            validate(launch, key, 3600)
        except InitDataError:
            return True
        return False

    genuine = fields(1, now)
    launch = _launch(genuine, sign(genuine, token))
    started = time.perf_counter_ns()
    try:
        accepted = validate(launch, token, 3600)["user"]["id"] == 1
    except InitDataError:
        accepted = False
    verify_us = round((time.perf_counter_ns() - started) / 1000, 1)
    checks = {
        "valid_accepted": accepted,
        "tampered_rejected": rejected(_launch(fields(2, now), sign(genuine, token)), token),
        "wrong_token_rejected": rejected(launch, secrets.token_urlsafe(32)),
        "expired_rejected": rejected(_launch(fields(1, now - 7200), sign(fields(1, now - 7200), token)), token),
        "future_rejected": rejected(_launch(fields(1, now + 3600), sign(fields(1, now + 3600), token)), token),
    }
    live = metrics.snapshot()["ops"].get("max_initdata", {})
    mode = auth_mode(config.MAX_BOT_TOKEN, config.MAX_REQUIRE_AUTH)
    return {"status": "ok" if all(checks.values()) else "fail", "algorithm": "HMAC-SHA256 · ключ HMAC(WebAppData, токен бота)",
            "self_test": checks, "verify_us": verify_us, "mode": mode, "production_ready": mode == "required",
            "bot_token_configured": bool(config.MAX_BOT_TOKEN), "max_age_s": int(config.MAX_AUTH_MAX_AGE),
            "launches": {"verified": int(live.get("verified", 0)), "rejected": int(live.get("rejected", 0))}}


# ------------------------------------------------------------------ report
_report_cache: dict[bool, tuple[float, dict[str, Any]]] = {}


def overall(sections: dict[str, dict[str, Any]]) -> str:
    states = {s.get("status") for s in sections.values()}
    return "fail" if "fail" in states else "degraded" if "degraded" in states else "ok"


async def deep_report(*, probe: bool = False) -> dict[str, Any]:
    hit = _report_cache.get(probe)
    if hit and time.monotonic() - hit[0] < REPORT_TTL:
        return {**hit[1], "cached": True}
    started = time.perf_counter()
    probe_result = await cached_probe() if probe else None
    search, swr = await asyncio.gather(asyncio.to_thread(school_search_section), asyncio.to_thread(swr_section))
    sections = {"groq": groq_section(probe_result), "school_search": search, "swr_cache": swr, "max_bridge": max_section()}
    body = {"status": overall(sections), "version": __version__, "release": __release__, "checked_at": _iso(), "duration_ms": _ms(started),
            "sections": sections, "cached": False}
    _report_cache[probe] = (time.monotonic(), body)
    return body


def _too_many(text: str) -> JSONResponse:
    return JSONResponse({"detail": text}, status_code=429, headers={**NO_STORE, "Retry-After": "60"})


@router.get(DEEP_PATH, include_in_schema=False)
async def health_deep(request: Request, probe: bool = False) -> JSONResponse:
    if not deep_enabled():
        return JSONResponse({"detail": "Not Found"}, status_code=404, headers=NO_STORE)
    peer = _peer(request)
    if not DEEP_LIMIT.allow(peer) or (probe and not PROBE_LIMIT.allow(peer)):
        return _too_many("Слишком часто: телеметрия обновляется не чаще 30 раз в минуту")
    body = await deep_report(probe=probe)
    return JSONResponse(body, status_code=503 if body["status"] == "fail" else 200, headers=NO_STORE)


# ------------------------------------------------------------------ SWR drill («СГО упал»)
class _DrillUpstream:
    """Учебный «сервер СГО»: отвечает, падает с 503 или медлит — по команде учений."""

    def __init__(self, payload: dict[str, Any]) -> None:
        self.payload, self.down, self.delay, self.calls = payload, False, 0.0, 0

    async def fetch(self) -> dict[str, Any]:
        from app.diary_providers import ProviderUnavailable

        self.calls += 1
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.down:
            raise ProviderUnavailable("HTTP 503 (учения)")
        return json.loads(json.dumps(self.payload))


def _drill_payload(today: date) -> dict[str, Any]:
    from app.diary_providers import DiarySnapshot, Grade
    from app.sgo_adapter import student_payload

    stamp = today.isoformat()
    snapshot = DiarySnapshot(
        days={stamp: [{"lesson_number": 1, "start_time": "08:30", "end_time": "09:10", "subject": "Алгебра"},
                      {"lesson_number": 2, "start_time": "09:20", "end_time": "10:00", "subject": "Русский язык"}]},
        tasks=[{"title": "Алгебра: № 214–216", "deadline": stamp, "type": "written"}],
        grades=[Grade(subject="Алгебра", value="4", date=stamp, work_type="Самостоятельная"),
                Grade(subject="Русский язык", value="5", date=stamp, work_type="Диктант")])
    return {"role": "student", "school": {"scid": "drill", "name": "Школа учений"},
            "student_data": student_payload(snapshot, today)}


_drill_dir: Path | None = None


def _drill_db() -> Path:
    """Один приватный каталог на процесс (0700); учения идут по одному, файл базы удаляется после каждых."""
    global _drill_dir
    if _drill_dir is None or not _drill_dir.is_dir():
        _drill_dir = Path(tempfile.mkdtemp(prefix="sf-swr-drill-"))
    return _drill_dir / "drill.sqlite3"


def _wipe(path: Path) -> None:
    for item in (path, path.with_name(path.name + "-journal")):
        try:
            item.unlink()
        except FileNotFoundError:
            pass


def _step(sid: str, title: str, expect: str, body: dict[str, Any], *, calls: int, ms: float, ok: bool) -> dict[str, Any]:
    data = body.get("student_data") or {}
    return {"id": sid, "title": title, "expect": expect, "http_status": 200, "status": body.get("status"),
            "is_stale": body.get("is_stale"), "cached_at": body.get("cached_at"), "reason": body.get("reason"),
            "grades_state": data.get("grades_state"), "grades_shown": len(data.get("grades") or []),
            "upstream_calls": calls, "ms": ms, "passed": bool(ok)}


async def run_swr_drill() -> dict[str, Any]:
    from cryptography.fernet import Fernet

    from app import sgo_adapter, sgo_profiles as profiles
    from app.diary_vault import EncryptedDiaryVault
    from app.onboarding_routes import present
    from app.platform_store import PlatformStore
    from app.session_cipher import SessionCipher

    path = _drill_db()
    _wipe(path)
    uid = "drill:" + secrets.token_hex(8)
    started = time.perf_counter()
    try:
        repo = await asyncio.to_thread(PlatformStore, path, secrets.token_urlsafe(48))
        vault = EncryptedDiaryVault(repo, Fernet.generate_key().decode())
        # Только одноразовые ключи: даже при заданном DIARY_AES_KEYRING_JSON ключи продакшена учения не видят.
        vault.records = SessionCipher({"v1": secrets.token_bytes(32)}, "v1")
        upstream = _DrillUpstream(_drill_payload(date.today()))

        class DrillAdapter(sgo_adapter.SGOMultiRegionAdapter):
            async def _fetch(self, session: profiles.SgoSession) -> dict[str, Any]:
                return await upstream.fetch()

        sgo = DrillAdapter(repo, vault)
        profiles.update_profile(repo, uid, role="student", scid="drill", school_name="Школа учений",
                                onboarding_completed=True)
        profiles.save_session(repo, vault, uid=uid, role="student", scid="drill", base_url="https://sgo.drill.invalid",
                              login="drill", native={"access_token": secrets.token_hex(16), "cookies": []}, ttl=3600)

        async def view(refresh: bool) -> dict[str, Any]:
            return present(await sgo.overview(uid, refresh=refresh), profiles.get_profile(repo, uid))

        steps: list[dict[str, Any]] = []
        t = time.perf_counter()
        fresh = await view(True)
        steps.append(_step("fresh", "СГО отвечает", "200 · is_stale=false · оценки ok", fresh, calls=upstream.calls,
                           ms=_ms(t), ok=fresh["status"] == "ok" and fresh["is_stale"] is False
                           and fresh["student_data"]["grades_state"] == "ok" and upstream.calls == 1))

        upstream.down = True
        t, before = time.perf_counter(), upstream.calls
        stale = await view(True)
        steps.append(_step("outage", "СГО вернул 503", "200 · is_stale=true · cached_at · stale_cache", stale,
                           calls=upstream.calls - before, ms=_ms(t),
                           ok=stale["is_stale"] is True and stale["cached_at"] == fresh["cached_at"]
                           and stale["reason"] == "upstream_unavailable"
                           and stale["student_data"]["grades_state"] == "stale_cache"
                           and len(stale["student_data"]["grades"]) == len(fresh["student_data"]["grades"])))

        upstream.down, upstream.delay = False, 0.15
        def _expire() -> None:  # копия «протухла»: следующие запросы обязаны освежить её (DB-01: в пуле потоков)
            with repo.tx() as db:
                db.execute("UPDATE sgo_data_cache SET expires_at=0 WHERE user_id=?", (uid,))
        await asyncio.to_thread(_expire)
        t, before = time.perf_counter(), upstream.calls
        burst = await asyncio.gather(*(view(False) for _ in range(5)))
        calls = upstream.calls - before
        steps.append(_step("single_flight", "5 запросов одновременно", "1 поход в СГО · все 200 is_stale=false",
                           burst[-1], calls=calls, ms=_ms(t),
                           ok=calls == 1 and all(b["is_stale"] is False and b["status"] == "ok" for b in burst)))

        upstream.down, upstream.delay = True, 0.0
        profiles.update_profile(repo, uid, hide_grades=True)
        t, before = time.perf_counter(), upstream.calls
        private = await view(True)
        steps.append(_step("privacy_over_stale", "Сбой + «Скрывать оценки»", "200 · is_stale=true · privacy_hidden · 0 оценок",
                           private, calls=upstream.calls - before, ms=_ms(t),
                           ok=private["is_stale"] is True and private["student_data"]["grades_state"] == "privacy_hidden"
                           and private["student_data"]["grades"] == []))
    finally:
        for registry in (sgo_adapter._user_sgo_locks, sgo_adapter._lock_loops, sgo_adapter._refreshed_at):
            registry.pop(uid, None)
        await asyncio.to_thread(_wipe, path)
    return {"drill": "sgo_outage_swr", "passed": all(s["passed"] for s in steps), "steps": steps,
            "total_ms": _ms(started), "checked_at": _iso(),
            "code_path": ["SGOMultiRegionAdapter.overview", "sgo_profiles.cache_put/cache_get", "onboarding_routes.present"],
            "isolation": "временная зашифрованная база с одноразовыми ключами; реальные пользователи и СГО не затрагиваются"}


@router.post(DRILL_PATH, include_in_schema=False)
async def health_swr_drill(request: Request) -> JSONResponse:
    if not drill_enabled():
        return JSONResponse({"detail": "Учения SWR на этом сервере выключены", "reason_code": "swr_drill_disabled"},
                            status_code=404, headers=NO_STORE)
    if not DRILL_LIMIT.allow(_peer(request)):
        return _too_many("Слишком часто: учения можно запускать до 6 раз в минуту")
    lock = _lock("swr-drill")
    if lock.locked():
        return JSONResponse({"detail": "Учения уже идут — подождите секунду", "reason_code": "swr_drill_busy"},
                            status_code=409, headers=NO_STORE)
    async with lock:
        try:
            report = await run_swr_drill()
        except Exception as exc:  # учения не должны ронять процесс; причина — только класс ошибки
            logger.warning("swr_drill_failed kind=%s", type(exc).__name__)
            return JSONResponse({"drill": "sgo_outage_swr", "passed": False, "steps": [], "error": type(exc).__name__},
                                status_code=500, headers=NO_STORE)
    return JSONResponse(report, status_code=200, headers=NO_STORE)
