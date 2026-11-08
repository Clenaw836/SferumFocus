"""v17 «Teacher Intelligence»: профиль учителя, предметные права, расписание учителя,
импорт изменений (EVIDENCE → PARSE → MATCH → PREVIEW → CONFIRM → APPLY), предложения
для общего слоя, подготовка к уроку, черновик плана, материалы.

Принципы (docs/TEACHER_MODE.md, docs/TEACHER_PERMISSIONS.md):
* Права проверяет только сервер. Роль из заголовка клиента НЕ даёт доступа к школьным данным.
* Источники: ``school`` — справочник школы (``TEACHER_DIRECTORY_FILE``, JSON) для подписанного
  MAX-пользователя; ``demo`` — синтетический справочник ниже (всё помечено DEMO). Реального API
  Сферума / «Сетевого города» нет — ничего оттуда не читаем и не выдаём за их данные.
* Личность учителя никогда не выводится из совпадения предмета или ФИО: ``match_teacher``
  возвращает ``exact`` только по идентификатору или по ФИО+школе при единственном кандидате.
* Модуль детерминирован, без вызовов ИИ: рекомендации — правила с указанием основания (``basis``).
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

from app.ephemeral import FileStore
from app.json_storage import transaction, read_record, write_record
from functools import wraps

DEMO_BADGE = "DEMO"
LOW_CONFIDENCE = 0.6          # ниже — строка импорта не применяется
PREVIEW_TTL = 15 * 60
_LOCK = threading.Lock()
_PREVIEWS = FileStore("teacher_previews", ttl=PREVIEW_TTL, max_items=2000)  # v18: переживает рестарт

# ------------------------------------------------------------------ звонки
BELLS: dict[str, list[tuple[str, str]]] = {
    # обычная школа — 45 мин
    "std": [("08:30", "09:15"), ("09:25", "10:10"), ("10:25", "11:10"), ("11:25", "12:10"),
            ("12:20", "13:05"), ("13:15", "14:00"), ("14:10", "14:55"), ("15:05", "15:50")],
    # лицей — 40 мин (проверка «план под длительность урока»)
    "short": [("08:00", "08:40"), ("08:50", "09:30"), ("09:45", "10:25"), ("10:40", "11:20"),
              ("11:35", "12:15"), ("12:25", "13:05"), ("13:15", "13:55")],
}

# ------------------------------------------------------------------ DEMO-справочник (синтетический)
_P = {"view_schedule": True, "view_stats": True, "edit_schedule": True, "approve_schedule": False, "grade": False}

def _a(cls: str, subject: str, **perm: bool) -> dict[str, Any]:
    return {"class": cls, "subject": subject, "perms": {**_P, **perm}}

DEMO_SCHOOLS: list[dict[str, Any]] = [
    {"id": "demo-s1", "name": "DEMO · Школа №1 (синтетическая)", "bells": "std"},
    {"id": "demo-s2", "name": "DEMO · Лицей «Север» (синтетический)", "bells": "short"},
]

DEMO_TEACHERS: list[dict[str, Any]] = [
    {"id": "demo-t-rus1", "school_id": "demo-s1", "full_name": "Смирнова Анна Петровна",
     "assignments": [_a("5А", "Русский язык"), _a("5А", "Литература"), _a("6Б", "Русский язык"), _a("9А", "Русский язык"), _a("9А", "Литература")]},
    {"id": "demo-t-rus2", "school_id": "demo-s1", "full_name": "Смирнова Анна Павловна",   # почти тёзка — проверка сопоставления
     "assignments": [_a("7В", "Русский язык", view_stats=False), _a("8А", "Русский язык")]},
    {"id": "demo-t-math1", "school_id": "demo-s1", "full_name": "Кузнецов Игорь Олегович",
     "assignments": [_a("5А", "Математика"), _a("6Б", "Математика"), _a("7В", "Алгебра"), _a("7В", "Геометрия")]},
    {"id": "demo-t-math2", "school_id": "demo-s1", "full_name": "Орлова Елена Викторовна",
     "assignments": [_a("8А", "Алгебра"), _a("8А", "Геометрия"), _a("9А", "Алгебра"), _a("9А", "Геометрия"), _a("9А", "Вероятность и статистика")]},
    {"id": "demo-t-phys", "school_id": "demo-s1", "full_name": "Белов Дмитрий Сергеевич",
     "assignments": [_a("7В", "Физика"), _a("8А", "Физика"), _a("9А", "Физика", view_stats=False), _a("11А", "Физика")]},
    {"id": "demo-t-head", "school_id": "demo-s1", "full_name": "Лебедева Ольга Ивановна", "role_note": "завуч",
     "assignments": [_a("10Б", "История", approve_schedule=True), _a("11А", "История", approve_schedule=True)],
     "school_perms": {"approve_schedule": True}},
    {"id": "demo-t2-math", "school_id": "demo-s2", "full_name": "Кузнецов Игорь Олегович",  # полный тёзка в другой школе
     "assignments": [_a("10А", "Алгебра"), _a("10А", "Геометрия"), _a("11А", "Алгебра")]},
    {"id": "demo-t2-rus", "school_id": "demo-s2", "full_name": "Фёдорова Мария Андреевна",
     "assignments": [_a("10А", "Русский язык"), _a("11А", "Русский язык"), _a("11А", "Литература")]},
]

# Темы по синтетическому КТП: известны не для всех уроков — где нет, честно «тема неизвестна».
DEMO_KTP: dict[tuple[str, str], list[str]] = {
    ("8А", "Алгебра"): ["Квадратные корни", "Квадратные уравнения", "Теорема Виета", "Дробные рациональные уравнения"],
    ("9А", "Алгебра"): ["Квадратичная функция", "Неравенства второй степени", "Арифметическая прогрессия"],
    ("5А", "Математика"): ["Обыкновенные дроби", "Сложение дробей", "Смешанные числа"],
    ("5А", "Русский язык"): ["Орфограммы в корне", "Чередование гласных", "Имя существительное"],
    ("8А", "Русский язык"): ["Односоставные предложения", "Обособленные определения"],
    ("8А", "Физика"): ["Тепловые явления", "Количество теплоты", "Удельная теплоёмкость"],
    ("10А", "Алгебра"): ["Тригонометрические функции", "Формулы приведения"],
}

_FIRST = ["Алина", "Богдан", "Варвара", "Глеб", "Дарья", "Егор", "Злата", "Илья", "Кира", "Лев", "Мирон", "Ника",
          "Олег", "Полина", "Роман", "София", "Тимур", "Ульяна", "Фёдор", "Яна"]
_LAST = ["А.", "Б.", "В.", "Г.", "Д.", "Е.", "Ж.", "З.", "И.", "К.", "Л.", "М."]


def _h(*parts: Any) -> int:
    return int(hashlib.sha256("|".join(map(str, parts)).encode()).hexdigest()[:12], 16)


def _grade(cls: str) -> int:
    m = re.match(r"(\d+)", cls)
    return int(m.group(1)) if m else 0


# ------------------------------------------------------------------ хранилище
def _dir() -> Path:
    return Path(os.getenv("SFERUM_DATA_DIR", "data")) / "teacher"


def _ns(source: str) -> str:
    """Демо и школа физически разделены: data/teacher/demo/… и data/teacher/school/…"""
    return "demo" if source == "demo" else "school"


def _path(source: str, school_id: str, name: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", school_id)[:64]
    return _dir() / _ns(source) / safe / name


def _load(p: Path, default: Any) -> Any:
    if p.is_relative_to(_dir()):
        return read_record(p, default)
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def _save(p: Path, doc: Any) -> None:
    write_record(p, doc)


def _teacher_session(fn):
    @wraps(fn)
    def call(t, source, *args, **kwargs):
        with transaction(_path(source, t["school_id"], "state").parent):
            return fn(t, source, *args, **kwargs)
    return call


def _school_session(fn):
    @wraps(fn)
    def call(source, school_id, *args, **kwargs):
        with transaction(_path(source, school_id, "state").parent):
            return fn(source, school_id, *args, **kwargs)
    return call


# ------------------------------------------------------------------ справочник и личность
def school_directory() -> list[dict[str, Any]]:
    """Справочник школы (боевой): JSON-файл из TEACHER_DIRECTORY_FILE.
    Формат: [{"id", "school_id", "full_name", "max_ids": ["…"], "assignments": [{"class","subject","perms":{…}}]}].
    Нет файла → пусто: школьный учительский режим не включается (а не «все учителя видят всё»)."""
    fn = os.getenv("TEACHER_DIRECTORY_FILE", "").strip()
    if not fn:
        return []
    doc = _load(Path(fn), [])
    return [t for t in doc if isinstance(t, dict) and t.get("id") and t.get("school_id")] if isinstance(doc, list) else []


def directory(source: str) -> list[dict[str, Any]]:
    return DEMO_TEACHERS if source == "demo" else school_directory()


def schools(source: str) -> list[dict[str, Any]]:
    if source == "demo":
        return DEMO_SCHOOLS
    ids = sorted({t["school_id"] for t in school_directory()})
    return [{"id": i, "name": i, "bells": "std"} for i in ids]


def _norm(s: str) -> str:
    return re.sub(r"[^а-яёa-z ]", "", re.sub(r"\s+", " ", (s or "").lower().replace("ё", "е"))).strip()


def _name_keys(full: str) -> set[str]:
    """«Орлова Елена Викторовна» → {«орлова елена викторовна», «орлова ев», «орлова е»}."""
    p = _norm(full).split()
    if not p:
        return set()
    keys = {" ".join(p)}
    if len(p) >= 3:
        keys.add(f"{p[0]} {p[1][0]}{p[2][0]}")
    if len(p) >= 2:
        keys.add(f"{p[0]} {p[1][0]}")
    return keys


def _query_key(name: str) -> str:
    n = _norm(name.replace(".", " "))
    p = n.split()
    if len(p) >= 2 and all(len(x) == 1 for x in p[1:]):   # «Орлова Е В» → «орлова ев»
        return f"{p[0]} {''.join(p[1:])}"
    return n


def match_teacher(source: str, *, teacher_id: str | None = None, full_name: str | None = None,
                  school_id: str | None = None, subject: str | None = None) -> dict[str, Any]:
    """Сопоставление учителя. Никогда не выбирает «первого совпавшего».
    exact — ровно один кандидат по id или по (ФИО/инициалы + школа); ambiguous — несколько;
    insufficient — дан только предмет (по специализации личность не определяем); not_found."""
    people = directory(source)
    if teacher_id:
        hit = [t for t in people if t["id"] == teacher_id]
        return {"status": "exact" if hit else "not_found", "candidates": [_pub(t) for t in hit]}
    if not full_name:
        if subject:
            cands = [t for t in people if (not school_id or t["school_id"] == school_id)
                     and any(a["subject"] == subject for a in t.get("assignments", []))]
            return {"status": "insufficient", "candidates": [_pub(t) for t in cands],
                    "reason": "По предмету учителя не определяем — нужен идентификатор или ФИО"}
        return {"status": "not_found", "candidates": []}
    q = _query_key(full_name)
    pool = [t for t in people if not school_id or t["school_id"] == school_id]
    hit = [t for t in pool if q in _name_keys(t["full_name"])]
    if subject and len(hit) > 1:
        narrowed = [t for t in hit if any(a["subject"] == subject for a in t.get("assignments", []))]
        hit = narrowed if len(narrowed) == 1 else hit   # предмет может только сузить до одного, но не выбрать
    st = "exact" if len(hit) == 1 else ("ambiguous" if hit else "not_found")
    if st == "exact" and not school_id and len([t for t in people if q in _name_keys(t["full_name"])]) > 1:
        st = "ambiguous"
    return {"status": st, "candidates": [_pub(t) for t in hit]}


def _pub(t: dict[str, Any]) -> dict[str, Any]:
    return {"id": t["id"], "school_id": t["school_id"], "full_name": t["full_name"], "role_note": t.get("role_note"),
            "subjects": sorted({a["subject"] for a in t.get("assignments", [])}),
            "classes": sorted({a["class"] for a in t.get("assignments", [])}, key=lambda c: (_grade(c), c))}


def resolve(source: str, *, max_uid: str | None = None, demo_teacher: str | None = None) -> dict[str, Any] | None:
    """Кто сейчас учитель. school: подписанный MAX-ID в справочнике школы; demo: выбранный демо-учитель."""
    if source == "school":
        if not max_uid:
            return None
        people = school_directory()
        hit = [t for t in people if max_uid in (t.get("max_ids") or [])]
        # One-time teacher invitation (app.teacher_invites): binds a VERIFIED MAX id to one directory record.
        # Permissions still come only from that record; an invitation can narrow classes, never widen them.
        from app import teacher_invites
        bound = teacher_invites.binding(max_uid) if people else None
        if bound:
            rec = [t for t in people if t["id"] == bound["teacher_id"] and t["school_id"] == bound["school_id"]]
            if len(rec) != 1 or (hit and [t["id"] for t in hit] != [rec[0]["id"]]):
                return None                          # record gone or conflicting mapping — fail closed
            t = rec[0]
            if bound["classes"]:
                t = {**t, "assignments": [a for a in t.get("assignments", []) if a.get("class") in set(bound["classes"])]}
            return t
        return hit[0] if len(hit) == 1 else None    # два профиля на один MAX-ID — конфликт, доступа нет
    if not demo_teacher:
        return None
    hit = [t for t in DEMO_TEACHERS if t["id"] == demo_teacher]
    return hit[0] if hit else None


def can(t: dict[str, Any], action: str, cls: str | None = None, subject: str | None = None) -> bool:
    if action == "grade":
        return False  # ни один подключённый источник не поддерживает выставление оценок
    if action == "approve_schedule" and (t.get("school_perms") or {}).get("approve_schedule"):
        return True
    for a in t.get("assignments", []):
        if (cls is None or a["class"] == cls) and (subject is None or a["subject"] == subject):
            if (a.get("perms") or {}).get(action):
                return True
    return False


def profile(t: dict[str, Any], source: str) -> dict[str, Any]:
    sch = next((s for s in schools(source) if s["id"] == t["school_id"]), {"id": t["school_id"], "name": t["school_id"]})
    return {**_pub(t), "school": {"id": sch["id"], "name": sch["name"]}, "source": source, "is_demo": source == "demo",
            "assignments": [{"class": a["class"], "subject": a["subject"],
                             "perms": {k: bool(v) and k != "grade" for k, v in (a.get("perms") or {}).items()}}
                            for a in t.get("assignments", [])],
            "can_approve": can(t, "approve_schedule"),
            "grade_supported": False,
            "grade_note": "Личный журнал и черновики оценок доступны в секции «Журнал и выставление оценок». Отправка в СГО требует подтверждённых прав и разрешения сервера.",
            "sync": {"status": "demo" if source == "demo" else "directory", "last_sync_at": None}}


# ------------------------------------------------------------------ базовое расписание (DEMO-генератор)
_WEEKLY = {"Русский язык": 5, "Литература": 3, "Математика": 5, "Алгебра": 4, "Геометрия": 3, "Вероятность и статистика": 1,
           "Физика": 3, "История": 3}


def _base_week(source: str, school_id: str) -> dict[tuple[int, int], list[dict[str, Any]]]:
    """(weekday, period) → уроки школы. Жадно, без пересечений по учителю и классу; детерминировано."""
    if source != "demo":
        return {}
    sch = next(s for s in DEMO_SCHOOLS if s["id"] == school_id)
    periods = len(BELLS[sch["bells"]])
    busy_t: set[tuple[str, int, int]] = set()
    busy_c: set[tuple[str, int, int]] = set()
    grid: dict[tuple[int, int], list[dict[str, Any]]] = {}
    jobs = []
    for t in DEMO_TEACHERS:
        if t["school_id"] != school_id:
            continue
        for a in t["assignments"]:
            for k in range(_WEEKLY.get(a["subject"], 2)):
                jobs.append((t["id"], a["class"], a["subject"], k))
    jobs.sort(key=lambda j: _h(*j))
    for tid, cls, subj, k in jobs:
        start = _h(tid, cls, subj, k, "slot")
        for off in range(5 * periods):
            s = (start + off) % (5 * periods)
            wd, p = s // periods, s % periods
            if p >= periods - 1 and _grade(cls) <= 6:
                continue
            if (tid, wd, p) in busy_t or (cls, wd, p) in busy_c:
                continue
            busy_t.add((tid, wd, p)); busy_c.add((cls, wd, p))
            room = f"каб. {10 + _h(cls, subj) % 30}"
            grid.setdefault((wd, p), []).append({"teacher_id": tid, "class": cls, "subject": subj, "room": room,
                                                 "group": "1 группа" if subj == "Информатика" else None})
            break
    return grid


def _bells(source: str, school_id: str) -> list[tuple[str, str]]:
    sch = next((s for s in schools(source) if s["id"] == school_id), None)
    return BELLS[(sch or {}).get("bells", "std")]


def _lesson_id(school_id: str, d: str, n: int, cls: str) -> str:
    return f"{school_id}:{d}:{n}:{cls}"


def _minutes(hhmm: str) -> int:
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def duration_min(start: str, end: str) -> int:
    return max(0, _minutes(end) - _minutes(start))


@_school_session
def school_day(source: str, school_id: str, d: date) -> list[dict[str, Any]]:
    """Все уроки школы на дату: база + общий утверждённый слой."""
    out: list[dict[str, Any]] = []
    if d.weekday() < 5:
        bells = _bells(source, school_id)
        for (wd, p), items in _base_week(source, school_id).items():
            if wd != d.weekday():
                continue
            for it in items:
                st, en = bells[p]
                topics = DEMO_KTP.get((it["class"], it["subject"]))
                topic = topics[_h(d.isoformat(), it["class"]) % len(topics)] if topics and _h(d.isoformat(), it["subject"]) % 3 else None
                out.append({"id": _lesson_id(school_id, d.isoformat(), p + 1, it["class"]), "date": d.isoformat(), "n": p + 1,
                            "start": st, "end": en, "class": it["class"], "subject": it["subject"], "room": it["room"],
                            "group": it["group"], "teacher_id": it["teacher_id"], "topic": topic,
                            "topic_source": "ktp_demo" if topic else None,
                            "source": "demo", "confirmation": "demo", "status": "active", "notes": []})
    shared = _load(_path(source, school_id, "shared.json"), {"changes": []})
    return _apply_changes(out, [c for c in shared["changes"] if c["date"] == d.isoformat()], layer="shared")


def _apply_changes(lessons: list[dict[str, Any]], changes: list[dict[str, Any]], *, layer: str) -> list[dict[str, Any]]:
    by_key = {(l["date"], l["n"], l["class"]): l for l in lessons}
    for c in changes:
        k = (c["date"], c["n"], c["class"])
        cur = by_key.get(k)
        note = f"{'Утверждено' if layer == 'shared' else 'Мой импорт'}: {c.get('kind_label', c['kind'])}"
        if c["kind"] == "cancel":
            if cur:
                cur.update(status="cancelled", confirmation=layer)
                cur["notes"] = cur["notes"] + [note]
            continue
        if cur and c["kind"] in ("room", "substitute", "change", "move"):
            was = {f: cur.get(f) for f in ("start", "end", "room", "teacher_id", "subject")}
            for f in ("start", "end", "room", "teacher_id", "subject", "group", "topic"):
                if c.get(f):
                    cur[f] = c[f]
            cur.update(confirmation=layer, source=c.get("source", cur["source"]))
            cur["was"] = was
            cur["notes"] = cur["notes"] + [note]
        elif not cur:
            new = {"id": _lesson_id(c.get("school_id", "x"), c["date"], c["n"], c["class"]), "date": c["date"], "n": c["n"],
                   "start": c["start"], "end": c["end"], "class": c["class"], "subject": c["subject"], "room": c.get("room"),
                   "group": c.get("group"), "teacher_id": c.get("teacher_id"), "topic": c.get("topic"),
                   "topic_source": "teacher" if c.get("topic") else None, "source": c.get("source", "import"),
                   "confirmation": layer, "status": "active", "notes": [note]}
            lessons.append(new)
            by_key[k] = new
    lessons.sort(key=lambda l: (l["start"], l["class"]))
    return lessons


@_teacher_session
def teacher_day(t: dict[str, Any], source: str, d: date, *, scenario: str = "normal") -> dict[str, Any]:
    """Расписание учителя на день + состояние источника."""
    sch = t["school_id"]
    if source == "school" or scenario == "not_loaded":
        lessons: list[dict[str, Any]] = []
        state = "not_loaded"
    else:
        allday = school_day(source, sch, d)
        mine = [dict(l) for l in allday if l.get("teacher_id") == t["id"]]
        personal = _load(_path(source, sch, f"{t['id']}.personal.json"), {"changes": []})
        mine = _apply_changes(mine, [dict(c, school_id=sch) for c in personal["changes"] if c["date"] == d.isoformat()], layer="personal")
        mine = [l for l in mine if l.get("teacher_id") in (t["id"], None)]
        lessons = mine
        state = "ok" if lessons else ("no_lessons" if d.weekday() >= 5 or not lessons else "ok")
    for l in lessons:
        l["duration_min"] = duration_min(l["start"], l["end"])
        l["is_demo"] = source == "demo"
    act = [l for l in lessons if l["status"] == "active"]
    conflicts = [[a["id"], b["id"]] for i, a in enumerate(act) for b in act[i + 1:]
                 if _minutes(a["start"]) < _minutes(b["end"]) and _minutes(b["start"]) < _minutes(a["end"])]
    if conflicts:
        state = "conflict"
    if any(l.get("start") is None for l in lessons):
        state = "partial"
    meta = {"source": source, "source_label": "DEMO · синтетическое расписание" if source == "demo" else "Справочник школы",
            "last_sync_at": None, "stale": False}
    if scenario == "stale":
        state, meta["stale"] = "stale", True
        meta["last_sync_at"] = (datetime.combine(d, datetime.min.time()) - timedelta(days=3)).isoformat(timespec="minutes")
    if scenario == "unavailable":
        state, lessons, conflicts = "unavailable", [], []
    pending = [p for p in proposals(source, sch) if p["status"] == "pending" and t["id"] in p.get("affected_teachers", [])]
    if pending and state == "ok":
        state = "pending_import"
    changes = [n for l in lessons for n in l.get("notes", [])]
    return {"date": d.isoformat(), "state": state, "lessons": lessons, "conflicts": conflicts, "meta": meta,
            "pending_proposals": [p["id"] for p in pending], "changes": changes, "is_demo": source == "demo"}


def next_lesson(day: dict[str, Any], now_hhmm: str | None) -> dict[str, Any] | None:
    act = [l for l in day["lessons"] if l["status"] == "active"]
    if not act:
        return None
    if not now_hhmm:
        return act[0]
    nm = _minutes(now_hhmm)
    for l in act:
        if _minutes(l["end"]) > nm:
            return l
    return None


# ------------------------------------------------------------------ тепловая карта (DEMO)
def _students(source: str, school_id: str, cls: str) -> list[str]:
    n = 14 + _h(school_id, cls) % 9
    return [f"{_FIRST[(_h(cls, i) + i) % len(_FIRST)]} {_LAST[_h(cls, i, 'l') % len(_LAST)]}" for i in range(n)]


def class_results(t: dict[str, Any], source: str, cls: str, subject: str) -> dict[str, Any]:
    """Результаты последней мини-проверки по (класс, предмет). 403-логика — в can(view_stats)."""
    if source != "demo":
        return {"available": False, "reason": "Источник результатов проверок не подключён", "is_demo": False}
    topics = DEMO_KTP.get((cls, subject))
    qn = 5
    qs = []
    for i in range(qn):
        linked = bool(topics) and _h(cls, subject, i, "link") % 4 != 0
        qs.append({"id": f"q{i + 1}", "text": f"Вопрос {i + 1}", "topic": (topics[i % len(topics)] if linked else None),
                   "topic_link_confirmed": linked})
    names = _students(source, t["school_id"], cls)
    seed = _h(cls, subject)
    rows = []
    for i, nm in enumerate(names):
        skill = (_h(seed, nm) % 100) / 100
        answers: list[bool | None] = []
        absent = _h(seed, nm, "abs") % 9 == 0
        for j, q in enumerate(qs):
            if absent:
                answers.append(None)
                continue
            hard = 0.30 + 0.08 * ((_h(seed, j, "q") % 5))
            answers.append(((_h(seed, nm, j) % 100) / 100) * 0.5 + skill * 0.6 > hard)
        done = [a for a in answers if a is not None]
        correct = sum(1 for a in done if a)
        rows.append({"student": nm, "answers": answers, "answered": len(done), "correct": correct,
                     "correct_pct": round(correct * 100 / len(done)) if done else None})
    per_q = []
    for j, q in enumerate(qs):
        col = [r["answers"][j] for r in rows if r["answers"][j] is not None]
        per_q.append({**q, "answered": len(col), "correct_pct": round(sum(1 for a in col if a) * 100 / len(col)) if col else None})
    responded = sum(1 for r in rows if r["answered"])
    insufficient = responded < max(5, len(rows) // 2)
    hardest = sorted([q for q in per_q if q["correct_pct"] is not None], key=lambda q: (q["correct_pct"], q["id"]))[:2]
    check_date = (date(2026, 10, 1) + timedelta(days=seed % 9)).isoformat()
    return {"available": True, "is_demo": True, "class": cls, "subject": subject,
            "check": {"id": f"demo-check-{seed % 10000}", "kind": "mini_quiz", "title": f"Мини-проверка ({DEMO_BADGE})",
                      "date": check_date, "questions": qn, "period": f"проверка от {check_date}"},
            "class_size": len(rows), "responded": responded, "insufficient": insufficient,
            "rows": sort_rows(rows, "best"), "questions": per_q, "hardest": hardest,
            "caveat": "Это результат одной мини-проверки, а не итоговое освоение темы."}


def sort_rows(rows: list[dict[str, Any]], order: str) -> list[dict[str, Any]]:
    """Стабильная сортировка. best: % верных ↓, ответов ↓, имя ↑; без данных — в конце. alpha: имя ↑."""
    def nk(r: dict[str, Any]) -> tuple[str, str]:   # «Ё» рядом с «Е», как localeCompare("ru") на клиенте
        return (r["student"].lower().replace("ё", "е"), r["student"])
    if order == "alpha":
        return sorted(rows, key=nk)
    return sorted(rows, key=lambda r: (r["correct_pct"] is None, -(r["correct_pct"] or 0), -r["answered"], nk(r)))


# ------------------------------------------------------------------ образовательные источники
EDU_SOURCES: list[dict[str, Any]] = [
    {"id": "edsoo-frp", "title": "Федеральные рабочие программы по учебным предметам", "org": "ФГБНУ «Институт содержания и методов обучения имени В.С. Леднева»",
     "url": "https://edsoo.ru/rabochie-programmy/", "kind": "official_program", "priority": 2, "subjects": "*", "grades": [1, 11],
     "license": "Использование материалов — с активной ссылкой на первоисточник (условие сайта)", "checked_at": "2026-10-10"},
    {"id": "edsoo-constructor", "title": "Конструктор рабочих программ", "org": "ФГБНУ «ИСМО им. В.С. Леднева»",
     "url": "https://edsoo.ru/konstruktor-rabochih-programm/", "kind": "official_program", "priority": 2, "subjects": "*", "grades": [1, 11],
     "license": "Сервис с регистрацией; содержимое программ — по условиям edsoo.ru", "checked_at": "2026-10-10"},
    {"id": "fpu", "title": "Федеральный перечень учебников (приказ Минпросвещения России от 22.06.2026 № 436)", "org": "Минпросвещения России",
     "url": "https://fpu.edu.ru/", "kind": "official_register", "priority": 3, "subjects": "*", "grades": [1, 11],
     "license": "Перечень — официальный документ; тексты учебников защищены авторским правом и сюда не копируются", "checked_at": "2026-10-10"},
    {"id": "resh", "title": "Российская электронная школа — интерактивные уроки 1–11 класс", "org": "Минпросвещения России",
     "url": "https://resh.edu.ru/", "kind": "official_lessons", "priority": 3, "subjects": "*", "grades": [1, 11],
     "license": "Открытый доступ для пользователей; храним только ссылки", "checked_at": "2026-10-10"},
]


def materials(t: dict[str, Any], source: str, subject: str | None, cls: str | None, topic: str | None = None) -> dict[str, Any]:
    own = _load(_path(source, t["school_id"], f"{t['id']}.materials.json"), {"items": []})["items"]
    g = _grade(cls) if cls else None
    own_f = [m for m in own if (not subject or m.get("subject") == subject) and (not cls or m.get("class") in (None, "", cls))]
    if topic:
        own_f.sort(key=lambda m: (m.get("topic") != topic,))
    off = [dict(s) for s in EDU_SOURCES if s["subjects"] == "*" and (g is None or s["grades"][0] <= g <= s["grades"][1])]
    return {"teacher": [{**m, "priority": 1, "kind": "teacher"} for m in own_f], "official": sorted(off, key=lambda s: s["priority"]),
            "note": "Единого открытого API школьной программы нет: показываем ваши материалы и ссылки на официальные ресурсы."}


@_teacher_session
def add_material(t: dict[str, Any], source: str, item: dict[str, Any]) -> dict[str, Any]:
    p = _path(source, t["school_id"], f"{t['id']}.materials.json")
    with transaction(_path(source, t["school_id"], "state").parent):
        doc = _load(p, {"items": []})
        rec = {k: (str(item.get(k) or "")[:300] or None) for k in ("title", "author", "subject", "class", "topic", "url", "edition", "license")}
        if not rec["title"]:
            raise ValueError("Нужно название материала")
        if rec["url"] and not re.match(r"^https?://", rec["url"]):
            raise ValueError("Ссылка должна начинаться с http:// или https://")
        rec["id"] = hashlib.sha256(json.dumps(rec, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:12]
        rec["checked_at"] = date.today().isoformat()
        if not any(m["id"] == rec["id"] for m in doc["items"]):
            doc["items"].append(rec)
            _save(p, doc)
    return rec


# ------------------------------------------------------------------ подготовка и план
_SUBJECT_TIPS: dict[str, dict[str, list[str]]] = {
    "Алгебра": {"prior": ["действия с дробями и степенями", "раскрытие скобок и формулы сокращённого умножения"],
                "errors": ["потеря знака при переносе слагаемых", "деление на выражение, которое может быть нулём"],
                "questions": ["Как проверить, что найденный корень подходит?", "Что изменится, если коэффициент a = 0?"]},
    "Геометрия": {"prior": ["определения и свойства фигур из прошлой темы", "единицы измерения"],
                  "errors": ["опора на «видно по чертежу» вместо доказательства", "путаница высоты и медианы"],
                  "questions": ["Какое свойство мы использовали на этом шаге?", "Верно ли обратное утверждение?"]},
    "Математика": {"prior": ["таблица умножения и деление с остатком", "сравнение чисел"],
                   "errors": ["сложение знаменателей при сложении дробей", "потеря единиц измерения"],
                   "questions": ["Покажи на рисунке, что означает эта дробь", "Как проверить ответ другим способом?"]},
    "Русский язык": {"prior": ["разбор слова по составу", "части речи"],
                     "errors": ["проверка безударной гласной однокоренным словом с другим значением", "пропуск запятых при однородных членах"],
                     "questions": ["Подбери проверочное слово и объясни выбор", "Найди грамматическую основу"]},
    "Физика": {"prior": ["единицы СИ и перевод единиц", "чтение графиков"],
               "errors": ["путаница массы и веса", "подстановка без перевода единиц"],
               "questions": ["Какие величины даны и в каких единицах?", "Как изменится ответ, если удвоить массу?"]},
}
_GENERAL = {"prior": ["ключевые понятия прошлого урока"], "errors": ["формальное заучивание без понимания"],
            "questions": ["Объясни своими словами главную идею", "Приведи пример из жизни"]}


def prep(t: dict[str, Any], source: str, lesson: dict[str, Any]) -> dict[str, Any]:
    """Подготовка к уроку: факты отдельно, рекомендации — с основанием и типом."""
    cls, subj = lesson["class"], lesson["subject"]
    facts = [{"k": "Урок", "v": f"{lesson['n']}-й, {lesson['start']}–{lesson['end']} ({lesson['duration_min']} мин)", "source": lesson["source"]},
             {"k": "Класс", "v": cls, "source": lesson["source"]}, {"k": "Предмет", "v": subj, "source": lesson["source"]}]
    if lesson.get("room"):
        facts.append({"k": "Кабинет", "v": lesson["room"], "source": lesson["source"]})
    topic = lesson.get("topic")
    facts.append({"k": "Тема", "v": topic or "неизвестна", "source": lesson.get("topic_source") or "нет данных"})
    stats = None
    stats_note = None
    if can(t, "view_stats", cls, subj):
        res = class_results(t, source, cls, subj)
        if res.get("available"):
            stats = {"check": res["check"], "responded": res["responded"], "class_size": res["class_size"],
                     "insufficient": res["insufficient"], "hardest": res["hardest"], "caveat": res["caveat"]}
    else:
        stats_note = "Нет права на просмотр результатов этого класса по предмету."
    tips = _SUBJECT_TIPS.get(subj, _GENERAL)
    recs: list[dict[str, Any]] = []
    if stats and not stats["insufficient"]:
        for q in stats["hardest"]:
            if q["topic_link_confirmed"] and q["topic"]:
                recs.append({"kind": "data", "text": f"Повторить «{q['topic']}»: верно ответили {q['correct_pct']} % ({q['answered']} ответов, «{q['text']}»).",
                             "basis": f"{stats['check']['title']}, {stats['check']['period']}, вопрос {q['id']}"})
            else:
                recs.append({"kind": "data", "text": f"«{q['text']}» решили верно {q['correct_pct']} % — связь вопроса с темой не подтверждена, разберите сам вопрос, а не тему.",
                             "basis": f"{stats['check']['title']}, вопрос {q['id']}"})
    elif stats and stats["insufficient"]:
        recs.append({"kind": "data", "text": f"Данных мало: ответили {stats['responded']} из {stats['class_size']}. Задайте 2–3 вопроса в начале урока.",
                     "basis": stats["check"]["title"]})
    for p_ in tips["prior"]:
        recs.append({"kind": "general", "text": f"Предварительные знания: {p_}.", "basis": f"Общая рекомендация по предмету «{subj}» (не по данным класса)"})
    for e in tips["errors"]:
        recs.append({"kind": "general", "text": f"Возможная ошибка: {e}.", "basis": "Общая рекомендация по предмету"})
    questions = [{"text": q, "basis": "Общая рекомендация по предмету"} for q in tips["questions"]]
    if not topic:
        recs.insert(0, {"kind": "missing", "text": "Тема урока неизвестна — укажите её, чтобы подобрать материалы.", "basis": "Нет темы в расписании и КТП"})
    return {"lesson": lesson, "facts": facts, "stats": stats, "stats_note": stats_note, "recommendations": recs,
            "check_questions": questions, "materials": materials(t, source, subj, cls, topic), "is_demo": source == "demo",
            "ai_used": False, "plan": saved_plan(t, source, lesson["id"])}


_STAGES = [("Организационный момент", 0.05), ("Актуализация знаний", 0.15), ("Объяснение ключевой идеи", 0.28),
           ("Практика", 0.32), ("Проверка понимания", 0.13), ("Домашнее задание", 0.07)]


def plan_draft(lesson: dict[str, Any], topic: str | None, gaps: list[str] | None = None) -> dict[str, Any]:
    """Черновик плана строго под длительность урока (сумма = duration_min)."""
    total = lesson["duration_min"]
    mins = [max(1, round(total * w)) for _, w in _STAGES]
    mins[3] += total - sum(mins)        # остаток — в практику
    stages = [{"title": t_, "minutes": m, "text": ""} for (t_, _), m in zip(_STAGES, mins)]
    stages[1]["text"] = "Повторить: " + (", ".join(gaps) if gaps else "ключевые понятия прошлого урока")
    stages[2]["text"] = f"Тема: {topic}" if topic else "Тема не указана — заполните"
    return {"lesson_id": lesson["id"], "duration_min": total, "topic": topic, "stages": stages,
            "adaptation": "Если в проверке понимания больше половины ошибок — сократить практику и вернуться к объяснению на примере.",
            "status": "draft", "generated_by": "rules", "note": "Черновик — предложение, а не план. Отредактируйте и сохраните."}


def _plans_path(t: dict[str, Any], source: str) -> Path:
    return _path(source, t["school_id"], f"{t['id']}.plans.json")


@_teacher_session
def saved_plan(t: dict[str, Any], source: str, lesson_id: str) -> dict[str, Any] | None:
    return _load(_plans_path(t, source), {}).get(lesson_id)


@_teacher_session
def save_plan(t: dict[str, Any], source: str, lesson: dict[str, Any], plan: dict[str, Any]) -> dict[str, Any]:
    stages = plan.get("stages") or []
    total = sum(int(s.get("minutes") or 0) for s in stages)
    if total != lesson["duration_min"]:
        raise ValueError(f"Сумма этапов {total} мин, а урок длится {lesson['duration_min']} мин")
    rec = {"lesson_id": lesson["id"], "duration_min": lesson["duration_min"], "topic": (plan.get("topic") or None),
           "stages": [{"title": str(s.get("title", ""))[:120], "minutes": int(s.get("minutes") or 0), "text": str(s.get("text", ""))[:1000]} for s in stages],
           "adaptation": str(plan.get("adaptation") or "")[:1000], "status": "saved", "saved_at": datetime.now().isoformat(timespec="minutes")}
    with transaction(_path(source, t["school_id"], "state").parent):
        doc = _load(_plans_path(t, source), {})
        doc[lesson["id"]] = rec
        _save(_plans_path(t, source), doc)
    return rec


# ------------------------------------------------------------------ импорт
_KIND = [(r"отмен", "cancel", "отмена"), (r"замен", "substitute", "замена учителя"), (r"перенос|перенес", "move", "перенос"),
         (r"(смена|сменить|другой)\s+каб", "room", "смена кабинета")]
_WD = {"пн": 0, "вт": 1, "ср": 2, "чт": 3, "пт": 4, "сб": 5, "вс": 6, "по": 0, "че": 3, "пя": 4, "су": 5, "во": 6}


def parse_teacher_text(text: str, today: date) -> list[dict[str, Any]]:
    """Строки вида «2026-10-12 3 08:30-09:15 8А Алгебра каб. 21 Орлова Е.В. замена».
    Дата — YYYY-MM-DD, ДД.ММ или день недели (строкой выше или в начале строки). Время обязательно.
    Неразобранное попадает в unrecognized, ничего не угадывается."""
    rows: list[dict[str, Any]] = []
    cur_date: str | None = None
    for i, raw in enumerate(text.splitlines()[:300]):
        line = raw.strip().replace("–", "-").replace("—", "-")
        if not line:
            continue
        low = line.lower()
        d: str | None = None
        m = re.match(r"^(\d{4}-\d{2}-\d{2})\b\s*", line)
        m2 = re.match(r"^(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?\b\s*", line)
        m3 = re.match(r"^(пн|вт|ср|чт|пт|сб|вс|понедельник|вторник|среда|среду|четверг|пятница|пятницу|суббота|субботу)[а-я.]*[,:]?\s*", low)
        rest = line
        if m:
            d, rest = m.group(1), line[m.end():]
        elif m2 and not re.match(r"^\d{1,2}\.\d{1,2}\s*-", line):
            y = int(m2.group(3)) if m2.group(3) else today.year
            y = y + 2000 if y < 100 else y
            try:
                d = date(y, int(m2.group(2)), int(m2.group(1))).isoformat()
                rest = line[m2.end():]
            except ValueError:
                d = None
        elif m3:
            k = _WD[m3.group(1)[:2]]
            d = (today + timedelta(days=(k - today.weekday()) % 7)).isoformat()
            rest = line[m3.end():]
        if d and not rest.strip():
            cur_date = d
            continue
        d = d or cur_date
        unrec: list[str] = []
        mt = re.search(r"(\d{1,2}[:.]\d{2})\s*-\s*(\d{1,2}[:.]\d{2})", rest)
        mn = re.match(r"^\s*(\d{1,2})\s*[.)-]?\s+", rest)
        mc = re.search(r"\b(\d{1,2})\s?([А-ЯЁ])\b", rest)
        mr = re.search(r"каб(?:инет)?\.?\s*([\w-]+)", rest, re.I)
        mtch = re.search(r"([А-ЯЁ][а-яё]+(?:ой|ва|на|ев|ов|ин|ий|ая|ко|ук|юк|ец|ых|их)?)\s+([А-ЯЁ])\.\s?([А-ЯЁ])\.?", rest)
        kind, label = "change", "изменение"
        for pat, k_, lb in _KIND:
            if re.search(pat, low):
                kind, label = k_, lb
                break
        subj = None
        for s in sorted(set(_WEEKLY) | {"Информатика", "Биология", "Химия", "География", "Обществознание", "Английский язык"}, key=len, reverse=True):
            if s.lower() in low:
                subj = s
                break
        start = mt.group(1).replace(".", ":") if mt else None
        end = mt.group(2).replace(".", ":") if mt else None
        if start and len(start) == 4:
            start = "0" + start
        if end and len(end) == 4:
            end = "0" + end
        cls = f"{mc.group(1)}{mc.group(2)}" if mc else None
        if not d:
            unrec.append("дата")
        if not start:
            unrec.append("время")
        if not cls:
            unrec.append("класс")
        if not subj and kind != "cancel":
            unrec.append("предмет")
        rows.append({"row": i + 1, "raw": raw.strip()[:200], "date": d, "n": int(mn.group(1)) if mn else None, "start": start, "end": end,
                     "class": cls, "subject": subj, "room": f"каб. {mr.group(1)}" if mr else None,
                     "teacher_name": f"{mtch.group(1)} {mtch.group(2)}.{mtch.group(3)}." if mtch else None,
                     "kind": kind, "kind_label": label, "unrecognized": unrec,
                     "field_source": {f: "text" for f in ("date", "start", "end", "class", "subject", "room", "teacher_name")}})
    return rows


def _period_for(source: str, school_id: str, start: str | None) -> int | None:
    if not start:
        return None
    for i, (st, _) in enumerate(_bells(source, school_id)):
        if st == start:
            return i + 1
    return None


@_teacher_session
def preview_import(t: dict[str, Any], source: str, payload: str, *, source_kind: str, legibility: float, today: date) -> dict[str, Any]:
    if source_kind not in ("text", "image", "file", "manual"):
        raise ValueError("Неизвестный тип источника")
    rows = parse_teacher_text(payload, today)
    content_hash = hashlib.sha256(re.sub(r"\s+", " ", payload.strip().lower()).encode()).hexdigest()[:24]
    journal = _load(_path(source, t["school_id"], f"{t['id']}.journal.json"), {"entries": []})
    dup = next((e for e in journal["entries"] if e.get("content_hash") == content_hash and not e.get("reverted")), None)
    base_conf = 1.0 if source_kind in ("text", "manual") else max(0.0, min(1.0, float(legibility)))
    out = []
    my_days: dict[str, dict[str, Any]] = {}
    for r in rows:
        conf = round(base_conf * (1.0 - 0.15 * len(r["unrecognized"])), 2)
        r["confidence"] = conf
        r["n"] = r["n"] or _period_for(source, t["school_id"], r["start"])
        if r["start"] is None and r["n"] and r["n"] <= len(_bells(source, t["school_id"])):
            r["start"], r["end"] = _bells(source, t["school_id"])[r["n"] - 1]
            r["field_source"]["start"] = r["field_source"]["end"] = "bells"
            if "время" in r["unrecognized"]:
                r["unrecognized"].remove("время")
        # кому относится строка
        match = None
        if r["teacher_name"]:
            match = match_teacher(source, full_name=r["teacher_name"], school_id=t["school_id"], subject=r["subject"])
        if match and match["status"] == "exact":
            owner = match["candidates"][0]["id"]
            r["owner"] = "me" if owner == t["id"] else "other"
            r["owner_teacher"] = match["candidates"][0]
        elif match and match["status"] == "ambiguous":
            r["owner"], r["owner_candidates"] = "ambiguous", match["candidates"]
        elif match:
            r["owner"] = "unknown_teacher"
        elif r["class"] and r["subject"] and can(t, "edit_schedule", r["class"], r["subject"]):
            r["owner"] = "me"
        else:
            r["owner"] = "unconfirmed"   # предмет совпал со специализацией — это не доказательство
        # сравнение с текущим днём учителя
        cur = None
        if r["date"]:
            if r["date"] not in my_days:
                my_days[r["date"]] = teacher_day(t, source, date.fromisoformat(r["date"]))
            same = [l for l in my_days[r["date"]]["lessons"] if l["class"] == r["class"] and (l["n"] == r["n"] or l["start"] == r["start"])]
            cur = same[0] if same else None
        if r["kind"] == "cancel":
            r["effect"] = "cancelled" if cur else "nothing_to_cancel"
        elif cur:
            diff = [f for f in ("start", "end", "room", "subject") if r.get(f) and r[f] != cur.get(f)]
            r["effect"] = "changed" if diff or r["kind"] in ("substitute",) else "same"
            r["was"] = {f: cur.get(f) for f in ("start", "end", "room", "subject")}
        else:
            r["effect"] = "new"
        r["conflict"] = None
        if r["date"] and r["start"] and r["end"] and r["kind"] != "cancel" and r["owner"] == "me":
            for l in my_days[r["date"]]["lessons"]:
                if l["status"] == "active" and l is not cur and l["class"] != r["class"] and \
                   _minutes(l["start"]) < _minutes(r["end"]) and _minutes(r["start"]) < _minutes(l["end"]):
                    r["conflict"] = f"пересекается с {l['n']}-м уроком {l['class']} {l['start']}–{l['end']}"
        blocked = []
        if conf < LOW_CONFIDENCE:
            blocked.append("низкая уверенность распознавания")
        if r["unrecognized"] and r["kind"] != "cancel":
            blocked.append("не распознано: " + ", ".join(r["unrecognized"]))
        if r["owner"] in ("ambiguous", "unknown_teacher", "unconfirmed"):
            blocked.append({"ambiguous": "несколько учителей с таким ФИО — уточните", "unknown_teacher": "учитель не найден в справочнике",
                            "unconfirmed": "нет подтверждения, что урок ваш"}[r["owner"]])
        if r["conflict"]:
            blocked.append("конфликт расписания")
        if r["effect"] in ("same", "nothing_to_cancel"):
            blocked.append("изменений нет")
        r["blocked"] = blocked
        r["applicable"] = not blocked
        r["id"] = f"r{r['row']}"
        out.append(r)
    token = __import__("uuid").uuid4().hex[:24]
    _PREVIEWS.put(token, t["id"], {"teacher": t["id"], "source": source, "rows": out, "content_hash": content_hash, "source_kind": source_kind})
    groups = {g: [r["id"] for r in out if r["effect"] == g] for g in ("new", "changed", "cancelled")}
    return {"ok": True, "token": token, "rows": out, "groups": groups,
            "conflicts": [r["id"] for r in out if r["conflict"]], "unrecognized": [r["id"] for r in out if r["unrecognized"]],
            "duplicate_of": dup and {"journal_id": dup["id"], "at": dup["at"]}, "source_kind": source_kind,
            "confidence": base_conf, "is_demo": source == "demo",
            "official": False, "note": "Личный скриншот/файл — не официальное изменение школы. Чужие уроки уйдут на подтверждение."}


@_teacher_session
def confirm_import(t: dict[str, Any], source: str, token: str, accept: list[str]) -> dict[str, Any]:
    with transaction(_path(source, t["school_id"], "state").parent):
        jp = _path(source, t["school_id"], f"{t['id']}.journal.json")
        journal = _load(jp, {"entries": []})
        prev = next((e for e in journal["entries"] if e.get("token") == token), None)
        if prev:
            if prev["reverted"]:
                return {"ok": False, "error": "import_reverted"}
            personal = _load(_path(source, t["school_id"], f"{t['id']}.personal.json"), {"changes": []})
            if prev["applied"] and (not prev.get("effects") or not all(c in personal["changes"] for c in prev["effects"])):
                return {"ok": False, "error": "import_superseded"}
            return {"ok": True, "repeat": True, "journal_id": prev["id"], "applied": prev["applied"], "proposed": prev["proposed"]}
        with _PREVIEWS.lease(token, t["id"]) as pv:
            if not pv or pv["teacher"] != t["id"] or pv["source"] != source:
                return {"ok": False, "error": "preview_expired"}
            dup = next((e for e in journal["entries"] if e.get("content_hash") == pv["content_hash"] and not e.get("reverted")), None)
            if dup:
                effective = _load(_path(source, t["school_id"], f"{t['id']}.personal.json"), {"changes": []})
                if dup["applied"] and (not dup.get("effects") or not all(c in effective["changes"] for c in dup["effects"])):
                    return {"ok": False, "error": "import_superseded"}
                return {"ok": True, "repeat": True, "journal_id": dup["id"], "applied": dup["applied"], "proposed": dup["proposed"]}
            rows = {r["id"]: r for r in pv["rows"]}
            pp = _path(source, t["school_id"], f"{t['id']}.personal.json")
            personal = _load(pp, {"changes": []})
            before = json.loads(json.dumps(personal))
            applied, proposed = [], []
            jid = token[:12]
            for rid in accept:
                r = rows.get(rid)
                if not r or not r["applicable"]:
                    continue
                ch = {"date": r["date"], "n": r["n"], "class": r["class"], "subject": r["subject"], "start": r["start"], "end": r["end"],
                      "room": r["room"], "kind": r["kind"], "kind_label": r["kind_label"], "source": f"import:{pv['source_kind']}", "journal_id": jid}
                if r["owner"] == "me":
                    ch["teacher_id"] = t["id"]
                    personal["changes"] = [c for c in personal["changes"] if (c["date"], c["n"], c["class"]) != (ch["date"], ch["n"], ch["class"])] + [ch]
                    applied.append(rid)
            # строки про других учителей (точное совпадение) → предложение в общий слой
            others = [rows[rid] for rid in accept if rid in rows and rows[rid].get("owner") == "other"
                      and not [b for b in rows[rid]["blocked"] if b != "нет подтверждения, что урок ваш"]]
            if others:
                prop = _new_proposal(t, source, others, pv["source_kind"], jid)
                proposed = [r["id"] for r in others]
            else:
                prop = None
            if not applied and not proposed:
                return {"ok": False, "error": "nothing_applicable"}
            _save(pp, personal)
            check = _load(pp, {"changes": []})
            if check != personal:              # VERIFY перечитыванием, иначе откат
                _save(pp, before)
                return {"ok": False, "error": "verify_failed"}
            entry = {"id": jid, "token": token, "content_hash": pv["content_hash"], "at": datetime.now().isoformat(timespec="minutes"),
                     "applied": applied, "proposed": proposed, "proposal_id": prop and prop["id"], "before": before, "reverted": False,
                     "source_kind": pv["source_kind"], "effects": [dict(c) for c in personal["changes"] if c.get("journal_id") == jid]}
            journal["entries"].append(entry)
            _save(jp, journal)
    return {"ok": True, "repeat": False, "journal_id": jid, "applied": applied, "proposed": proposed, "proposal_id": prop and prop["id"]}


@_teacher_session
def journal(t: dict[str, Any], source: str) -> list[dict[str, Any]]:
    j = _load(_path(source, t["school_id"], f"{t['id']}.journal.json"), {"entries": []})["entries"]
    return [{k: e[k] for k in ("id", "at", "applied", "proposed", "proposal_id", "reverted", "source_kind")} for e in reversed(j)]


@_teacher_session
def revert_import(t: dict[str, Any], source: str, journal_id: str) -> dict[str, Any]:
    with transaction(_path(source, t["school_id"], "state").parent):
        jp = _path(source, t["school_id"], f"{t['id']}.journal.json")
        j = _load(jp, {"entries": []})
        e = next((x for x in j["entries"] if x["id"] == journal_id), None)
        if not e or e["reverted"]:
            return {"ok": False, "error": "not_found"}
        if any(x for x in j["entries"][j["entries"].index(e) + 1:] if not x["reverted"] and x["applied"]):
            return {"ok": False, "error": "newer_imports", "message": "Сначала отмените более поздние импорты"}
        if e.get("proposal_id"):
            proposal = next((p for p in _load(_proposals_path(source, t["school_id"]), {"items": []})["items"]
                             if p["id"] == e["proposal_id"]), None)
            if proposal and proposal["status"] == "approved":
                # Owner undo cannot revoke an authorized shared-school decision.
                return {"ok": False, "error": "proposal_approved", "message": "Утверждённое изменение требует решения школы"}
        pp = _path(source, t["school_id"], f"{t['id']}.personal.json")
        _save(pp, e["before"])
        e["reverted"] = True
        if e.get("proposal_id"):
            ps = _proposals_path(source, t["school_id"])
            doc = _load(ps, {"items": []})
            for p in doc["items"]:
                if p["id"] == e["proposal_id"] and p["status"] == "pending":
                    p["status"] = "withdrawn"
            _save(ps, doc)
        _save(jp, j)
    return {"ok": True, "reverted": journal_id}


# ------------------------------------------------------------------ предложения → общий слой
def _proposals_path(source: str, school_id: str) -> Path:
    return _path(source, school_id, "proposals.json")


@_school_session
def proposals(source: str, school_id: str) -> list[dict[str, Any]]:
    return _load(_proposals_path(source, school_id), {"items": []})["items"]


def _new_proposal(t: dict[str, Any], source: str, rows: list[dict[str, Any]], kind: str, jid: str) -> dict[str, Any]:
    ps = _proposals_path(source, t["school_id"])
    doc = _load(ps, {"items": []})
    pid = hashlib.sha256(f"{t['id']}|{jid}".encode()).hexdigest()[:12]
    changes = [{"date": r["date"], "n": r["n"], "class": r["class"], "subject": r["subject"], "start": r["start"], "end": r["end"],
                "room": r["room"], "kind": r["kind"], "kind_label": r["kind_label"], "teacher_id": r["owner_teacher"]["id"],
                "source": f"proposal:{kind}"} for r in rows]
    prop = {"id": pid, "status": "pending", "by": t["id"], "at": datetime.now().isoformat(timespec="minutes"), "source_kind": kind,
            "official": False, "changes": changes, "affected_teachers": sorted({c["teacher_id"] for c in changes}),
            "affected_classes": sorted({c["class"] for c in changes})}
    if not any(p["id"] == pid for p in doc["items"]):
        doc["items"].append(prop)
        _save(ps, doc)
    return prop


@_teacher_session
def decide_proposal(t: dict[str, Any], source: str, pid: str, approve: bool) -> dict[str, Any]:
    if not can(t, "approve_schedule"):
        return {"ok": False, "error": "forbidden"}
    with transaction(_path(source, t["school_id"], "state").parent):
        ps = _proposals_path(source, t["school_id"])
        doc = _load(ps, {"items": []})
        p = next((x for x in doc["items"] if x["id"] == pid), None)
        if not p:
            return {"ok": False, "error": "not_found"}
        if p["status"] != "pending":
            return {"ok": True, "repeat": True, "status": p["status"]}
        if p["by"] == t["id"]:
            return {"ok": False, "error": "self_approval", "message": "Своё предложение утверждает другой уполномоченный"}
        p["status"] = "approved" if approve else "rejected"
        p["decided_by"], p["decided_at"] = t["id"], datetime.now().isoformat(timespec="minutes")
        if approve:
            sp = _path(source, t["school_id"], "shared.json")
            shared = _load(sp, {"changes": []})
            keys = {(c["date"], c["n"], c["class"]) for c in p["changes"]}
            shared["changes"] = [c for c in shared["changes"] if (c["date"], c["n"], c["class"]) not in keys] + \
                                [dict(c, proposal_id=pid) for c in p["changes"]]
            _save(sp, shared)
        _save(ps, doc)
    return {"ok": True, "status": p["status"], "affected_teachers": p["affected_teachers"]}


def reset_demo() -> None:
    """Только для тестов/демо: очистить демо-слой (школьный не трогается)."""
    import shutil
    shutil.rmtree(_dir() / "demo", ignore_errors=True)
    _PREVIEWS.clear()
