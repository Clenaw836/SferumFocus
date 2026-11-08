"""Движок «Практикумов СферумФокус»: каталог, сессии 8 этапов, карта освоения, квиз-опросы, контекст тьютора.

Хранилище — ``SFERUM_DATA_DIR/practicum.sqlite3`` (WAL + busy_timeout через :mod:`app.sqlite_wal`):

* ``curriculum_topics``    — темы ФГОС 5–11 из :mod:`app.curriculum_registry` (зеркало для SQL-фильтров);
* ``practicum_catalog``    — проверенные практикумы (:mod:`app.practicum_content`, :mod:`app.practicum_boards`);
* ``practicum_sessions``   — прогресс ученика: этап, состояние лаборатории по этапам, ошибки, подсказки;
* ``student_skill_mastery``— карта освоения: только проверенные действия и ответы (последние 10 по навыку);
* ``quiz_attempts``        — выданные квиз-опросы; ключи ответов хранятся только на сервере.

Принципы: тема из ДЗ берётся из текста, оглавления учебника или порядка программы (§ 1..50, v3.2) и всегда
подписана источником; § > 50 или задание без темы → ``needs_topic_clarification``; проверка
действий только детерминированная (:func:`app.practicum_labs.check`), клиент не получает ключи ответов,
ученик хранится под хешем ``user_key`` — без имени, без ``x-user-id`` в открытом виде.
"""
from __future__ import annotations

import hashlib
import json
import os
import random
import re
import secrets
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from app import curriculum_registry as reg
from app import practicum_labs as labs
from app.pii_scrubber import scrub_pii
from app.practicum_boards import BOARDS
from app.practicum_content import DIFFICULTY_RU, DISPLAY_STEPS, FORMAT_TYPES, PRACTICUMS, STAGE_KINDS, STAGE_TITLES
from app.topic_generator import generated_for, topic_quiz
from app.sqlite_wal import connect

SCHEMA_VERSION = 2
RECENT_WINDOW = 10            # карта освоения — доля верных среди 10 последних проверенных действий навыка
RECOMMEND_BELOW = 60          # «Рекомендуем», если практикум тренирует навык с освоением < 60 %
MASTERED_FROM = 85
QUIZ_TTL_SECONDS = 24 * 3600
MAX_MISTAKES_LOG = 60
LAB_CHECK_STAGES = ("exploration", "action_check", "progressive_hints", "final_challenge")
ANSWER_STAGES = ("warmup", "error_explanation")
REVEAL_AFTER_FAILS = 3        # ответ «модель считает N» показываем только после 3 неудачных проверок этапа
# служебные величины моделей, которые клиент не должен видеть до проверки (иначе ответ «подсмотрим»)
SECRET_READOUTS = {"scales": {"left", "right", "x_found"}, "classify": {"correct", "wrong_items", "right_count", "missing"},
                   "order": {"correct", "first_wrong", "wrong_item", "pairs_ok"}, "ohm": {"table_wrong", "table_ok"},
                   "molecule": {"by_id", "neighbor_els"}}
SECRET_CONFIG = {"scales": {"x_true"}, "order": {"correct"}}


class PracticumError(Exception):
    def __init__(self, status: int, detail: str, code: str = "practicum_error") -> None:
        super().__init__(detail)
        self.status, self.detail, self.code = status, detail, code


HANDMADE: list[dict[str, Any]] = [*PRACTICUMS, *BOARDS]
# v3.2 · CUR-02: у каждой из 283 тем есть хотя бы один практикум — для тем без ручного добавляется «Карта понятий».
GENERATED: list[dict[str, Any]] = generated_for({p["topic_id"] for p in HANDMADE})
ALL: dict[str, dict[str, Any]] = {p["practicum_id"]: p for p in [*HANDMADE, *GENERATED]}
VERIFIED_LABEL = "Проверено автотестом решаемости"


def _hash(obj: Any, size: int = 16) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True, ensure_ascii=False, default=str).encode()).hexdigest()[:size]


CONTENT_HASH = {pid: _hash(p) for pid, p in ALL.items()}


def user_key(user_id: str | None) -> str:
    """Ученик в БД практикумов — только хеш идентификатора платформы."""
    raw = (user_id or "demo-user").strip()[:200] or "demo-user"
    return hashlib.sha256(f"sferum-practicum-v1|{raw}".encode()).hexdigest()[:32]


def _now() -> int:
    return int(time.time())


# ===================================================================================== хранилище
_SCHEMA = """
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS curriculum_topics(
  topic_id TEXT PRIMARY KEY, subject TEXT NOT NULL, grade INTEGER NOT NULL, title TEXT NOT NULL,
  fgos_code TEXT NOT NULL, textbook_edition TEXT, paragraph_ref TEXT, prerequisite_skills_json TEXT NOT NULL,
  skills_json TEXT NOT NULL, verified_status TEXT NOT NULL, version INTEGER NOT NULL, ord INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ix_topics_subject_grade ON curriculum_topics(subject, grade, ord);
CREATE TABLE IF NOT EXISTS practicum_catalog(
  practicum_id TEXT PRIMARY KEY, topic_id TEXT NOT NULL REFERENCES curriculum_topics(topic_id), subject TEXT NOT NULL,
  grade INTEGER NOT NULL, title TEXT NOT NULL, learning_goal TEXT NOT NULL, summary TEXT NOT NULL, difficulty TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL, format_type TEXT NOT NULL, mechanic_kind TEXT NOT NULL, model TEXT NOT NULL,
  stages_json TEXT NOT NULL, auto_verified_solvable INTEGER NOT NULL, version INTEGER NOT NULL, content_hash TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_catalog_topic ON practicum_catalog(topic_id);
CREATE INDEX IF NOT EXISTS ix_catalog_subject_grade ON practicum_catalog(subject, grade);
CREATE TABLE IF NOT EXISTS practicum_sessions(
  session_id TEXT PRIMARY KEY, user_key TEXT NOT NULL, practicum_id TEXT NOT NULL REFERENCES practicum_catalog(practicum_id),
  content_hash TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('in_progress','completed')),
  current_stage_idx INTEGER NOT NULL DEFAULT 0, lab_state_json TEXT NOT NULL DEFAULT '{}',
  stage_results_json TEXT NOT NULL DEFAULT '{}', mistakes_log_json TEXT NOT NULL DEFAULT '[]',
  hints_used_json TEXT NOT NULL DEFAULT '{}', mastery_before_json TEXT NOT NULL DEFAULT '{}',
  attempt_no INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER,
  UNIQUE(user_key, practicum_id));
CREATE INDEX IF NOT EXISTS ix_sessions_user ON practicum_sessions(user_key, updated_at);
CREATE TABLE IF NOT EXISTS student_skill_mastery(
  user_key TEXT NOT NULL, topic_id TEXT NOT NULL, skill_key TEXT NOT NULL, skill_title TEXT NOT NULL,
  verified_actions_count INTEGER NOT NULL DEFAULT 0, correct_actions_count INTEGER NOT NULL DEFAULT 0,
  recent_json TEXT NOT NULL DEFAULT '[]', mastery_percent INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
  PRIMARY KEY(user_key, topic_id, skill_key));
CREATE TABLE IF NOT EXISTS quiz_attempts(
  attempt_id TEXT PRIMARY KEY, user_key TEXT NOT NULL, topic_id TEXT NOT NULL, questions_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('open','submitted')), score INTEGER, max_score INTEGER, result_json TEXT,
  created_at INTEGER NOT NULL, submitted_at INTEGER);
CREATE INDEX IF NOT EXISTS ix_quiz_user ON quiz_attempts(user_key, topic_id, created_at);
"""

_ready: set[str] = set()
_ready_lock = threading.Lock()


def db_path() -> Path:
    from app import config
    return Path(os.getenv("SFERUM_DATA_DIR") or config.SFERUM_DATA_DIR) / "practicum.sqlite3"


def _migrate(db: Any) -> None:
    version = int(db.execute("PRAGMA user_version").fetchone()[0])
    if version > SCHEMA_VERSION:
        raise PracticumError(503, "Схема данных практикумов новее этой версии приложения", "schema_too_new")
    if 0 < version < 2:
        cols = {r[1] for r in db.execute("PRAGMA table_info(practicum_catalog)").fetchall()}
        if "verified_by_admin" in cols:   # v3.2: флаг переименован честно (решаемость проверена автотестом)
            db.execute("ALTER TABLE practicum_catalog RENAME COLUMN verified_by_admin TO auto_verified_solvable")
    db.executescript(_SCHEMA)
    db.execute(f"PRAGMA user_version={SCHEMA_VERSION}")


def _seed(db: Any) -> None:
    """Upsert тем и каталога, если изменился контент (хеш всего набора)."""
    topics = reg.all_topics()
    seed_hash = _hash([CONTENT_HASH, [t.as_dict() for t in topics]])
    row = db.execute("SELECT value FROM meta WHERE key='seed_hash'").fetchone()
    if row and row[0] == seed_hash:
        return
    for t in topics:
        db.execute("""INSERT INTO curriculum_topics(topic_id, subject, grade, title, fgos_code, textbook_edition, paragraph_ref,
                      prerequisite_skills_json, skills_json, verified_status, version, ord)
                      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
                      ON CONFLICT(topic_id) DO UPDATE SET subject=excluded.subject, grade=excluded.grade, title=excluded.title,
                      fgos_code=excluded.fgos_code, paragraph_ref=excluded.paragraph_ref, skills_json=excluded.skills_json,
                      verified_status=excluded.verified_status, version=excluded.version, ord=excluded.ord""",
                   (t.topic_id, t.subject, t.grade, t.title, t.fgos_ref, None,
                    ",".join(str(n) for n in t.paragraph_numbers) or None, "[]",
                    json.dumps([s.as_dict() for s in t.skills], ensure_ascii=False), "program", 1, t.order))
    for pid, p in ALL.items():
        t = reg.topic(p["topic_id"])
        if t is None:
            raise RuntimeError(f"practicum {pid}: unknown topic {p['topic_id']}")
        db.execute("""INSERT INTO practicum_catalog(practicum_id, topic_id, subject, grade, title, learning_goal, summary, difficulty,
                      duration_minutes, format_type, mechanic_kind, model, stages_json, auto_verified_solvable, version, content_hash)
                      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                      ON CONFLICT(practicum_id) DO UPDATE SET topic_id=excluded.topic_id, subject=excluded.subject, grade=excluded.grade,
                      title=excluded.title, learning_goal=excluded.learning_goal, summary=excluded.summary, difficulty=excluded.difficulty,
                      duration_minutes=excluded.duration_minutes, format_type=excluded.format_type, mechanic_kind=excluded.mechanic_kind,
                      model=excluded.model, stages_json=excluded.stages_json, auto_verified_solvable=excluded.auto_verified_solvable,
                      version=excluded.version, content_hash=excluded.content_hash""",
                   (pid, t.topic_id, t.subject, t.grade, p["title"], p["learning_goal"], p["summary"], p["difficulty"],
                    p["duration_minutes"], p["format_type"], p["mechanic_kind"], p["model"],
                    json.dumps(p["stages"], ensure_ascii=False), 1 if p["auto_verified_solvable"] else 0, p["version"], CONTENT_HASH[pid]))
    db.execute("INSERT INTO meta(key, value) VALUES('seed_hash', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (seed_hash,))


@contextmanager
def tx() -> Iterator[Any]:
    path = db_path()
    db = connect(path)
    key = str(path.resolve())
    try:
        if key not in _ready:
            with _ready_lock:
                _migrate(db)                     # executescript сам фиксирует DDL
                db.execute("BEGIN IMMEDIATE")
                _seed(db)
                db.commit()
                _ready.add(key)
        db.execute("BEGIN IMMEDIATE")
        yield db
        db.commit()
    except BaseException:
        db.rollback()
        raise
    finally:
        db.close()


def reset_cache() -> None:
    """Тесты меняют SFERUM_DATA_DIR между кейсами."""
    _ready.clear()
# ===================================================================================== контент и представления
DIFFICULTY_ORDER = {"basic": 0, "medium": 1, "advanced": 2}
_DIFF_BY_RU = {v.lower(): k for k, v in DIFFICULTY_RU.items()}
# величины, по которым скрытый ответ вычисляется в одно действие (S = S/π · π, R = U / I …)
RELATED_HIDDEN = {"area": {"S": {"S_over_pi"}, "S_over_pi": {"S"}, "C": {"C_over_pi"}, "C_over_pi": {"C"}},
                  "ohm": {"I": {"P", "heat"}, "R_total": {"I", "P", "heat"}}}
SHAPE_RU = {"rectangle": "прямоугольник", "parallelogram": "параллелограмм", "triangle": "треугольник",
            "trapezoid": "трапеция", "circle": "круг"}


def practicum(pid: str) -> dict[str, Any]:
    p = ALL.get(str(pid or ""))
    if p is None:
        raise PracticumError(404, "Практикум не найден", "PRACTICUM_NOT_FOUND")
    return p


def topic_of(p: dict[str, Any]) -> reg.Topic:
    t = reg.topic(p["topic_id"])
    assert t is not None, p["practicum_id"]
    return t


def practicums_for_topic(topic_id: str) -> list[dict[str, Any]]:
    return sorted((p for p in ALL.values() if p["topic_id"] == topic_id),
                  key=lambda p: (bool(p.get("generated")), DIFFICULTY_ORDER[p["difficulty"]], p["title"]))


def display_step(idx: int) -> tuple[int, str]:
    kind = STAGE_KINDS[idx]
    for n, (title, kinds) in enumerate(DISPLAY_STEPS, 1):
        if kind in kinds:
            return n, title
    return len(DISPLAY_STEPS), DISPLAY_STEPS[-1][0]


def trained_skills(p: dict[str, Any]) -> list[int]:
    return sorted({int(s["skill"]) for s in p["stages"] if s.get("skill") is not None})


def _hidden(model: str, stage: dict[str, Any], state: dict[str, Any]) -> set[str]:
    hidden = set(SECRET_READOUTS.get(model, set()))
    for a in stage.get("answers", []):
        q = a.get("q")
        if q and q not in state:
            hidden.add(q)
            hidden |= RELATED_HIDDEN.get(model, {}).get(q, set())
    return hidden


def readouts(model: str, stage: dict[str, Any], state: dict[str, Any], derived: dict[str, Any]) -> dict[str, Any]:
    hidden = _hidden(model, stage, state)
    return {k: v for k, v in derived.items() if k not in hidden and not k.startswith("student_")}


def client_lab(lab: dict[str, Any], reveal: bool) -> dict[str, Any]:
    model = lab["model"]
    out = {k: v for k, v in lab.items() if k not in SECRET_CONFIG.get(model, set()) and k != "items"}
    if model == "classify":
        out["items"] = [{"id": i["id"], "text": i["text"], **({"bucket": i["bucket"], "why": i["why"]} if reveal else {})}
                        for i in lab["items"]]
    elif model == "order":
        out["items"] = [{"id": i["id"], "text": i["text"], **({"why": i["why"]} if reveal else {})} for i in lab["items"]]
        if reveal:
            out["correct"] = list(lab["correct"])
    return out


def _lab_view(lab: dict[str, Any], stage: dict[str, Any], saved: dict[str, Any] | None, reveal: bool) -> dict[str, Any]:
    model = lab["model"]
    state = labs.normalize(model, saved if saved is not None else lab.get("initial", {}), lab)
    derived = labs.derive(model, state, lab)
    return {"lab": client_lab(lab, reveal), "state": state, "readouts": readouts(model, stage, state, derived)}


def _skill_ref(t: reg.Topic, idx: Any) -> dict[str, str] | None:
    if idx is None or not 0 <= int(idx) < len(t.skills):
        return None
    return t.skills[int(idx)].as_dict()


def stage_view(p: dict[str, Any], idx: int, data: dict[str, Any]) -> dict[str, Any]:
    t = topic_of(p)
    st = p["stages"][idx]
    kind = st["kind"]
    res = data["results"].get(str(idx), {})
    passed = bool(res.get("passed"))
    step, step_title = display_step(idx)
    view: dict[str, Any] = {"index": idx, "kind": kind, "title": STAGE_TITLES[kind], "step": step,
                            "steps_total": len(DISPLAY_STEPS), "step_title": step_title, "passed": passed,
                            "attempts": int(res.get("attempts", 0)), "skipped": bool(res.get("skipped")),
                            "skill": _skill_ref(t, st.get("skill"))}
    if kind == "intro":
        view.update(body=st["body"], real_life=st["real_life"], exam=st["exam"], can_advance=True)
    elif kind in ANSWER_STAGES:
        q = st["question"]
        reveal = passed or bool(res.get("revealed"))
        view["question"] = {"text": q["text"], "options": list(q["options"]),
                            **({"correct": q["correct"], "explain": q["explain"]} if reveal else {})}
        view["body"] = st.get("body", "")
        view["case"] = st.get("case", "")
        if st.get("lab"):
            view.update(_lab_view(st["lab"], st, None, True))
        view["can_advance"] = reveal
    elif kind in LAB_CHECK_STAGES:
        saved = data["lab_state"].get(str(idx))
        view.update(_lab_view(st["lab"], st, saved, passed))
        view["task"] = st["task"]
        view["answers"] = [{"field": a["field"], "label": a["label"], "value": (saved or {}).get(a["field"])}
                           for a in st.get("answers", [])]
        hints = st.get("hints", []) if kind != "final_challenge" else []
        level = int(data["hints"].get(str(idx), 0))
        view["hints"] = {"allowed": kind != "final_challenge", "total": len(hints), "shown": hints[:level]}
        if kind == "exploration" and passed:
            view["observe"] = st.get("observe", "")
        fails = int(res.get("attempts", 0)) - (1 if passed else 0)
        view["can_skip"] = not passed and fails >= 5
        view["can_advance"] = passed or bool(res.get("skipped"))
    else:  # summary_and_next
        view.update(learned=st["learned"], next_step=st["next_step"], can_advance=True)
    return view


def _decode(row: Any) -> dict[str, Any]:
    return {"session_id": row["session_id"], "status": row["status"], "idx": int(row["current_stage_idx"]),
            "lab_state": json.loads(row["lab_state_json"]), "results": json.loads(row["stage_results_json"]),
            "mistakes": json.loads(row["mistakes_log_json"]), "hints": json.loads(row["hints_used_json"]),
            "mastery_before": json.loads(row["mastery_before_json"]), "attempt_no": int(row["attempt_no"]),
            "revision": int(row["revision"]), "updated_at": int(row["updated_at"]), "completed_at": row["completed_at"],
            "content_hash": row["content_hash"]}


def progress_status(data: dict[str, Any] | None) -> dict[str, Any]:
    total = len(DISPLAY_STEPS)
    if data is None:
        return {"state": "not_started", "label": "Не начат", "step": 0, "total": total}
    if data["status"] == "completed":
        if any(r.get("skipped") for r in data["results"].values()):
            return {"state": "completed", "label": "Пройден · есть пропущенные этапы", "step": total, "total": total}
        return {"state": "completed", "label": "Освоено", "step": total, "total": total}
    step, _ = display_step(data["idx"])
    return {"state": "in_progress", "label": f"В процессе · этап {step} из {total}", "step": step, "total": total}


# ===================================================================================== карта освоения
def _status_of(pct: int | None) -> str:
    if pct is None:
        return "Нет проверенных данных"
    if pct >= MASTERED_FROM:
        return "Освоено"
    if pct >= RECOMMEND_BELOW:
        return "Почти освоено"
    return "Нужно закрепить"


def record_skill(db: Any, uk: str, t: reg.Topic, skill_idx: Any, ok: bool) -> None:
    """Одно проверенное действие/ответ → навык темы (скользящее окно последних 10)."""
    ref = _skill_ref(t, skill_idx)
    if ref is None:
        return
    row = db.execute("SELECT * FROM student_skill_mastery WHERE user_key=? AND topic_id=? AND skill_key=?",
                     (uk, t.topic_id, ref["key"])).fetchone()
    recent = (json.loads(row["recent_json"]) if row else [])[-(RECENT_WINDOW - 1):] + [1 if ok else 0]
    verified = (int(row["verified_actions_count"]) if row else 0) + 1
    correct = (int(row["correct_actions_count"]) if row else 0) + (1 if ok else 0)
    pct = round(100 * sum(recent) / len(recent))
    db.execute("""INSERT INTO student_skill_mastery(user_key, topic_id, skill_key, skill_title, verified_actions_count,
                  correct_actions_count, recent_json, mastery_percent, updated_at) VALUES(?,?,?,?,?,?,?,?,?)
                  ON CONFLICT(user_key, topic_id, skill_key) DO UPDATE SET skill_title=excluded.skill_title,
                  verified_actions_count=excluded.verified_actions_count, correct_actions_count=excluded.correct_actions_count,
                  recent_json=excluded.recent_json, mastery_percent=excluded.mastery_percent, updated_at=excluded.updated_at""",
               (uk, t.topic_id, ref["key"], ref["title"], verified, correct, json.dumps(recent), pct, _now()))


def skill_map(db: Any, uk: str, t: reg.Topic) -> dict[str, Any]:
    rows = {r["skill_key"]: r for r in db.execute(
        "SELECT * FROM student_skill_mastery WHERE user_key=? AND topic_id=?", (uk, t.topic_id)).fetchall()}
    skills = []
    for s in t.skills:
        r = rows.get(s.key)
        pct = int(r["mastery_percent"]) if r else None
        skills.append({"skill_key": s.key, "title": s.title, "mastery_percent": pct, "status": _status_of(pct),
                       "verified_actions": int(r["verified_actions_count"]) if r else 0,
                       "correct_actions": int(r["correct_actions_count"]) if r else 0})
    return {"topic_id": t.topic_id, "topic_title": t.title, "subject": t.subject, "grade": t.grade, "skills": skills,
            "has_data": any(s["mastery_percent"] is not None for s in skills),
            "basis": f"Проценты — доля верных среди последних {RECENT_WINDOW} проверенных действий в практикумах и ответов "
                     "в квиз-опросах по каждому навыку. Без проверенных действий процент не выставляется."}


def _sessions(db: Any, uk: str, pids: list[str]) -> dict[str, dict[str, Any]]:
    if not pids:
        return {}
    marks = ",".join("?" * len(pids))
    rows = db.execute(f"SELECT * FROM practicum_sessions WHERE user_key=? AND practicum_id IN ({marks})", (uk, *pids)).fetchall()
    return {r["practicum_id"]: _decode(r) for r in rows}


def _weak_skills(smap: dict[str, Any]) -> set[int]:
    return {i for i, s in enumerate(smap["skills"]) if s["mastery_percent"] is not None and s["mastery_percent"] < RECOMMEND_BELOW}


def recommendation(db: Any, uk: str, t: reg.Topic, smap: dict[str, Any] | None = None) -> dict[str, Any] | None:
    """Навык с наименьшим проверенным освоением → практикум, который его тренирует сильнее всего."""
    smap = smap or skill_map(db, uk, t)
    items = practicums_for_topic(t.topic_id)
    sessions = _sessions(db, uk, [p["practicum_id"] for p in items])
    measured = [(i, s) for i, s in enumerate(smap["skills"]) if s["mastery_percent"] is not None]
    if items:
        if measured:
            idx, weakest = min(measured, key=lambda x: (x[1]["mastery_percent"], x[0]))
            if weakest["mastery_percent"] < MASTERED_FROM:
                def weight(p: dict[str, Any]) -> tuple[int, int, int]:
                    hits = sum(1 for s in p["stages"] if s.get("skill") == idx)
                    done = 1 if sessions.get(p["practicum_id"], {}).get("status") == "completed" else 0
                    return (-hits, done, DIFFICULTY_ORDER[p["difficulty"]])
                best = min(items, key=weight)
                return {"kind": "practicum", "practicum_id": best["practicum_id"], "title": best["title"],
                        "skill_key": weakest["skill_key"],
                        "text": f"Практикум «{best['title']}» — закрепить навык «{weakest['title']}»",
                        "reason": f"Сейчас {weakest['mastery_percent']} % по проверенным действиям"}
        fresh = [p for p in items if p["practicum_id"] not in sessions]
        open_ = [p for p in items if sessions.get(p["practicum_id"], {}).get("status") == "in_progress"]
        if open_:
            p = open_[0]
            return {"kind": "practicum", "practicum_id": p["practicum_id"], "title": p["title"], "skill_key": None,
                    "text": f"Продолжи практикум «{p['title']}»", "reason": progress_status(sessions[p["practicum_id"]])["label"]}
        if fresh and not measured:
            p = fresh[0]
            return {"kind": "practicum", "practicum_id": p["practicum_id"], "title": p["title"], "skill_key": None,
                    "text": f"Практикум «{p['title']}» — с него начинается карта навыков темы",
                    "reason": "По теме ещё нет проверенных действий"}
        if fresh:
            p = fresh[0]
            return {"kind": "practicum", "practicum_id": p["practicum_id"], "title": p["title"], "skill_key": None,
                    "text": f"Практикум «{p['title']}» — следующий по теме", "reason": "Навыки темы освоены, этот практикум ещё не пройден"}
    nxt = next((x for x in reg.topics_for(t.subject, t.grade) if x.order > t.order), None)
    if measured and nxt is not None:
        return {"kind": "topic", "topic_id": nxt.topic_id, "title": nxt.title, "skill_key": None,
                "text": f"Следующая тема программы: «{nxt.title}»", "reason": "Навыки этой темы освоены"}
    if quiz_pool(t):
        return {"kind": "quiz", "topic_id": t.topic_id, "title": t.title, "skill_key": None,
                "text": f"Квиз-опрос по теме «{t.title}» — быстрая проверка", "reason": "Практикумов по теме пока нет"}
    return None


def mastery_snapshot(db: Any, uk: str, t: reg.Topic) -> dict[str, int | None]:
    return {s["skill_key"]: s["mastery_percent"] for s in skill_map(db, uk, t)["skills"]}


# ===================================================================================== каталог и развилка предмета
def _grade(raw: Any) -> int:
    try:
        grade = int(str(raw).strip())
    except (TypeError, ValueError):
        raise PracticumError(400, "Класс должен быть числом от 5 до 11", "GRADE_INVALID") from None
    if not 5 <= grade <= 11:
        raise PracticumError(400, "Класс должен быть числом от 5 до 11", "GRADE_INVALID")
    return grade


def _subject(raw: str | None) -> str:
    key = reg.normalize_subject(raw)
    if key is None:
        raise PracticumError(404, "Предмет не найден в программе 5–11 классов", "SUBJECT_UNKNOWN")
    return key


def _difficulty(raw: str | None) -> str | None:
    if not raw:
        return None
    value = str(raw).strip()
    if value in DIFFICULTY_RU:
        return value
    key = _DIFF_BY_RU.get(value.lower())
    if key is None:
        raise PracticumError(400, "Неизвестный уровень сложности", "DIFFICULTY_INVALID")
    return key


def resolve_current_topic(subject: str, grade: int, topic_id: str | None = None, hw: str | None = None,
                          textbook_id: str | None = None) -> dict[str, Any]:
    """Текущая тема: явный выбор ученика → ДЗ из СГО (ключевые слова / сверенный §) → честное уточнение."""
    options = [{"topic_id": x.topic_id, "title": x.title} for x in reg.topics_for(subject, grade)]
    if topic_id:
        found = reg.topic(topic_id)
        if found is None or found.subject != subject or found.grade != grade:
            raise PracticumError(404, "Тема не найдена в программе этого класса", "TOPIC_UNKNOWN")
        return {"topic": found, "needs_topic_clarification": False, "match": "chosen", "reason": "Тема выбрана вручную",
                "paragraph": None, "options": options, "label": reg.topic_label(None, found.title)}
    if hw and hw.strip():
        res = reg.resolve_sgo_homework_topic(grade, subject, hw[:2000], textbook_id)
        found = reg.topic(res["topic"]["topic_id"]) if res.get("topic") else None
        return {"topic": found, "needs_topic_clarification": found is None, "match": res["match"], "reason": res["reason"],
                "paragraph": res.get("paragraph"), "options": options, "textbook": res.get("textbook"),
                "label": res.get("label")}
    return {"topic": None, "needs_topic_clarification": True, "match": "none", "paragraph": None, "options": options,
            "reason": f"Тема урока не передана. Выбери тему из программы {grade} класса или прикрепи фото страницы учебника"}


def catalog_card(p: dict[str, Any], data: dict[str, Any] | None, current_topic_id: str | None,
                 weak: set[int] | None = None) -> dict[str, Any]:
    t = topic_of(p)
    current = current_topic_id == t.topic_id
    recommended = bool(weak) and bool(set(trained_skills(p)) & (weak or set()))
    label = ("По текущей теме · " if current else "") + f"ФГОС {t.grade} кл."
    badges = (["По текущей теме"] if current else []) + (["Рекомендуем"] if recommended else [])
    return {"practicum_id": p["practicum_id"], "title": p["title"],
            "subject": {"key": t.subject, "title": t.subject_title, "grade": t.grade},
            "topic": {"topic_id": t.topic_id, "title": t.title},
            "learning_goal": p["learning_goal"], "summary": p["summary"],
            "difficulty": DIFFICULTY_RU[p["difficulty"]], "difficulty_key": p["difficulty"],
            "duration_minutes": p["duration_minutes"], "format_type": p["format_type"],
            "curriculum_match": {"label": label, "fgos_ref": t.fgos_ref, "current_topic": current, "recommended": recommended},
            "progress_status": progress_status(data), "badges": badges, "mechanic_kind": p["mechanic_kind"],
            "model": p["model"], "auto_verified_solvable": bool(p["auto_verified_solvable"]), "verified_label": VERIFIED_LABEL,
            "generated": bool(p.get("generated")), "version": p["version"]}


def catalog(user_id: str | None, subject: str | None = None, grade: Any = None, topic_id: str | None = None,
            scope: str = "all", difficulty: str | None = None, format_type: str | None = None,
            hw: str | None = None) -> dict[str, Any]:
    uk = user_key(user_id)
    key = _subject(subject) if subject else None
    level = _grade(grade) if grade not in (None, "") else None
    diff = _difficulty(difficulty)
    if format_type and format_type not in FORMAT_TYPES:
        raise PracticumError(400, "Неизвестный формат практикума", "FORMAT_INVALID")
    if scope not in ("all", "current"):
        raise PracticumError(400, "Фильтр темы: current или all", "SCOPE_INVALID")
    current = resolve_current_topic(key, level, topic_id, hw) if key and level else None
    current_id = current["topic"].topic_id if current and current["topic"] else None
    base = [p for p in ALL.values()
            if (key is None or topic_of(p).subject == key) and (level is None or topic_of(p).grade == level)]
    with tx() as db:
        sessions = _sessions(db, uk, [p["practicum_id"] for p in base])
        weak_by_topic: dict[str, set[int]] = {}
        for tid in {p["topic_id"] for p in base}:
            weak_by_topic[tid] = _weak_skills(skill_map(db, uk, reg.topic(tid)))  # type: ignore[arg-type]
    facets = {"difficulty": {}, "format_type": {}}
    for p in base:
        facets["difficulty"][DIFFICULTY_RU[p["difficulty"]]] = facets["difficulty"].get(DIFFICULTY_RU[p["difficulty"]], 0) + 1
        facets["format_type"][p["format_type"]] = facets["format_type"].get(p["format_type"], 0) + 1
    items = [p for p in base
             if (scope != "current" or p["topic_id"] == current_id) and (diff is None or p["difficulty"] == diff)
             and (format_type is None or p["format_type"] == format_type)]
    cards = [catalog_card(p, sessions.get(p["practicum_id"]), current_id, weak_by_topic.get(p["topic_id"])) for p in items]
    cards.sort(key=lambda c: (not c["curriculum_match"]["current_topic"], not c["curriculum_match"]["recommended"],
                              c["generated"], reg.topic(c["topic"]["topic_id"]).order, DIFFICULTY_ORDER[c["difficulty_key"]], c["title"]))  # type: ignore[union-attr]
    out: dict[str, Any] = {"items": cards, "total": len(cards), "facets": facets,
                           "filters": {"subject": key, "grade": level, "scope": scope, "difficulty": diff, "format_type": format_type},
                           "current_topic": current["topic"].as_dict() if current and current["topic"] else None,
                           "needs_topic_clarification": bool(current and current["needs_topic_clarification"]),
                           "message": None, "other_grades": []}
    if not cards:
        if key and level and level not in reg.SUBJECTS[key]["grades"]:
            out["message"] = f"{reg.SUBJECTS[key]['title']} в {level} классе по программе не изучается"
        elif scope == "current" and current_id is None:
            out["message"] = "Текущая тема не определена — выбери тему или открой все темы"
        else:
            out["message"] = "По выбранным фильтрам проверенных практикумов пока нет"
        if key:
            others = sorted({topic_of(p).grade for p in ALL.values() if topic_of(p).subject == key} - {level})
            out["other_grades"] = others
    return out


def curriculum_path(subject: str, grade: int, current: dict[str, Any], smap: dict[str, Any] | None,
                    region: str | None = None) -> list[dict[str, str]]:
    """5 уровней: ФГОС → Регион → Школа → Класс → Ученик. Неизвестное честно помечено как неизвестное."""
    sub = reg.SUBJECTS[subject]
    level = "НОО" if grade < 5 else ("ООО" if grade <= 9 else "СОО")
    t: reg.Topic | None = current.get("topic")
    region_title = (region or "").strip()[:80]
    gaps = [s["title"] for s in (smap or {}).get("skills", []) if s["mastery_percent"] is not None and s["mastery_percent"] < RECOMMEND_BELOW]
    return [
        {"level": "ФГОС", "title": f"ФГОС {level} · {sub['title']}, {grade} класс",
         "detail": t.fgos_ref if t else "Федеральная рабочая программа предмета", "state": "known"},
        {"level": "Регион", "title": f"Регион: {region_title}" if region_title else "Региональная специфика",
         "detail": "Региональный компонент учтён в расписании школы" if region_title else "Регион не передан — опора на федеральную программу",
         "state": "known" if region_title else "unknown"},
        {"level": "Школа", "title": current.get("textbook") or "Учебник школы",
         "detail": "Оглавление сверено" if current.get("textbook") else "Оглавление учебника школы не сверено — темы по программе класса",
         "state": "known" if current.get("textbook") else "unknown"},
        {"level": "Класс", "title": t.title if t else "Текущая тема не определена",
         "detail": current.get("reason", ""), "state": "known" if t else "needs_clarification"},
        {"level": "Ученик", "title": ("Пробелы: " + ", ".join(gaps)) if gaps else (
            "Пробелов по проверенным действиям нет" if smap and smap.get("has_data") else "Нет проверенных данных"),
         "detail": "По карте освоения темы", "state": "known" if smap and smap.get("has_data") else "unknown"},
    ]


def hub(user_id: str | None, subject: str, grade: Any, topic_id: str | None = None, hw: str | None = None,
        region: str | None = None, textbook_id: str | None = None) -> dict[str, Any]:
    uk = user_key(user_id)
    key = _subject(subject)
    level = _grade(grade)
    sub = reg.SUBJECTS[key]
    studied = level in sub["grades"]
    current = resolve_current_topic(key, level, topic_id, hw, textbook_id) if studied else {
        "topic": None, "needs_topic_clarification": False, "match": "none", "paragraph": None, "options": [],
        "reason": f"{sub['title']} в {level} классе по программе не изучается"}
    t: reg.Topic | None = current["topic"]
    smap = rec = None
    with tx() as db:
        if t is not None:
            smap = skill_map(db, uk, t)
            rec = recommendation(db, uk, t, smap)
    topic_items = practicums_for_topic(t.topic_id) if t else []
    grade_items = [p for p in ALL.values() if topic_of(p).subject == key and topic_of(p).grade == level]
    pool = quiz_pool(t) if t else []
    quiz_card = {"kind": "quiz", "title": "Квиз-опрос", "badge": "Быстрая проверка",
                 "text": "Проверь, насколько хорошо ты понимаешь тему.", "available": bool(pool),
                 "questions": min(QUIZ_SIZE, len(pool)), "minutes": max(2, min(QUIZ_SIZE, len(pool))),
                 "reason": None if pool else ("Сначала выбери тему урока" if t is None else "Для этой темы пока нет проверенных вопросов")}
    practicum_card = {"kind": "practicum", "title": "Практикум", "badge": "Интерактивное обучение",
                      "text": "Исследуй, решай и осваивай тему через действия.",
                      "available": bool(topic_items or grade_items), "count": len(topic_items) if t else len(grade_items),
                      "count_scope": "topic" if t else "grade", "grade_count": len(grade_items),
                      "reason": None if (topic_items or grade_items) else f"Проверенных практикумов для {level} класса пока нет"}
    return {"subject": {"key": key, "title": sub["title"], "grade": level, "studied": studied},
            "current_topic": t.as_dict() if t else None,
            "needs_topic_clarification": bool(current["needs_topic_clarification"]),
            "topic_source": {"match": current["match"], "reason": current["reason"], "paragraph": current.get("paragraph"),
                             "label": current.get("label")},
            "topic_options": current["options"], "cards": [quiz_card, practicum_card], "skill_map": smap,
            "recommendation": rec, "curriculum_path": curriculum_path(key, level, current, smap, region)}


def subjects_overview(user_id: str | None, grade: Any) -> dict[str, Any]:
    level = _grade(grade)
    out = []
    for key, sub in reg.SUBJECTS.items():
        if level not in sub["grades"]:
            continue
        count = sum(1 for p in ALL.values() if topic_of(p).subject == key and topic_of(p).grade == level)
        out.append({"key": key, "title": sub["title"], "practicums": count, "topics": len(reg.topics_for(key, level))})
    return {"grade": level, "subjects": out}


# ===================================================================================== сессии и действия
def _load(db: Any, uk: str, pid: str) -> dict[str, Any] | None:
    row = db.execute("SELECT * FROM practicum_sessions WHERE user_key=? AND practicum_id=?", (uk, pid)).fetchone()
    return _decode(row) if row else None


def _create(db: Any, uk: str, p: dict[str, Any]) -> dict[str, Any]:
    at = _now()
    sid = "ps_" + secrets.token_urlsafe(12)
    before = mastery_snapshot(db, uk, topic_of(p))
    db.execute("""INSERT INTO practicum_sessions(session_id, user_key, practicum_id, content_hash, status, current_stage_idx,
                  mastery_before_json, started_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)""",
               (sid, uk, p["practicum_id"], CONTENT_HASH[p["practicum_id"]], "in_progress", 0, json.dumps(before), at, at))
    return _load(db, uk, p["practicum_id"])  # type: ignore[return-value]


def _save(db: Any, uk: str, pid: str, data: dict[str, Any]) -> None:
    data["revision"] += 1
    data["updated_at"] = _now()
    db.execute("""UPDATE practicum_sessions SET status=?, current_stage_idx=?, lab_state_json=?, stage_results_json=?,
                  mistakes_log_json=?, hints_used_json=?, mastery_before_json=?, attempt_no=?, revision=?, updated_at=?,
                  completed_at=?, content_hash=? WHERE user_key=? AND practicum_id=?""",
               (data["status"], data["idx"], json.dumps(data["lab_state"], ensure_ascii=False), json.dumps(data["results"]),
                json.dumps(data["mistakes"][-MAX_MISTAKES_LOG:], ensure_ascii=False), json.dumps(data["hints"]),
                json.dumps(data["mastery_before"]), data["attempt_no"], data["revision"], data["updated_at"],
                data["completed_at"], CONTENT_HASH[pid], uk, pid))


def session_view(db: Any, uk: str, p: dict[str, Any], data: dict[str, Any]) -> dict[str, Any]:
    t = topic_of(p)
    idx = data["idx"]
    stages = []
    for i, st in enumerate(p["stages"]):
        res = data["results"].get(str(i), {})
        step, _ = display_step(i)
        stages.append({"index": i, "kind": st["kind"], "title": STAGE_TITLES[st["kind"]], "step": step,
                       "passed": bool(res.get("passed")), "skipped": bool(res.get("skipped")), "current": i == idx})
    view: dict[str, Any] = {
        "session_id": data["session_id"], "practicum": catalog_card(p, data, None), "status": data["status"],
        "progress": progress_status(data), "stage": stage_view(p, idx, data), "stages": stages,
        "steps": [{"n": n, "title": title} for n, (title, _) in enumerate(DISPLAY_STEPS, 1)],
        "principles": p.get("principles", {}), "revision": data["revision"], "attempt_no": data["attempt_no"]}
    if p["stages"][idx]["kind"] == "summary_and_next" or data["status"] == "completed":
        smap = skill_map(db, uk, t)
        before = data["mastery_before"]
        view["mastery_change"] = [{"skill_key": s["skill_key"], "title": s["title"], "before": before.get(s["skill_key"]),
                                   "after": s["mastery_percent"]} for s in smap["skills"]]
        view["skill_map"] = smap
        view["next"] = recommendation(db, uk, t, smap)
    return view


def get_session(user_id: str | None, pid: str) -> dict[str, Any]:
    p = practicum(pid)
    uk = user_key(user_id)
    with tx() as db:
        data = _load(db, uk, pid) or _create(db, uk, p)
        return session_view(db, uk, p, data)


def _stage_guard(data: dict[str, Any], stage_index: Any) -> None:
    if stage_index is None:
        return
    try:
        idx = int(stage_index)
    except (TypeError, ValueError):
        raise PracticumError(400, "Некорректный номер этапа", "STAGE_INVALID") from None
    if idx != data["idx"]:
        raise PracticumError(409, "Этап уже сменился — практикум обновлён до текущего этапа", "STAGE_MISMATCH")


def _clean_state(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        return {}
    if len(json.dumps(raw, ensure_ascii=False, default=str)) > 12_000:
        raise PracticumError(413, "Слишком большое состояние лаборатории", "STATE_TOO_LARGE")
    return raw


def save_state(user_id: str | None, pid: str, lab_state: Any, answers: Any = None, stage_index: Any = None) -> dict[str, Any]:
    """Автосохранение лаборатории (ползунки, гири, атомы, программа Робота) — без проверки и без ключей."""
    p = practicum(pid)
    uk = user_key(user_id)
    with tx() as db:
        data = _load(db, uk, pid) or _create(db, uk, p)
        _stage_guard(data, stage_index)
        idx = data["idx"]
        st = p["stages"][idx]
        if st["kind"] not in LAB_CHECK_STAGES:
            raise PracticumError(409, "На этом этапе нет лаборатории", "STAGE_HAS_NO_LAB")
        merged = {**_clean_state(lab_state), **{k: v for k, v in _clean_state(answers).items() if str(k).startswith("student_")}}
        lab = st["lab"]
        clean = labs.normalize(lab["model"], merged, lab)
        data["lab_state"][str(idx)] = clean
        _save(db, uk, pid, data)
        derived = labs.derive(lab["model"], clean, lab)
        return {"stage_index": idx, "state": clean, "readouts": readouts(lab["model"], st, clean, derived),
                "revision": data["revision"], "saved_at": data["updated_at"]}


def get_state(user_id: str | None, pid: str) -> dict[str, Any]:
    p = practicum(pid)
    uk = user_key(user_id)
    with tx() as db:
        data = _load(db, uk, pid)
        if data is None:
            return {"started": False, "stage_index": 0, "state": None, "progress": progress_status(None)}
        return {"started": True, "stage_index": data["idx"], "state": data["lab_state"].get(str(data["idx"])),
                "progress": progress_status(data), "revision": data["revision"], "updated_at": data["updated_at"]}


def _principle_title(p: dict[str, Any], key: str) -> str:
    return p.get("principles", {}).get(key) or {"complete": "Все карточки должны быть на месте",
                                                 "classify": "Признак группы", "order": "Последовательность",
                                                 "walls": "Робот не проходит сквозь стены", "goal": "Цель маршрута",
                                                 "loops": "Цикл «повтори n раз»"}.get(key, "Условие задания")


def _feedback(p: dict[str, Any], st: dict[str, Any], failed: list[dict[str, Any]], fails_before: int,
              derived: dict[str, Any]) -> list[dict[str, Any]]:
    reveal = st["kind"] != "final_challenge" and fails_before + 1 >= REVEAL_AFTER_FAILS
    out = []
    for f in failed:
        title = _principle_title(p, f["principle"])
        message = f["say"]
        if f["kind"] == "answer" and not reveal:
            given = f.get("given")
            message = (f"Заполни поле «{f.get('label') or 'ответ'}»." if given is None else
                       f"{with_unit(f.get('label') or 'Ответ', given)} — не сходится с моделью. Проверь принцип «{title.rstrip('.')}».")
        out.append({"principle": f["principle"], "principle_title": title, "kind": f["kind"], "message": message})
    model = st["lab"]["model"]
    if model == "order" and derived.get("first_wrong") is not None and not derived.get("correct"):
        out.append({"principle": "order", "principle_title": "Последовательность", "kind": "model",
                    "message": f"Первая карточка не на своём месте — позиция № {int(derived['first_wrong']) + 1}."})
    return out


def with_unit(label: str, given: Any) -> str:
    """«I, А» + 4 → «I = 4 А»; «D =» + 10 → «D = 10»."""
    label = (label or "Ответ").strip()
    value = labs.fmt(given)
    if ", " in label:
        name, unit = label.split(", ", 1)
        return f"{name} = {value} {unit}"
    return f"{label} {value}" if label.endswith("=") else f"{label}: {value}"


def _mistake(idx: int, st: dict[str, Any], failed: list[dict[str, Any]], state: dict[str, Any]) -> dict[str, Any]:
    compact = {k: v for k, v in state.items() if isinstance(v, (int, float, str, bool)) or v is None}
    return {"stage": idx, "kind": st["kind"], "principles": sorted({f["principle"] for f in failed}),
            "messages": [f["say"] if f["kind"] == "model" else with_unit(f.get("label", ""), f.get("given"))
                         for f in failed][:4], "state": dict(list(compact.items())[:16]), "at": _now()}


def _answer_stage(db: Any, uk: str, p: dict[str, Any], data: dict[str, Any], selected: Any) -> dict[str, Any]:
    idx = data["idx"]
    st = p["stages"][idx]
    q = st["question"]
    try:
        choice = int(selected)
    except (TypeError, ValueError):
        raise PracticumError(400, "Выбери один из вариантов ответа", "ANSWER_REQUIRED") from None
    if not 0 <= choice < len(q["options"]):
        raise PracticumError(400, "Такого варианта нет", "ANSWER_INVALID")
    res = data["results"].setdefault(str(idx), {"attempts": 0})
    if res.get("passed") or res.get("revealed"):
        return {"ok": bool(res.get("passed")), "repeat": True, "feedback": [], "explain": q["explain"], "correct": q["correct"]}
    res["attempts"] = int(res.get("attempts", 0)) + 1
    ok = choice == int(q["correct"])
    record_skill(db, uk, topic_of(p), st.get("skill"), ok)
    if ok:
        res["passed"] = True
        res["first_try"] = res["attempts"] == 1
        return {"ok": True, "feedback": [], "explain": q["explain"], "correct": q["correct"]}
    data["mistakes"].append({"stage": idx, "kind": st["kind"], "principles": ["answer"], "messages": [q["options"][choice]],
                             "state": {}, "at": _now()})
    if res["attempts"] >= 2:
        res["revealed"] = True
        return {"ok": False, "revealed": True, "explain": q["explain"], "correct": q["correct"],
                "feedback": [{"principle": "answer", "principle_title": "Разбор", "kind": "answer",
                              "message": "Разберём вместе: правильный вариант и объяснение — ниже. Прочитай и переходи дальше."}]}
    hint = st.get("body") or st.get("case") or "Перечитай вопрос и исключи варианты, которые противоречат определению."
    return {"ok": False, "feedback": [{"principle": "answer", "principle_title": "Подумай ещё", "kind": "answer",
                                       "message": f"Этот вариант не подходит. {hint}"}]}


def _check_stage(db: Any, uk: str, p: dict[str, Any], data: dict[str, Any], lab_state: Any, answers: Any) -> dict[str, Any]:
    idx = data["idx"]
    st = p["stages"][idx]
    lab = st["lab"]
    merged = {**_clean_state(lab_state), **{k: v for k, v in _clean_state(answers).items() if str(k).startswith("student_")}}
    if not merged and str(idx) in data["lab_state"]:
        merged = dict(data["lab_state"][str(idx)])
    res = data["results"].setdefault(str(idx), {"attempts": 0})
    if res.get("passed"):
        clean = labs.normalize(lab["model"], data["lab_state"].get(str(idx), merged), lab)
        return {"ok": True, "repeat": True, "feedback": [], "state": clean,
                "readouts": readouts(lab["model"], st, clean, labs.derive(lab["model"], clean, lab))}
    result = labs.check(lab["model"], st, merged)
    fails_before = int(res.get("attempts", 0))
    res["attempts"] = fails_before + 1
    data["lab_state"][str(idx)] = result["state"]
    record_skill(db, uk, topic_of(p), st.get("skill"), result["ok"])
    full = labs.derive(lab["model"], result["state"], lab)
    out: dict[str, Any] = {"ok": result["ok"], "state": result["state"]}
    if result["ok"]:
        res["passed"] = True
        res["first_try"] = fails_before == 0
        res["hints"] = int(data["hints"].get(str(idx), 0))
        out["feedback"] = []
        out["readouts"] = {k: v for k, v in full.items() if k not in ("by_id", "neighbor_els")}
        if st["kind"] == "exploration":
            out["observe"] = st.get("observe", "")
        if lab["model"] in ("classify", "order"):
            out["lab"] = client_lab(lab, True)
        return out
    data["mistakes"].append(_mistake(idx, st, result["failed"], result["state"]))
    out["feedback"] = _feedback(p, st, result["failed"], fails_before, full)
    out["readouts"] = readouts(lab["model"], st, result["state"], full)
    if lab["model"] == "classify":
        out["marks"] = {"wrong_count": len(full["wrong_items"]),
                        **({"wrong": full["wrong_items"]} if fails_before + 1 >= 2 else {})}
    if lab["model"] == "ohm" and full.get("table_wrong"):
        out["marks"] = {"table_wrong": full["table_wrong"]}
    hints = st.get("hints", []) if st["kind"] != "final_challenge" else []
    out["hint_available"] = int(data["hints"].get(str(idx), 0)) < len(hints)
    out["can_skip"] = res["attempts"] >= 5
    return out


def action(user_id: str | None, pid: str, body: dict[str, Any]) -> dict[str, Any]:
    """Единая точка действий ученика: advance · answer · check · hint · skip · restart."""
    p = practicum(pid)
    uk = user_key(user_id)
    kind = str(body.get("type") or "")
    if kind not in ("advance", "answer", "check", "hint", "skip", "restart"):
        raise PracticumError(400, "Неизвестное действие", "ACTION_INVALID")
    with tx() as db:
        data = _load(db, uk, pid) or _create(db, uk, p)
        if kind == "restart":
            data.update(status="in_progress", idx=0, lab_state={}, results={}, hints={}, mistakes=[], completed_at=None,
                        mastery_before=mastery_snapshot(db, uk, topic_of(p)), attempt_no=data["attempt_no"] + 1)
            _save(db, uk, pid, data)
            return {"result": {"ok": True}, "session": session_view(db, uk, p, data)}
        _stage_guard(data, body.get("stage_index"))
        idx = data["idx"]
        st = p["stages"][idx]
        res = data["results"].get(str(idx), {})
        result: dict[str, Any]
        if kind == "advance":
            allowed = st["kind"] in ("intro", "summary_and_next") or res.get("passed") or res.get("revealed") or res.get("skipped")
            if not allowed:
                raise PracticumError(409, "Сначала выполни задание этапа", "STAGE_NOT_DONE")
            if st["kind"] == "intro":
                data["results"][str(idx)] = {"passed": True, "attempts": 0}
            if idx == len(p["stages"]) - 1:
                data["results"][str(idx)] = {"passed": True, "attempts": 0}
                if data["status"] != "completed":
                    data["status"], data["completed_at"] = "completed", _now()
            else:
                data["idx"] = idx + 1
            result = {"ok": True}
        elif kind == "answer":
            if st["kind"] not in ANSWER_STAGES:
                raise PracticumError(409, "На этом этапе нужен не выбор ответа, а действие в лаборатории", "STAGE_KIND_MISMATCH")
            result = _answer_stage(db, uk, p, data, body.get("selected_answer"))
        elif kind == "check":
            if st["kind"] not in LAB_CHECK_STAGES:
                raise PracticumError(409, "На этом этапе нечего проверять в лаборатории", "STAGE_KIND_MISMATCH")
            result = _check_stage(db, uk, p, data, body.get("lab_state"), body.get("answers"))
        elif kind == "hint":
            if st["kind"] == "final_challenge":
                raise PracticumError(409, "В финальном испытании подсказок нет — примени то, что уже освоил", "HINTS_DISABLED")
            hints = st.get("hints", [])
            if not hints:
                raise PracticumError(409, "На этом этапе подсказок нет", "HINTS_EMPTY")
            level = min(int(data["hints"].get(str(idx), 0)) + 1, len(hints))
            data["hints"][str(idx)] = level
            result = {"ok": True, "hint": hints[level - 1], "level": level, "total": len(hints)}
        else:  # skip
            fails = int(res.get("attempts", 0))
            if st["kind"] not in LAB_CHECK_STAGES or res.get("passed") or fails < 5:
                raise PracticumError(409, "Пропустить этап можно после 5 попыток проверки", "SKIP_NOT_ALLOWED")
            data["results"].setdefault(str(idx), {})["skipped"] = True
            result = {"ok": True, "skipped": True}
        _save(db, uk, pid, data)
        return {"result": result, "session": session_view(db, uk, p, data)}


# ===================================================================================== квиз-опросы
QUIZ_SIZE = 5
QUIZ_KINDS = ("single_choice", "multi_choice", "short_answer", "matching", "ordering", "diagram_question")


def _from_boards(p: dict[str, Any]) -> list[dict[str, Any]]:
    """Вопросы из проверенных досок практикума: «к какой группе относится…» и «восстанови порядок»."""
    out: list[dict[str, Any]] = []
    for st in p["stages"]:
        lab = st.get("lab") or {}
        if st["kind"] not in ("action_check", "progressive_hints") or lab.get("model") not in ("classify", "order"):
            continue
        if lab["model"] == "classify":
            titles = [b["title"] for b in lab["buckets"]]
            ids = [b["id"] for b in lab["buckets"]]
            for item in lab["items"][:3]:
                out.append({"kind": "single_choice", "text": f"К какой группе относится: «{item['text']}»?", "options": titles,
                            "correct": ids.index(item["bucket"]), "explain": item["why"], "skill": st.get("skill"), "source": p["practicum_id"]})
        else:
            by_id = {i["id"]: i for i in lab["items"]}
            out.append({"kind": "ordering", "text": "Восстанови правильный порядок.", "items": [by_id[i]["text"] for i in lab["correct"]],
                        "explain": " → ".join(by_id[i]["why"] for i in lab["correct"])[:600], "skill": st.get("skill"),
                        "source": p["practicum_id"]})
    return out


def _from_bank(t: reg.Topic, count: int) -> list[dict[str, Any]]:
    from app import quiz_bank
    try:
        built = quiz_bank.build(t.subject_title, t.title, count=count)
    except quiz_bank.BankError:
        return []
    out = []
    for q in built.get("questions", []):
        kind = {"single": "single_choice", "multi": "multi_choice", "short": "short_answer"}.get(q.get("kind"))
        if kind is None:
            continue
        # Навык банка не размечен: вычислительный ответ относим к навыку вычислений (№ 2), выбор — к пониманию (№ 1).
        skill = 1 if kind == "short_answer" and len(t.skills) > 1 else 0
        item: dict[str, Any] = {"kind": kind, "text": q["text"], "explain": q.get("explain", ""), "skill": skill, "source": "quiz_bank"}
        if kind == "short_answer":
            item.update(value=None, answers=list(q.get("answers") or []), tol=0.0)
        elif kind == "single_choice":
            item.update(options=list(q["options"]), correct=int(q["correct"][0]))
        else:
            item.update(options=list(q["options"]), correct=sorted(int(i) for i in q["correct"]))
        out.append(item)
    return out


def quiz_pool(t: reg.Topic | None) -> list[dict[str, Any]]:
    if t is None:
        return []
    pool: list[dict[str, Any]] = []
    for p in practicums_for_topic(t.topic_id):
        pool.extend({**q, "source": p["practicum_id"]} for q in p.get("quiz", []))
        pool.extend(_from_boards(p))
    if len(pool) < QUIZ_SIZE:
        pool.extend(_from_bank(t, QUIZ_SIZE - len(pool)))
    if len(pool) < QUIZ_SIZE:
        pool.extend(topic_quiz(t))
    seen: set[str] = set()
    unique = []
    for q in pool:
        sig = re.sub(r"\s+", " ", q["text"].lower())
        if sig not in seen and q["kind"] in QUIZ_KINDS:
            seen.add(sig)
            unique.append(q)
    return unique


def _pick(pool: list[dict[str, Any]], rng: random.Random, size: int) -> list[dict[str, Any]]:
    """Разные навыки и разные типы вопросов: раунд-робин по навыкам, внутри — перемешивание."""
    by_skill: dict[Any, list[dict[str, Any]]] = {}
    for q in pool:
        by_skill.setdefault(q.get("skill"), []).append(q)
    for items in by_skill.values():
        rng.shuffle(items)
    keys = sorted(by_skill, key=lambda k: (k is None, k if k is not None else 0))
    out: list[dict[str, Any]] = []
    while len(out) < size and any(by_skill.values()):
        for k in keys:
            if by_skill[k] and len(out) < size:
                out.append(by_skill[k].pop())
    return out


def _client_question(q: dict[str, Any], qid: str, rng: random.Random) -> tuple[dict[str, Any], dict[str, Any]]:
    view: dict[str, Any] = {"id": qid, "kind": q["kind"], "text": q["text"]}
    secret: dict[str, Any] = {}
    if q["kind"] in ("single_choice", "multi_choice", "diagram_question"):
        view["options"] = list(q["options"])
        if q["kind"] == "diagram_question":
            view["diagram"] = q["diagram"]
    elif q["kind"] == "matching":
        perm = list(range(len(q["pairs"])))
        while len(perm) > 1 and perm == sorted(perm):
            rng.shuffle(perm)
        view["left"] = [a for a, _ in q["pairs"]]
        view["right"] = [q["pairs"][i][1] for i in perm]
        secret["perm"] = perm
    elif q["kind"] == "ordering":
        perm = list(range(len(q["items"])))
        while len(perm) > 1 and perm == sorted(perm):
            rng.shuffle(perm)
        view["items"] = [q["items"][i] for i in perm]
        secret["perm"] = perm
    return view, secret


def start_quiz(user_id: str | None, topic_id: str) -> dict[str, Any]:
    t = reg.topic(topic_id)
    if t is None:
        raise PracticumError(404, "Тема не найдена", "TOPIC_UNKNOWN")
    pool = quiz_pool(t)
    if not pool:
        raise PracticumError(404, "Для этой темы пока нет проверенных вопросов — квиз не собирается из догадок", "QUIZ_EMPTY")
    uk = user_key(user_id)
    attempt_id = "qa_" + secrets.token_urlsafe(12)
    rng = random.Random(int.from_bytes(hashlib.sha256(attempt_id.encode()).digest()[:8], "big"))
    chosen = _pick(pool, rng, QUIZ_SIZE)
    stored, views = [], []
    for n, q in enumerate(chosen, 1):
        view, secret = _client_question(q, f"q{n}", rng)
        views.append(view)
        stored.append({"id": view["id"], "q": q, **secret})
    at = _now()
    with tx() as db:
        db.execute("DELETE FROM quiz_attempts WHERE created_at < ?", (at - QUIZ_TTL_SECONDS,))
        db.execute("INSERT INTO quiz_attempts(attempt_id, user_key, topic_id, questions_json, status, created_at) VALUES(?,?,?,?,?,?)",
                   (attempt_id, uk, t.topic_id, json.dumps(stored, ensure_ascii=False), "open", at))
    return {"attempt_id": attempt_id, "topic": t.as_dict(), "title": "Квиз-опрос", "badge": "Быстрая проверка",
            "questions": views, "total": len(views)}


def _norm_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").lower().replace("ё", "е")).strip().strip(" .,!?;:«»\"'()")


def _grade_one(item: dict[str, Any], given: Any) -> bool:
    q = item["q"]
    kind = q["kind"]
    try:
        if kind in ("single_choice", "diagram_question"):
            return given is not None and int(given) == int(q["correct"])
        if kind == "multi_choice":
            return isinstance(given, list) and sorted({int(x) for x in given}) == sorted(int(x) for x in q["correct"])
        if kind == "short_answer":
            number = labs.parse_number(given)
            if q.get("value") is not None and number is not None:
                return abs(number - float(q["value"])) <= max(float(q.get("tol", 0.01)), 1e-9)
            accepted = [_norm_text(a) for a in q.get("answers", [])]
            if q.get("value") is not None:
                accepted.append(_norm_text(labs.fmt(q["value"])))
            text = _norm_text(given)
            if text and text in accepted:
                return True
            nums = [labs.parse_number(a) for a in q.get("answers", [])]
            return number is not None and any(n is not None and abs(n - number) <= 1e-9 for n in nums)
        if kind == "matching":
            perm = item["perm"]          # right[j] на экране = pairs[perm[j]]
            return isinstance(given, list) and len(given) == len(perm) and all(perm[int(j)] == i for i, j in enumerate(given))
        if kind == "ordering":
            perm = item["perm"]
            return isinstance(given, list) and [perm[int(j)] for j in given] == list(range(len(perm)))
    except (TypeError, ValueError, IndexError):
        return False
    return False


def _answer_display(q: dict[str, Any]) -> str:
    kind = q["kind"]
    if kind in ("single_choice", "diagram_question"):
        return q["options"][int(q["correct"])]
    if kind == "multi_choice":
        return "; ".join(q["options"][int(i)] for i in q["correct"])
    if kind == "short_answer":
        return labs.fmt(q["value"]) if q.get("value") is not None else (q.get("answers") or ["—"])[0]
    if kind == "matching":
        return "; ".join(f"{a} — {b}" for a, b in q["pairs"])
    return " → ".join(q["items"])


def submit_quiz(user_id: str | None, attempt_id: str, answers: Any) -> dict[str, Any]:
    uk = user_key(user_id)
    given = answers if isinstance(answers, dict) else {}
    with tx() as db:
        row = db.execute("SELECT * FROM quiz_attempts WHERE attempt_id=? AND user_key=?", (str(attempt_id), uk)).fetchone()
        if row is None:
            raise PracticumError(404, "Квиз-опрос не найден или устарел", "QUIZ_NOT_FOUND")
        if row["status"] == "submitted":
            return json.loads(row["result_json"])
        t = reg.topic(row["topic_id"])
        assert t is not None
        stored = json.loads(row["questions_json"])
        per_q, by_skill = [], {}
        for item in stored:
            ok = _grade_one(item, given.get(item["id"]))
            q = item["q"]
            record_skill(db, uk, t, q.get("skill"), ok)
            ref = _skill_ref(t, q.get("skill"))
            if ref:
                agg = by_skill.setdefault(ref["key"], {"skill_key": ref["key"], "title": ref["title"], "wrong": 0, "total": 0})
                agg["total"] += 1
                agg["wrong"] += 0 if ok else 1
            per_q.append({"id": item["id"], "correct": ok, "explain": q.get("explain", ""), "answer": _answer_display(q),
                          "skill": ref})
        score = sum(1 for x in per_q if x["correct"])
        smap = skill_map(db, uk, t)
        pct = {s["skill_key"]: s["mastery_percent"] for s in smap["skills"]}
        gaps = [{**g, "mastery_percent": pct.get(g["skill_key"])} for g in by_skill.values() if g["wrong"]]
        items = practicums_for_topic(t.topic_id)
        rec = recommendation(db, uk, t, smap)
        cta = None
        if items:
            target = next((p for p in items if rec and rec.get("practicum_id") == p["practicum_id"]), items[0])
            cta = {"label": "Закрыть пробел в Практикуме по этой теме", "practicum_id": target["practicum_id"], "title": target["title"]}
        result = {"attempt_id": attempt_id, "topic": t.as_dict(), "score": score, "max_score": len(per_q),
                  "score_label": f"{score} из {len(per_q)}", "questions": per_q, "gaps": gaps, "skill_map": smap,
                  "cta": cta, "message": None if gaps else "Пробелов по этим вопросам не найдено"}
        db.execute("UPDATE quiz_attempts SET status='submitted', score=?, max_score=?, result_json=?, submitted_at=? WHERE attempt_id=?",
                   (score, len(per_q), json.dumps(result, ensure_ascii=False), _now(), attempt_id))
        return result


# ===================================================================================== тьютор в контексте практикума
def _scrub_obj(value: Any) -> Any:
    if isinstance(value, str):
        return scrub_pii(value)
    if isinstance(value, list):
        return [_scrub_obj(v) for v in value]
    if isinstance(value, dict):
        return {k: _scrub_obj(v) for k, v in value.items()}
    return value


def tutor_context(user_id: str | None, pid: str, lab_state: Any = None, answers: Any = None) -> dict[str, Any]:
    """``PracticumTutorContext``: класс, предмет, тема, этап, действие ученика, его ошибки и показанные подсказки."""
    p = practicum(pid)
    t = topic_of(p)
    uk = user_key(user_id)
    with tx() as db:
        data = _load(db, uk, pid) or _create(db, uk, p)
    idx = data["idx"]
    st = p["stages"][idx]
    lab = st.get("lab") or {}
    state: dict[str, Any] = {}
    failed: list[dict[str, Any]] = []
    hidden: list[str] = []
    if st["kind"] in LAB_CHECK_STAGES:
        merged = {**(data["lab_state"].get(str(idx)) or lab.get("initial", {})), **_clean_state(lab_state),
                  **{k: v for k, v in _clean_state(answers).items() if str(k).startswith("student_")}}
        checked = labs.check(lab["model"], st, merged)
        state = checked["state"]
        failed = checked["failed"]
        hidden = sorted(_hidden(lab["model"], st, state))
    hints = st.get("hints", []) if st["kind"] != "final_challenge" else []
    ctx = {"grade": t.grade, "subject": t.subject_title, "topic": t.title, "curriculum_ref": t.fgos_ref,
           "practicum_id": p["practicum_id"], "practicum_title": p["title"],
           "current_stage": {"index": idx, "kind": st["kind"], "title": STAGE_TITLES[st["kind"]],
                             "task": st.get("task") or (st.get("question") or {}).get("text") or st.get("body", "")},
           "model": lab.get("model"), "student_action_state": state,
           "failing_principles": [{"principle": f["principle"], "title": _principle_title(p, f["principle"]), "kind": f["kind"],
                                   "q": f.get("q"), "field": f.get("field"), "label": f.get("label"), "given": f.get("given")}
                                  for f in failed],
           "previous_mistakes": [m for m in data["mistakes"] if m.get("stage") == idx][-5:],
           "hints_shown": hints[:int(data["hints"].get(str(idx), 0))],
           "hidden_quantities": hidden, "final_challenge": st["kind"] == "final_challenge"}
    return _scrub_obj(ctx)


def _v(state: dict[str, Any], key: str) -> str:
    return labs.fmt(state.get(key))


def _socratic_lab(model: str, principle: str, kind: str, state: dict[str, Any], derived: dict[str, Any], given: Any,
                  label: str = "") -> str | None:
    s = state
    if model == "quadratic":
        if principle == "branch_direction":
            return f"Сейчас a = {_v(s, 'a')}. От знака какого коэффициента зависит, куда смотрят ветви параболы, — и какой знак нужен?"
        if principle == "discriminant_formula":
            return (f"У тебя a = {_v(s, 'a')}, b = {_v(s, 'b')}, c = {_v(s, 'c')}. Посчитай D = b² − 4ac по шагам: чему равно b², "
                    "чему равно 4ac и что получится при вычитании? Следи за знаком c.")
        if principle.startswith("discriminant") or principle == "roots_on_axis":
            return (f"У тебя a = {_v(s, 'a')}, b = {_v(s, 'b')}, c = {_v(s, 'c')}. Как по знаку D = b² − 4ac понять, "
                    "сколько раз парабола пересечёт ось Ox?")
        if principle in ("coefficients", "given_a"):
            return "Выпиши коэффициенты из условия вместе со знаками: что стоит перед x², что перед x и что без x?"
        return "Какой корень даёт знак «+» в формуле x = (−b ± √D) / (2a)? Подходит ли он по смыслу задачи?"
    if model == "linear":
        return f"Сейчас k = {_v(s, 'k')}, b = {_v(s, 'b')}. Какой из коэффициентов отвечает за наклон прямой, а какой — за точку на оси Oy?"
    if model == "scales":
        if principle == "isolate":
            return "Что останется на чаше, если снять с обеих чаш одинаковое число гирь? А если одинаковое число x?"
        if principle == "keep_unknown":
            return "Если x пропадёт с обеих чаш, что станет с уравнением? Сколько x нужно оставить хотя бы на одной чаше?"
        if principle == "root":
            return "Когда на чаше остался один x, сколько гирь на другой чаше его уравновешивают?"
        return (f"Сейчас перевешивает {derived.get('heavier', 'одна')} чаша. Какое одно и то же действие нужно сделать "
                "с обеими чашами, чтобы равновесие не нарушилось?")
    if model == "area":
        shape = SHAPE_RU.get(str(s.get("shape")), "фигура")
        return (f"Фигура — {shape}. Какие размеры входят в формулу её площади? Как изменится площадь, "
                "если увеличить высоту вдвое, а остальное не трогать?")
    if model == "ohm":
        if principle == "closed_circuit":
            return "Посмотри на ключ: может ли идти ток, если цепь разомкнута?"
        if kind == "answer" and given is not None:
            return (f"Ты выставил U = {_v(s, 'U')} В и R = {_v(s, 'R')} Ом, а записал {with_unit(label or 'I, А', given)}. Вспомни закон Ома "
                    "I = U / R: если напряжение не меняется, а сопротивление растёт, ток растёт или уменьшается?")
        if s.get("mode") in ("series", "parallel"):
            return "Как складываются сопротивления при последовательном соединении и как — при параллельном? Какое общее R у твоей цепи?"
        return f"Сейчас U = {_v(s, 'U')} В, R = {_v(s, 'R')} Ом. Что нужно изменить — напряжение или сопротивление, — чтобы ток стал таким, как в задании?"
    if model == "molecule":
        if principle == "connected":
            return "Все ли атомы соединены в одну молекулу? Найди атом, от которого не идёт ни одной связи."
        if principle in ("valence", "valence_ok"):
            return "Посчитай черточки у каждого атома. Сколько связей должно быть у водорода, кислорода и углерода по валентности?"
        return "Сравни число атомов каждого элемента с формулой из задания: чего не хватает и что лишнее?"
    if model == "climate":
        if principle == "belts":
            return f"Ты на широте {_v(s, 'lat')}°. Между какими параллелями лежит нужный климатический пояс?"
        if principle.startswith("pressure"):
            return "До какой высоты честно работает правило «−10 мм рт. ст. на каждые 100 м»? Что происходит выше?"
        return f"Ты на высоте {_v(s, 'alt')} м. На сколько градусов холоднее становится с каждым километром подъёма и сколько километров ты прошёл?"
    if model == "order":
        if derived.get("first_wrong") is not None:
            return (f"Посмотри на карточку на позиции № {int(derived['first_wrong']) + 1}. Что должно случиться раньше — она "
                    "или та, что стоит перед ней? Ищи причину и следствие.")
        return "Какое событие или шаг здесь самое первое — то, без чего не начнётся всё остальное?"
    if model == "classify":
        if derived.get("missing_count"):
            return f"Осталось разложить карточек: {derived['missing_count']}. Задай каждой вопрос признака группы — на какой из них она отвечает?"
        return "Возьми карточку, в которой сомневаешься, и задай ей вопрос признака каждой группы. На какой вопрос она отвечает?"
    if model == "robot":
        if derived.get("crashed"):
            return f"Робот врезается на шаге № {derived.get('crashed_step')}. Где стена относительно Робота перед этим шагом и как её обойти?"
        if principle == "loops":
            return "Какие команды идут подряд одинаковыми? Их можно записать одной командой «повтори n раз»."
        return f"Робот остановился в клетке ({_v(derived, 'x')}; {_v(derived, 'y')}). В какую сторону и на сколько клеток ещё до цели?"
    return None


def socratic_reply(ctx: dict[str, Any]) -> str:
    """Наводящий вопрос без готового ответа и без скрытых величин этапа."""
    stage = ctx["current_stage"]
    kind = stage["kind"]
    if kind == "intro":
        return "Где ты уже встречал это в жизни или на уроке? Прочитай, где это пригодится, и переходи к подготовке."
    if kind == "summary_and_next":
        return "Посмотри на карту навыков: какой навык сейчас ниже всего? С него и стоит продолжить."
    if kind in ANSWER_STAGES:
        if kind == "error_explanation":
            return "Найди в решении шаг, где нарушено правило. Какое правило должно было сработать именно там?"
        return "Какое понятие в вопросе главное? Вспомни его определение и исключи варианты, которые ему противоречат."
    model = ctx.get("model") or ""
    state = ctx.get("student_action_state") or {}
    failing = ctx.get("failing_principles") or []
    if not failing:
        return "Модель уже выставлена верно. Нажми «Проверить» — или перечитай задание: какую величину просят записать?"
    first = next((f for f in failing if f["kind"] == "model"), failing[0])
    p = ALL.get(ctx["practicum_id"])
    lab = (p["stages"][stage["index"]].get("lab") if p else None) or {}
    derived = labs.derive(model, labs.normalize(model, state, lab), lab) if model else {}
    visible = {k: v for k, v in derived.items() if k not in set(ctx.get("hidden_quantities") or [])}
    question = _socratic_lab(model, str(first["principle"]), first["kind"], state, visible, first.get("given"),
                             first.get("label") or "")
    title = first["title"].rstrip(".")
    lead = "" if question and title in question else f"Ключевой принцип: {title}. "
    return lead + (question or "Что в твоём действии расходится с условием задания? Измени один параметр и посмотри, что поменяется.")


def _leaks_hidden(reply: str, ctx: dict[str, Any]) -> bool:
    """Не выдал ли ИИ скрытую величину этапа (например, D или x₂), которой нет в контексте ученика."""
    p = ALL.get(ctx["practicum_id"])
    if p is None or not ctx.get("hidden_quantities"):
        return False
    st = p["stages"][ctx["current_stage"]["index"]]
    lab = st.get("lab") or {}
    model = lab.get("model")
    if not model:
        return False
    derived = labs.derive(model, labs.normalize(model, ctx.get("student_action_state") or {}, lab), lab)
    visible_text = json.dumps(ctx, ensure_ascii=False)
    for key in ctx["hidden_quantities"]:
        value = derived.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            token = labs.fmt(value)
            pattern = r"(?<![\d,.])" + re.escape(token).replace("−", "[−-]") + r"(?![\d,])"
            if re.search(pattern, reply) and not re.search(pattern, visible_text):
                return True
    return False


def tutor_prompt(ctx: dict[str, Any]) -> str:
    stage = ctx["current_stage"]
    state = ", ".join(f"{k} = {labs.fmt(v)}" for k, v in (ctx.get("student_action_state") or {}).items()
                      if not isinstance(v, (list, dict))) or "—"
    mistakes = "; ".join(" / ".join(m.get("messages", [])) for m in ctx.get("previous_mistakes", [])) or "нет"
    failing = "; ".join(f["title"] for f in ctx.get("failing_principles", [])) or "нет"
    return (f"Практикум «{ctx['practicum_title']}». {ctx['subject']}, {ctx['grade']} класс, тема «{ctx['topic']}» ({ctx['curriculum_ref']}).\n"
            f"Этап: {stage['title']}. Задание: {stage['task']}\n"
            f"Что ученик выставил в лаборатории: {state}\n"
            f"Нарушенные принципы сейчас: {failing}\nПредыдущие ошибки на этапе: {mistakes}\n"
            f"Уже показанные подсказки: {'; '.join(ctx.get('hints_shown', [])) or 'нет'}\n"
            f"Нельзя называть готовый ответ и значения величин: {', '.join(ctx.get('hidden_quantities', [])) or '—'}."
            + (" Это финальное испытание: только один наводящий вопрос о принципе, без подсказок к числам." if ctx.get("final_challenge") else ""))
