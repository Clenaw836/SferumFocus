"""Isolated server-side demo sandboxes: the jury runs teacher -> student -> teacher on the real backend.

Guarantees (see docs/IMPLEMENTATION_REPORT.md, P0-02)
------------------------------------------------------
* A sandbox is created anonymously (``POST /api/v1/demo/session``) and identified by a random id.
  Its credential is an HMAC-SHA256 signed bearer token in the ``X-Demo-Session`` header.  The persona
  (the synthetic teacher or one of the synthetic students) is part of the signed claims, so a client can
  never pick an arbitrary identity or role: switching persona asks the server for a new token.
* Sandbox identities live in the reserved ``demo:<sid>:<persona>`` namespace.  The gate strips every client
  ``X-User-Id`` in that namespace, so no other client (legacy demo, browser) can impersonate a persona.
* A request with a valid token bypasses host authentication (there is no host identity in a sandbox) and is
  marked ``request.state.demo_sandbox``.  Role and data source decisions treat it as synthetic ``demo`` data;
  school data, diaries and account endpoints are refused.
* Assignment rows of a sandbox carry its id in the teacher id (``<teacher>@<sid>``) and in every student key,
  so two sandboxes never see each other's classes, assignments, attempts or results.
* Production profile: disabled unless ``SFERUM_DEMO_SANDBOX=1`` and a signing key of at least 32 bytes
  (``DEMO_SANDBOX_KEY`` or ``SESSION_SIGNING_KEY``).  Mixing a token with MAX/Telegram launch data is a 400.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import secrets
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

logger = logging.getLogger("sferumfocus.demo_sandbox")

HEADER = b"x-demo-session"
NAMESPACE = "demo:"
TOKEN_VERSION = "v1"
DEFAULT_TTL_SEC = 6 * 3600
CREATE_LIMIT_PER_HOUR = 30            # per client address
MAX_ACTIVE = 500                      # whole server
SESSION_PATH = "/api/v1/demo/session"
# Real accounts, diaries and shared links never belong to a synthetic persona.
REFUSED_PREFIXES = ("/api/v1/auth/", "/api/v1/diary/", "/api/platform/", "/api/v1/shared/", "/api/v1/handoff/")

TEACHER_ID = "demo-t-math2"
CLASS_NAME = "8А"
SCHOOL_NAME = "DEMO · Школа №1 (синтетическая)"
PERSONAS: dict[str, dict[str, Any]] = {
    "teacher": {"role": "teacher", "full_name": "Орлова Елена Викторовна", "label": "Учитель · алгебра, геометрия",
                "teacher": TEACHER_ID},
    "s1": {"role": "student", "full_name": "Котова Алина", "label": f"Ученица {CLASS_NAME}", "class": CLASS_NAME},
    "s2": {"role": "student", "full_name": "Лебедев Глеб", "label": f"Ученик {CLASS_NAME}", "class": CLASS_NAME},
    "s3": {"role": "student", "full_name": "Миронова Ника", "label": f"Ученица {CLASS_NAME} · заявка ждёт учителя",
           "class": CLASS_NAME},
}
# A classmate without the app: exists only in the teacher's roster (mixed class).
OFFLINE_STUDENTS = ("Фёдоров Тимур",)

_TRUE = {"1", "true", "yes", "on"}
_process_key = secrets.token_bytes(32)


class SandboxError(Exception):
    def __init__(self, status: int, detail: str, reason: str):
        super().__init__(detail)
        self.status, self.detail, self.reason = status, detail, reason


def _profile() -> str:
    return os.getenv("SFERUM_ENV", "production").strip().lower()


def _configured_key() -> bytes:
    for name in ("DEMO_SANDBOX_KEY", "SESSION_SIGNING_KEY"):
        raw = os.getenv(name, "").encode()
        if len(raw) >= 32:
            return raw
    return b""


def enabled() -> bool:
    """demo/test: on unless SFERUM_DEMO_SANDBOX=0.  production: only explicit opt-in with a real key."""
    flag = os.getenv("SFERUM_DEMO_SANDBOX", "").strip().lower()
    if _profile() in {"demo", "test"}:
        return flag not in {"0", "false", "no", "off"}
    return flag in _TRUE and bool(_configured_key())


def _key() -> bytes:
    # Without a configured key tokens are valid for this process only (restart = new demo sessions).
    return _configured_key() or _process_key


def ttl_sec() -> int:
    try:
        return max(600, min(24 * 3600, int(os.getenv("DEMO_SANDBOX_TTL_SEC", str(DEFAULT_TTL_SEC)))))
    except ValueError:
        return DEFAULT_TTL_SEC


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _sign(body: str) -> str:
    return _b64(hmac.new(_key(), f"{TOKEN_VERSION}.{body}".encode(), hashlib.sha256).digest())


def issue_token(sid: str, persona: str, expires: int) -> str:
    if persona not in PERSONAS:
        raise SandboxError(422, "Неизвестная демо-персона", "demo_persona_unknown")
    body = _b64(json.dumps({"s": sid, "p": persona, "e": int(expires)}, separators=(",", ":")).encode())
    return f"{TOKEN_VERSION}.{body}.{_sign(body)}"


def read_token(token: str, now: float | None = None) -> dict[str, Any] | None:
    """Signature, expiry and shape only; the store decides whether the sandbox still exists."""
    try:
        if len(token) > 600:
            return None
        version, body, sig = token.split(".")
        if version != TOKEN_VERSION or not hmac.compare_digest(sig, _sign(body)):
            return None
        claims = json.loads(_unb64(body))
        sid, persona, exp = claims["s"], claims["p"], int(claims["e"])
    except (ValueError, KeyError, TypeError, json.JSONDecodeError, UnicodeDecodeError):
        return None
    if not (isinstance(sid, str) and len(sid) == 20 and sid.isalnum()) or persona not in PERSONAS:
        return None
    if exp < (time.time() if now is None else now):
        return None
    return {"sid": sid, "persona": persona, "expires": exp}


def user_key(sid: str, persona: str) -> str:
    return f"{NAMESPACE}{sid}:{persona}"


def sandbox_of_key(key: str | None) -> str | None:
    """Sandbox id of a student key in the reserved namespace, else None."""
    if not key or not key.startswith(NAMESPACE):
        return None
    parts = key.split(":")
    return parts[1] if len(parts) == 3 else None


def sandbox_of_teacher(teacher_id: str | None) -> str | None:
    if not teacher_id or "@" not in teacher_id:
        return None
    return teacher_id.rsplit("@", 1)[1] or None


def base_teacher_id(teacher_id: str) -> str:
    return teacher_id.split("@", 1)[0]


# ------------------------------------------------------------------ store
def _db_path() -> Path:
    from app import config
    return Path(os.getenv("SFERUM_DATA_DIR") or config.SFERUM_DATA_DIR) / "demo_sandbox.sqlite3"


_prepared: set[str] = set()


@contextmanager
def _tx() -> Iterator[sqlite3.Connection]:
    path = _db_path()
    if str(path) not in _prepared or not path.exists():
        # v2.2 · аудит SQLite: файл песочницы — как остальные базы (каталог 0700, файл 0600, владелец — процесс),
        # а не по umask (раньше мог быть 0644 и читаться другими пользователями сервера).
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
        os.close(fd)
        os.chmod(path, 0o600)
        _prepared.add(str(path))
    db = sqlite3.connect(path, timeout=10)
    db.row_factory = sqlite3.Row
    try:
        db.execute("PRAGMA busy_timeout=10000")
        db.execute("PRAGMA journal_mode=WAL")          # v3.0 DB-01
        db.execute("PRAGMA secure_delete=ON")
        db.execute("BEGIN IMMEDIATE")
        db.execute("CREATE TABLE IF NOT EXISTS sandboxes(sid TEXT PRIMARY KEY, created_ms INTEGER NOT NULL, "
                   "expires_ms INTEGER NOT NULL, client TEXT NOT NULL, ended_ms INTEGER)")
        db.execute("CREATE INDEX IF NOT EXISTS sandboxes_client ON sandboxes(client, created_ms)")
        yield db
        db.commit()
    except BaseException:
        db.rollback()
        raise
    finally:
        db.close()


def _client_tag(client: str) -> str:
    # Only a keyed hash of the address is stored (rate limit), never the address itself.
    return hmac.new(_key(), (client or "?").encode(), hashlib.sha256).hexdigest()[:24]


def alive(sid: str, now_ms: int | None = None) -> bool:
    at = int(time.time() * 1000) if now_ms is None else now_ms
    try:
        with _tx() as db:
            row = db.execute("SELECT expires_ms, ended_ms FROM sandboxes WHERE sid=?", (sid,)).fetchone()
    except (OSError, sqlite3.Error) as exc:
        logger.error("Demo sandbox store unavailable: %s", type(exc).__name__)
        return False
    return bool(row) and row["ended_ms"] is None and int(row["expires_ms"]) > at


def create(client: str) -> dict[str, Any]:
    at = int(time.time() * 1000)
    ttl = ttl_sec()
    tag = _client_tag(client)
    sid = secrets.token_hex(10)
    try:
        with _tx() as db:
            expired = [r["sid"] for r in db.execute("SELECT sid FROM sandboxes WHERE ended_ms IS NULL AND expires_ms<=?", (at,))]
            for old in expired:
                db.execute("UPDATE sandboxes SET ended_ms=? WHERE sid=?", (at, old))
            recent = db.execute("SELECT COUNT(*) FROM sandboxes WHERE client=? AND created_ms>?", (tag, at - 3_600_000)).fetchone()[0]
            if recent >= CREATE_LIMIT_PER_HOUR:
                raise SandboxError(429, "Слишком много новых демо-сессий. Продолжите текущую или попробуйте через час.", "demo_rate_limited")
            active = db.execute("SELECT COUNT(*) FROM sandboxes WHERE ended_ms IS NULL AND expires_ms>?", (at,)).fetchone()[0]
            if active >= MAX_ACTIVE:
                raise SandboxError(503, "Демо-сервер занят: слишком много активных демо-сессий.", "demo_capacity")
            db.execute("INSERT INTO sandboxes(sid, created_ms, expires_ms, client) VALUES(?,?,?,?)", (sid, at, at + ttl * 1000, tag))
    except (OSError, sqlite3.Error) as exc:
        raise SandboxError(503, "Хранилище демо-сессий недоступно", "demo_store_unavailable") from exc
    for old in expired:
        _purge(old)
    from app import assignments
    try:
        assignments.seed_sandbox(sid, teacher_id=TEACHER_ID, class_name=CLASS_NAME,
                                 students=[(p, PERSONAS[p]["full_name"]) for p in ("s1", "s2", "s3")],
                                 pending=("s3",), offline=OFFLINE_STUDENTS)
    except assignments.HwError as exc:
        end(sid)
        raise SandboxError(503, "Не удалось подготовить демо-класс: " + exc.detail, "demo_seed_failed") from exc
    return {"sid": sid, "expires": at // 1000 + ttl}


def end(sid: str) -> None:
    at = int(time.time() * 1000)
    try:
        with _tx() as db:
            db.execute("UPDATE sandboxes SET ended_ms=? WHERE sid=? AND ended_ms IS NULL", (at, sid))
    except (OSError, sqlite3.Error) as exc:
        logger.error("Demo sandbox store unavailable: %s", type(exc).__name__)
    _purge(sid)


def _purge(sid: str) -> None:
    from app.teacher_toolkit import ToolkitStore
    try:
        ToolkitStore(_db_path().parent/'teacher_tools.sqlite3').purge_owner('demo:'+sid+':teacher')
    except (OSError,sqlite3.Error):
        logger.warning("Demo tool cleanup postponed")
    from app import assignments
    try:
        assignments.purge_sandbox(sid)
    except assignments.HwError as exc:
        logger.warning("Demo sandbox purge postponed: %s", exc.detail)


def persona_public(persona: str) -> dict[str, Any]:
    p = PERSONAS[persona]
    return {"id": persona, "role": p["role"], "full_name": p["full_name"], "label": p["label"]}


def describe(sid: str, persona: str, expires: int) -> dict[str, Any]:
    return {"sandbox": True, "persona": persona_public(persona), "expires_at": expires,
            "personas": [persona_public(p) for p in PERSONAS], "class": CLASS_NAME, "school": SCHOOL_NAME,
            "offline_students": list(OFFLINE_STUDENTS),
            "notice": "Демо-песочница: вымышленные учитель, класс и ученики. Данные видны только в этой сессии и удаляются после её окончания."}


def state_of(request: Any) -> dict[str, Any] | None:
    """Sandbox claims attached by the gate, or None for every other request."""
    st = getattr(request, "state", None)
    sb = getattr(st, "demo_sandbox", None) if st is not None else None
    return sb if isinstance(sb, dict) else None


# ------------------------------------------------------------------ ASGI gate
async def _deny(send, status: int, detail: str, reason: str) -> None:
    body = json.dumps({"detail": detail, "reason_code": reason}, ensure_ascii=False).encode()
    await send({"type": "http.response.start", "status": status,
                "headers": [(b"content-type", b"application/json; charset=utf-8"), (b"cache-control", b"no-store"),
                            (b"content-length", str(len(body)).encode())]})
    await send({"type": "http.response.body", "body": body})


_STRIP = {b"x-user-id", b"x-auth", b"x-user-role", b"x-demo-teacher", b"x-teacher-token", b"x-verified-principal",
          b"cookie", b"x-csrf-token", b"x-web-bootstrap"}


class DemoSandboxGate:
    """Wraps the host authentication middleware.  Without a sandbox token nothing changes except that the
    reserved ``demo:`` identity namespace is never accepted from a client."""

    def __init__(self, app, auth, **auth_kwargs):
        self.inner = app
        self.auth = auth(app, **auth_kwargs)
        # Middleware chains are walked through ``.app`` (tests, diagnostics): the next hop is the auth layer.
        self.app = self.auth

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope["path"].startswith("/api/"):
            return await self.auth(scope, receive, send)
        headers = scope.get("headers", [])
        tokens = [v for k, v in headers if k.lower() == HEADER]
        cleaned = [(k, v) for k, v in headers
                   if k.lower() != HEADER and not (k.lower() == b"x-user-id" and v.startswith(NAMESPACE.encode()))]
        scope = dict(scope, headers=cleaned)
        if not enabled():
            if scope["path"] == SESSION_PATH or scope["path"].startswith(SESSION_PATH + "/") or scope["path"] == "/api/v1/demo/persona":
                return await _deny(send, 404, "Демо-песочница на этом сервере выключена", "demo_sandbox_disabled")
            return await self.auth(scope, receive, send)
        if not tokens:
            if scope["path"] == SESSION_PATH and scope["method"] == "POST":
                return await self.inner(scope, receive, send)          # anonymous creation, rate-limited in the route
            return await self.auth(scope, receive, send)
        if len(tokens) > 1:
            return await _deny(send, 400, "Повтор заголовка демо-сессии", "demo_session_duplicate")
        if any(k.lower() in (b"x-max-init-data", b"x-telegram-init-data") for k, _ in cleaned):
            return await _deny(send, 400, "Неоднозначная среда запуска: демо-сессия вместе с входом MAX/Telegram", "demo_session_ambiguous")
        claims = read_token(tokens[0].decode("latin-1"))
        if not claims or not alive(claims["sid"]):
            return await _deny(send, 401, "Демо-сессия закончилась. Начните демонстрацию заново.", "demo_session_invalid")
        if scope["path"].startswith(REFUSED_PREFIXES):
            return await _deny(send, 403, "В демо-песочнице недоступно: здесь нет настоящих аккаунтов и дневников.", "demo_sandbox_refused")
        persona = PERSONAS[claims["persona"]]
        key = user_key(claims["sid"], claims["persona"])
        rewritten = [(k, v) for k, v in cleaned if k.lower() not in _STRIP] + [(b"x-user-id", key.encode()), (b"x-auth", b"demo")]
        state = dict(scope.get("state") or {})
        state["demo_sandbox"] = {"sid": claims["sid"], "persona": claims["persona"], "role": persona["role"],
                                 "teacher": persona.get("teacher"), "full_name": persona["full_name"],
                                 "class": persona.get("class"), "expires": claims["expires"], "key": key}
        return await self.inner(dict(scope, headers=rewritten, state=state), receive, send)
