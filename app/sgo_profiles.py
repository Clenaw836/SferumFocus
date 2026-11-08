"""v2.1: профиль пользователя (роль, школа, приватность, размер шрифта), сессии СГО и SWR-кэш.

Три таблицы создаются идемпотентно при старте PlatformStore; недостающие колонки добавляются ALTER.
Чувствительные поля (логин СГО, cookies, токены, кэш с оценками) хранятся только зашифрованными
через EncryptedDiaryVault.seal(uid, purpose, value) — ключ шифрования вне SQLite. Пароль СГО не
хранится нигде. Все запросы параметризованы.
"""
from __future__ import annotations

import json
import secrets
import sqlite3
import time
from dataclasses import dataclass
from typing import Any, Literal, Protocol, cast

Role = Literal["student", "teacher"]
FontScale = Literal["small", "normal", "large", "xlarge"]
ROLES: tuple[Role, ...] = ("student", "teacher")
FONT_SCALES: tuple[FontScale, ...] = ("small", "normal", "large", "xlarge")

SCHEMA = """
CREATE TABLE IF NOT EXISTS user_profiles(
 user_id TEXT PRIMARY KEY,
 role TEXT NOT NULL DEFAULT 'student' CHECK(role IN ('student','teacher')),
 scid TEXT, school_name TEXT, region_code TEXT, sgo_base_url TEXT,
 hide_grades INTEGER NOT NULL DEFAULT 0,
 font_scale TEXT NOT NULL DEFAULT 'normal',
 onboarding_completed INTEGER NOT NULL DEFAULT 0,
 updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sgo_sessions(
 user_id TEXT PRIMARY KEY,
 role TEXT NOT NULL CHECK(role IN ('student','teacher')),
 scid TEXT NOT NULL, sgo_base_url TEXT NOT NULL, sgo_login TEXT NOT NULL,
 cookies_json TEXT NOT NULL, csrf_token TEXT, at_token TEXT, student_id TEXT,
 expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'active');
CREATE TABLE IF NOT EXISTS sgo_data_cache(
 user_id TEXT NOT NULL, role TEXT NOT NULL, cache_key TEXT NOT NULL,
 payload_json TEXT NOT NULL, fetched_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 PRIMARY KEY(user_id, role, cache_key));
CREATE INDEX IF NOT EXISTS sgo_data_cache_expiry ON sgo_data_cache(expires_at);
"""

# Колонки, которых может не быть в базе ранней сборки v2.1-preview. ALTER ADD COLUMN не умеет
# NOT NULL без DEFAULT — поэтому у обязательных полей здесь константные значения по умолчанию.
_ADDITIVE: dict[str, list[tuple[str, str]]] = {
    "user_profiles": [
        ("role", "TEXT NOT NULL DEFAULT 'student'"), ("scid", "TEXT"), ("school_name", "TEXT"),
        ("region_code", "TEXT"), ("sgo_base_url", "TEXT"), ("hide_grades", "INTEGER NOT NULL DEFAULT 0"),
        ("font_scale", "TEXT NOT NULL DEFAULT 'normal'"), ("onboarding_completed", "INTEGER NOT NULL DEFAULT 0"),
        ("updated_at", "INTEGER NOT NULL DEFAULT 0"),
    ],
    "sgo_sessions": [
        ("role", "TEXT NOT NULL DEFAULT 'student'"), ("scid", "TEXT NOT NULL DEFAULT ''"),
        ("sgo_base_url", "TEXT NOT NULL DEFAULT ''"), ("sgo_login", "TEXT NOT NULL DEFAULT ''"),
        ("cookies_json", "TEXT NOT NULL DEFAULT ''"), ("csrf_token", "TEXT"), ("at_token", "TEXT"),
        ("student_id", "TEXT"), ("expires_at", "INTEGER NOT NULL DEFAULT 0"),
        ("updated_at", "INTEGER NOT NULL DEFAULT 0"), ("status", "TEXT NOT NULL DEFAULT 'active'"),
    ],
    "sgo_data_cache": [
        ("payload_json", "TEXT NOT NULL DEFAULT ''"), ("fetched_at", "INTEGER NOT NULL DEFAULT 0"),
        ("expires_at", "INTEGER NOT NULL DEFAULT 0"),
    ],
}


def migrate(db: sqlite3.Connection) -> None:
    """Идемпотентно: CREATE IF NOT EXISTS + ALTER только отсутствующих колонок."""
    for statement in SCHEMA.split(";"):
        if statement.strip():
            db.execute(statement)
    for table, columns in _ADDITIVE.items():
        present = {row[1] for row in db.execute(f"PRAGMA table_info({table})")}
        for name, ddl in columns:
            if name not in present:
                db.execute(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}")


class _Tx(Protocol):
    def tx(self) -> Any: ...


class _Sealer(Protocol):
    def seal(self, uid: str, purpose: str, value: Any) -> str: ...
    def open(self, uid: str, purpose: str, ciphertext: str) -> Any: ...


def now() -> int:
    return int(time.time())


# ------------------------------------------------------------------ user_profiles
DEFAULT_PROFILE: dict[str, Any] = {
    "role": "student", "scid": None, "school_name": None, "region_code": None, "sgo_base_url": None,
    "hide_grades": False, "font_scale": "normal", "onboarding_completed": False, "updated_at": 0,
}


def _public_profile(row: sqlite3.Row | None) -> dict[str, Any]:
    if row is None:
        return dict(DEFAULT_PROFILE)
    data = dict(row)
    return {
        "role": data["role"] if data["role"] in ROLES else "student",
        "scid": data["scid"], "school_name": data["school_name"], "region_code": data["region_code"],
        "sgo_base_url": data["sgo_base_url"], "hide_grades": bool(data["hide_grades"]),
        "font_scale": data["font_scale"] if data["font_scale"] in FONT_SCALES else "normal",
        "onboarding_completed": bool(data["onboarding_completed"]), "updated_at": int(data["updated_at"] or 0),
    }


def get_profile(repo: _Tx, uid: str) -> dict[str, Any]:
    with repo.tx() as db:
        row = db.execute("SELECT * FROM user_profiles WHERE user_id=?", (uid,)).fetchone()
    return _public_profile(row)


_PROFILE_FIELDS = ("role", "scid", "school_name", "region_code", "sgo_base_url", "hide_grades",
                   "font_scale", "onboarding_completed")


def update_profile(repo: _Tx, uid: str, **fields: Any) -> dict[str, Any]:
    """Частичное обновление: меняются только переданные поля (None у строк — очистка)."""
    unknown = set(fields) - set(_PROFILE_FIELDS)
    if unknown:
        raise ValueError("unknown profile fields")
    if "role" in fields and fields["role"] not in ROLES:
        raise ValueError("invalid role")
    if "font_scale" in fields and fields["font_scale"] not in FONT_SCALES:
        raise ValueError("invalid font scale")
    values = {k: (int(bool(v)) if k in {"hide_grades", "onboarding_completed"} else v) for k, v in fields.items()}
    stamp = now()
    with repo.tx() as db:
        db.execute("INSERT INTO user_profiles(user_id, updated_at) VALUES(?, ?) ON CONFLICT(user_id) DO NOTHING", (uid, stamp))
        if values:
            assignments = ", ".join(f"{name}=?" for name in values)  # имена — только из _PROFILE_FIELDS
            db.execute(f"UPDATE user_profiles SET {assignments}, updated_at=? WHERE user_id=?",
                       (*values.values(), stamp, uid))
        row = db.execute("SELECT * FROM user_profiles WHERE user_id=?", (uid,)).fetchone()
    return _public_profile(row)


# ------------------------------------------------------------------ sgo_sessions
@dataclass
class SgoSession:
    user_id: str
    role: Role
    scid: str
    sgo_base_url: str
    login: str
    cookies: list[dict[str, Any]]
    at_token: str
    csrf_token: str | None
    student_id: str | None
    expires_at: int
    updated_at: int
    status: str
    extra: dict[str, Any]

    def as_native(self, host_id: str) -> dict[str, Any]:
        """Формат сессии NetSchoolClient (app/sgo_client.py)."""
        native: dict[str, Any] = {"protocol": "netschool-native-v1", "host_id": host_id,
                                  "access_token": self.at_token, "cookies": self.cookies, **self.extra}
        if self.student_id is not None and self.student_id.isdigit():
            native["student_id"] = int(self.student_id)
        return native


def save_session(repo: _Tx, vault: _Sealer, *, uid: str, role: Role, scid: str, base_url: str, login: str,
                 native: dict[str, Any], ttl: int) -> None:
    """Сохраняет вход СГО. Логин, cookies, токен и служебные поля шифруются; пароль сюда не попадает."""
    if role not in ROLES:
        raise ValueError("invalid role")
    token = native.get("access_token")
    if not isinstance(token, str) or not token:
        raise ValueError("missing provider token")
    cookies = native.get("cookies") or []
    extra = {k: v for k, v in native.items()
             if k in {"year_id", "student_name", "class_name", "provider_school_id", "assignment_types",
                      "last_keep_alive", "school_uid", "user_name", "teacher_roles", "role", "is_teacher", "teacher_verified"}}
    # Новая авторизация всегда получает отдельное поколение кэша, даже если портал повторил токен.
    extra["session_cache_nonce"] = secrets.token_urlsafe(18)
    student = native.get("student_id")
    stamp = now()
    with repo.tx() as db:
        db.execute(
            "INSERT INTO sgo_sessions(user_id, role, scid, sgo_base_url, sgo_login, cookies_json, csrf_token, at_token,"
            " student_id, expires_at, updated_at, status) VALUES(?,?,?,?,?,?,?,?,?,?,?, 'active')"
            " ON CONFLICT(user_id) DO UPDATE SET role=excluded.role, scid=excluded.scid,"
            " sgo_base_url=excluded.sgo_base_url, sgo_login=excluded.sgo_login, cookies_json=excluded.cookies_json,"
            " csrf_token=excluded.csrf_token, at_token=excluded.at_token, student_id=excluded.student_id,"
            " expires_at=excluded.expires_at, updated_at=excluded.updated_at, status='active'",
            (uid, role, scid, base_url, vault.seal(uid, "sgo:login", login),
             vault.seal(uid, "sgo:cookies", {"cookies": cookies, "extra": extra}), None,
             vault.seal(uid, "sgo:at", token), None if student is None else str(student), stamp + ttl, stamp))
        # Новый вход — новые данные: старый кэш другой роли/школы не показываем.
        db.execute("DELETE FROM sgo_data_cache WHERE user_id=?", (uid,))


def load_session(repo: _Tx, vault: _Sealer, uid: str) -> SgoSession | None:
    with repo.tx() as db:
        row = db.execute("SELECT * FROM sgo_sessions WHERE user_id=?", (uid,)).fetchone()
    if row is None:
        return None
    data = dict(row)
    try:
        bundle = vault.open(uid, "sgo:cookies", data["cookies_json"])
        token = vault.open(uid, "sgo:at", data["at_token"]) if data["at_token"] else ""
        login = vault.open(uid, "sgo:login", data["sgo_login"])
    except ValueError:
        # Ключ шифрования сменили или запись повреждена: вход недействителен, данные не раскрываем.
        mark_session(repo, uid, "reauth_required")
        return SgoSession(uid, cast(Role, data["role"]), data["scid"], data["sgo_base_url"], "", [], "", None,
                          data["student_id"], int(data["expires_at"]), int(data["updated_at"]), "reauth_required", {})
    if not isinstance(bundle, dict):
        bundle = {"cookies": [], "extra": {}}
    return SgoSession(uid, cast(Role, data["role"]), data["scid"], data["sgo_base_url"], str(login),
                      list(bundle.get("cookies") or []), str(token or ""), None, data["student_id"],
                      int(data["expires_at"]), int(data["updated_at"]), str(data["status"]),
                      dict(bundle.get("extra") or {}))


def refresh_session(repo: _Tx, vault: _Sealer, session: SgoSession, *, cookies: list[dict[str, Any]],
                    extra: dict[str, Any], ttl: int) -> None:
    stamp = now()
    with repo.tx() as db:
        db.execute("UPDATE sgo_sessions SET cookies_json=?, expires_at=?, updated_at=?, status='active' WHERE user_id=?",
                   (vault.seal(session.user_id, "sgo:cookies", {"cookies": cookies, "extra": extra}),
                    stamp + ttl, stamp, session.user_id))


def mark_session(repo: _Tx, uid: str, status: str) -> None:
    with repo.tx() as db:
        if status in {"reauth_required", "revoked"}:
            # Токен и cookies больше не нужны — стираем шифротекст, оставляя метаданные для UI.
            db.execute("UPDATE sgo_sessions SET status=?, at_token=NULL, cookies_json='', updated_at=? WHERE user_id=?",
                       (status, now(), uid))
        else:
            db.execute("UPDATE sgo_sessions SET status=?, updated_at=? WHERE user_id=?", (status, now(), uid))


def delete_session(repo: _Tx, uid: str) -> None:
    with repo.tx() as db:
        db.execute("DELETE FROM sgo_sessions WHERE user_id=?", (uid,))
        db.execute("DELETE FROM sgo_data_cache WHERE user_id=?", (uid,))


# ------------------------------------------------------------------ sgo_data_cache (SWR)
@dataclass
class CacheEntry:
    payload: dict[str, Any]
    fetched_at: int
    expires_at: int

    @property
    def fresh(self) -> bool:
        return self.expires_at > now()


def cache_put(repo: _Tx, vault: _Sealer, uid: str, role: Role, key: str, payload: dict[str, Any], ttl: int) -> CacheEntry:
    stamp = now()
    sealed = vault.seal(uid, f"sgo-cache:{role}:{key}", payload)
    with repo.tx() as db:
        db.execute("INSERT INTO sgo_data_cache(user_id, role, cache_key, payload_json, fetched_at, expires_at)"
                   " VALUES(?,?,?,?,?,?) ON CONFLICT(user_id, role, cache_key) DO UPDATE SET"
                   " payload_json=excluded.payload_json, fetched_at=excluded.fetched_at, expires_at=excluded.expires_at",
                   (uid, role, key, sealed, stamp, stamp + ttl))
    return CacheEntry(payload, stamp, stamp + ttl)


def cache_get(repo: _Tx, vault: _Sealer, uid: str, role: Role, key: str) -> CacheEntry | None:
    with repo.tx() as db:
        row = db.execute("SELECT payload_json, fetched_at, expires_at FROM sgo_data_cache"
                         " WHERE user_id=? AND role=? AND cache_key=?", (uid, role, key)).fetchone()
    if row is None:
        return None
    try:
        payload = vault.open(uid, f"sgo-cache:{role}:{key}", row[0])
    except ValueError:
        return None
    if not isinstance(payload, dict):
        return None
    return CacheEntry(payload, int(row[1]), int(row[2]))


def iso(ts: int | None) -> str | None:
    if not ts:
        return None
    from datetime import datetime, timezone
    return datetime.fromtimestamp(ts, timezone.utc).isoformat(timespec="seconds")


def dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
