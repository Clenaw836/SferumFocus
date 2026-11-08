"""Recovery 2: teacher -> individual student assignments with a server timer.

Storage is SQLite.  With PLATFORM_AUTH_ENABLED the tables live in
``platform.sqlite3`` (additive, versioned migration run from
``PlatformStore.__init__``).  Explicit legacy/demo deployments use
``SFERUM_DATA_DIR/assignments.sqlite3`` with the same schema and the same
transaction discipline (process flock + ``BEGIN IMMEDIATE`` + synchronous=FULL).

Trust model
-----------
* Identities are never taken from the request body.  Teachers come from
  ``app.main._tctx`` (school directory for verified MAX, explicit demo selection
  otherwise); students are the ``x-user-id`` rewritten by the auth middleware.
* A teacher never receives a student account key.  Roster rows expose an opaque
  ``roster_id`` and the display name the student typed when joining.
* Every query is scoped by ``source`` + ``school_id`` + ``teacher_id`` (teacher)
  or ``source`` + ``student_key`` (student).  Foreign ids answer 404, so there is
  no existence oracle.
* Every mutation is keyed by ``X-Idempotency-Key`` inside the same transaction
  that performs it: a retried request replays the stored response, a key reused
  for a different request is a 409.

Time model (see docs/recovery-2/TIME_ACCOUNTING.md)
---------------------------------------------------
``planned`` minutes come from the teacher.  ``timer`` is the sum of server
segments between start/resume and pause/complete, anchored to the server receive
time minus the delay reported by the device (device clock offsets cancel out).
``confirmed`` only counts gaps of at most 90 s between consecutive signals that
the server received live (heartbeats while the app is visible and the timer is
running).  It proves that the app was open with a running timer, not attention.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import secrets
import sqlite3
import time
import unicodedata
import uuid
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Iterator

from app.json_storage import file_lock

logger = logging.getLogger("sferumfocus.assignments")

COMPONENT = "assignments"
SCHEMA_VERSION = 4
KINDS = ("task", "quiz")
ACCESS = ("app", "offline")
SOURCES = ("demo", "school")
STATUSES = ("assigned", "in_progress", "paused", "completed", "revoked")
OPEN = ("assigned", "in_progress", "paused")
CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
CODE_LEN = 8
CODE_TTL_MS = 7 * 86_400_000
JOIN_LIMIT, JOIN_WINDOW_MS = 10, 600_000
LIVE_DELAY_MS = 15_000          # a signal delivered later than this is not "live"
HEARTBEAT_GAP_MS = 90_000       # longest credited gap between two live signals
HEARTBEAT_MIN_MS = 10_000       # closer heartbeats are acknowledged without a write
MAX_DELAY_MS = 7 * 86_400_000   # device-reported delivery delay is clamped to this
MAX_TIMER_MS = 12 * 3_600_000   # same ceiling as the device timer (lib/focus.ts)
DELAYED_FLAG_MS = 60_000        # events delivered later than this are flagged for the teacher
DUPLICATE_WINDOW_MS = 10 * 60_000
OPS_RETENTION_MS = 30 * 86_400_000
MAX_ROSTER = 200

MIGRATIONS: list[tuple[int, str]] = [(1, """
CREATE TABLE IF NOT EXISTS hw_class_codes(
 code TEXT PRIMARY KEY,
 source TEXT NOT NULL CHECK(source IN ('demo','school')),
 school_id TEXT NOT NULL, teacher_id TEXT NOT NULL, class_name TEXT NOT NULL,
 created_ms INTEGER NOT NULL, expires_ms INTEGER NOT NULL, revoked_ms INTEGER);
CREATE INDEX IF NOT EXISTS hw_codes_owner ON hw_class_codes(source,school_id,teacher_id,class_name);
CREATE TABLE IF NOT EXISTS hw_roster(
 roster_id TEXT PRIMARY KEY,
 source TEXT NOT NULL CHECK(source IN ('demo','school')),
 school_id TEXT NOT NULL, teacher_id TEXT NOT NULL, class_name TEXT NOT NULL,
 student_key TEXT NOT NULL, display_name TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','active','rejected','removed','left')),
 origin TEXT NOT NULL DEFAULT 'join_code',
 requested_ms INTEGER NOT NULL, decided_ms INTEGER, updated_ms INTEGER NOT NULL,
 UNIQUE(source,school_id,teacher_id,class_name,student_key));
CREATE INDEX IF NOT EXISTS hw_roster_student ON hw_roster(source,student_key);
CREATE TABLE IF NOT EXISTS hw_templates(
 template_id TEXT PRIMARY KEY,
 source TEXT NOT NULL CHECK(source IN ('demo','school')),
 school_id TEXT NOT NULL, teacher_id TEXT NOT NULL, teacher_name TEXT NOT NULL,
 class_name TEXT NOT NULL, subject TEXT NOT NULL, title TEXT NOT NULL,
 instructions TEXT NOT NULL DEFAULT '',
 task_type TEXT NOT NULL CHECK(task_type IN ('written','oral')),
 planned_minutes INTEGER NOT NULL CHECK(planned_minutes BETWEEN 1 AND 600),
 due_date TEXT, revision INTEGER NOT NULL DEFAULT 1,
 created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL, archived_ms INTEGER);
CREATE INDEX IF NOT EXISTS hw_templates_owner ON hw_templates(source,school_id,teacher_id,archived_ms);
CREATE TABLE IF NOT EXISTS hw_issues(
 issue_id TEXT PRIMARY KEY,
 template_id TEXT NOT NULL REFERENCES hw_templates(template_id),
 roster_id TEXT NOT NULL REFERENCES hw_roster(roster_id),
 source TEXT NOT NULL, school_id TEXT NOT NULL, teacher_id TEXT NOT NULL, student_key TEXT NOT NULL,
 teacher_name TEXT NOT NULL, class_name TEXT NOT NULL, subject TEXT NOT NULL, title TEXT NOT NULL,
 instructions TEXT NOT NULL DEFAULT '', task_type TEXT NOT NULL, planned_minutes INTEGER NOT NULL,
 due_date TEXT, snapshot_revision INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('assigned','in_progress','paused','completed','revoked')),
 issued_ms INTEGER NOT NULL, first_started_ms INTEGER, run_started_ms INTEGER,
 timer_ms INTEGER NOT NULL DEFAULT 0, segments INTEGER NOT NULL DEFAULT 0,
 confirmed_ms INTEGER NOT NULL DEFAULT 0, last_signal_ms INTEGER,
 last_effective_ms INTEGER NOT NULL, pomodoro_round INTEGER NOT NULL DEFAULT 0,
 completed_ms INTEGER, completed_study_day TEXT, client_elapsed_sec INTEGER,
 revoked_ms INTEGER, revision INTEGER NOT NULL DEFAULT 1, updated_ms INTEGER NOT NULL,
 UNIQUE(template_id,roster_id));
CREATE INDEX IF NOT EXISTS hw_issues_student ON hw_issues(source,student_key,status);
CREATE INDEX IF NOT EXISTS hw_issues_template ON hw_issues(template_id);
CREATE TABLE IF NOT EXISTS hw_events(
 event_id TEXT PRIMARY KEY,
 issue_id TEXT NOT NULL REFERENCES hw_issues(issue_id),
 seq INTEGER NOT NULL, kind TEXT NOT NULL,
 actor TEXT NOT NULL CHECK(actor IN ('teacher','student','system')),
 received_ms INTEGER NOT NULL, effective_ms INTEGER NOT NULL, delay_ms INTEGER NOT NULL DEFAULT 0,
 op_key TEXT, status_before TEXT, status_after TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}',
 UNIQUE(issue_id,seq), UNIQUE(issue_id,op_key));
CREATE TABLE IF NOT EXISTS hw_operations(
 scope TEXT NOT NULL, op_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
 response TEXT NOT NULL, created_ms INTEGER NOT NULL, PRIMARY KEY(scope,op_key));
CREATE INDEX IF NOT EXISTS hw_operations_created ON hw_operations(created_ms);
CREATE TABLE IF NOT EXISTS hw_limits(bucket TEXT PRIMARY KEY, expires_ms INTEGER NOT NULL, attempts INTEGER NOT NULL)
"""), (2, """
ALTER TABLE hw_templates ADD COLUMN kind TEXT NOT NULL DEFAULT 'task';
ALTER TABLE hw_templates ADD COLUMN quiz_json TEXT;
ALTER TABLE hw_issues ADD COLUMN kind TEXT NOT NULL DEFAULT 'task';
ALTER TABLE hw_issues ADD COLUMN quiz_json TEXT;
ALTER TABLE hw_issues ADD COLUMN seen_ms INTEGER;
ALTER TABLE hw_issues ADD COLUMN manual_json TEXT;
ALTER TABLE hw_roster ADD COLUMN access TEXT NOT NULL DEFAULT 'app';
CREATE TABLE IF NOT EXISTS hw_quiz_attempts(
 issue_id TEXT PRIMARY KEY REFERENCES hw_issues(issue_id),
 student_key TEXT NOT NULL, started_ms INTEGER NOT NULL, submitted_ms INTEGER,
 answers TEXT NOT NULL DEFAULT '[]', detail TEXT NOT NULL DEFAULT '[]',
 score INTEGER, max_score INTEGER, late INTEGER NOT NULL DEFAULT 0, overtime INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS hw_attempts_student ON hw_quiz_attempts(student_key)
"""), (3, """
CREATE TABLE IF NOT EXISTS hw_guest_pins(
 pin_id TEXT PRIMARY KEY, pin TEXT NOT NULL,
 template_id TEXT NOT NULL REFERENCES hw_templates(template_id),
 source TEXT NOT NULL CHECK(source IN ('demo','school')),
 school_id TEXT NOT NULL, teacher_id TEXT NOT NULL, teacher_name TEXT NOT NULL,
 class_name TEXT NOT NULL, subject TEXT NOT NULL, title TEXT NOT NULL, quiz_json TEXT NOT NULL,
 created_ms INTEGER NOT NULL, expires_ms INTEGER NOT NULL, revoked_ms INTEGER);
CREATE INDEX IF NOT EXISTS hw_guest_pins_pin ON hw_guest_pins(pin, expires_ms);
CREATE INDEX IF NOT EXISTS hw_guest_pins_tpl ON hw_guest_pins(template_id);
CREATE TABLE IF NOT EXISTS hw_guest_attempts(
 attempt_id TEXT PRIMARY KEY, pin_id TEXT NOT NULL REFERENCES hw_guest_pins(pin_id),
 template_id TEXT NOT NULL, guest_key TEXT NOT NULL, display_name TEXT NOT NULL,
 answers TEXT NOT NULL DEFAULT '[]', detail TEXT NOT NULL DEFAULT '[]',
 score INTEGER NOT NULL, max_score INTEGER NOT NULL, quiz_json TEXT NOT NULL, submitted_ms INTEGER NOT NULL,
 UNIQUE(pin_id, guest_key));
CREATE INDEX IF NOT EXISTS hw_guest_attempts_tpl ON hw_guest_attempts(template_id)
"""), (4, """
DELETE FROM hw_guest_attempts;
DELETE FROM hw_guest_pins;
DELETE FROM hw_limits WHERE bucket LIKE 'guest_%'
""")]


class HwError(Exception):
    """Domain refusal translated to an HTTP status by the routes."""

    def __init__(self, http_status: int, detail: str, /, **extra: Any):
        super().__init__(detail)
        self.status, self.detail, self.extra = http_status, detail, extra


class SchemaTooNew(RuntimeError):
    """The database was written by a newer release; refuse instead of guessing."""


def _now_ms() -> int:
    return int(time.time() * 1000)


_clock: Callable[[], int] = _now_ms      # tests replace this with a controllable clock


def now() -> int:
    return int(_clock())


def iso(ms: int | None) -> str | None:
    if ms is None:
        return None
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


# ------------------------------------------------------------------ schema
def migrate(db: sqlite3.Connection) -> int:
    """Additive, versioned and idempotent.  Never rewrites or drops older tables."""
    db.execute("CREATE TABLE IF NOT EXISTS schema_versions(component TEXT PRIMARY KEY, "
               "version INTEGER NOT NULL, applied_ms INTEGER NOT NULL)")
    row = db.execute("SELECT version FROM schema_versions WHERE component=?", (COMPONENT,)).fetchone()
    current = int(row[0]) if row else 0
    if current > SCHEMA_VERSION:
        raise SchemaTooNew(f"{COMPONENT} schema v{current} is newer than supported v{SCHEMA_VERSION}")
    for version, ddl in MIGRATIONS:
        if version <= current:
            continue
        for statement in ddl.split(";"):
            if statement.strip():
                db.execute(statement)
        db.execute("INSERT INTO schema_versions(component,version,applied_ms) VALUES(?,?,?) "
                   "ON CONFLICT(component) DO UPDATE SET version=excluded.version, applied_ms=excluded.applied_ms",
                   (COMPONENT, version, _now_ms()))
    return SCHEMA_VERSION


_schema_error: str | None = None


def platform_migrate(db: sqlite3.Connection) -> None:
    """Hook for PlatformStore: a newer schema disables assignments, not sign-in."""
    global _schema_error
    try:
        migrate(db)
        _schema_error = None
    except SchemaTooNew as exc:
        _schema_error = str(exc)
        logger.error("Assignments disabled: %s", exc)


class Repo:
    def __init__(self, tx: Callable[[], Any], label: str):
        self._tx, self.label = tx, label

    @contextmanager
    def tx(self) -> Iterator[sqlite3.Connection]:
        with self._tx() as db:
            yield db


_legacy_repos: dict[str, Repo] = {}


def _legacy_repo(path: Path) -> Repo:
    key = str(path.resolve())
    hit = _legacy_repos.get(key)
    if hit and path.exists():
        return hit
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    os.close(fd)
    os.chmod(path, 0o600)   # v2.2: и для уже существующего файла (O_CREAT не меняет права старого)

    @contextmanager
    def tx() -> Iterator[sqlite3.Connection]:
        with file_lock(path):
            db = sqlite3.connect(path, timeout=10)
            db.row_factory = sqlite3.Row
            try:
                db.execute("PRAGMA busy_timeout=10000")
                db.execute("PRAGMA journal_mode=WAL")      # v3.0 DB-01: читатели не ждут писателя
                db.execute("PRAGMA synchronous=FULL")
                db.execute("PRAGMA foreign_keys=ON")
                db.execute("PRAGMA secure_delete=ON")
                db.execute("BEGIN IMMEDIATE")
                yield db
                db.commit()
            except BaseException:
                db.rollback()
                raise
            finally:
                db.close()

    with tx() as db:
        migrate(db)
    repo = Repo(tx, "legacy:" + path.name)
    _legacy_repos[key] = repo
    return repo


def repo() -> Repo:
    from app.platform_auth import enabled, store
    if enabled():
        try:
            platform = store()
        except (ValueError, OSError, sqlite3.Error) as exc:
            raise HwError(503, "Хранилище заданий недоступно") from exc
        if _schema_error:
            raise HwError(503, "Схема данных заданий новее этой версии приложения")
        return Repo(platform.tx, "platform")
    from app import config
    try:
        # Same resolution as app/schedule.py: the environment wins, then the startup config.
        return _legacy_repo(Path(os.getenv("SFERUM_DATA_DIR") or config.SFERUM_DATA_DIR) / "assignments.sqlite3")
    except SchemaTooNew as exc:
        raise HwError(503, "Схема данных заданий новее этой версии приложения") from exc
    except (OSError, sqlite3.Error) as exc:
        raise HwError(503, "Хранилище заданий недоступно") from exc


# ------------------------------------------------------------------ helpers
def _id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


_CTRL = re.compile(r"[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]")


def clean_line(value: str, limit: int) -> str:
    text = unicodedata.normalize("NFC", _CTRL.sub(" ", value or ""))
    return re.sub(r"\s+", " ", text).strip()[:limit]


def clean_text(value: str, limit: int) -> str:
    text = unicodedata.normalize("NFC", (value or "").replace("\r\n", "\n"))
    text = "\n".join(re.sub(r"[ \t]+", " ", _CTRL.sub(" ", line)).strip() for line in text.split("\n"))
    return re.sub(r"\n{3,}", "\n\n", text).strip()[:limit]


def normalize_code(value: str) -> str:
    return re.sub(r"[\s\-_]", "", (value or "").upper())


def pretty_code(code: str) -> str:
    return code[:4] + "-" + code[4:]


def _fingerprint(obj: Any) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def _rows(cur: sqlite3.Cursor) -> list[dict[str, Any]]:
    return [dict(r) for r in cur.fetchall()]


def _one(cur: sqlite3.Cursor) -> dict[str, Any] | None:
    r = cur.fetchone()
    return dict(r) if r else None


def teacher_scope(actor: dict[str, Any]) -> str:
    return f"t|{actor['source']}|{actor['school_id']}|{actor['teacher_id']}"


def student_scope(source: str, student_key: str) -> str:
    return f"s|{source}|{student_key}"


def mutate(scope: str, op_key: str, request_fingerprint: Any, fn: Callable[[sqlite3.Connection], dict[str, Any]]) -> tuple[dict[str, Any], bool]:
    """Run ``fn`` exactly once per (scope, key) in one transaction with its replay record."""
    from app.progress import IdempotencyConflict
    fp = _fingerprint(request_fingerprint)
    with repo().tx() as db:
        prior = db.execute("SELECT fingerprint,response FROM hw_operations WHERE scope=? AND op_key=?",
                           (scope, op_key)).fetchone()
        if prior:
            if prior["fingerprint"] != fp:
                raise IdempotencyConflict("X-Idempotency-Key уже использован для другого запроса")
            return json.loads(prior["response"]), True
        result = fn(db)
        stamp = now()
        db.execute("INSERT INTO hw_operations(scope,op_key,fingerprint,response,created_ms) VALUES(?,?,?,?,?)",
                   (scope, op_key, fp, json.dumps(result, ensure_ascii=False), stamp))
        db.execute("DELETE FROM hw_operations WHERE created_ms<?", (stamp - OPS_RETENTION_MS,))
        return result, False


def read(fn: Callable[[sqlite3.Connection], Any]) -> Any:
    with repo().tx() as db:
        return fn(db)


# ------------------------------------------------------------------ permissions
def can_assign(t: dict[str, Any], cls: str, subject: str | None = None) -> bool:
    """Teaching (class, subject) in the directory implies homework rights unless
    the directory explicitly sets perms.assign_homework=false."""
    for a in t.get("assignments", []) or []:
        if a.get("class") == cls and (subject is None or a.get("subject") == subject):
            if (a.get("perms") or {}).get("assign_homework", True) is not False:
                return True
    return False


def teacher_classes(t: dict[str, Any]) -> list[dict[str, Any]]:
    out: dict[str, list[str]] = {}
    for a in t.get("assignments", []) or []:
        if can_assign(t, a.get("class"), a.get("subject")):
            out.setdefault(a["class"], [])
            if a["subject"] not in out[a["class"]]:
                out[a["class"]].append(a["subject"])
    def grade(c: str) -> tuple[int, str]:
        m = re.match(r"(\d+)", c)
        return (int(m.group(1)) if m else 0, c)
    return [{"class": c, "subjects": s} for c, s in sorted(out.items(), key=lambda kv: grade(kv[0]))]


def actor_of(t: dict[str, Any], source: str, sandbox: str | None = None) -> dict[str, Any]:
    """A demo sandbox scopes every row by ``<teacher>@<sandbox>``: sandboxes never share classes or results."""
    teacher_id = str(t["id"]) + (f"@{sandbox}" if sandbox else "")
    return {"source": source, "school_id": str(t["school_id"]), "teacher_id": teacher_id,
            "teacher_name": str(t.get("full_name") or t["id"]), "t": t, "sandbox": sandbox}


def _owner(actor: dict[str, Any]) -> tuple[str, str, str]:
    return actor["source"], actor["school_id"], actor["teacher_id"]


def _require_class(actor: dict[str, Any], cls: str, subject: str | None = None) -> None:
    if not can_assign(actor["t"], cls, subject):
        raise HwError(403, "Нет права выдавать задания этому классу" + (" по этому предмету" if subject else ""))


# ------------------------------------------------------------------ views
def timer_ms(r: dict[str, Any], at: int) -> int:
    t = int(r["timer_ms"])
    if r["status"] == "in_progress" and r["run_started_ms"] is not None:
        t += max(0, at - int(r["run_started_ms"]))
    return min(t, MAX_TIMER_MS)


def _confirmed_ms(r: dict[str, Any], at: int) -> int:
    return min(int(r["confirmed_ms"]), timer_ms(r, at))


def student_view(r: dict[str, Any], at: int | None = None) -> dict[str, Any]:
    at = now() if at is None else at
    return {
        "issue_id": r["issue_id"], "template_id": r["template_id"], "class": r["class_name"], "subject": r["subject"],
        "title": r["title"], "instructions": r["instructions"], "type": r["task_type"],
        "planned_minutes": r["planned_minutes"], "due_date": r["due_date"], "teacher_name": r["teacher_name"],
        "status": r["status"], "issued_at": iso(r["issued_ms"]), "first_started_at": iso(r["first_started_ms"]),
        "completed_at": iso(r["completed_ms"]), "completed_study_day": r["completed_study_day"],
        "timer_sec": timer_ms(r, at) // 1000, "confirmed_sec": _confirmed_ms(r, at) // 1000,
        "running_since": iso(r["run_started_ms"]) if r["status"] == "in_progress" else None,
        "segments": r["segments"], "pomodoro_round": r["pomodoro_round"], "revision": r["revision"],
        "snapshot_revision": r["snapshot_revision"], "is_demo": r["source"] == "demo", "server_now": iso(at),
        "kind": r.get("kind") or "task", "seen_at": iso(r.get("seen_ms")), "quiz": _quiz_summary(r),
    }


def _teacher_issue_view(r: dict[str, Any], at: int) -> dict[str, Any]:
    wall = (int(r["completed_ms"]) - int(r["first_started_ms"])) // 1000 if r["completed_ms"] and r["first_started_ms"] else None
    return {
        "issue_id": r["issue_id"], "roster_id": r["roster_id"], "display_name": r.get("display_name") or "Ученик",
        "member_status": r.get("member_status"), "status": r["status"], "issued_at": iso(r["issued_ms"]),
        "first_started_at": iso(r["first_started_ms"]), "completed_at": iso(r["completed_ms"]),
        "revoked_at": iso(r["revoked_ms"]), "timer_sec": timer_ms(r, at) // 1000,
        "confirmed_sec": _confirmed_ms(r, at) // 1000, "wall_sec": wall, "segments": r["segments"],
        "pomodoro_round": r["pomodoro_round"], "running": r["status"] == "in_progress",
        "running_since": iso(r["run_started_ms"]) if r["status"] == "in_progress" else None,
        "last_signal_at": iso(r["last_signal_ms"]), "client_elapsed_sec": r["client_elapsed_sec"],
        "snapshot_revision": r["snapshot_revision"], "revision": r["revision"], "updated_at": iso(r["updated_ms"]),
        "delayed_events": int(r.get("delayed_events") or 0),
        "kind": r.get("kind") or "task", "seen_at": iso(r.get("seen_ms")), "access": r.get("member_access") or "app",
        "quiz": _quiz_summary(r), "manual": _manual_view(r.get("manual_json")),
    }


def _template_view(r: dict[str, Any], counts: dict[str, int] | None = None) -> dict[str, Any]:
    c = {s: 0 for s in STATUSES}
    c.update(counts or {})
    return {
        "template_id": r["template_id"], "class": r["class_name"], "subject": r["subject"], "title": r["title"],
        "instructions": r["instructions"], "type": r["task_type"], "planned_minutes": r["planned_minutes"],
        "due_date": r["due_date"], "revision": r["revision"], "created_at": iso(r["created_ms"]),
        "updated_at": iso(r["updated_ms"]), "archived_at": iso(r["archived_ms"]),
        "is_demo": r["source"] == "demo", "counts": {**c, "total": sum(c.values())},
        "kind": r.get("kind") or "task", "quiz": _quiz_brief(r.get("quiz_json")),
    }


def _member_view(r: dict[str, Any]) -> dict[str, Any]:
    return {"roster_id": r["roster_id"], "class": r["class_name"], "display_name": r["display_name"],
            "status": r["status"], "origin": r["origin"], "requested_at": iso(r["requested_ms"]),
            "decided_at": iso(r["decided_ms"]), "access": r.get("access") or "app",
            "last_activity_at": iso(r.get("last_activity_ms"))}


_EVENT_LABELS = {"issued": "Выдано", "reissued": "Выдано повторно", "started": "Начато", "paused": "Пауза",
                 "resumed": "Продолжено", "completed": "Завершено", "revoked": "Отозвано", "updated": "Задание изменено",
                 "seen": "Просмотрено учеником", "manual_result": "Результат внесён учителем",
                 "manual_cleared": "Отметка учителя снята"}


def _event_view(r: dict[str, Any]) -> dict[str, Any]:
    payload = json.loads(r["payload"] or "{}")
    return {"seq": r["seq"], "kind": r["kind"], "label": _EVENT_LABELS.get(r["kind"], r["kind"]), "actor": r["actor"],
            "received_at": iso(r["received_ms"]), "effective_at": iso(r["effective_ms"]),
            "delay_sec": int(r["delay_ms"]) // 1000, "delayed": int(r["delay_ms"]) > DELAYED_FLAG_MS,
            "status_before": r["status_before"], "status_after": r["status_after"], "payload": payload}


# ------------------------------------------------------------------ event log + transitions
def _event(db: sqlite3.Connection, r: dict[str, Any], kind: str, actor: str, received: int, effective: int,
           delay: int, op_key: str | None, before: str | None, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    seq = db.execute("SELECT COALESCE(MAX(seq),0)+1 FROM hw_events WHERE issue_id=?", (r["issue_id"],)).fetchone()[0]
    if op_key is not None and db.execute("SELECT 1 FROM hw_events WHERE issue_id=? AND op_key=?",
                                         (r["issue_id"], op_key)).fetchone():
        op_key = None   # one client operation may touch an issue twice (auto-pause + start); keep the first link
    event = {"event_id": _id("evt"), "issue_id": r["issue_id"], "seq": seq, "kind": kind, "actor": actor,
             "received_ms": received, "effective_ms": effective, "delay_ms": delay, "op_key": op_key,
             "status_before": before, "status_after": r["status"],
             "payload": json.dumps(payload or {}, ensure_ascii=False, sort_keys=True)}
    db.execute("INSERT INTO hw_events(event_id,issue_id,seq,kind,actor,received_ms,effective_ms,delay_ms,op_key,"
               "status_before,status_after,payload) VALUES(:event_id,:issue_id,:seq,:kind,:actor,:received_ms,"
               ":effective_ms,:delay_ms,:op_key,:status_before,:status_after,:payload)", event)
    return event


_ISSUE_MUTABLE = ("status", "first_started_ms", "run_started_ms", "timer_ms", "segments", "confirmed_ms",
                  "last_signal_ms", "last_effective_ms", "pomodoro_round", "completed_ms", "completed_study_day",
                  "client_elapsed_sec", "revoked_ms", "title", "instructions", "task_type", "planned_minutes",
                  "due_date", "snapshot_revision", "quiz_json", "seen_ms", "manual_json")


def _save_issue(db: sqlite3.Connection, r: dict[str, Any], stamp: int) -> None:
    r["revision"] = int(r["revision"]) + 1
    r["updated_ms"] = stamp
    cols = _ISSUE_MUTABLE + ("revision", "updated_ms")
    db.execute("UPDATE hw_issues SET " + ",".join(f"{c}=?" for c in cols) + " WHERE issue_id=?",
               tuple(r[c] for c in cols) + (r["issue_id"],))


def _credit(r: dict[str, Any], received: int, live: bool) -> None:
    last = r["last_signal_ms"]
    if live and last is not None:
        gap = received - int(last)
        if 0 <= gap <= HEARTBEAT_GAP_MS:
            r["confirmed_ms"] = int(r["confirmed_ms"]) + gap


def _stop(r: dict[str, Any], effective: int, received: int, live: bool) -> None:
    """Close a running segment (pause/complete/revoke)."""
    if r["status"] != "in_progress" or r["run_started_ms"] is None:
        return
    _credit(r, received, live)
    r["timer_ms"] = min(MAX_TIMER_MS, int(r["timer_ms"]) + max(0, effective - int(r["run_started_ms"])))
    r["run_started_ms"] = None
    r["last_signal_ms"] = None
    r["confirmed_ms"] = min(int(r["confirmed_ms"]), int(r["timer_ms"]))


def effective_time(r: dict[str, Any], received: int, client_event_at: int | None, client_sent_at: int | None) -> tuple[int, int]:
    """Server receive time minus the delay measured on the device clock.

    Only the device's *relative* measurement is used, so a wrong device clock
    cancels out.  The result never precedes the issue or its previous event and
    never follows the receive time."""
    delay = 0
    if isinstance(client_event_at, int) and isinstance(client_sent_at, int):
        delay = max(0, min(MAX_DELAY_MS, client_sent_at - client_event_at))
    floor = max(int(r["issued_ms"]), int(r["last_effective_ms"]))
    eff = min(received, max(floor, received - delay))
    return eff, received - eff


STUDENT_ACTIONS = ("start", "pause", "resume", "complete")


def _transition(db: sqlite3.Connection, r: dict[str, Any], action: str, actor: str, received: int, effective: int,
                delay: int, op_key: str | None, body: dict[str, Any]) -> dict[str, Any] | None:
    """Apply one state-machine step.  Returns the event or None for an idempotent no-op."""
    status = r["status"]
    live = delay <= LIVE_DELAY_MS
    payload: dict[str, Any] = {}
    if body.get("reason"):
        payload["reason"] = body["reason"]
    if body.get("round"):
        payload["round"] = int(body["round"])
    if action in ("start", "resume"):
        if status == "in_progress":
            return None
        if status not in ("assigned", "paused"):
            raise HwError(409, "Задание уже " + ("выполнено" if status == "completed" else "отозвано учителем"), status=status)
        kind = "started" if status == "assigned" else "resumed"
        r.update(status="in_progress", run_started_ms=effective, segments=int(r["segments"]) + 1,
                 first_started_ms=r["first_started_ms"] or effective, last_signal_ms=received if live else None)
        if body.get("round"):
            r["pomodoro_round"] = max(int(r["pomodoro_round"]), int(body["round"]))
        elif kind == "started" and not r["pomodoro_round"]:
            r["pomodoro_round"] = 1
    elif action == "pause":
        if status in ("assigned", "paused"):
            return None
        if status != "in_progress":
            raise HwError(409, "Задание уже " + ("выполнено" if status == "completed" else "отозвано учителем"), status=status)
        _stop(r, effective, received, live)
        r["status"] = "paused"
        kind = "paused"
    elif action == "complete":
        if status == "completed":
            return None
        if status == "revoked":
            raise HwError(409, "Задание отозвано учителем", status=status)
        _stop(r, effective, received, live)
        day = body.get("study_day")
        r.update(status="completed", completed_ms=effective, completed_study_day=day or iso(effective)[:10],
                 client_elapsed_sec=body.get("client_elapsed_sec"))
        if body.get("client_elapsed_sec") is not None:
            payload["client_elapsed_sec"] = int(body["client_elapsed_sec"])
        if body.get("quiz_max") is not None:
            payload.update(score=int(body["quiz_score"]), max_score=int(body["quiz_max"]))
        if body.get("manual"):
            payload["manual"] = True
        kind = "completed"
    elif action == "revoke":
        if status == "revoked":
            return None
        if status == "completed":
            raise HwError(409, "Выполненное задание нельзя отозвать: история сохраняется", status=status)
        _stop(r, effective, received, False)   # a teacher action is not a student presence signal
        r.update(status="revoked", revoked_ms=effective)
        kind = "revoked"
    else:   # pragma: no cover - routes validate the action
        raise HwError(422, "Неизвестное действие")
    r["last_effective_ms"] = max(int(r["last_effective_ms"]), effective)
    _save_issue(db, r, received)
    return _event(db, r, kind, actor, received, effective, delay, op_key, status, payload)


# ------------------------------------------------------------------ teacher: roster
def _active_code(db: sqlite3.Connection, actor: dict[str, Any], cls: str, at: int) -> dict[str, Any] | None:
    return _one(db.execute("SELECT * FROM hw_class_codes WHERE source=? AND school_id=? AND teacher_id=? AND class_name=? "
                           "AND revoked_ms IS NULL AND expires_ms>? ORDER BY created_ms DESC LIMIT 1",
                           (*_owner(actor), cls, at)))


def _code_view(c: dict[str, Any] | None) -> dict[str, Any] | None:
    return {"code": pretty_code(c["code"]), "expires_at": iso(c["expires_ms"]), "created_at": iso(c["created_ms"])} if c else None


def roster(actor: dict[str, Any], cls: str) -> dict[str, Any]:
    _require_class(actor, cls)
    def q(db: sqlite3.Connection) -> dict[str, Any]:
        at = now()
        members = _rows(db.execute("SELECT r.*, (SELECT MAX(e.received_ms) FROM hw_events e JOIN hw_issues i ON i.issue_id=e.issue_id "
                                   "WHERE i.roster_id=r.roster_id AND e.actor='student') AS last_activity_ms "
                                   "FROM hw_roster r WHERE r.source=? AND r.school_id=? AND r.teacher_id=? AND r.class_name=? "
                                   "AND r.status IN ('pending','active') ORDER BY r.status DESC, r.display_name COLLATE NOCASE, r.requested_ms",
                                   (*_owner(actor), cls)))
        return {"class": cls, "code": _code_view(_active_code(db, actor, cls, at)),
                "members": [_member_view(m) for m in members], "is_demo": actor["source"] == "demo"}
    return read(q)


def ensure_code(actor: dict[str, Any], cls: str, rotate: bool, op_key: str) -> tuple[dict[str, Any], bool]:
    _require_class(actor, cls)
    def op(db: sqlite3.Connection) -> dict[str, Any]:
        at = now()
        current = _active_code(db, actor, cls, at)
        if current and not rotate:
            return {"class": cls, "code": _code_view(current), "rotated": False}
        db.execute("UPDATE hw_class_codes SET revoked_ms=? WHERE source=? AND school_id=? AND teacher_id=? AND class_name=? "
                   "AND revoked_ms IS NULL", (at, *_owner(actor), cls))
        for _ in range(8):
            code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LEN))
            try:
                db.execute("INSERT INTO hw_class_codes(code,source,school_id,teacher_id,class_name,created_ms,expires_ms) "
                           "VALUES(?,?,?,?,?,?,?)", (code, *_owner(actor), cls, at, at + CODE_TTL_MS))
                break
            except sqlite3.IntegrityError:
                continue
        else:   # pragma: no cover - 31^8 space
            raise HwError(503, "Не удалось создать код, попробуйте ещё раз")
        return {"class": cls, "code": _code_view(_active_code(db, actor, cls, at)), "rotated": bool(current)}
    return mutate(teacher_scope(actor), op_key, ["code", cls, rotate], op)


def _owned_member(db: sqlite3.Connection, actor: dict[str, Any], roster_id: str) -> dict[str, Any]:
    m = _one(db.execute("SELECT * FROM hw_roster WHERE roster_id=? AND source=? AND school_id=? AND teacher_id=?",
                        (roster_id, *_owner(actor))))
    if not m or not can_assign(actor["t"], m["class_name"]):
        raise HwError(404, "Ученик не найден в ваших классах")
    return m


def _revoke_open(db: sqlite3.Connection, where: str, args: tuple, actor: str, reason: str, op_key: str | None, at: int) -> int:
    rows = _rows(db.execute("SELECT * FROM hw_issues WHERE status IN ('assigned','in_progress','paused') AND " + where, args))
    for r in rows:
        _transition(db, r, "revoke", actor, at, max(at, int(r["last_effective_ms"])), 0, op_key, {"reason": reason})
    return len(rows)


def decide(actor: dict[str, Any], roster_id: str, approve: bool, op_key: str) -> tuple[dict[str, Any], bool]:
    def op(db: sqlite3.Connection) -> dict[str, Any]:
        m = _owned_member(db, actor, roster_id)
        if m["status"] not in ("pending", "active", "rejected"):
            raise HwError(409, "Заявка уже закрыта: ученик вышел или удалён из класса")
        at = now()
        status = "active" if approve else "rejected"
        revoked = 0
        if m["status"] != status:
            db.execute("UPDATE hw_roster SET status=?, decided_ms=?, updated_ms=? WHERE roster_id=?", (status, at, at, roster_id))
            if status == "rejected":
                revoked = _revoke_open(db, "roster_id=?", (roster_id,), "teacher", "student_rejected", op_key, at)
        m.update(status=status, decided_ms=at if m["status"] != status else m["decided_ms"])
        return {"member": _member_view(m), "revoked_issues": revoked}
    return mutate(teacher_scope(actor), op_key, ["decide", roster_id, approve], op)


def remove_member(actor: dict[str, Any], roster_id: str, op_key: str) -> tuple[dict[str, Any], bool]:
    def op(db: sqlite3.Connection) -> dict[str, Any]:
        m = _owned_member(db, actor, roster_id)
        at = now()
        revoked = 0
        if m["status"] != "removed":
            db.execute("UPDATE hw_roster SET status='removed', decided_ms=?, updated_ms=? WHERE roster_id=?", (at, at, roster_id))
            revoked = _revoke_open(db, "roster_id=?", (roster_id,), "teacher", "student_removed", op_key, at)
            m.update(status="removed", decided_ms=at)
        return {"member": _member_view(m), "revoked_issues": revoked}
    return mutate(teacher_scope(actor), op_key, ["remove", roster_id], op)


# ------------------------------------------------------------------ teacher: templates & issues
def _owned_template(db: sqlite3.Connection, actor: dict[str, Any], template_id: str) -> dict[str, Any]:
    tpl = _one(db.execute("SELECT * FROM hw_templates WHERE template_id=? AND source=? AND school_id=? AND teacher_id=?",
                          (template_id, *_owner(actor))))
    if not tpl:
        raise HwError(404, "Задание не найдено")
    return tpl


def _counts(db: sqlite3.Connection, template_ids: list[str]) -> dict[str, dict[str, int]]:
    out: dict[str, dict[str, int]] = {}
    if not template_ids:
        return out
    marks = ",".join("?" * len(template_ids))
    for row in db.execute(f"SELECT template_id,status,COUNT(*) n FROM hw_issues WHERE template_id IN ({marks}) "
                          "GROUP BY template_id,status", template_ids):
        out.setdefault(row["template_id"], {})[row["status"]] = row["n"]
    return out


def list_templates(actor: dict[str, Any], cls: str | None, archived: bool) -> dict[str, Any]:
    if cls:
        _require_class(actor, cls)
    def q(db: sqlite3.Connection) -> dict[str, Any]:
        sql = "SELECT * FROM hw_templates WHERE source=? AND school_id=? AND teacher_id=? AND archived_ms IS " + ("NOT NULL" if archived else "NULL")
        args: list[Any] = [*_owner(actor)]
        if cls:
            sql += " AND class_name=?"
            args.append(cls)
        rows = _rows(db.execute(sql + " ORDER BY created_ms DESC LIMIT 200", args))
        counts = _counts(db, [r["template_id"] for r in rows])
        return {"templates": [_template_view(r, counts.get(r["template_id"])) for r in rows], "archived": archived}
    return read(q)


def _active_members(db: sqlite3.Connection, actor: dict[str, Any], cls: str, roster_ids: list[str]) -> list[dict[str, Any]]:
    ids = list(dict.fromkeys(roster_ids))
    if len(ids) > MAX_ROSTER:
        raise HwError(422, f"Не больше {MAX_ROSTER} учеников за раз")
    if not ids:
        return []
    marks = ",".join("?" * len(ids))
    rows = _rows(db.execute(f"SELECT * FROM hw_roster WHERE roster_id IN ({marks}) AND source=? AND school_id=? AND teacher_id=? "
                            "AND class_name=? AND status='active'", (*ids, *_owner(actor), cls)))
    found = {r["roster_id"] for r in rows}
    missing = [i for i in ids if i not in found]
    if missing:
        raise HwError(422, "Выдать можно только подтверждённым ученикам этого класса", invalid_roster_ids=missing)
    order = {rid: n for n, rid in enumerate(ids)}
    return sorted(rows, key=lambda r: order[r["roster_id"]])


def _issue_rows(db: sqlite3.Connection, tpl: dict[str, Any], members: list[dict[str, Any]], op_key: str, at: int) -> dict[str, list[str]]:
    created, reissued, already = [], [], []
    for m in members:
        existing = _one(db.execute("SELECT * FROM hw_issues WHERE template_id=? AND roster_id=?", (tpl["template_id"], m["roster_id"])))
        if existing is None:
            r = {"issue_id": _id("iss"), "template_id": tpl["template_id"], "roster_id": m["roster_id"],
                 "source": tpl["source"], "school_id": tpl["school_id"], "teacher_id": tpl["teacher_id"],
                 "student_key": m["student_key"], "teacher_name": tpl["teacher_name"], "class_name": tpl["class_name"],
                 "subject": tpl["subject"], "title": tpl["title"], "instructions": tpl["instructions"],
                 "task_type": tpl["task_type"], "planned_minutes": tpl["planned_minutes"], "due_date": tpl["due_date"],
                 "snapshot_revision": tpl["revision"], "status": "assigned", "issued_ms": at, "last_effective_ms": at,
                 "revision": 1, "updated_ms": at, "kind": tpl.get("kind") or "task", "quiz_json": tpl.get("quiz_json")}
            db.execute("INSERT INTO hw_issues(" + ",".join(r) + ") VALUES(" + ",".join("?" * len(r)) + ")", tuple(r.values()))
            full = _one(db.execute("SELECT * FROM hw_issues WHERE issue_id=?", (r["issue_id"],)))
            _event(db, full, "issued", "teacher", at, at, 0, op_key, None,
                   {"snapshot_revision": tpl["revision"], "planned_minutes": tpl["planned_minutes"], "due_date": tpl["due_date"]})
            created.append(r["issue_id"])
        elif existing["status"] == "revoked":
            before = existing["status"]
            existing.update(status="paused" if int(existing["timer_ms"]) > 0 else "assigned", revoked_ms=None,
                            title=tpl["title"], instructions=tpl["instructions"], task_type=tpl["task_type"],
                            planned_minutes=tpl["planned_minutes"], due_date=tpl["due_date"], snapshot_revision=tpl["revision"],
                            last_effective_ms=max(at, int(existing["last_effective_ms"])))
            if not _attempt(db, existing["issue_id"]):
                existing["quiz_json"] = tpl.get("quiz_json")
            _save_issue(db, existing, at)
            _event(db, existing, "reissued", "teacher", at, at, 0, op_key, before, {"snapshot_revision": tpl["revision"]})
            reissued.append(existing["issue_id"])
        else:
            already.append(existing["issue_id"])
    return {"created": created, "reissued": reissued, "already": already}


def _fields(payload: dict[str, Any]) -> dict[str, Any]:
    return {"title": clean_line(payload["title"], 120), "instructions": clean_text(payload.get("instructions") or "", 2000),
            "task_type": payload.get("type") or "written", "planned_minutes": int(payload["planned_minutes"]),
            "due_date": payload.get("due_date")}


def _quiz_payload(kind: str, quiz: Any) -> str | None:
    if kind not in KINDS:
        raise HwError(422, "Неизвестный вид задания")
    if kind == "quiz":
        return json.dumps(normalize_quiz(quiz), ensure_ascii=False, sort_keys=True)
    if quiz:
        raise HwError(422, "Вопросы нужны только блиц-опросу")
    return None


def _class_members(db: sqlite3.Connection, actor: dict[str, Any], cls: str) -> list[dict[str, Any]]:
    """Whole class = every confirmed member right now, with or without the app."""
    return _rows(db.execute("SELECT * FROM hw_roster WHERE source=? AND school_id=? AND teacher_id=? AND class_name=? AND status='active' "
                            "ORDER BY display_name COLLATE NOCASE, requested_ms", (*_owner(actor), cls)))


def create_template(actor: dict[str, Any], payload: dict[str, Any], op_key: str) -> tuple[dict[str, Any], bool]:
    cls, subject = payload["class"], clean_line(payload["subject"], 60)
    _require_class(actor, cls, subject)
    fields = _fields(payload)
    if not fields["title"]:
        raise HwError(422, "Название задания не может быть пустым")
    kind = payload.get("kind") or "task"
    quiz_json = _quiz_payload(kind, payload.get("quiz"))
    whole = bool(payload.get("whole_class"))
    def op(db: sqlite3.Connection) -> dict[str, Any]:
        at = now()
        members = _class_members(db, actor, cls) if whole else _active_members(db, actor, cls, payload.get("roster_ids") or [])
        if not payload.get("allow_duplicate"):
            dup = _one(db.execute("SELECT template_id,created_ms FROM hw_templates WHERE source=? AND school_id=? AND teacher_id=? "
                                  "AND class_name=? AND subject=? AND title=? AND instructions=? AND COALESCE(due_date,'')=? "
                                  "AND planned_minutes=? AND kind=? AND COALESCE(quiz_json,'')=? AND archived_ms IS NULL AND created_ms>? "
                                  "ORDER BY created_ms DESC LIMIT 1",
                                  (*_owner(actor), cls, subject, fields["title"], fields["instructions"], fields["due_date"] or "",
                                   fields["planned_minutes"], kind, quiz_json or "", at - DUPLICATE_WINDOW_MS)))
            if dup:
                raise HwError(409, "Такое же задание уже создано несколько минут назад", duplicate_of=dup["template_id"])
        tpl = {"template_id": _id("tpl"), "source": actor["source"], "school_id": actor["school_id"],
               "teacher_id": actor["teacher_id"], "teacher_name": actor["teacher_name"], "class_name": cls,
               "subject": subject, **fields, "revision": 1, "created_ms": at, "updated_ms": at,
               "kind": kind, "quiz_json": quiz_json}
        db.execute("INSERT INTO hw_templates(" + ",".join(tpl) + ") VALUES(" + ",".join("?" * len(tpl)) + ")", tuple(tpl.values()))
        tpl["archived_ms"] = None
        result = _issue_rows(db, tpl, members, op_key, at)
        return {"template": _template_view(tpl, _counts(db, [tpl["template_id"]]).get(tpl["template_id"])), **result}
    return mutate(teacher_scope(actor), op_key, ["create", cls, subject, fields, sorted(set(payload.get("roster_ids") or [])),
                                                 bool(payload.get("allow_duplicate")), kind, quiz_json, whole], op)


def issue_template(actor: dict[str, Any], template_id: str, roster_ids: list[str], op_key: str, whole_class: bool = False) -> tuple[dict[str, Any], bool]:
    def op(db: sqlite3.Connection) -> dict[str, Any]:
        tpl = _owned_template(db, actor, template_id)
        if tpl["archived_ms"] is not None:
            raise HwError(409, "Задание в архиве: выдать его нельзя")
        _require_class(actor, tpl["class_name"], tpl["subject"])
        at = now()
        members = _class_members(db, actor, tpl["class_name"]) if whole_class else _active_members(db, actor, tpl["class_name"], roster_ids)
        if not members:
            raise HwError(422, "В классе нет подтверждённых учеников" if whole_class else "Выберите хотя бы одного ученика")
        result = _issue_rows(db, tpl, members, op_key, at)
        return {"template": _template_view(tpl, _counts(db, [template_id]).get(template_id)), **result}
    fingerprint = ["issue", template_id, sorted(set(roster_ids))] + (["whole_class"] if whole_class else [])
    return mutate(teacher_scope(actor), op_key, fingerprint, op)


def update_template(actor: dict[str, Any], template_id: str, changes: dict[str, Any], expected_revision: int, op_key: str) -> tuple[dict[str, Any], bool]:
    def op(db: sqlite3.Connection) -> dict[str, Any]:
        tpl = _owned_template(db, actor, template_id)
        if tpl["archived_ms"] is not None:
            raise HwError(409, "Задание в архиве: изменить его нельзя")
        _require_class(actor, tpl["class_name"], tpl["subject"])
        if int(tpl["revision"]) != int(expected_revision):
            raise HwError(409, "Задание уже изменили в другом окне — обновите и повторите", revision=tpl["revision"])
        new = dict(tpl)
        if "title" in changes:
            new["title"] = clean_line(changes["title"], 120)
            if not new["title"]:
                raise HwError(422, "Название задания не может быть пустым")
        if "instructions" in changes:
            new["instructions"] = clean_text(changes["instructions"] or "", 2000)
        if "type" in changes:
            new["task_type"] = changes["type"]
        if "planned_minutes" in changes:
            new["planned_minutes"] = int(changes["planned_minutes"])
        if "due_date" in changes:
            new["due_date"] = changes["due_date"]
        if "quiz" in changes:
            if (tpl.get("kind") or "task") != "quiz":
                raise HwError(422, "Вопросы есть только у блиц-опроса")
            new["quiz_json"] = _quiz_payload("quiz", changes["quiz"])
        diff = {k: [tpl[k], new[k]] for k in ("title", "instructions", "task_type", "planned_minutes", "due_date") if tpl[k] != new[k]}
        quiz_changed = new.get("quiz_json") != tpl.get("quiz_json")
        if quiz_changed:
            diff["quiz"] = ["прежние вопросы", "новые вопросы"]
        at = now()
        touched = 0
        if diff:
            new["revision"] = int(tpl["revision"]) + 1
            new["updated_ms"] = at
            db.execute("UPDATE hw_templates SET title=?,instructions=?,task_type=?,planned_minutes=?,due_date=?,revision=?,updated_ms=?,quiz_json=? "
                       "WHERE template_id=?", (new["title"], new["instructions"], new["task_type"], new["planned_minutes"],
                                               new["due_date"], new["revision"], at, new.get("quiz_json"), template_id))
            for r in _rows(db.execute("SELECT * FROM hw_issues WHERE template_id=? AND status IN ('assigned','in_progress','paused')", (template_id,))):
                r.update(title=new["title"], instructions=new["instructions"], task_type=new["task_type"],
                         planned_minutes=new["planned_minutes"], due_date=new["due_date"], snapshot_revision=new["revision"],
                         last_effective_ms=max(at, int(r["last_effective_ms"])))
                if quiz_changed and not _attempt(db, r["issue_id"]):
                    r["quiz_json"] = new.get("quiz_json")   # an attempt in progress keeps the questions it started with
                _save_issue(db, r, at)
                _event(db, r, "updated", "teacher", at, at, 0, op_key, r["status"], {"fields": diff, "snapshot_revision": new["revision"]})
                touched += 1
        return {"template": _template_view(new, _counts(db, [template_id]).get(template_id)), "changed": sorted(diff),
                "updated_issues": touched}
    return mutate(teacher_scope(actor), op_key, ["update", template_id, expected_revision, sorted(changes.items())], op)


def archive_template(actor: dict[str, Any], template_id: str, op_key: str) -> tuple[dict[str, Any], bool]:
    def op(db: sqlite3.Connection) -> dict[str, Any]:
        tpl = _owned_template(db, actor, template_id)
        at = now()
        revoked = 0
        if tpl["archived_ms"] is None:
            db.execute("UPDATE hw_templates SET archived_ms=?, updated_ms=? WHERE template_id=?", (at, at, template_id))
            tpl.update(archived_ms=at, updated_ms=at)
            revoked = _revoke_open(db, "template_id=?", (template_id,), "teacher", "template_archived", op_key, at)
        return {"template": _template_view(tpl, _counts(db, [template_id]).get(template_id)), "revoked_issues": revoked}
    return mutate(teacher_scope(actor), op_key, ["archive", template_id], op)


_ATTEMPT_COLS = ("a.started_ms AS q_started_ms, a.submitted_ms AS q_submitted_ms, a.score AS q_score, "
                 "a.max_score AS q_max_score, a.late AS q_late, a.overtime AS q_overtime ")
_ISSUE_JOIN = ("SELECT i.*, r.display_name AS display_name, r.status AS member_status, r.access AS member_access, "
               "(SELECT COUNT(*) FROM hw_events e WHERE e.issue_id=i.issue_id AND e.delay_ms>" + str(DELAYED_FLAG_MS) + ") AS delayed_events, "
               + _ATTEMPT_COLS +
               "FROM hw_issues i JOIN hw_roster r ON r.roster_id=i.roster_id LEFT JOIN hw_quiz_attempts a ON a.issue_id=i.issue_id ")


def template_detail(actor: dict[str, Any], template_id: str) -> dict[str, Any]:
    def q(db: sqlite3.Connection) -> dict[str, Any]:
        tpl = _owned_template(db, actor, template_id)
        at = now()
        rows = _rows(db.execute(_ISSUE_JOIN + "WHERE i.template_id=? ORDER BY r.display_name COLLATE NOCASE, i.issued_ms", (template_id,)))
        issued = {r["roster_id"] for r in rows}
        free = _rows(db.execute("SELECT * FROM hw_roster WHERE source=? AND school_id=? AND teacher_id=? AND class_name=? "
                                "AND status='active' ORDER BY display_name COLLATE NOCASE", (*_owner(actor), tpl["class_name"])))
        return {"template": _template_view(tpl, _counts(db, [template_id]).get(template_id)),
                "students": [_teacher_issue_view(r, at) for r in rows],
                "not_issued": [_member_view(m) for m in free if m["roster_id"] not in issued], "server_now": iso(at)}
    return read(q)


def teacher_issue(actor: dict[str, Any], issue_id: str) -> dict[str, Any]:
    def q(db: sqlite3.Connection) -> dict[str, Any]:
        r = _one(db.execute(_ISSUE_JOIN + "WHERE i.issue_id=? AND i.source=? AND i.school_id=? AND i.teacher_id=?", (issue_id, *_owner(actor))))
        if not r:
            raise HwError(404, "Выдача не найдена")
        events = _rows(db.execute("SELECT * FROM hw_events WHERE issue_id=? ORDER BY seq", (issue_id,)))
        tpl = _one(db.execute("SELECT * FROM hw_templates WHERE template_id=?", (r["template_id"],)))
        at = now()
        return {"issue": {**_teacher_issue_view(r, at), "title": r["title"], "subject": r["subject"], "class": r["class_name"],
                          "planned_minutes": r["planned_minutes"], "due_date": r["due_date"]},
                "template": _template_view(tpl) if tpl else None, "events": [_event_view(e) for e in events], "server_now": iso(at)}
    return read(q)


def revoke_issue(actor: dict[str, Any], issue_id: str, op_key: str) -> tuple[dict[str, Any], bool]:
    def op(db: sqlite3.Connection) -> dict[str, Any]:
        r = _one(db.execute("SELECT * FROM hw_issues WHERE issue_id=? AND source=? AND school_id=? AND teacher_id=?", (issue_id, *_owner(actor))))
        if not r:
            raise HwError(404, "Выдача не найдена")
        at = now()
        event = _transition(db, r, "revoke", "teacher", at, max(at, int(r["last_effective_ms"])), 0, op_key, {"reason": "teacher_revoked"})
        return {"issue_id": issue_id, "status": r["status"], "changed": event is not None}
    return mutate(teacher_scope(actor), op_key, ["revoke", issue_id], op)


def overview(actor: dict[str, Any]) -> dict[str, Any]:
    classes = teacher_classes(actor["t"])
    def q(db: sqlite3.Connection) -> dict[str, Any]:
        at = now()
        out = []
        for c in classes:
            n = {row["status"]: row["n"] for row in db.execute(
                "SELECT status, COUNT(*) n FROM hw_roster WHERE source=? AND school_id=? AND teacher_id=? AND class_name=? GROUP BY status",
                (*_owner(actor), c["class"]))}
            out.append({**c, "active": n.get("active", 0), "pending": n.get("pending", 0),
                        "code": _code_view(_active_code(db, actor, c["class"], at))})
        return {"source": actor["source"], "is_demo": actor["source"] == "demo", "teacher_name": actor["teacher_name"], "classes": out}
    return read(q)


# ------------------------------------------------------------------ student
def _limit(db: sqlite3.Connection, bucket: str, limit: int, window: int, at: int) -> bool:
    db.execute("DELETE FROM hw_limits WHERE expires_ms<=?", (at,))
    row = db.execute("SELECT attempts FROM hw_limits WHERE bucket=?", (bucket,)).fetchone()
    if row and row[0] >= limit:
        return False
    db.execute("INSERT INTO hw_limits VALUES(?,?,1) ON CONFLICT(bucket) DO UPDATE SET attempts=attempts+1", (bucket, at + window))
    return True


def join(source: str, student_key: str, code: str, display_name: str, op_key: str) -> tuple[dict[str, Any], bool]:
    norm = normalize_code(code)
    name = clean_line(display_name, 60)
    if len(name) < 2:
        raise HwError(422, "Напишите имя и фамилию так, чтобы учитель вас узнал")
    with repo().tx() as db:          # committed even when the code is wrong
        if not _limit(db, "join|" + student_scope(source, student_key), JOIN_LIMIT, JOIN_WINDOW_MS, now()):
            raise HwError(429, "Слишком много попыток ввести код. Попробуйте через 10 минут", retry_after=600)
    def op(db: sqlite3.Connection) -> dict[str, Any]:
        at = now()
        c = _one(db.execute("SELECT * FROM hw_class_codes WHERE code=? AND source=? AND revoked_ms IS NULL AND expires_ms>?", (norm, source, at)))
        if c and c["source"] == "demo" and _sandbox_of_teacher(c["teacher_id"]) != _sandbox_of_key(student_key):
            c = None              # a demo sandbox is closed: same answer as an unknown code, no existence oracle
        if not c:
            raise HwError(404, "Код не найден или устарел. Попросите учителя показать актуальный код")
        m = _one(db.execute("SELECT * FROM hw_roster WHERE source=? AND school_id=? AND teacher_id=? AND class_name=? AND student_key=?",
                            (source, c["school_id"], c["teacher_id"], c["class_name"], student_key)))
        if m is None:
            m = {"roster_id": _id("ros"), "source": source, "school_id": c["school_id"], "teacher_id": c["teacher_id"],
                 "class_name": c["class_name"], "student_key": student_key, "display_name": name, "status": "pending",
                 "origin": "join_code", "requested_ms": at, "decided_ms": None, "updated_ms": at}
            db.execute("INSERT INTO hw_roster(" + ",".join(m) + ") VALUES(" + ",".join("?" * len(m)) + ")", tuple(m.values()))
        elif m["status"] in ("rejected", "removed", "left"):
            db.execute("UPDATE hw_roster SET status='pending', display_name=?, requested_ms=?, decided_ms=NULL, updated_ms=? WHERE roster_id=?",
                       (name, at, at, m["roster_id"]))
            m.update(status="pending", display_name=name, requested_ms=at, decided_ms=None)
        elif m["status"] == "pending" and m["display_name"] != name:
            db.execute("UPDATE hw_roster SET display_name=?, updated_ms=? WHERE roster_id=?", (name, at, m["roster_id"]))
            m["display_name"] = name
        return {"membership": _membership_view(db, m)}
    return mutate(student_scope(source, student_key), op_key, ["join", norm, name], op)


def _teacher_name(db: sqlite3.Connection, m: dict[str, Any]) -> str | None:
    from app import teacher_mode
    base = m["teacher_id"].split("@", 1)[0] if m["source"] == "demo" else m["teacher_id"]
    hit = next((t for t in teacher_mode.directory(m["source"]) if str(t.get("id")) == base
                and str(t.get("school_id")) == m["school_id"]), None)
    if hit:
        return hit.get("full_name")
    row = db.execute("SELECT teacher_name FROM hw_templates WHERE source=? AND school_id=? AND teacher_id=? ORDER BY created_ms DESC LIMIT 1",
                     (m["source"], m["school_id"], m["teacher_id"])).fetchone()
    return row[0] if row else None


def _membership_view(db: sqlite3.Connection, m: dict[str, Any]) -> dict[str, Any]:
    return {"membership_id": m["roster_id"], "class": m["class_name"], "teacher_name": _teacher_name(db, m),
            "display_name": m["display_name"], "status": m["status"], "requested_at": iso(m["requested_ms"]),
            "decided_at": iso(m["decided_ms"]), "is_demo": m["source"] == "demo"}


def memberships(source: str, student_key: str) -> dict[str, Any]:
    def q(db: sqlite3.Connection) -> dict[str, Any]:
        rows = _rows(db.execute("SELECT * FROM hw_roster WHERE source=? AND student_key=? AND status IN ('pending','active','rejected','removed') "
                                "ORDER BY requested_ms DESC", (source, student_key)))
        return {"memberships": [_membership_view(db, m) for m in rows]}
    return read(q)


def leave(source: str, student_key: str, membership_id: str, op_key: str) -> tuple[dict[str, Any], bool]:
    def op(db: sqlite3.Connection) -> dict[str, Any]:
        m = _one(db.execute("SELECT * FROM hw_roster WHERE roster_id=? AND source=? AND student_key=?", (membership_id, source, student_key)))
        if not m:
            raise HwError(404, "Класс не найден")
        at = now()
        revoked = 0
        if m["status"] != "left":
            db.execute("UPDATE hw_roster SET status='left', updated_ms=? WHERE roster_id=?", (at, membership_id))
            revoked = _revoke_open(db, "roster_id=?", (membership_id,), "student", "student_left", op_key, at)
            m["status"] = "left"
        return {"membership": _membership_view(db, m), "revoked_issues": revoked}
    return mutate(student_scope(source, student_key), op_key, ["leave", membership_id], op)


_STUDENT_SELECT = "SELECT i.*, " + _ATTEMPT_COLS + "FROM hw_issues i LEFT JOIN hw_quiz_attempts a ON a.issue_id=i.issue_id "


def _student_issues(db: sqlite3.Connection, source: str, student_key: str, day: str | None) -> list[dict[str, Any]]:
    if day:
        return _rows(db.execute(_STUDENT_SELECT + "WHERE i.source=? AND i.student_key=? AND (i.status IN ('assigned','in_progress','paused') "
                                "OR (i.status='completed' AND i.completed_study_day=?)) ORDER BY i.issued_ms, i.issue_id", (source, student_key, day)))
    return _rows(db.execute(_STUDENT_SELECT + "WHERE i.source=? AND i.student_key=? AND (i.status IN ('assigned','in_progress','paused') "
                            "OR (i.status='completed' AND i.completed_ms>?)) ORDER BY i.issued_ms, i.issue_id",
                            (source, student_key, now() - 7 * 86_400_000)))


def student_list(source: str, student_key: str, day: str | None = None) -> list[dict[str, Any]]:
    def q(db: sqlite3.Connection) -> list[dict[str, Any]]:
        at = now()
        return [student_view(r, at) for r in _student_issues(db, source, student_key, day)]
    return read(q)


def student_issue(source: str, student_key: str, issue_id: str) -> dict[str, Any]:
    def q(db: sqlite3.Connection) -> dict[str, Any]:
        r = _one(db.execute(_STUDENT_SELECT + "WHERE i.issue_id=? AND i.source=? AND i.student_key=?", (issue_id, source, student_key)))
        if not r:
            raise HwError(404, "Задание не найдено")
        events = _rows(db.execute("SELECT * FROM hw_events WHERE issue_id=? ORDER BY seq", (issue_id,)))
        return {"issue": student_view(r), "events": [_event_view(e) for e in events]}
    return read(q)


def _owned_issue(db: sqlite3.Connection, source: str, student_key: str, issue_id: str) -> dict[str, Any]:
    r = _one(db.execute("SELECT * FROM hw_issues WHERE issue_id=? AND source=? AND student_key=?", (issue_id, source, student_key)))
    if not r:
        raise HwError(404, "Задание не найдено")
    return r


def transition(source: str, student_key: str, issue_id: str, action: str, body: dict[str, Any], op_key: str) -> tuple[dict[str, Any], bool]:
    if action not in STUDENT_ACTIONS:
        raise HwError(404, "Неизвестное действие")
    semantic = {k: body.get(k) for k in ("client_event_at", "reason", "round", "study_day", "client_elapsed_sec")}
    def op(db: sqlite3.Connection) -> dict[str, Any]:
        r = _owned_issue(db, source, student_key, issue_id)
        if action == "complete" and (r.get("kind") or "task") == "quiz":
            raise HwError(409, "Блиц-опрос завершается отправкой ответов", status=r["status"])
        received = now()
        effective, delay = effective_time(r, received, body.get("client_event_at"), body.get("client_sent_at"))
        auto: list[str] = []
        if action in ("start", "resume") and r["status"] in ("assigned", "paused"):
            for other in _rows(db.execute("SELECT * FROM hw_issues WHERE source=? AND student_key=? AND status='in_progress' AND issue_id<>?",
                                          (source, student_key, issue_id))):
                eff_other, delay_other = effective_time(other, received, body.get("client_event_at"), body.get("client_sent_at"))
                _transition(db, other, "pause", "system", received, eff_other, delay_other, op_key, {"reason": "switched"})
                auto.append(other["issue_id"])
        event = _transition(db, r, action, "student", received, effective, delay, op_key, body)
        return {"issue": student_view(r, received), "changed": event is not None,
                "event": _event_view(event) if event else None, "auto_paused": auto}
    return mutate(student_scope(source, student_key), op_key, ["transition", issue_id, action, semantic], op)


def heartbeat(source: str, student_key: str, issue_id: str) -> dict[str, Any]:
    """Not an event: extends confirmed time only for live gaps <= 90 s while running."""
    with repo().tx() as db:
        r = _owned_issue(db, source, student_key, issue_id)
        received = now()
        credited = 0
        if r["status"] == "in_progress":
            last = r["last_signal_ms"]
            if last is None or received - int(last) >= HEARTBEAT_MIN_MS:
                before = int(r["confirmed_ms"])
                _credit(r, received, True)
                r["confirmed_ms"] = min(int(r["confirmed_ms"]), timer_ms(r, received))
                credited = int(r["confirmed_ms"]) - before
                r["last_signal_ms"] = received
                db.execute("UPDATE hw_issues SET confirmed_ms=?, last_signal_ms=?, updated_ms=? WHERE issue_id=?",
                           (r["confirmed_ms"], received, received, issue_id))
        return {"issue": student_view(r, received), "credited_sec": credited // 1000}


# ------------------------------------------------------------------ evening plan integration
def task_title(item: dict[str, Any], taken: set[str]) -> str:
    subject, title = item["subject"].strip(), item["title"].strip()
    base = title if title.lower().startswith(subject.lower()) else f"{subject}: {title}"
    base = base[:280]
    if base not in taken:
        return base
    short = (item.get("teacher_name") or "учитель").split()[0]
    candidate = f"{base} · {short}"
    if candidate not in taken:
        return candidate
    return f"{base} · №{item['issue_id'][-4:]}"


def plan_tasks(source: str, student_key: str, day: date, existing_titles: set[str]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """TaskItem rows + state for initial-state: open issues and issues completed on ``day``."""
    taken = set(existing_titles)
    tasks, infos = [], []
    for item in student_list(source, student_key, day.isoformat()):
        title = task_title(item, taken)
        taken.add(title)
        tasks.append({"id": "hw:" + item["issue_id"], "provider_assignment_id": item["issue_id"], "title": title,
                      "type": item["type"], "deadline": item["due_date"], "planned_minutes": item["planned_minutes"],
                      "source": "teacher"})
        infos.append({**item, "task_title": title})
    return tasks, infos


# ------------------------------------------------------------------ v2: sandbox scoping helpers
def _sandbox_of_key(key: str | None) -> str | None:
    from app.demo_sandbox import sandbox_of_key
    return sandbox_of_key(key)


def _sandbox_of_teacher(teacher_id: str | None) -> str | None:
    from app.demo_sandbox import sandbox_of_teacher
    return sandbox_of_teacher(teacher_id)


# ------------------------------------------------------------------ v2: blitz quizzes from the teacher
QUIZ_MAX_QUESTIONS = 20
QUIZ_KINDS = ("single", "multi", "short")
MANUAL_HOW = ("oral", "paper")      # v2.2: how a classmate without the app handed the work in
OVERTIME_GRACE_MS = 30_000


def _norm_answer(value: Any) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).lower().replace("ё", "е")
    return re.sub(r"\s+", " ", text).strip().strip(" .,!?;:«»\"'()")


def _as_number(text: str) -> float | None:
    t = text.replace(" ", "").replace(",", ".").replace("−", "-")
    if re.fullmatch(r"[-+]?\d+(\.\d+)?", t):
        return float(t)
    m = re.fullmatch(r"([-+]?\d+)/(\d+)", t)
    if m and int(m.group(2)):
        return int(m.group(1)) / int(m.group(2))
    return None


def _short_ok(given: str, accepted: list[str]) -> bool:
    g = _norm_answer(given)
    if not g:
        return False
    gn = _as_number(g)
    for a in accepted:
        n = _norm_answer(a)
        if g == n:
            return True
        an = _as_number(n)
        if gn is not None and an is not None and abs(gn - an) <= 1e-9 * max(1.0, abs(an)):
            return True
    return False


def _int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def normalize_quiz(raw: Any) -> dict[str, Any]:
    """Server-side validation of a teacher quiz.  Answer keys never leave the teacher scope."""
    if not isinstance(raw, dict):
        raise HwError(422, "Добавьте вопросы опроса")
    questions = raw.get("questions")
    if not isinstance(questions, list) or not questions:
        raise HwError(422, "В опросе нужен хотя бы один вопрос")
    if len(questions) > QUIZ_MAX_QUESTIONS:
        raise HwError(422, f"Не больше {QUIZ_MAX_QUESTIONS} вопросов в одном опросе")
    out: list[dict[str, Any]] = []
    for n, q in enumerate(questions, 1):
        where = f"Вопрос {n}: "
        if not isinstance(q, dict):
            raise HwError(422, where + "неверный формат", question=n)
        kind = q.get("kind") or "single"
        if kind not in QUIZ_KINDS:
            raise HwError(422, where + "неизвестный тип вопроса", question=n)
        text = clean_text(str(q.get("text") or ""), 500)
        if not text:
            raise HwError(422, where + "напишите текст вопроса", question=n)
        points = q.get("points", 1)
        if not _int(points) or not 1 <= points <= 5:
            raise HwError(422, where + "баллы — от 1 до 5", question=n)
        item: dict[str, Any] = {"id": f"q{n}", "kind": kind, "text": text, "points": points,
                                "explain": clean_text(str(q.get("explain") or ""), 500)}
        if kind == "short":
            answers = [clean_line(str(a), 100) for a in (q.get("answers") or []) if isinstance(a, (str, int, float))]
            answers = list(dict.fromkeys(a for a in answers if a))[:5]
            if not answers:
                raise HwError(422, where + "укажите хотя бы один верный ответ", question=n)
            item.update(options=[], correct=[], answers=answers)
        else:
            options = [clean_line(str(o), 200) for o in (q.get("options") or [])]
            if not 2 <= len(options) <= 6:
                raise HwError(422, where + "нужно от 2 до 6 вариантов ответа", question=n)
            if any(not o for o in options):
                raise HwError(422, where + "есть пустой вариант ответа", question=n)
            if len({_norm_answer(o) for o in options}) != len(options):
                raise HwError(422, where + "варианты ответа повторяются", question=n)
            correct = q.get("correct")
            if not isinstance(correct, list) or not all(_int(i) for i in correct):
                raise HwError(422, where + "отметьте верный вариант", question=n)
            correct = sorted(set(correct))
            if not correct or any(i < 0 or i >= len(options) for i in correct):
                raise HwError(422, where + "отметьте верный вариант", question=n)
            if kind == "single" and len(correct) != 1:
                raise HwError(422, where + "в вопросе с одним ответом отметьте ровно один верный вариант", question=n)
            item.update(options=options, correct=correct, answers=[])
        out.append(item)
    limit = raw.get("time_limit_min")
    if limit is not None and (not _int(limit) or not 1 <= limit <= 90):
        raise HwError(422, "Ограничение времени — от 1 до 90 минут")
    origin = raw.get("origin") if raw.get("origin") in ("manual", "ai", "ai_edited", "bank") else "manual"
    if origin != "manual" and raw.get("reviewed") is not True:
        # Drafts (AI or built-in bank) are never issued unseen: the teacher confirms every question and answer key.
        # (Origin is declared by the client, so this is a workflow guard, not an authorization control.)
        if origin == "bank":
            raise HwError(422, "Черновик из банка: подтвердите, что проверили каждый вопрос и верные ответы", code="bank_review_required")
        raise HwError(422, "Черновик ИИ: подтвердите, что проверили каждый вопрос и верные ответы", code="ai_review_required")
    out_quiz = {"version": 1, "questions": out, "time_limit_min": limit, "show_answers": raw.get("show_answers", True) is not False,
                "origin": origin, "topic": clean_line(str(raw.get("topic") or ""), 120)}
    if origin != "manual":
        out_quiz["reviewed"] = True
    return out_quiz


def grade(quiz: dict[str, Any], answers: list[dict[str, Any]]) -> tuple[int, int, list[dict[str, Any]]]:
    """All-or-nothing per question; multi-choice needs exactly the marked set; short answers are normalised
    (case, ё/е, spaces, punctuation, 0,5 = 0.5 = 1/2)."""
    given = {a.get("id"): a for a in answers if isinstance(a, dict)}
    score = total = 0
    detail: list[dict[str, Any]] = []
    for q in quiz["questions"]:
        total += q["points"]
        a = given.get(q["id"]) or {}
        if q["kind"] == "short":
            text = clean_line(str(a.get("text") or ""), 200)
            ok, answered, stored = _short_ok(text, q["answers"]), bool(text), {"text": text}
        else:
            picked = a.get("choice")
            if _int(picked):
                picked = [picked]
            picked = sorted({i for i in picked if _int(i) and 0 <= i < len(q["options"])}) if isinstance(picked, list) else []
            answered = bool(picked)
            ok = answered and picked == q["correct"] and not (q["kind"] == "single" and len(picked) > 1)
            stored = {"choice": picked}
        if ok:
            score += q["points"]
        detail.append({"id": q["id"], "answered": answered, "correct": ok, "points": q["points"] if ok else 0, **stored})
    return score, total, detail


def _load_quiz(raw: str | None) -> dict[str, Any] | None:
    try:
        quiz = json.loads(raw) if raw else None
    except ValueError:
        return None
    return quiz if isinstance(quiz, dict) and isinstance(quiz.get("questions"), list) else None


def _quiz_brief(raw: str | None) -> dict[str, Any] | None:
    quiz = _load_quiz(raw)
    if not quiz:
        return None
    return {"count": len(quiz["questions"]), "max_score": sum(int(q.get("points", 1)) for q in quiz["questions"]),
            "time_limit_min": quiz.get("time_limit_min"), "origin": quiz.get("origin") or "manual", "topic": quiz.get("topic") or "",
            "show_answers": quiz.get("show_answers", True) is not False}


def _quiz_summary(r: dict[str, Any]) -> dict[str, Any] | None:
    if (r.get("kind") or "task") != "quiz":
        return None
    brief = _quiz_brief(r.get("quiz_json")) or {"count": 0, "max_score": 0, "time_limit_min": None}
    state = "submitted" if r.get("q_submitted_ms") else "started" if r.get("q_started_ms") else "not_started"
    return {"count": brief["count"], "max_score": r.get("q_max_score") or brief["max_score"], "time_limit_min": brief["time_limit_min"],
            "state": state, "started_at": iso(r.get("q_started_ms")), "submitted_at": iso(r.get("q_submitted_ms")),
            "score": r.get("q_score"), "late": bool(r.get("q_late")), "overtime": bool(r.get("q_overtime"))}


def _manual_view(raw: str | None) -> dict[str, Any] | None:
    try:
        m = json.loads(raw) if raw else None
    except ValueError:
        return None
    if not isinstance(m, dict):
        return None
    how = m.get("how") if m.get("how") in MANUAL_HOW else None
    return {"score": m.get("score"), "max_score": m.get("max_score"), "note": m.get("note") or "", "entered_at": iso(m.get("entered_ms")), "how": how}


def _attempt(db: sqlite3.Connection, issue_id: str) -> dict[str, Any] | None:
    return _one(db.execute("SELECT * FROM hw_quiz_attempts WHERE issue_id=?", (issue_id,)))


def _with_attempt(db: sqlite3.Connection, r: dict[str, Any]) -> dict[str, Any]:
    a = _attempt(db, r["issue_id"]) if (r.get("kind") or "task") == "quiz" else None
    if a:
        r.update(q_started_ms=a["started_ms"], q_submitted_ms=a["submitted_ms"], q_score=a["score"], q_max_score=a["max_score"],
                 q_late=a["late"], q_overtime=a["overtime"])
    return r


def _is_late(due: str | None, at: int) -> bool:
    if not due:
        return False
    from zoneinfo import ZoneInfo
    try:
        tz = ZoneInfo(os.getenv("SCHOOL_TZ") or "Europe/Moscow")
        return datetime.fromtimestamp(at / 1000, tz).date() > date.fromisoformat(due)
    except (ValueError, KeyError):
        return False


def _student_questions(quiz: dict[str, Any], detail: list[dict[str, Any]] | None, reveal: bool) -> list[dict[str, Any]]:
    marks = {d["id"]: d for d in detail or []}
    out = []
    for q in quiz["questions"]:
        item: dict[str, Any] = {"id": q["id"], "kind": q["kind"], "text": q["text"], "options": q["options"], "points": q["points"]}
        if q["id"] in marks:
            d = marks[q["id"]]
            item["result"] = {k: d[k] for k in ("answered", "correct", "choice", "text") if k in d}
        if reveal:
            item.update(correct=q["correct"], answers=q["answers"], explain=q["explain"])
        out.append(item)
    return out


def _quiz_state(db: sqlite3.Connection, r: dict[str, Any], at: int) -> dict[str, Any]:
    quiz = _load_quiz(r.get("quiz_json"))
    if (r.get("kind") or "task") != "quiz" or not quiz:
        raise HwError(404, "Это задание — не блиц-опрос")
    a = _attempt(db, r["issue_id"])
    state = "submitted" if a and a["submitted_ms"] else "started" if a else ("closed" if r["status"] in ("completed", "revoked") else "not_started")
    detail = json.loads(a["detail"]) if a and a["submitted_ms"] else None
    limit = quiz.get("time_limit_min")
    started = a["started_ms"] if a else None
    return {"issue_id": r["issue_id"], "title": r["title"], "subject": r["subject"], "class": r["class_name"],
            "teacher_name": r["teacher_name"], "instructions": r["instructions"], "status": r["status"], "state": state,
            "count": len(quiz["questions"]), "max_score": sum(q["points"] for q in quiz["questions"]), "time_limit_min": limit,
            "show_answers": quiz.get("show_answers", True) is not False, "started_at": iso(started),
            "deadline_at": iso(started + limit * 60_000) if started and limit else None,
            "submitted_at": iso(a["submitted_ms"]) if a else None, "score": a["score"] if a else None,
            "late": bool(a and a["late"]), "overtime": bool(a and a["overtime"]), "due_date": r["due_date"],
            "manual": _manual_view(r.get("manual_json")),
            "questions": [] if state in ("not_started", "closed") else _student_questions(
                quiz, detail, reveal=state == "submitted" and quiz.get("show_answers", True) is not False),
            "is_demo": r["source"] == "demo", "server_now": iso(at)}


def student_quiz(source: str, student_key: str, issue_id: str) -> dict[str, Any]:
    def q(db: sqlite3.Connection) -> dict[str, Any]:
        return _quiz_state(db, _owned_issue(db, source, student_key, issue_id), now())
    return read(q)


def _start_running(db: sqlite3.Connection, source: str, student_key: str, r: dict[str, Any], received: int, op_key: str | None) -> None:
    """Same rule as the timer: one running assignment per student; others are paused by the system."""
    if r["status"] not in ("assigned", "paused"):
        return
    for other in _rows(db.execute("SELECT * FROM hw_issues WHERE source=? AND student_key=? AND status='in_progress' AND issue_id<>?",
                                  (source, student_key, r["issue_id"]))):
        _transition(db, other, "pause", "system", received, max(received, int(other["last_effective_ms"])), 0, op_key, {"reason": "switch"})
    _transition(db, r, "start" if r["status"] == "assigned" else "resume", "student", received, max(received, int(r["last_effective_ms"])),
                0, op_key, {"reason": "list"})


def quiz_start(source: str, student_key: str, issue_id: str, op_key: str) -> tuple[dict[str, Any], bool]:
    def op(db: sqlite3.Connection) -> dict[str, Any]:
        r = _owned_issue(db, source, student_key, issue_id)
        _quiz_state(db, r, now())                       # 404 for a non-quiz
        if r["status"] == "revoked":
            raise HwError(409, "Опрос отозван учителем", status="revoked")
        received = now()
        if not _attempt(db, issue_id):
            if r["status"] == "completed":
                raise HwError(409, "Результат уже внесён учителем", status="completed")
            db.execute("INSERT INTO hw_quiz_attempts(issue_id, student_key, started_ms) VALUES(?,?,?)", (issue_id, student_key, received))
            if r.get("seen_ms") is None:
                r["seen_ms"] = received
                db.execute("UPDATE hw_issues SET seen_ms=? WHERE issue_id=?", (received, issue_id))
            _start_running(db, source, student_key, r, received, op_key)
        return _quiz_state(db, _owned_issue(db, source, student_key, issue_id), received)
    return mutate(student_scope(source, student_key), op_key, ["quiz_start", issue_id], op)


def quiz_submit(source: str, student_key: str, issue_id: str, answers: list[dict[str, Any]], op_key: str,
                study_day: str | None = None) -> tuple[dict[str, Any], bool]:
    def op(db: sqlite3.Connection) -> dict[str, Any]:
        r = _owned_issue(db, source, student_key, issue_id)
        received = now()
        state = _quiz_state(db, r, received)
        if state["state"] == "submitted":
            return {**state, "changed": False}
        if r["status"] == "revoked":
            raise HwError(409, "Опрос отозван учителем", status="revoked")
        if r["status"] == "completed":
            raise HwError(409, "Результат уже внесён учителем", status="completed")
        a = _attempt(db, issue_id)
        if not a:
            db.execute("INSERT INTO hw_quiz_attempts(issue_id, student_key, started_ms) VALUES(?,?,?)", (issue_id, student_key, received))
            _start_running(db, source, student_key, r, received, op_key)
            a = _attempt(db, issue_id)
        quiz = _load_quiz(r["quiz_json"])
        score, total, detail = grade(quiz, answers)
        limit = quiz.get("time_limit_min")
        overtime = bool(limit) and received - int(a["started_ms"]) > limit * 60_000 + OVERTIME_GRACE_MS
        late = _is_late(r["due_date"], received)
        clean_answers = [{k: d[k] for k in ("id", "choice", "text") if k in d} for d in detail]
        db.execute("UPDATE hw_quiz_attempts SET submitted_ms=?, answers=?, detail=?, score=?, max_score=?, late=?, overtime=? WHERE issue_id=?",
                   (received, json.dumps(clean_answers, ensure_ascii=False), json.dumps(detail, ensure_ascii=False), score, total,
                    int(late), int(overtime), issue_id))
        r = _owned_issue(db, source, student_key, issue_id)
        if r.get("seen_ms") is None:
            r["seen_ms"] = received
        _transition(db, r, "complete", "student", received, max(received, int(r["last_effective_ms"])), 0, op_key,
                    {"reason": "list", "study_day": study_day, "client_elapsed_sec": max(0, (received - int(a["started_ms"])) // 1000),
                     "quiz_score": score, "quiz_max": total})
        return {**_quiz_state(db, _owned_issue(db, source, student_key, issue_id), received), "changed": True}
    fingerprint = ["quiz_submit", issue_id, sorted(json.dumps(a, ensure_ascii=False, sort_keys=True) for a in answers)]
    return mutate(student_scope(source, student_key), op_key, fingerprint, op)


def mark_seen(source: str, student_key: str, issue_id: str) -> dict[str, Any]:
    """The student opened the assignment: the indicator goes off and the teacher sees «просмотрено»."""
    with repo().tx() as db:
        r = _owned_issue(db, source, student_key, issue_id)
        changed = False
        if r.get("seen_ms") is None and r["status"] != "revoked":
            at = now()
            r["seen_ms"] = at
            db.execute("UPDATE hw_issues SET seen_ms=? WHERE issue_id=?", (at, issue_id))
            _event(db, r, "seen", "student", at, at, 0, None, r["status"], {})
            changed = True
        return {"issue_id": issue_id, "seen_at": iso(r.get("seen_ms")), "changed": changed}


# ------------------------------------------------------------------ v2: mixed class (students without the app)
def add_offline(actor: dict[str, Any], cls: str, display_name: str, op_key: str) -> tuple[dict[str, Any], bool]:
    """A classmate without the app: exists only in the teacher's roster.  The teacher hands out paper/print
    and enters the result manually; nobody can sign in as this row."""
    _require_class(actor, cls)
    name = clean_line(display_name, 60)
    if len(name) < 2:
        raise HwError(422, "Напишите имя и фамилию ученика")
    def op(db: sqlite3.Connection) -> dict[str, Any]:
        at = now()
        n = db.execute("SELECT COUNT(*) FROM hw_roster WHERE source=? AND school_id=? AND teacher_id=? AND class_name=? AND status='active'",
                       (*_owner(actor), cls)).fetchone()[0]
        if n >= MAX_ROSTER:
            raise HwError(422, f"В классе уже {MAX_ROSTER} учеников")
        if db.execute("SELECT 1 FROM hw_roster WHERE source=? AND school_id=? AND teacher_id=? AND class_name=? AND status='active' "
                      "AND access='offline' AND display_name=?", (*_owner(actor), cls, name)).fetchone():
            raise HwError(409, "Этот ученик без приложения уже есть в списке")
        m = {"roster_id": _id("ros"), "source": actor["source"], "school_id": actor["school_id"], "teacher_id": actor["teacher_id"],
             "class_name": cls, "student_key": "offline:" + uuid.uuid4().hex, "display_name": name, "status": "active",
             "origin": "teacher_added", "requested_ms": at, "decided_ms": at, "updated_ms": at, "access": "offline"}
        db.execute("INSERT INTO hw_roster(" + ",".join(m) + ") VALUES(" + ",".join("?" * len(m)) + ")", tuple(m.values()))
        return {"member": _member_view(m)}
    return mutate(teacher_scope(actor), op_key, ["offline_add", cls, name], op)


def manual_result(actor: dict[str, Any], issue_id: str, payload: dict[str, Any], op_key: str) -> tuple[dict[str, Any], bool]:
    """Teacher enters the result of work done on paper (offline student or no device)."""
    def op(db: sqlite3.Connection) -> dict[str, Any]:
        r = _one(db.execute(_ISSUE_JOIN + "WHERE i.issue_id=? AND i.source=? AND i.school_id=? AND i.teacher_id=?", (issue_id, *_owner(actor))))
        if not r:
            raise HwError(404, "Выдача не найдена")
        if r["status"] == "revoked":
            raise HwError(409, "Выдача отозвана: сначала выдайте задание снова")
        if r.get("q_submitted_ms"):
            raise HwError(409, "Ученик уже сдал опрос в приложении — его результат не перезаписывается")
        if r["status"] == "completed" and not r.get("manual_json"):
            raise HwError(409, "Ученик уже отметил выполнение в приложении")
        score, max_score = payload.get("score"), payload.get("max_score")
        how = payload.get("how") if payload.get("how") in MANUAL_HOW else None
        if (r.get("kind") or "task") == "quiz":
            quiz_max = (_quiz_brief(r.get("quiz_json")) or {}).get("max_score") or 0
            if score is None:
                # v2.2: a one-tap mark («сдал устно» / «на листочке») without points yet — never counted as 0%
                if not how:
                    raise HwError(422, "Укажите, сколько баллов набрал ученик, или отметьте: сдал устно / на листочке")
                max_score = None
            else:
                max_score = quiz_max if max_score is None else max_score
        if (score is None) != (max_score is None) and (r.get("kind") or "task") != "quiz":
            raise HwError(422, "Укажите и баллы, и максимум — или ни то, ни другое")
        if score is not None and (not _int(score) or not _int(max_score) or max_score < 1 or not 0 <= score <= max_score):
            raise HwError(422, "Баллы — целое число от 0 до максимума")
        at = now()
        manual = {"score": score, "max_score": max_score, "note": clean_text(payload.get("note") or "", 300), "entered_ms": at, "how": how}
        r["manual_json"] = json.dumps(manual, ensure_ascii=False)
        row = {k: v for k, v in r.items() if k not in ("display_name", "member_status", "member_access", "delayed_events") and not k.startswith("q_")}
        if row["status"] != "completed":
            _transition(db, row, "complete", "teacher", at, max(at, int(row["last_effective_ms"])), 0, op_key, {"reason": "list", "manual": True})
        else:
            _save_issue(db, row, at)
        _event(db, row, "manual_result", "teacher", at, at, 0, None, row["status"], {"score": score, "max_score": max_score, "how": how})
        fresh = _one(db.execute(_ISSUE_JOIN + "WHERE i.issue_id=?", (issue_id,)))
        return {"issue": _teacher_issue_view(fresh, at)}
    return mutate(teacher_scope(actor), op_key, ["manual", issue_id, payload.get("score"), payload.get("max_score"), payload.get("note") or "",
                                                 payload.get("how") or ""], op)


def manual_clear(actor: dict[str, Any], issue_id: str, op_key: str) -> tuple[dict[str, Any], bool]:
    """v2.2: the teacher takes back a mistaken mark («сдал устно», «на листочке» or points).

    Only a teacher-entered result can be taken back — never a submission made in the app.  History is kept:
    the earlier ``manual_result`` stays in the log, a ``manual_cleared`` event follows it, and the period report
    reads the latest of the two, so a withdrawn mark never counts as a result."""
    def op(db: sqlite3.Connection) -> dict[str, Any]:
        r = _one(db.execute(_ISSUE_JOIN + "WHERE i.issue_id=? AND i.source=? AND i.school_id=? AND i.teacher_id=?", (issue_id, *_owner(actor))))
        if not r:
            raise HwError(404, "Выдача не найдена")
        if r.get("q_submitted_ms"):
            raise HwError(409, "Ученик сдал опрос в приложении — этот результат не снимается")
        if not r.get("manual_json"):
            raise HwError(409, "Отметки учителя нет — снимать нечего")
        at = now()
        row = {k: v for k, v in r.items() if k not in ("display_name", "member_status", "member_access", "delayed_events") and not k.startswith("q_")}
        before = row["status"]
        row["manual_json"] = None
        if before == "completed":    # a manual mark is what completed it: back to where the student was
            row.update(status="paused" if row.get("first_started_ms") else "assigned", completed_ms=None, completed_study_day=None)
        row["last_effective_ms"] = max(int(row["last_effective_ms"]), at)
        _save_issue(db, row, at)
        _event(db, row, "manual_cleared", "teacher", at, at, 0, op_key, before, {})
        fresh = _one(db.execute(_ISSUE_JOIN + "WHERE i.issue_id=?", (issue_id,)))
        return {"issue": _teacher_issue_view(fresh, at)}
    return mutate(teacher_scope(actor), op_key, ["manual_clear", issue_id], op)


# ------------------------------------------------------------------ v2: quiz results and participation
def _bucket(pct: float) -> str:
    return "90–100" if pct >= 90 else "70–89" if pct >= 70 else "50–69" if pct >= 50 else "0–49"


def quiz_stats(db: sqlite3.Connection, tpl: dict[str, Any]) -> dict[str, Any] | None:
    """Participation and results of one quiz, computed from server records only (no estimates)."""
    quiz = _load_quiz(tpl.get("quiz_json"))
    if (tpl.get("kind") or "task") != "quiz" or not quiz:
        return None
    rows = _rows(db.execute("SELECT i.issue_id, i.status, i.seen_ms, i.manual_json, i.quiz_json, r.access AS member_access, "
                            + _ATTEMPT_COLS + ", a.detail AS q_detail FROM hw_issues i JOIN hw_roster r ON r.roster_id=i.roster_id "
                            "LEFT JOIN hw_quiz_attempts a ON a.issue_id=i.issue_id WHERE i.template_id=?", (tpl["template_id"],)))
    live = [x for x in rows if x["status"] != "revoked"]
    app_rows = [x for x in live if (x["member_access"] or "app") == "app"]
    submitted = [x for x in live if x["q_submitted_ms"]]
    manual = [x for x in live if x["manual_json"] and not x["q_submitted_ms"]]
    pcts: list[float] = [100 * x["q_score"] / x["q_max_score"] for x in submitted if x["q_max_score"]]
    for x in manual:
        m = _manual_view(x["manual_json"]) or {}
        if m.get("max_score"):
            pcts.append(100 * (m.get("score") or 0) / m["max_score"])
    buckets = {b: 0 for b in ("0–49", "50–69", "70–89", "90–100")}
    for v in pcts:
        buckets[_bucket(v)] += 1
    current = tpl.get("quiz_json")
    same = [x for x in submitted if x["quiz_json"] == current]
    per_q = []
    for q in quiz["questions"]:
        answered = correct = 0
        picks = [0] * len(q["options"])
        wrong: dict[str, int] = {}
        for x in same:
            d = next((d for d in json.loads(x["q_detail"] or "[]") if d.get("id") == q["id"]), None)
            if not d or not d.get("answered"):
                continue
            answered += 1
            correct += 1 if d.get("correct") else 0
            for i in d.get("choice") or []:
                if 0 <= i < len(picks):
                    picks[i] += 1
            if q["kind"] == "short" and not d.get("correct") and d.get("text"):
                key = _norm_answer(d["text"])[:60]
                wrong[key] = wrong.get(key, 0) + 1
        per_q.append({"id": q["id"], "kind": q["kind"], "text": q["text"], "answered": answered, "correct": correct,
                      "correct_pct": round(100 * correct / answered) if answered else None,
                      "options": [{"text": o, "picked": picks[i], "is_correct": i in q["correct"]} for i, o in enumerate(q["options"])],
                      "top_wrong": sorted(wrong.items(), key=lambda kv: (-kv[1], kv[0]))[:3]})
    started = sum(1 for x in live if x["q_started_ms"])
    return {"received": len(live), "with_app": len(app_rows), "without_app": len(live) - len(app_rows),
            "seen": sum(1 for x in app_rows if x["seen_ms"]), "started": started, "submitted": len(submitted),
            "manual": len(manual), "manual_oral": sum(1 for x in manual if (_manual_view(x["manual_json"]) or {}).get("how") == "oral"),
            "manual_paper": sum(1 for x in manual if (_manual_view(x["manual_json"]) or {}).get("how") == "paper"),
            "not_started": sum(1 for x in app_rows if not x["q_started_ms"] and not x["manual_json"]),
            "in_progress": sum(1 for x in live if x["q_started_ms"] and not x["q_submitted_ms"]),
            "late": sum(1 for x in submitted if x["q_late"]), "overtime": sum(1 for x in submitted if x["q_overtime"]),
            "avg_pct": round(sum(pcts) / len(pcts)) if pcts else None, "results": len(pcts), "buckets": buckets,
            "questions": per_q, "older_version": len(submitted) - len(same), "insufficient": len(pcts) < 3}


def teacher_quiz(actor: dict[str, Any], template_id: str) -> dict[str, Any]:
    """Teacher-only full quiz (with answer keys) + live statistics."""
    def q(db: sqlite3.Connection) -> dict[str, Any]:
        tpl = _owned_template(db, actor, template_id)
        quiz = _load_quiz(tpl.get("quiz_json"))
        if not quiz:
            raise HwError(404, "У этого задания нет вопросов")
        return {"template_id": template_id, "quiz": quiz, "stats": quiz_stats(db, tpl), "server_now": iso(now())}
    return read(q)


# ------------------------------------------------------------------ R-08: class report for a period
REPORT_MAX_DAYS = 92


def _tz():
    from zoneinfo import ZoneInfo
    try:
        return ZoneInfo(os.getenv("SCHOOL_TZ") or "Europe/Moscow")
    except (ValueError, KeyError):
        return timezone.utc


def _day_start_ms(d: date) -> int:
    return int(datetime(d.year, d.month, d.day, tzinfo=_tz()).timestamp() * 1000)


def _pct(score: Any, max_score: Any) -> int | None:
    if not _int(score) or not _int(max_score) or max_score < 1:
        return None
    return round(100 * score / max_score)


def class_report(actor: dict[str, Any], cls: str, date_from: str, date_to: str) -> dict[str, Any]:
    """Teacher report for one class and a period, computed only from recorded facts: the issue rows, their
    append-only ``hw_events`` (status as of the end of the period), server-graded quiz attempts and manual
    results entered by the teacher.  No estimates, no synthetic numbers; an empty period is an honest zero."""
    _require_class(actor, cls)
    try:
        d0, d1 = date.fromisoformat(date_from), date.fromisoformat(date_to)
    except (TypeError, ValueError):
        raise HwError(422, "Период: даты в формате ГГГГ-ММ-ДД") from None
    if d1 < d0:
        raise HwError(422, "Период: дата «по» раньше даты «с»")
    if (d1 - d0).days + 1 > REPORT_MAX_DAYS:
        raise HwError(422, f"Период — не больше {REPORT_MAX_DAYS} дней")
    start, end = _day_start_ms(d0), _day_start_ms(d1 + timedelta(days=1))
    at = min(now(), end)
    today = datetime.fromtimestamp(at / 1000, _tz()).date()

    def q(db: sqlite3.Connection) -> dict[str, Any]:
        issues = _rows(db.execute(
            "SELECT i.issue_id, i.template_id, i.student_key, i.title, i.subject, i.kind, i.due_date, i.issued_ms "
            "FROM hw_issues i WHERE i.source=? AND i.school_id=? AND i.teacher_id=? AND i.class_name=? "
            "AND i.issued_ms>=? AND i.issued_ms<? ORDER BY i.issued_ms, i.issue_id", (*_owner(actor), cls, start, end)))
        names = {r["student_key"]: r["display_name"] for r in _rows(db.execute(
            "SELECT student_key, display_name FROM hw_roster WHERE source=? AND school_id=? AND teacher_id=? AND class_name=?",
            (*_owner(actor), cls)))}
        totals = {"issued": 0, "revoked": 0, "completed": 0, "completed_late": 0, "in_progress": 0, "not_started": 0,
                  "overdue_open": 0, "results": 0}
        students: dict[str, dict[str, Any]] = {}
        templates: dict[str, dict[str, Any]] = {}
        percents: list[int] = []
        for r in issues:
            last = db.execute("SELECT status_after, effective_ms FROM hw_events WHERE issue_id=? AND effective_ms<? "
                              "ORDER BY seq DESC LIMIT 1", (r["issue_id"], end)).fetchone()
            status = last[0] if last else "assigned"
            if status == "revoked":
                totals["revoked"] += 1
                continue
            done_ev = db.execute("SELECT effective_ms FROM hw_events WHERE issue_id=? AND status_after='completed' "
                                 "AND effective_ms<? ORDER BY seq DESC LIMIT 1", (r["issue_id"], end)).fetchone()
            pct = None
            att = db.execute("SELECT score, max_score FROM hw_quiz_attempts WHERE issue_id=? AND submitted_ms IS NOT NULL "
                             "AND submitted_ms<?", (r["issue_id"], end)).fetchone()
            if att:
                pct = _pct(att[0], att[1])
            if pct is None:
                man = db.execute("SELECT payload, kind FROM hw_events WHERE issue_id=? AND kind IN ('manual_result','manual_cleared') "
                                 "AND effective_ms<? ORDER BY seq DESC LIMIT 1", (r["issue_id"], end)).fetchone()
                if man and man[1] == "manual_result":     # a withdrawn mark (v2.2 manual_cleared) is not a result
                    try:
                        m = json.loads(man[0])
                    except ValueError:
                        m = {}
                    pct = _pct(m.get("score"), m.get("max_score"))
            totals["issued"] += 1
            completed = status == "completed"
            late = completed and done_ev is not None and _is_late(r["due_date"], int(done_ev[0]))
            overdue = (not completed) and bool(r["due_date"]) and date.fromisoformat(r["due_date"]) < today
            totals["completed"] += completed
            totals["completed_late"] += late
            totals["in_progress"] += status in ("in_progress", "paused")
            totals["not_started"] += status == "assigned"
            totals["overdue_open"] += overdue
            if pct is not None:
                totals["results"] += 1
                percents.append(pct)
            st = students.setdefault(r["student_key"], {"name": names.get(r["student_key"], "Ученик"), "issued": 0,
                                                        "completed": 0, "overdue_open": 0, "_p": []})
            st["issued"] += 1
            st["completed"] += completed
            st["overdue_open"] += overdue
            tp = templates.setdefault(r["template_id"], {"template_id": r["template_id"], "title": r["title"],
                                                         "subject": r["subject"], "kind": r["kind"] or "task",
                                                         "issued": 0, "completed": 0, "_p": []})
            tp["issued"] += 1
            tp["completed"] += completed
            if pct is not None:
                st["_p"].append(pct)
                tp["_p"].append(pct)

        def avg(xs: list[int]) -> int | None:
            return round(sum(xs) / len(xs)) if xs else None

        def finish(d: dict[str, Any]) -> dict[str, Any]:
            p = d.pop("_p")
            return {**d, "avg_percent": avg(p), "results": len(p)}

        rate = round(100 * totals["completed"] / totals["issued"]) if totals["issued"] else None
        return {"class": cls, "from": d0.isoformat(), "to": d1.isoformat(), "as_of": iso(at),
                "basis": "hw_events", "totals": {**totals, "completion_percent": rate, "avg_percent": avg(percents)},
                "students": sorted((finish(v) for v in students.values()), key=lambda x: (x["completed"] - x["issued"], x["name"])),
                "assignments": [finish(v) for v in templates.values()]}
    return read(q)


# ------------------------------------------------------------------ v2: demo sandbox seed / purge
WARMUP_QUIZ = {
    "topic": "Квадратные корни", "origin": "manual", "time_limit_min": 10, "show_answers": True,
    "questions": [
        {"kind": "single", "text": "Чему равен √49?", "options": ["7", "−7", "24,5", "49"], "correct": [0],
         "explain": "√49 — неотрицательное число, квадрат которого равен 49."},
        {"kind": "single", "text": "При каком значении a выражение √a не имеет смысла?", "options": ["a = 0", "a = 4", "a = −1", "a = 0,25"],
         "correct": [2], "explain": "Арифметический квадратный корень определён только для a ≥ 0."},
        {"kind": "multi", "text": "Какие числа иррациональные?", "options": ["√2", "√16", "√3", "0,5"], "correct": [0, 2],
         "explain": "√16 = 4 и 0,5 — рациональные числа."},
        {"kind": "short", "text": "Вычислите √0,36", "answers": ["0,6"], "explain": "0,6² = 0,36."},
        {"kind": "single", "text": "Упростите √(9·25)", "options": ["15", "34", "225", "8"], "correct": [0],
         "explain": "√(9·25) = √9·√25 = 3·5."},
    ],
}
WARMUP_S2_ANSWERS = [{"id": "q1", "choice": [0]}, {"id": "q2", "choice": [2]}, {"id": "q3", "choice": [0]},
                     {"id": "q4", "text": "0.6"}, {"id": "q5", "choice": [0]}]


def seed_sandbox(sid: str, *, teacher_id: str, class_name: str, students: list[tuple[str, str]],
                 pending: tuple[str, ...] = (), offline: tuple[str, ...] = ()) -> None:
    """A ready class for the jury: code, two confirmed students with the app, one pending request, one
    classmate without the app, and a warm-up quiz with one submitted and one manually entered result."""
    from app import teacher_mode
    from app.demo_sandbox import user_key
    t = teacher_mode.resolve("demo", demo_teacher=teacher_id)
    if not t:
        raise HwError(503, "Демо-учитель не найден")
    actor = actor_of(t, "demo", sandbox=sid)
    at = now()
    with repo().tx() as db:
        for _ in range(8):
            code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LEN))
            try:
                db.execute("INSERT INTO hw_class_codes(code,source,school_id,teacher_id,class_name,created_ms,expires_ms) VALUES(?,?,?,?,?,?,?)",
                           (code, *_owner(actor), class_name, at, at + CODE_TTL_MS))
                break
            except sqlite3.IntegrityError:
                continue
        members: dict[str, dict[str, Any]] = {}
        def add(key: str, name: str, status: str, origin: str, access: str, when: int) -> dict[str, Any]:
            m = {"roster_id": _id("ros"), "source": "demo", "school_id": actor["school_id"], "teacher_id": actor["teacher_id"],
                 "class_name": class_name, "student_key": key, "display_name": name, "status": status, "origin": origin,
                 "requested_ms": when, "decided_ms": when if status == "active" else None, "updated_ms": when, "access": access}
            db.execute("INSERT INTO hw_roster(" + ",".join(m) + ") VALUES(" + ",".join("?" * len(m)) + ")", tuple(m.values()))
            return m
        for persona, name in students:
            members[persona] = add(user_key(sid, persona), name, "pending" if persona in pending else "active", "demo_seed", "app",
                                   at - (60_000 if persona in pending else 3 * 86_400_000))
        for name in offline:
            members["offline:" + name] = add("offline:" + uuid.uuid4().hex, name, "active", "teacher_added", "offline", at - 3 * 86_400_000)
        issued = at - 26 * 3_600_000
        quiz_json = json.dumps(normalize_quiz(WARMUP_QUIZ), ensure_ascii=False, sort_keys=True)
        tpl = {"template_id": _id("tpl"), "source": "demo", "school_id": actor["school_id"], "teacher_id": actor["teacher_id"],
               "teacher_name": actor["teacher_name"], "class_name": class_name, "subject": "Алгебра", "title": "Квадратные корни — разминка",
               "instructions": "Пять коротких вопросов перед контрольной. Одна попытка, 10 минут.", "task_type": "written",
               "planned_minutes": 10, "due_date": (datetime.fromtimestamp(at / 1000, timezone.utc).date() + timedelta(days=1)).isoformat(),
               "revision": 1, "created_ms": issued, "updated_ms": issued, "kind": "quiz", "quiz_json": quiz_json}
        db.execute("INSERT INTO hw_templates(" + ",".join(tpl) + ") VALUES(" + ",".join("?" * len(tpl)) + ")", tuple(tpl.values()))
        tpl["archived_ms"] = None
        active = [m for m in members.values() if m["status"] == "active"]
        _issue_rows(db, tpl, active, None, issued)
        quiz = _load_quiz(quiz_json)
        s2 = members.get("s2")
        if s2:
            r = _one(db.execute("SELECT * FROM hw_issues WHERE template_id=? AND roster_id=?", (tpl["template_id"], s2["roster_id"])))
            start, done = issued + 3_600_000, issued + 3_600_000 + 6 * 60_000
            r["seen_ms"] = start
            _event(db, r, "seen", "student", start, start, 0, None, r["status"], {})
            db.execute("INSERT INTO hw_quiz_attempts(issue_id, student_key, started_ms) VALUES(?,?,?)", (r["issue_id"], s2["student_key"], start))
            _transition(db, r, "start", "student", start, start, 0, None, {"reason": "list"})
            score, total, detail = grade(quiz, WARMUP_S2_ANSWERS)
            db.execute("UPDATE hw_quiz_attempts SET submitted_ms=?, answers=?, detail=?, score=?, max_score=? WHERE issue_id=?",
                       (done, json.dumps(WARMUP_S2_ANSWERS, ensure_ascii=False), json.dumps(detail, ensure_ascii=False), score, total, r["issue_id"]))
            _transition(db, r, "complete", "student", done, done, 0, None,
                        {"reason": "list", "client_elapsed_sec": 360, "quiz_score": score, "quiz_max": total})
        for key, m in members.items():
            if key.startswith("offline:"):
                r = _one(db.execute("SELECT * FROM hw_issues WHERE template_id=? AND roster_id=?", (tpl["template_id"], m["roster_id"])))
                when = issued + 20 * 3_600_000
                r["manual_json"] = json.dumps({"score": 3, "max_score": 5, "note": "Писал на бумаге на уроке", "entered_ms": when}, ensure_ascii=False)
                _transition(db, r, "complete", "teacher", when, when, 0, None, {"reason": "list", "manual": True})
                _event(db, r, "manual_result", "teacher", when, when, 0, None, r["status"], {"score": 3, "max_score": 5})


def purge_sandbox(sid: str) -> int:
    """Delete every row of one sandbox (teacher ids ``…@sid``, student keys ``demo:sid:…``)."""
    if not re.fullmatch(r"[0-9a-f]{20}", sid or ""):
        return 0
    owner = f"%@{sid}"
    with repo().tx() as db:
        issues = [r[0] for r in db.execute("SELECT issue_id FROM hw_issues WHERE source='demo' AND teacher_id LIKE ?", (owner,))]
        for i in range(0, len(issues), 200):
            chunk = issues[i:i + 200]
            marks = ",".join("?" * len(chunk))
            db.execute(f"DELETE FROM hw_quiz_attempts WHERE issue_id IN ({marks})", chunk)
            db.execute(f"DELETE FROM hw_events WHERE issue_id IN ({marks})", chunk)
        db.execute("DELETE FROM hw_issues WHERE source='demo' AND teacher_id LIKE ?", (owner,))
        # F9: гостевые PIN и попытки песочницы — до шаблонов (внешний ключ на hw_templates)
        db.execute("DELETE FROM hw_guest_attempts WHERE pin_id IN (SELECT pin_id FROM hw_guest_pins WHERE source='demo' AND teacher_id LIKE ?)", (owner,))
        db.execute("DELETE FROM hw_guest_pins WHERE source='demo' AND teacher_id LIKE ?", (owner,))
        db.execute("DELETE FROM hw_templates WHERE source='demo' AND teacher_id LIKE ?", (owner,))
        db.execute("DELETE FROM hw_roster WHERE source='demo' AND teacher_id LIKE ?", (owner,))
        db.execute("DELETE FROM hw_class_codes WHERE source='demo' AND teacher_id LIKE ?", (owner,))
        db.execute("DELETE FROM hw_operations WHERE scope LIKE ? OR scope LIKE ?", (f"t|demo|%{owner}", f"s|demo|demo:{sid}:%"))
        db.execute("DELETE FROM hw_limits WHERE bucket LIKE ? OR bucket LIKE ?", (f"join|s|demo|demo:{sid}:%", f"guest_%|demo|demo:{sid}:%"))
        return len(issues)


# ------------------------------------------------------------------ F9 · гостевой блиц по PIN — удалён в v3.2
# Решение PO v3.2 (блок 2 мастер-директивы): вход в СферумФокус только после авторизации СГО / Госуслуги (ЕСИА)
# или в демо-капсуле жюри; блиц ученик проходит только по опросу, который учитель выдал ему в классе (код опроса
# сверяется на клиенте с его собственными заданиями, см. ui/QuizCode.tsx). Маршруты /api/v1/blitz/pin/* и
# /teacher/hw/templates/{id}/guest-pin* сняты, а миграция схемы 4 стирает все прежние гостевые записи.
# Таблицы hw_guest_* остаются пустыми: политика миграций — только добавлять, ничего не удалять.
