"""Нормализованная модель школьного расписания + архитектура провайдеров.

ScheduleProvider
├── RealSferumProvider     — живое расписание школы (нужны SFERUM_API_URL + SFERUM_API_TOKEN;
│                            без них провайдер честно «не подключён», данные НЕ выдумываются)
├── DemoScheduleProvider   — демо-неделя 8А (помечается is_demo, UI пишет «ДЕМО»)
├── VoiceScheduleOverride  — изменения, подтверждённые учеником по голосу
└── PhotoScheduleOverride  — изменения по фото/скриншоту (OCR), тоже только после подтверждения

Слои: база (real|demo) → применённые изменения ученика по порядку. Оригинал базы
никогда не перезаписывается: у каждого изменения есть аудит (кто/откуда/когда) и
статус applied|reverted — «Отменить изменение» просто выключает слой.

Та же функция apply_changes живёт во фронте (frontend/src/lib/schedule.ts) —
паритет проверяет tests/test_schedule.py. Хранилище изменений — JSON на пользователя
(SFERUM_DATA_DIR/schedule/<uid>.json), синхронизация — объединение по id (без дублей).
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import threading
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Protocol

from app.config import SFERUM_DATA_DIR
from app.progress import quarantine
from app.uid_store import legacy_file, user_file
from app.json_storage import file_lock, atomic_json

WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
WEEKDAY_RU = {"monday": "Понедельник", "tuesday": "Вторник", "wednesday": "Среда",
              "thursday": "Четверг", "friday": "Пятница", "saturday": "Суббота", "sunday": "Воскресенье"}

# Звонки школы (номер урока → время). Совпадают с mock_diary.MOCK_LESSONS.
BELLS: list[tuple[str, str]] = [
    ("08:30", "09:15"), ("09:25", "10:10"), ("10:25", "11:10"), ("11:25", "12:10"),
    ("12:20", "13:05"), ("13:55", "14:45"), ("14:55", "15:40"), ("15:50", "16:35"),
]

# Демо-неделя 8А. Среда = mock_diary.MOCK_LESSONS (последний звонок 14:45).
DEMO_WEEK: dict[str, list[str]] = {
    "monday": ["Русский язык", "Алгебра", "Английский язык", "Биология", "Литература", "Физкультура"],
    "tuesday": ["Геометрия", "Физика", "Русский язык", "История", "Английский язык", "Информатика"],
    "wednesday": ["Алгебра", "Русский язык", "Литература", "Физика", "История", "Физкультура"],
    "thursday": ["Химия", "Алгебра", "Русский язык", "Английский язык", "История", "Биология"],
    "friday": ["Физика", "Геометрия", "Русский язык", "Английский язык", "Литература", "Технология"],
    "saturday": ["Информатика", "Обществознание", "География", "Алгебра"],
}
DEMO_ROOMS = {"Физкультура": "спортзал", "Информатика": "каб. 31", "Химия": "каб. 24"}

CHANGE_TYPES = ("ADD", "REMOVE", "REPLACE", "MOVE", "TIME_CHANGE", "TEACHER_CHANGE",
                "ROOM_CHANGE", "CANCEL", "NOTE", "UNKNOWN")
SOURCES = ("real", "demo", "student_voice", "photo_ocr", "manual", "text")
_HHMM = re.compile(r"^\d{1,2}:\d{2}$")
_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def weekday_of(d: date) -> str:
    return WEEKDAYS[d.weekday()]


def bell(n: int) -> tuple[str | None, str | None]:
    return BELLS[n - 1] if 1 <= n <= len(BELLS) else (None, None)


def lesson(d: date, n: int, subject: str, source: str, *, confidence: float = 1.0,
           start: str | None = None, end: str | None = None, room: str | None = None,
           teacher: str | None = None, updated_at: str | None = None) -> dict[str, Any]:
    s, e = bell(n)
    return {
        "day": weekday_of(d), "date": d.isoformat(), "lesson_number": n,
        "start_time": start or s, "end_time": end or e, "subject": subject,
        "teacher": teacher, "room": room, "source": source, "confidence": confidence,
        "updated_at": updated_at, "change_type": None, "status": "active",
        "was": None, "note": None,
    }


# --------------------------------------------------------------------------
# Провайдеры
# --------------------------------------------------------------------------

class ScheduleProvider(Protocol):
    name: str
    kind: str  # real | demo

    def status(self) -> str: ...
    def lessons(self, d: date) -> list[dict[str, Any]] | None: ...


class RealSferumProvider:
    """Расписание из школьной системы. Публичного API «Сферума» с расписанием у нас нет:
    без учётных данных провайдер возвращает status=not_configured и НЕ отдаёт данных.
    С учётными данными — status=not_connected, пока интеграция не реализована
    (точка расширения: метод lessons). Фейковых ответов «как будто из Сферума» нет."""
    name = "Сферум"
    kind = "real"

    def __init__(self) -> None:
        self.url = os.getenv("SFERUM_API_URL", "").strip()
        self.token = os.getenv("SFERUM_API_TOKEN", "").strip()

    def status(self) -> str:
        return "not_connected" if (self.url and self.token) else "not_configured"

    def lessons(self, d: date) -> list[dict[str, Any]] | None:
        return None


class DemoScheduleProvider:
    name = "Демо-расписание"
    kind = "demo"

    def status(self) -> str:
        return "ok"

    def lessons(self, d: date) -> list[dict[str, Any]] | None:
        subjects = DEMO_WEEK.get(weekday_of(d), [])
        return [lesson(d, i + 1, s, "demo", room=DEMO_ROOMS.get(s)) for i, s in enumerate(subjects)]


class _OverrideSource:
    """Источник изменений ученика. Сам ничего не меняет: создаёт черновик изменения,
    который попадёт в расписание только после подтверждения (apply)."""
    source = "manual"
    label = "Вручную"

    def draft(self, **fields: Any) -> dict[str, Any]:
        return normalize_change({**fields, "source": self.source})


class VoiceScheduleOverride(_OverrideSource):
    source = "student_voice"
    label = "Голос"


class PhotoScheduleOverride(_OverrideSource):
    source = "photo_ocr"
    label = "Фото"


SOURCE_LABEL = {"real": "Школьный дневник", "demo": "Демо", "student_voice": "Голос",
                "photo_ocr": "Фото", "manual": "Вручную", "text": "Текст"}


def active_provider() -> tuple[ScheduleProvider, dict[str, Any]]:
    """Совместимость (≤v15): провайдер без учёта ученика. Новый код — ``resolve_base(uid)``."""
    real = RealSferumProvider()
    st = real.status()
    info = {"real_status": st, "kind": "demo", "name": DemoScheduleProvider.name, "is_demo": True}
    return DemoScheduleProvider(), info


class _NoSchedule:
    """SCHEDULE_DEMO=0 и нет ни источника, ни импорта: данных нет — НЕ выдумываем."""
    name = "Расписание не подключено"
    kind = "none"

    def status(self) -> str:
        return "none"

    def lessons(self, d: date) -> list[dict[str, Any]] | None:
        return None


class ResolvedSchedule:
    """v16: база дня по приоритету — импорт ученика → источник школы (последнее удачное) → демо (если разрешено)."""

    def __init__(self, uid: str) -> None:
        from app import schedule_feed as sf
        self._sf = sf
        self.imported = sf.imported_days(uid)["days"]
        self.feed = sf.feed_days()
        self.state = sf.feed_state()
        self.status = sf.resolve_status(has_import=bool(self.imported), feed=self.feed, state=self.state)
        self.demo = sf.demo_enabled()
        self.diary = None
        from app.platform_auth import enabled, store
        if enabled():
            from app.diary_vault import EncryptedDiaryVault
            repo=store()
            with repo.tx() as db:
                account=db.execute('SELECT uid FROM accounts WHERE data_key=?',(uid,)).fetchone()
            if account:
                connection=EncryptedDiaryVault(repo).get(account[0])
                if connection and connection['provider'] in {'netschool','manual'}:
                    self.diary=connection
                    self.diary_days=dict(connection['snapshot'].get('days') or {})
                    snap=connection['snapshot']
                    if not self.diary_days and snap.get('school_date'):
                        self.diary_days[snap['school_date']]=[{'lesson_number':x.get('lesson_number') or i+1,'subject':x['subject'],'start_time':x.get('starts_at'),'end_time':x.get('ends_at'),'room':x.get('room')} for i,x in enumerate(snap.get('lessons',[]))]

    def _stamp(self, d: date, lessons: list[dict[str, Any]], source: str) -> list[dict[str, Any]]:
        out = []
        for x in lessons:
            le = lesson(d, x["lesson_number"], x["subject"], source, start=x["start_time"], end=x["end_time"],
                        room=x.get("room"), teacher=x.get("teacher"))
            le["start_time"] = x.get("start_time")
            le["end_time"] = x.get("end_time")
            le["status"] = x.get("status", "active")
            if x.get("topic"):
                le["topic"] = x["topic"]
            out.append(le)
        return out

    def lessons(self, d: date) -> list[dict[str, Any]] | None:
        ds = d.isoformat()
        if self.diary:
            # Connected provider wins over old manual imports; an unknown day is
            # not a holiday and not a licence to invent default bells.
            if ds in self.diary_days:
                source='real' if self.diary['provider']=='netschool' else 'manual'
                return self._stamp(d,self.diary_days[ds],source)
            return None
        if ds in self.imported:
            return self._stamp(d, self.imported[ds], "manual")
        if self.feed and ds in (self.feed.get("days") or {}):
            return self._stamp(d, self.feed["days"][ds], "real")
        if self.feed and self.feed.get("days"):
            return None                       # источник есть, но этого дня в нём нет — не дорисовываем демо
        if self.demo:
            return DemoScheduleProvider().lessons(d)
        return None

    def info(self) -> dict[str, Any]:
        st = self.status
        real = RealSferumProvider().status()
        if self.diary:
            connection=self.diary;snap=connection['snapshot']
            stamp=snap.get('synced_at')
            fresh=False
            if stamp:
                try:fresh=(datetime.now(timezone.utc)-datetime.fromisoformat(stamp)).total_seconds()<3600
                except ValueError:fresh=False
            return {'real_status':connection['status'],'kind':'real' if connection['provider']=='netschool' else 'import',
                    'name':'Сетевой Город' if connection['provider']=='netschool' else 'Импорт дневника',
                    'is_demo':False,'status':('imported' if connection['provider']=='manual' else 'fresh' if fresh and connection['status']=='connected' else 'stale'),
                    'last_sync_at':stamp,'error':None if connection['status']=='connected' else connection['status'],
                    'has_import':bool(self.imported),'school_tz':self._sf.school_tz(),'feed_configured':True}
        if st["source"] == "feed" and self.feed:
            kind, name, demo = "real", "Источник школы", False
        elif st["source"] == "import":
            kind, name, demo = "import", "Импорт ученика", False
        elif st["source"] == "demo":
            kind, name, demo = "demo", DemoScheduleProvider.name, True
        else:
            kind, name, demo = "none", _NoSchedule.name, False
        return {"real_status": real, "kind": kind, "name": name, "is_demo": demo,
                "status": st["status"], "last_sync_at": st["last_sync_at"], "error": st["error"],
                "has_import": st["has_import"], "school_tz": self._sf.school_tz(),
                "feed_configured": bool(self._sf.feed_url())}


# --------------------------------------------------------------------------
# Изменения и их применение (паритет с frontend/src/lib/schedule.ts)
# --------------------------------------------------------------------------

def _str(v: Any, n: int = 80) -> str | None:
    if v is None:
        return None
    s = str(v).strip()[:n]
    return s or None


def _int(v: Any) -> int | None:
    try:
        i = int(v)
    except (TypeError, ValueError):
        return None
    return i if 1 <= i <= len(BELLS) else None


def _time(v: Any) -> str | None:
    s = _str(v, 5)
    return s if s and _HHMM.match(s) else None


def _valid_date(s: str) -> bool:
    try:
        date.fromisoformat(s)
        return True
    except ValueError:
        return False


def normalize_change(raw: dict[str, Any]) -> dict[str, Any]:
    """Мусор на входе (синк с телефона) → безопасная нормализованная запись."""
    ct = str(raw.get("change_type") or "UNKNOWN").upper()
    if ct not in CHANGE_TYPES:
        ct = "UNKNOWN"
    src = raw.get("source") if raw.get("source") in SOURCES else "manual"
    d = _str(raw.get("date"), 10)
    try:
        conf = max(0.0, min(1.0, float(raw.get("confidence", 1.0))))
    except (TypeError, ValueError):
        conf = 0.0
    status = raw.get("status") if raw.get("status") in ("applied", "reverted") else "applied"
    return {
        "id": _str(raw.get("id"), 64) or "c" + hashlib.sha1(json.dumps(raw, sort_keys=True, default=str).encode()).hexdigest()[:12],
        "date": d if d and _ISO.match(d) and _valid_date(d) else None,
        "change_type": ct,
        "lesson_number": _int(raw.get("lesson_number")),
        "to_lesson_number": _int(raw.get("to_lesson_number")),
        "shift": bool(raw.get("shift", False)),
        "subject": _str(raw.get("subject")),
        "before": _str(raw.get("before")),
        "start_time": _time(raw.get("start_time")),
        "end_time": _time(raw.get("end_time")),
        "teacher": _str(raw.get("teacher")),
        "room": _str(raw.get("room"), 30),
        "note": _str(raw.get("note"), 140),
        "reason": _str(raw.get("reason"), 140),
        "source": src,
        "evidence": [e for e in (raw.get("evidence") or []) if e in ("photo", "screenshot", "voice", "text", "file", "paste")][:6],
        "evidence_note": _str(raw.get("evidence_note"), 200),
        "confidence": conf,
        "created_at": _str(raw.get("created_at"), 40),
        "updated_at": _str(raw.get("updated_at"), 40) or _str(raw.get("created_at"), 40),
        "status": status,
    }


def _slot(lessons: list[dict[str, Any]], n: int | None) -> dict[str, Any] | None:
    return next((x for x in lessons if x["lesson_number"] == n), None) if n else None


def apply_changes(base: list[dict[str, Any]], changes: list[dict[str, Any]], d: date) -> list[dict[str, Any]]:
    """База дня + применённые изменения (по порядку создания). Отменённые (reverted) пропускаются."""
    out = [dict(x) for x in base]
    for c in changes:
        if c.get("status") != "applied" or c.get("date") != d.isoformat():
            continue
        ct, n = c["change_type"], c.get("lesson_number")
        cur = _slot(out, n)
        stamp = {"source": c["source"], "confidence": c["confidence"], "updated_at": c.get("updated_at"),
                 "change_type": ct}
        if ct in ("ADD", "REPLACE") and n and c.get("subject"):
            if cur:
                was = cur["subject"] if cur["status"] == "active" and cur["subject"] != c["subject"] else cur.get("was")
                if cur["subject"] != c["subject"]:  # другой предмет — кабинет/учитель/пометка прежнего урока не переносятся
                    cur.update(room=None, teacher=None, note=None)
                cur.update(stamp, subject=c["subject"], status="active", was=was)
                if c.get("start_time"):
                    cur["start_time"] = c["start_time"]
                if c.get("end_time"):
                    cur["end_time"] = c["end_time"]
            else:
                nl = lesson(d, n, c["subject"], c["source"], confidence=c["confidence"],
                            start=c.get("start_time"), end=c.get("end_time"), updated_at=c.get("updated_at"))
                nl["change_type"] = ct
                out.append(nl)
            tgt = _slot(out, n)
            for k in ("room", "teacher"):
                if c.get(k):
                    tgt[k] = c[k]
        elif ct in ("REMOVE", "CANCEL") and cur:
            cur.update(stamp, status="cancelled")
        elif ct == "MOVE" and cur and cur["status"] == "active" and c.get("to_lesson_number"):
            # n → m; shift=True — сдвигаются и все последующие уроки («математика тоже перенесена»)
            delta = c["to_lesson_number"] - n
            group = [x for x in out if x["status"] == "active"
                     and (x["lesson_number"] >= n if c.get("shift") else x["lesson_number"] == n)]
            snapshot = [dict(x) for x in group]
            for x in group:            # освобождённые слоты — «отменён», пока туда никто не въехал
                x.update(stamp, status="cancelled")
            for x in snapshot:
                k = x["lesson_number"] + delta
                if not 1 <= k <= len(BELLS):
                    continue
                s, e = bell(k)
                tgt = _slot(out, k)
                moved = {**x, **stamp, "lesson_number": k, "start_time": s, "end_time": e,
                         "status": "active", "was": None}
                if tgt:
                    if tgt["status"] == "active" and tgt["subject"] != x["subject"]:
                        moved["was"] = tgt["subject"]
                    tgt.clear(); tgt.update(moved)
                else:
                    out.append(moved)
        elif ct == "TIME_CHANGE" and cur:
            cur.update(stamp)
            if c.get("start_time"):
                cur["start_time"] = c["start_time"]
            if c.get("end_time"):
                cur["end_time"] = c["end_time"]
        elif ct == "TEACHER_CHANGE" and cur and c.get("teacher"):
            cur.update(stamp, teacher=c["teacher"])
        elif ct == "ROOM_CHANGE" and cur and c.get("room"):
            cur.update(stamp, room=c["room"])
        elif ct == "NOTE" and cur and c.get("note"):
            cur.update(note=c["note"])
    out.sort(key=lambda x: x["lesson_number"])
    return out


def day_view(d: date, base: list[dict[str, Any]] | None, changes: list[dict[str, Any]]) -> dict[str, Any]:
    lessons = apply_changes(base or [], changes, d)
    active = [x for x in lessons if x["status"] == "active"]
    ids = [c["id"] for c in changes if c.get("status") == "applied" and c.get("date") == d.isoformat()]
    return {
        "date": d.isoformat(), "weekday": weekday_of(d), "base": base or [],
        "lessons": lessons,
        "first_lesson": active[0]["start_time"] if active else None,
        "last_bell": active[-1]["end_time"] if active else None,
        "changed": bool(ids), "change_ids": ids, "available": base is not None,
    }


# --------------------------------------------------------------------------
# Хранилище изменений ученика
# --------------------------------------------------------------------------

_LOCK = threading.Lock()


def _dir() -> Path:
    return Path(os.getenv("SFERUM_DATA_DIR", SFERUM_DATA_DIR)) / "schedule"


def _path(uid: str) -> Path:
    """v18.1 (D-06): однозначный файл пользователя (sha256 uid), см. app/uid_store.py."""
    return user_file(_dir(), uid, ".json")


def load_doc(uid: str) -> dict[str, Any]:
    with file_lock(_path(uid)):
        return _read_doc(uid)

def _read_doc(uid: str) -> dict[str, Any]:
    p = _path(uid)
    legacy = None
    if not p.exists():   # совместимость: старый файл законного владельца — только чтение, не трогаем
        legacy = legacy_file(_dir(), uid, ".json")
        if legacy is None or not legacy.exists():
            return {"version": 0, "changes": [], "school_week": None}
        p = legacy
    try:
        doc = json.loads(p.read_text(encoding="utf-8"))
        if isinstance(doc, dict) and isinstance(doc.get("changes"), list):
            doc.setdefault("version", 0)
            doc.setdefault("school_week", None)
            return doc
        if legacy is not None:
            raise ValueError('invalid owned legacy schedule schema')
        if legacy is None:
            quarantine(p)  # v15: неверная структура — сохраняем копию, не затираем
    except FileNotFoundError:
        pass
    except ValueError:
        if legacy is not None:
            raise  # malformed owned legacy cannot silently become a fresh empty document
        if legacy is None:
            quarantine(p)
    return {"version": 0, "changes": [], "school_week": None}


def _save(uid: str, doc: dict[str, Any]) -> None:
    p = _path(uid)
    atomic_json(p, doc)


def merge_changes(uid: str, incoming: list[dict[str, Any]], school_week: int | None = None) -> dict[str, Any]:
    """Синхронизация с телефона: объединение по id. Повторная отправка не создаёт дублей;
    для одной записи побеждает более поздний updated_at (так доезжает «отменить»)."""
    with file_lock(_path(uid)):
        doc = load_doc(uid)
        by_id = {c["id"]: c for c in doc["changes"]}
        changed = False
        for raw in incoming[:500]:
            c = normalize_change(raw)
            if not c["date"]:
                continue
            old = by_id.get(c["id"])
            if old is None:
                c["created_at"] = c["created_at"] or datetime.now(timezone.utc).isoformat()
                doc["changes"].append(c); by_id[c["id"]] = c; changed = True
            elif (c.get("updated_at") or "") > (old.get("updated_at") or "") and c != old:
                old.update(c); changed = True
        if school_week in (5, 6) and doc.get("school_week") != school_week:
            doc["school_week"] = school_week; changed = True
        if changed:
            doc["version"] = int(doc.get("version", 0)) + 1
            _save(uid, doc)
        return doc


def school_week_days(uid: str) -> int:
    sw = load_doc(uid).get("school_week")
    return sw if sw in (5, 6) else 5


def week(uid: str, start: date, days: int = 7) -> dict[str, Any]:
    rs = ResolvedSchedule(uid)
    changes = load_doc(uid)["changes"]
    out = []
    for i in range(max(1, min(14, days))):
        d = start + timedelta(days=i)
        out.append(day_view(d, rs.lessons(d), changes))
    return {"provider": rs.info(), "school_week_days": school_week_days(uid),
            "bells": ([{"lesson_number": i + 1, "start_time": s, "end_time": e} for i, (s, e) in enumerate(BELLS)] if rs.info()["is_demo"] else []),
            "days": out}


def school_day(uid: str, d: date) -> dict[str, Any]:
    """Сегодняшний день для initial-state (контракт SchoolDay: starts_at/ends_at/subject)."""
    rs = ResolvedSchedule(uid)
    v = day_view(d, rs.lessons(d), load_doc(uid)["changes"])
    lessons = [{"starts_at": x["start_time"], "ends_at": x["end_time"], "subject": x["subject"],
                "lesson_number": x["lesson_number"], "source": x["source"], "status": x["status"],
                "room": x.get("room"), "teacher": x.get("teacher"), "was": x.get("was"), "note": x.get("note")}
               for x in v["lessons"] if x["status"] == "active"]
    return {"date": d.isoformat(), "lessons": lessons, "last_bell": v["last_bell"]}
