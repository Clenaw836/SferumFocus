"""Синхронизация и импорт расписания (v16).

Факты (проверено по официальным источникам, см. docs/SCHEDULER_ARCHITECTURE.md §2):
у «Сферума» НЕТ публичного API расписания; дневник работает через «Госуслуги. Моя школа»
и региональные ЭЖД со входом через ЕСИА. Поэтому:

* ``FeedScheduleProvider`` — подключаемый источник в НАШЕМ формате ``sferumfocus.schedule.v1``
  (его отдаёт школа/интегратор по ``SCHEDULE_FEED_URL`` [+ ``SCHEDULE_FEED_TOKEN``]).
  Эндпоинты Сферума не выдумываем и не обходим авторизацию.
* ручной импорт: EVIDENCE → PARSE → VALIDATE → PREVIEW → CONFIRM → APPLY → VERIFY.
* последнее удачное расписание хранится на диске (атомарная запись); ошибка источника
  его НЕ стирает, пустой ответ не заменяет непустой.
* ``SCHEDULE_DEMO=0`` — демо-данные не выдаются никогда (боевой режим).

Статусы: fresh · stale · partial · conflict · imported · demo · unavailable · none
(«updating» — клиентский, пока идёт запрос).
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx

from app import metrics
from app.ephemeral import FileStore
from app.progress import quarantine
from app.uid_store import legacy_file, user_file
from app.json_storage import file_lock, atomic_json

FORMAT = "sferumfocus.schedule.v1"
MAX_DAYS = 31
MAX_LESSONS = 12
_HHMM = re.compile(r"^([01]?\d|2[0-3]):[0-5]\d$")
_LOCK = threading.Lock()


def _env(name: str, default: str = "") -> str:
    return (os.getenv(name, default) or default).strip()


def demo_enabled() -> bool:
    return _env("SCHEDULE_DEMO", "1").lower() not in ("0", "false", "no", "off")


def school_tz() -> str | None:
    return _env("SCHOOL_TZ") or None


def feed_url() -> str:
    return _env("SCHEDULE_FEED_URL")


def _ttl() -> int:
    try:
        return max(60, int(_env("SCHEDULE_FEED_TTL", "21600")))
    except ValueError:
        return 21600


def _stale_after() -> int:
    try:
        return max(600, int(_env("SCHEDULE_STALE_AFTER", "86400")))
    except ValueError:
        return 86400


def _data_dir() -> Path:
    return Path(os.getenv("SFERUM_DATA_DIR", "data")) / "schedule"


def _atomic_write(p: Path, doc: Any) -> None:
    atomic_json(p, doc)


def _read(p: Path) -> Any | None:
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except ValueError:
        quarantine(p)
        return None


# ------------------------------------------------------------------ валидация

def _t(v: Any) -> str | None:
    s = str(v).strip() if v is not None else ""
    if not _HHMM.match(s):
        return None
    h, m = s.split(":")
    return f"{int(h):02d}:{m}"


def _m(s: str) -> int:
    return int(s[:2]) * 60 + int(s[3:])


def validate_feed(doc: Any) -> dict[str, Any]:
    """Структура источника → нормализованные дни + ошибки/предупреждения. Ничего не выдумывает.

    Возвращает {"days": {date: [lesson…]}, "errors": [...], "warnings": [...],
    "status": "ok|partial|conflict|invalid|empty", "timezone": str|None}.
    """
    errors: list[str] = []
    warnings: list[str] = []
    if not isinstance(doc, dict):
        return {"days": {}, "errors": ["ответ не JSON-объект"], "warnings": [], "status": "invalid", "timezone": None}
    if doc.get("format") not in (FORMAT, None):
        return {"days": {}, "errors": [f"неизвестный формат {str(doc.get('format'))[:40]}"], "warnings": [],
                "status": "invalid", "timezone": None}
    raw_days = doc.get("days")
    if not isinstance(raw_days, list):
        return {"days": {}, "errors": ["нет списка days"], "warnings": [], "status": "invalid", "timezone": None}
    tz = doc.get("timezone") if isinstance(doc.get("timezone"), str) and len(doc["timezone"]) < 64 else None
    out: dict[str, list[dict[str, Any]]] = {}
    conflict = False
    dropped = 0
    for d in raw_days[:MAX_DAYS]:
        if not isinstance(d, dict):
            dropped += 1
            continue
        ds = str(d.get("date") or "")[:10]
        try:
            date.fromisoformat(ds)
        except ValueError:
            errors.append(f"неверная дата «{ds[:12]}»")
            continue
        if ds in out:
            warnings.append(f"{ds}: день повторяется — взят первый")
            continue
        lessons = []
        seen: set[int] = set()
        for x in (d.get("lessons") or [])[:MAX_LESSONS]:
            if not isinstance(x, dict):
                dropped += 1
                continue
            try:
                n = int(x.get("n", x.get("lesson_number")))
            except (TypeError, ValueError):
                dropped += 1
                continue
            subj = str(x.get("subject") or "").strip()[:80]
            s, e = _t(x.get("start", x.get("start_time"))), _t(x.get("end", x.get("end_time")))
            if not (1 <= n <= MAX_LESSONS) or not subj or n in seen:
                dropped += 1
                continue
            if s is None or e is None or _m(e) <= _m(s):
                warnings.append(f"{ds}: {n}-й урок без корректного времени — пропущен")
                dropped += 1
                continue
            seen.add(n)
            lessons.append({"lesson_number": n, "subject": subj, "start_time": s, "end_time": e,
                            "room": (str(x["room"]).strip()[:30] or None) if x.get("room") else None,
                            "teacher": (str(x["teacher"]).strip()[:80] or None) if x.get("teacher") else None,
                            "topic": (str(x["topic"]).strip()[:120] or None) if x.get("topic") else None,
                            "status": "cancelled" if x.get("cancelled") else "active"})
        lessons.sort(key=lambda y: _m(y["start_time"]))
        act = [y for y in lessons if y["status"] == "active"]
        for i in range(1, len(act)):
            if _m(act[i]["start_time"]) < _m(act[i - 1]["end_time"]):
                conflict = True
                warnings.append(f"{ds}: уроки {act[i - 1]['lesson_number']} и {act[i]['lesson_number']} пересекаются")
        lessons.sort(key=lambda y: y["lesson_number"])
        out[ds] = lessons
    if dropped:
        warnings.append(f"пропущено записей: {dropped}")
    if not out:
        status = "empty" if not errors else "invalid"
    elif conflict:
        status = "conflict"
    elif dropped or errors:
        status = "partial"
    else:
        status = "ok"
    return {"days": out, "errors": errors[:20], "warnings": warnings[:20], "status": status, "timezone": tz}


# ------------------------------------------------------------------ источник

class FeedError(Exception):
    def __init__(self, reason: str, detail: str = "") -> None:
        super().__init__(reason)
        self.reason = reason      # not_configured | auth | unavailable | timeout | invalid | empty
        self.detail = detail


class FeedScheduleProvider:
    name = "Источник школы"
    kind = "real"

    def __init__(self, url: str | None = None, token: str | None = None, timeout: float = 8.0,
                 transport: httpx.BaseTransport | None = None) -> None:
        self.url = feed_url() if url is None else url
        self.token = _env("SCHEDULE_FEED_TOKEN") if token is None else token
        self.timeout = timeout
        self.transport = transport

    def configured(self) -> bool:
        return self.url.startswith("https://") or self.url.startswith("http://")

    def fetch(self) -> dict[str, Any]:
        if not self.configured():
            raise FeedError("not_configured")
        headers = {"Accept": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        try:
            with httpx.Client(timeout=self.timeout, transport=self.transport, follow_redirects=False) as c:
                r = c.get(self.url, headers=headers)
        except httpx.TimeoutException:
            raise FeedError("timeout") from None
        except httpx.HTTPError as e:
            raise FeedError("unavailable", type(e).__name__) from None
        if r.status_code in (401, 403):
            raise FeedError("auth", str(r.status_code))
        if r.status_code >= 500 or r.status_code == 429:
            raise FeedError("unavailable", str(r.status_code))
        if r.status_code != 200:
            raise FeedError("invalid", str(r.status_code))
        if len(r.content) > 512_000:
            raise FeedError("invalid", "too_large")
        try:
            doc = r.json()
        except ValueError:
            raise FeedError("invalid", "json") from None
        v = validate_feed(doc)
        if v["status"] == "invalid":
            raise FeedError("invalid", "; ".join(v["errors"])[:200])
        if v["status"] == "empty":
            raise FeedError("empty")
        return v


# ------------------------------------------------------------------ кэш последнего удачного

def _feed_cache_path() -> Path:
    return _data_dir() / "_feed_last_good.json"


def _state_path() -> Path:
    return _data_dir() / "_feed_state.json"


def feed_state() -> dict[str, Any]:
    return _read(_state_path()) or {}


def sync_feed(provider: FeedScheduleProvider | None = None, *, now: float | None = None, force: bool = False) -> dict[str, Any]:
    """Забрать источник; при ошибке — оставить последнее удачное. Возвращает состояние синхронизации."""
    provider = provider or FeedScheduleProvider()
    now = time.time() if now is None else now
    with file_lock(_data_dir() / ".feed-sync"):
        st = feed_state()
        if not provider.configured():
            return {"status": "not_configured"}
        if not force and st.get("last_ok_ts") and now - float(st["last_ok_ts"]) < _ttl():
            return st
        t0 = time.perf_counter()
        try:
            v = provider.fetch()
        except FeedError as e:
            metrics.op("schedule_sync", e.reason, (time.perf_counter() - t0) * 1000)
            if e.reason == "invalid":
                metrics.invalid("schedule_feed")
            st.update({"last_error": e.reason, "last_error_at": _iso(now), "last_attempt_ts": now})
            _atomic_write(_state_path(), st)
            return st
        metrics.op("schedule_sync", "ok", (time.perf_counter() - t0) * 1000)
        if v["status"] != "ok":
            metrics.op("schedule_normalize", v["status"])
        _atomic_write(_feed_cache_path(), {"days": v["days"], "timezone": v["timezone"], "fetched_at": _iso(now),
                                           "quality": v["status"], "warnings": v["warnings"]})
        st = {"last_ok_ts": now, "last_sync_at": _iso(now), "quality": v["status"], "last_error": None,
              "warnings": v["warnings"][:5], "last_attempt_ts": now}
        _atomic_write(_state_path(), st)
        return st


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat(timespec="seconds")


def feed_days() -> dict[str, Any] | None:
    return _read(_feed_cache_path())


# ------------------------------------------------------------------ ручной импорт

def parse_text(text: str, today: date) -> dict[str, Any]:
    """Простой текст → документ v1. Формат (по строкам):
        2026-10-12            ← дата (или «пн», «вт», … — ближайший такой день от today)
        1 Алгебра 08:30-09:15 каб. 12
        2. Русский язык 09:25–10:10
    Время обязательно — звонки не угадываем.
    """
    wd = {"пн": 0, "вт": 1, "ср": 2, "чт": 3, "пт": 4, "сб": 5, "вс": 6}
    days: list[dict[str, Any]] = []
    cur: dict[str, Any] | None = None
    for raw in text.splitlines()[:200]:
        line = raw.strip().replace("–", "-").replace("—", "-")
        if not line:
            continue
        m_date = re.match(r"^(\d{4}-\d{2}-\d{2})\s*:?$", line)
        m_wd = re.match(r"^(пн|вт|ср|чт|пт|сб|вс|понедельник|вторник|среда|среду|четверг|пятница|пятницу|суббота|субботу|воскресенье)[а-я.]*\s*:?$", line.lower())
        if m_date or m_wd:
            if m_date:
                ds = m_date.group(1)
            else:
                k = wd.get(m_wd.group(1)[:2], None)
                if k is None:
                    k = {"по": 0, "вт": 1, "ср": 2, "че": 3, "пя": 4, "су": 5, "во": 6}[m_wd.group(1)[:2]]
                ds = (today + timedelta(days=(k - today.weekday()) % 7)).isoformat()
            cur = {"date": ds, "lessons": []}
            days.append(cur)
            continue
        m = re.match(r"^(\d{1,2})[.)]?\s+(.+?)\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})(?:\s+(.*))?$", line)
        if m and cur is not None:
            room = (m.group(5) or "").strip() or None
            cur["lessons"].append({"n": int(m.group(1)), "subject": m.group(2).strip(), "start": m.group(3),
                                   "end": m.group(4), "room": room})
    return {"format": FORMAT, "days": days}


def _import_path(uid: str) -> Path:
    """v18.1 (D-06): однозначный файл пользователя (sha256 uid), см. app/uid_store.py."""
    return user_file(_data_dir(), uid, ".import.json")


def imported_days(uid: str) -> dict[str, Any]:
    with file_lock(_import_path(uid)):
        return _read_imported(uid)

def _read_imported(uid: str) -> dict[str, Any]:
    p = _import_path(uid)
    if p.exists():
        doc = _read(p)
    else:   # совместимость: старый файл законного владельца — только чтение, не переписываем
        legacy = legacy_file(_data_dir(), uid, ".import.json")
        doc = _read_legacy(legacy) if legacy is not None else None
        if legacy is not None and legacy.exists() and not (isinstance(doc, dict) and isinstance(doc.get("days"), dict)):
            raise ValueError('invalid owned legacy import schema')
    return doc if isinstance(doc, dict) and isinstance(doc.get("days"), dict) else {"days": {}, "applied": []}


def _read_legacy(p: Path) -> Any | None:
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None


_PREVIEWS = FileStore("schedule_previews", ttl=900, max_items=2000)  # v18: переживает рестарт


def preview_import(uid: str, payload: str, fmt: str, today: date, base_for) -> dict[str, Any]:
    """PARSE → VALIDATE → PREVIEW: «было → станет» по каждому дню. Ничего не сохраняет."""
    if fmt == "json":
        try:
            doc = json.loads(payload)
        except ValueError:
            return {"ok": False, "token": None, "errors": ["это не JSON"], "warnings": [], "days": []}
    else:
        doc = parse_text(payload, today)
    v = validate_feed(doc)
    if v["status"] in ("invalid", "empty"):
        return {"ok": False, "token": None, "errors": v["errors"] or ["не нашёл ни одного урока со временем"],
                "warnings": v["warnings"], "days": []}
    days = []
    for ds, lessons in sorted(v["days"].items()):
        before = base_for(date.fromisoformat(ds)) or []
        b = [f"{x['lesson_number']}. {x['subject']} {x['start_time']}–{x['end_time']}" for x in before if x.get("status", "active") == "active"]
        a = [f"{x['lesson_number']}. {x['subject']} {x['start_time']}–{x['end_time']}" for x in lessons if x["status"] == "active"]
        days.append({"date": ds, "before": b, "after": a, "changed": a != b})
    token = __import__("uuid").uuid4().hex[:24]
    _PREVIEWS.put(token, uid, v)
    return {"ok": True, "token": token, "errors": v["errors"], "warnings": v["warnings"], "days": days,
            "quality": v["status"]}


def confirm_import(uid: str, token: str) -> dict[str, Any]:
    """CONFIRM → APPLY (атомарно) → VERIFY. Повтор того же token — без дублей (идемпотентно)."""
    with file_lock(_import_path(uid)):
        doc = imported_days(uid)
        receipt = doc.get("receipts", {}).get(token)
        if receipt is not None:
            if receipt.get("state") == "active" and all(doc["days"].get(ds) == lessons for ds, lessons in receipt["days"].items()):
                return {"ok": True, "applied": False, "dates": sorted(receipt["days"]), "repeat": True}
            return {"ok": False, "error": "Импорт отменён или заменён — создайте новый предпросмотр"}
        if token in doc.get("applied", []):
            # Legacy receipt has no effective snapshot: do not falsely assert repeat.
            return {"ok": False, "error": "Старый импорт требует нового предпросмотра"}
        with _PREVIEWS.lease(token, uid) as v:
            if not v:
                return {"ok": False, "error": "Превью устарело — загрузи расписание ещё раз"}
            backup = json.loads(json.dumps(doc))
            doc["days"].update(v["days"])
            doc["applied"] = (doc.get("applied", []) + [token])[-50:]
            doc.setdefault("receipts", {})[token] = {"state": "active", "days": v["days"]}
            doc["updated_at"] = _iso(time.time())
            doc["can_revert"] = True
            doc["quality"] = v["status"]
            doc["previous"] = backup.get("days", {})
            doc["previous_receipts"] = backup.get("receipts", {})
            p = _import_path(uid)
            _atomic_write(p, doc)
            check = imported_days(uid)
            if any(check["days"].get(ds) != ls for ds, ls in v["days"].items()):
                _atomic_write(p, backup)
                return {"ok": False, "error": "Не удалось сохранить — прежнее расписание сохранено"}
            return {"ok": True, "applied": True, "dates": sorted(v["days"].keys()), "repeat": False}


def revert_import(uid: str) -> dict[str, Any]:
    with file_lock(_import_path(uid)):
        doc = imported_days(uid)
        if not doc["days"] or doc.get("can_revert") is False:
            return {"ok": True, "reverted": False}
        doc["days"] = doc.get("previous") or {}
        doc["previous"] = {}
        doc["can_revert"] = False
        previous = doc.pop("previous_receipts", {})
        doc["receipts"] = {token: {**receipt, "state": "reverted"} for token, receipt in doc.get("receipts", {}).items()}
        doc["receipts"].update(previous)
        _atomic_write(_import_path(uid), doc)
        return {"ok": True, "reverted": True}


# ------------------------------------------------------------------ итоговый статус

def resolve_status(*, has_import: bool, feed: dict[str, Any] | None, state: dict[str, Any], now: float | None = None) -> dict[str, Any]:
    now = time.time() if now is None else now
    configured = bool(feed_url())
    last = state.get("last_sync_at") or (feed or {}).get("fetched_at")
    if feed and feed.get("days"):
        age = now - float(state.get("last_ok_ts") or 0)
        q = feed.get("quality") or "ok"
        if state.get("last_error") or age > _stale_after():
            status = "stale"
        elif q in ("partial", "conflict"):
            status = q
        else:
            status = "fresh"
        return {"status": status, "source": "feed", "last_sync_at": last, "error": state.get("last_error"),
                "has_import": has_import}
    if has_import:
        return {"status": "imported", "source": "import", "last_sync_at": None, "error": state.get("last_error"),
                "has_import": True}
    if configured:
        return {"status": "unavailable", "source": "feed", "last_sync_at": None, "error": state.get("last_error"),
                "has_import": False}
    if demo_enabled():
        return {"status": "demo", "source": "demo", "last_sync_at": None, "error": None, "has_import": False}
    return {"status": "none", "source": None, "last_sync_at": None, "error": None, "has_import": False}
