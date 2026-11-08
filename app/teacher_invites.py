"""One-time teacher invitations — replacement for the removed shared TEACHER_TOKEN / X-Teacher-Token.

Guarantees (tests: tests/test_security_step1_invites.py)
* Only the server operator creates invitations (``scripts/teacher_invites.py`` needs access to the server's
  data directory). There is no API that creates, lists or reveals invitations.
* A code carries 80 bits from ``secrets`` (16 symbols of a 32-symbol alphabet without I/O/0/1). It is shown
  once to the operator; the database stores only SHA-256 of the normalised code, never the code.
* Every invitation is bound to exactly one record of the school directory (``TEACHER_DIRECTORY_FILE``):
  teacher id + school id, optionally narrowed to a subset of that record's classes. Permissions always come
  from the directory record; an invitation can only bind an identity to it, never widen it.
* Only a MAX user whose launch data passed the server-side HMAC check (``app.max_auth``) can redeem a code.
  Browser demo, demo sandbox, Telegram and unsigned requests are refused.
* One-time: the code is consumed by a single atomic UPDATE (unused, not revoked, not expired) inside an
  IMMEDIATE transaction, so two concurrent redemptions cannot both succeed.
* Expiring: 72 h by default, 14 days at most. Revocable by the operator (invite and binding).
* Rate-limited: failed attempts are counted per MAX account and per client address (SQLite, survives
  restarts). Unknown, expired, used and revoked codes give the same answer (no enumeration oracle).
* Logs contain the invitation id and a pseudonym of the account — never the code or its hash.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import secrets
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

logger = logging.getLogger("sferumfocus.teacher_invites")

ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"   # 32 symbols: 5 bits each, no I/O/0/1
CODE_LEN = 16                                   # 80 bits
PREFIX = "SFT"
DEFAULT_TTL_HOURS = 72
MAX_TTL_HOURS = 14 * 24
UID_FAILS, UID_WINDOW_MS = 5, 15 * 60 * 1000
CLIENT_FAILS, CLIENT_WINDOW_MS = 20, 60 * 60 * 1000
GENERIC_REFUSAL = "Код приглашения недействителен, истёк или уже использован"

SCHEMA = """
CREATE TABLE IF NOT EXISTS teacher_invites(
 invite_id TEXT PRIMARY KEY, code_sha256 TEXT NOT NULL UNIQUE, teacher_id TEXT NOT NULL, school_id TEXT NOT NULL,
 classes TEXT NOT NULL, created_ms INTEGER NOT NULL, expires_ms INTEGER NOT NULL,
 used_ms INTEGER, used_by TEXT, revoked_ms INTEGER, note TEXT);
CREATE TABLE IF NOT EXISTS teacher_bindings(
 max_uid TEXT PRIMARY KEY, teacher_id TEXT NOT NULL, school_id TEXT NOT NULL, classes TEXT NOT NULL,
 invite_id TEXT NOT NULL, bound_ms INTEGER NOT NULL, revoked_ms INTEGER);
CREATE TABLE IF NOT EXISTS teacher_invite_attempts(
 bucket TEXT PRIMARY KEY, window_start_ms INTEGER NOT NULL, failures INTEGER NOT NULL);
"""


class InviteError(Exception):
    def __init__(self, status: int, detail: str, reason: str, retry_after: int | None = None):
        super().__init__(detail)
        self.status, self.detail, self.reason, self.retry_after = status, detail, reason, retry_after


def _now_ms() -> int:
    return int(time.time() * 1000)


def _db_path() -> Path:
    from app.config import SFERUM_DATA_DIR
    return Path(os.getenv("SFERUM_DATA_DIR") or SFERUM_DATA_DIR) / "teacher_invites.sqlite3"


@contextmanager
def _tx() -> Iterator[sqlite3.Connection]:
    path = _db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=5, isolation_level=None)
    try:
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA busy_timeout=5000")
        db.execute("PRAGMA journal_mode=WAL")          # v3.0 DB-01
        db.executescript(SCHEMA)
        db.execute("BEGIN IMMEDIATE")
        try:
            yield db
        except BaseException:
            db.execute("ROLLBACK")
            raise
        db.execute("COMMIT")
    finally:
        db.close()
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def normalize(code: Any) -> str | None:
    """'sft-abcd efgh-…' → 'ABCDEFGH…' (16 symbols of ALPHABET) or None."""
    if not isinstance(code, str) or len(code) > 64:
        return None
    raw = "".join(ch for ch in code.upper() if ch not in " -_\t")
    if raw.startswith(PREFIX) and len(raw) == len(PREFIX) + CODE_LEN:
        raw = raw[len(PREFIX):]
    if len(raw) != CODE_LEN or any(ch not in ALPHABET for ch in raw):
        return None
    return raw


def _digest(normalized: str) -> str:
    return hashlib.sha256(("sferumfocus-teacher-invite-v1:" + normalized).encode()).hexdigest()


def format_code(normalized: str) -> str:
    return PREFIX + "-" + "-".join(normalized[i:i + 4] for i in range(0, CODE_LEN, 4))


def pseudonym(value: str) -> str:
    return hashlib.sha256(("teacher-invite-subject:" + value).encode()).hexdigest()[:10]


def _directory_record(teacher_id: str, school_id: str | None = None) -> dict[str, Any] | None:
    from app.teacher_mode import school_directory
    hit = [t for t in school_directory() if t.get("id") == teacher_id and (school_id is None or t.get("school_id") == school_id)]
    return hit[0] if len(hit) == 1 else None


def _school_people() -> list[dict[str, Any]]:
    from app.teacher_mode import school_directory
    return list(school_directory())


def _record_classes(record: dict[str, Any]) -> set[str]:
    return {a.get("class") for a in record.get("assignments") or [] if isinstance(a, dict) and a.get("class")}


# ------------------------------------------------------------------ operator side (CLI only)
def create(teacher_id: str, classes: list[str] | None = None, ttl_hours: int = DEFAULT_TTL_HOURS,
           note: str | None = None, now_ms: int | None = None) -> dict[str, Any]:
    record = _directory_record(teacher_id)
    if not record:
        raise InviteError(404, "Учитель не найден в справочнике школы (TEACHER_DIRECTORY_FILE)", "teacher_not_in_directory")
    wanted = sorted({c.strip() for c in (classes or []) if c and c.strip()})
    unknown = [c for c in wanted if c not in _record_classes(record)]
    if unknown:
        raise InviteError(422, "Классы не входят в назначения учителя в справочнике", "class_not_in_directory")
    if not isinstance(ttl_hours, int) or not 1 <= ttl_hours <= MAX_TTL_HOURS:
        raise InviteError(422, f"Срок действия — от 1 до {MAX_TTL_HOURS} часов", "invalid_ttl")
    at = _now_ms() if now_ms is None else now_ms
    normalized = "".join(secrets.choice(ALPHABET) for _ in range(CODE_LEN))
    invite_id = "inv_" + secrets.token_hex(6)
    with _tx() as db:
        db.execute("INSERT INTO teacher_invites(invite_id,code_sha256,teacher_id,school_id,classes,created_ms,expires_ms,note)"
                   " VALUES(?,?,?,?,?,?,?,?)",
                   (invite_id, _digest(normalized), record["id"], record["school_id"], json.dumps(wanted, ensure_ascii=False),
                    at, at + ttl_hours * 3600 * 1000, (note or "")[:120] or None))
    logger.info("teacher_invite created invite=%s school=%s classes=%d ttl_h=%d", invite_id, record["school_id"], len(wanted), ttl_hours)
    return {"invite_id": invite_id, "code": format_code(normalized), "teacher_id": record["id"],
            "school_id": record["school_id"], "classes": wanted, "expires_ms": at + ttl_hours * 3600 * 1000}


def list_invites(now_ms: int | None = None) -> list[dict[str, Any]]:
    at = _now_ms() if now_ms is None else now_ms
    with _tx() as db:
        rows = db.execute("SELECT invite_id,teacher_id,school_id,classes,created_ms,expires_ms,used_ms,used_by,revoked_ms,note"
                          " FROM teacher_invites ORDER BY created_ms").fetchall()
    out = []
    for r in rows:
        state = ("revoked" if r["revoked_ms"] else "used" if r["used_ms"] else "expired" if r["expires_ms"] <= at else "active")
        out.append({"invite_id": r["invite_id"], "teacher_id": r["teacher_id"], "school_id": r["school_id"],
                    "classes": json.loads(r["classes"]), "state": state, "expires_ms": r["expires_ms"],
                    "used_by": pseudonym(r["used_by"]) if r["used_by"] else None, "note": r["note"]})
    return out


def revoke_invite(invite_id: str, now_ms: int | None = None) -> bool:
    with _tx() as db:
        n = db.execute("UPDATE teacher_invites SET revoked_ms=? WHERE invite_id=? AND revoked_ms IS NULL AND used_ms IS NULL",
                       (_now_ms() if now_ms is None else now_ms, invite_id)).rowcount
    logger.info("teacher_invite revoked invite=%s changed=%s", invite_id, bool(n))
    return bool(n)


def unbind(max_uid: str, now_ms: int | None = None) -> bool:
    with _tx() as db:
        n = db.execute("UPDATE teacher_bindings SET revoked_ms=? WHERE max_uid=? AND revoked_ms IS NULL",
                       (_now_ms() if now_ms is None else now_ms, max_uid)).rowcount
    logger.info("teacher_binding revoked subject=%s changed=%s", pseudonym(max_uid), bool(n))
    return bool(n)


# ------------------------------------------------------------------ teacher side (verified MAX only)
def _limited(db: sqlite3.Connection, bucket: str, limit: int, window_ms: int, at: int) -> int | None:
    row = db.execute("SELECT window_start_ms, failures FROM teacher_invite_attempts WHERE bucket=?", (bucket,)).fetchone()
    if row and at - row["window_start_ms"] < window_ms and row["failures"] >= limit:
        return max(1, (row["window_start_ms"] + window_ms - at) // 1000)
    return None


def _fail(db: sqlite3.Connection, bucket: str, window_ms: int, at: int) -> None:
    row = db.execute("SELECT window_start_ms, failures FROM teacher_invite_attempts WHERE bucket=?", (bucket,)).fetchone()
    if not row or at - row["window_start_ms"] >= window_ms:
        db.execute("INSERT INTO teacher_invite_attempts(bucket,window_start_ms,failures) VALUES(?,?,1)"
                   " ON CONFLICT(bucket) DO UPDATE SET window_start_ms=excluded.window_start_ms, failures=1", (bucket, at))
    else:
        db.execute("UPDATE teacher_invite_attempts SET failures=failures+1 WHERE bucket=?", (bucket,))


def redeem(max_uid: str, code: Any, client: str, now_ms: int | None = None) -> dict[str, Any]:
    """Bind a verified MAX account (``max_uid`` = numeric id, no prefix) to the invitation's directory record."""
    if not isinstance(max_uid, str) or not max_uid or not max_uid.isdigit():
        raise InviteError(401, "Откройте приложение в MAX, чтобы принять приглашение", "verified_max_required")
    at = _now_ms() if now_ms is None else now_ms
    uid_bucket, client_bucket = "uid:" + pseudonym(max_uid), "client:" + pseudonym(client or "unknown")
    failure: InviteError | None = None
    result: dict[str, Any] | None = None
    with _tx() as db:
        wait = _limited(db, uid_bucket, UID_FAILS, UID_WINDOW_MS, at) or _limited(db, client_bucket, CLIENT_FAILS, CLIENT_WINDOW_MS, at)
        if wait:
            raise InviteError(429, "Слишком много попыток ввода кода. Попробуйте позже", "rate_limited", retry_after=int(wait))
        active = db.execute("SELECT teacher_id FROM teacher_bindings WHERE max_uid=? AND revoked_ms IS NULL", (max_uid,)).fetchone()
        normalized = normalize(code)
        row = None
        if normalized:
            row = db.execute("SELECT * FROM teacher_invites WHERE code_sha256=?", (_digest(normalized),)).fetchone()
        usable = bool(row) and row["used_ms"] is None and row["revoked_ms"] is None and row["expires_ms"] > at
        record = _directory_record(row["teacher_id"], row["school_id"]) if usable else None
        mapped = sorted(t.get("id") for t in _school_people() if max_uid in (t.get("max_ids") or [])) if usable else []
        if usable and (active or (mapped and (not record or mapped != [record["id"]]))):
            # The code stays unused: one account maps to one directory record (an invitation binding or the
            # school's own max_ids mapping); the operator unbinds / fixes the directory first.
            failure = InviteError(409, "Этот аккаунт MAX уже привязан к профилю учителя", "already_bound")
        elif not usable or not record:
            _fail(db, uid_bucket, UID_WINDOW_MS, at)
            _fail(db, client_bucket, CLIENT_WINDOW_MS, at)
            failure = InviteError(403, GENERIC_REFUSAL, "invite_invalid")
        else:
            classes = json.loads(row["classes"])
            if classes and not set(classes) <= _record_classes(record):
                failure = InviteError(403, GENERIC_REFUSAL, "invite_invalid")
            else:
                n = db.execute("UPDATE teacher_invites SET used_ms=?, used_by=? WHERE invite_id=? AND used_ms IS NULL"
                               " AND revoked_ms IS NULL AND expires_ms>?", (at, max_uid, row["invite_id"], at)).rowcount
                if n != 1:
                    failure = InviteError(403, GENERIC_REFUSAL, "invite_invalid")
                else:
                    db.execute("INSERT INTO teacher_bindings(max_uid,teacher_id,school_id,classes,invite_id,bound_ms)"
                               " VALUES(?,?,?,?,?,?) ON CONFLICT(max_uid) DO UPDATE SET teacher_id=excluded.teacher_id,"
                               " school_id=excluded.school_id, classes=excluded.classes, invite_id=excluded.invite_id,"
                               " bound_ms=excluded.bound_ms, revoked_ms=NULL",
                               (max_uid, record["id"], record["school_id"], row["classes"], row["invite_id"], at))
                    result = {"status": "bound", "teacher_id": record["id"], "school_id": record["school_id"],
                              "classes": classes or sorted(_record_classes(record))}
    if failure:
        logger.info("teacher_invite refused reason=%s subject=%s", failure.reason, pseudonym(max_uid))
        raise failure
    assert result is not None
    logger.info("teacher_invite redeemed subject=%s school=%s", pseudonym(max_uid), result["school_id"])
    return result


def binding(max_uid: str | None) -> dict[str, Any] | None:
    """Active binding of a verified MAX id (numeric, no prefix) or None. Storage errors fail closed."""
    if not max_uid:
        return None
    try:
        path = _db_path()
        if not path.exists():
            return None
        with _tx() as db:
            row = db.execute("SELECT teacher_id, school_id, classes FROM teacher_bindings WHERE max_uid=? AND revoked_ms IS NULL",
                             (max_uid,)).fetchone()
    except (sqlite3.Error, OSError, ValueError):
        logger.warning("teacher_binding store unavailable — teacher access via invitation refused")
        return None
    if not row:
        return None
    return {"teacher_id": row["teacher_id"], "school_id": row["school_id"], "classes": json.loads(row["classes"])}
