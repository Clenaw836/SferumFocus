"""Реальный движок прогресса «СферумФокус»: стрик, очки, уровень,
достижения, «Моя неделя». Хранение — JSON-файл (атомарная запись),
ноль внешних зависимостей; готовая точка замены на SQLite/БД.

## Правила стрика (по ТЗ)
1. День засчитывается в стрик, только если выполнено ≥65% заданий дня.
2. Меньше 65% — стрик в этот день не растёт.
3. Рост после провального дня возможен на следующий день И только
   через закрытую блиц-дуэль (устный предмет «на параграфах»).
4. Если 3 дня подряд задавался устный предмет «на параграфах», день
   провален и блиц не сделан — стрик сбрасывается в 0.

## Система наград
Очки за реальные действия; уровни дают множитель очков; достижения —
настоящие триггеры событий, а не проценты из хеша.
"""
from __future__ import annotations

import json
import hashlib
from time import time as _receipt_time
from uuid import UUID
from collections.abc import Callable
import logging
import os
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

from app.config import SFERUM_DATA_DIR
from app.json_storage import file_lock, atomic_json
from app.ephemeral import ResourceLimitError
from functools import wraps

DAY_RATIO_PASS = 0.65
MISS_LIMIT = 3

DATA_DIR = Path(SFERUM_DATA_DIR)
STORE_FILE = DATA_DIR / "progress.json"

# Очки (до множителя уровня).
POINTS_TASK_WRITTEN = 10
POINTS_TASK_ORAL = 15
POINTS_DUEL = 25
POINTS_DUEL_SECOND_CHANCE = 10
POINTS_DAY_COUNTED = 30
POINTS_FLASHCARD = 5
POINTS_PERFECT_DAY = 20

# Уровни: порог очков → (название, множитель).
LEVELS: list[tuple[int, str, float]] = [
    (0, "Новичок", 1.0),
    (200, "Собиратель", 1.05),
    (600, "Концентрат", 1.1),
    (1200, "Мастер вечера", 1.15),
    (2000, "Легенда фокуса", 1.2),
]

# Достижения: ключ → (название, описание, цель, счётчик).
ACHIEVEMENTS: tuple[dict[str, Any], ...] = (
    {"id": "first_plan", "title": "Первый шаг",
     "description": "Собери свой первый план дня", "target": 1,
     "counter": "plan_built"},
    {"id": "first_duel", "title": "Закрывший тему",
     "description": "Закрой первую тему блиц-дуэлью", "target": 1,
     "counter": "duels"},
    {"id": "duels5", "title": "Дуэлянт",
     "description": "Закрой 5 тем блиц-дуэлями", "target": 5,
     "counter": "duels"},
    {"id": "streak3", "title": "Три дня подряд",
     "description": "Держи стрик 3 дня", "target": 3,
     "counter": "streak_peak"},
    {"id": "streak7", "title": "Неделя фокуса",
     "description": "Держи стрик 7 дней", "target": 7,
     "counter": "streak_peak"},
    {"id": "streak14", "title": "Две недели огня",
     "description": "Держи стрик 14 дней", "target": 14,
     "counter": "streak_peak"},
    {"id": "days5", "title": "Пять собранных дней",
     "description": "Собери 5 дней с выполнением от 65%", "target": 5,
     "counter": "counted_days"},
    {"id": "flashcards5", "title": "Шпаргалочник",
     "description": "Получи 5 шпаргалок на перемену", "target": 5,
     "counter": "flashcards"},
    {"id": "perfect", "title": "Полный разгром",
     "description": "Выполни все задания дня (100%)", "target": 1,
     "counter": "perfect_days"},
    {"id": "early", "title": "Ранняя пташка",
     "description": "Рассчитай вечер до 16:00", "target": 1,
     "counter": "early_plans"},
    {"id": "comeback", "title": "Возвращение",
     "description": "Продолжи стрик после провального дня через блиц",
     "target": 1, "counter": "comebacks"},
)

def _today() -> date:
    return date.today()

def _level_of(points: int) -> tuple[int, str, int, int]:
    """→ (уровень, название, до след. уровня, прогресс %)."""
    idx = 0
    for i, (threshold, _, _) in enumerate(LEVELS):
        if points >= threshold:
            idx = i
    level, name, _mult = LEVELS[idx]
    if idx + 1 < len(LEVELS):
        nxt = LEVELS[idx + 1][0]
        prev = LEVELS[idx][0]
        to_next = max(0, nxt - points)
        percent = min(99, int((points - prev) / max(1, nxt - prev) * 100))
    else:
        to_next, percent = 0, 100
    return idx + 1, name, to_next, percent

def quarantine(path: Path) -> Path | None:
    """Переименовать повреждённый JSON в <name>.corrupt-<ts>, чтобы данные можно было
    восстановить вручную, а не потерять при следующей записи (v15)."""
    try:
        if path.exists():
            dst = path.with_name(f"{path.name}.corrupt-{int(time.time())}")
            os.replace(path, dst)
            logging.getLogger(__name__).error("Повреждённый файл данных отложен: %s", dst.name)
            return dst
    except OSError:
        pass
    return None

IDEMPOTENCY_TTL_SECONDS = 24 * 3600
IDEMPOTENCY_MAX_RECEIPTS = 2048
IDEMPOTENCY_PER_USER = 128
IDEMPOTENCY_MAX_BYTES = 16 * 1024 * 1024

class IdempotencyConflict(ValueError):
    """A live key was reused for a different validated request."""

class IdempotencyKeyError(ValueError):
    """The mutation key is not one canonical UUIDv4."""

def validate_mutation_key(value: str) -> str:
    try:
        parsed = UUID(value)
    except (ValueError, TypeError, AttributeError) as exc:
        raise IdempotencyKeyError("X-Idempotency-Key должен быть UUIDv4") from exc
    if parsed.version != 4 or str(parsed) != value.lower():
        raise IdempotencyKeyError("X-Idempotency-Key должен быть UUIDv4")
    return str(parsed)

def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)

EVENT_ID_MAX = 120          # длина id события
EVENT_IDS_PER_DAY = 300     # защита от разрастания


def _duel_score(v: Any) -> int:
    """Счёт дуэли/блица от клиента → целое 0..3 (v16.1: без доверия к вводу)."""
    try:
        n = int(v)
    except (TypeError, ValueError):
        return 0
    return max(0, min(3, n))

def _persisted(fn):
    @wraps(fn)
    def call(self, *args, **kwargs):
        with file_lock(self.path):
            outer = not getattr(self, '_operation', False)
            if outer:
                self._load()
                self._operation = True
            try:
                return fn(self, *args, **kwargs)
            except Exception:
                if outer:
                    self._load()  # failed in-memory change is never a future false success
                raise
            finally:
                if outer:
                    self._operation = False
    return call

class ProgressStore:
    """Персистентный стор прогресса.

    Публичные операции перечитывают общий JSON под межпроцессной блокировкой.
    Уникальный tmp + replace; ошибки сохранения не превращаются в успех.
    """

    def __init__(self, path: Path | None = None) -> None:
        self.path = path or STORE_FILE
        self._data: dict[str, Any] = {}
        self._load()

    # ------------------------- хранение -------------------------

    def _load(self) -> None:
        self._data = {}
        try:
            if self.path.exists():
                self._data = json.loads(self.path.read_text(encoding="utf-8"))
        except ValueError:
            # v15: битый файл не затираем следующей записью — откладываем в сторону.
            quarantine(self.path)
            self._data = {}
        if not isinstance(self._data, dict):
            quarantine(self.path)
            self._data = {}

    def _save(self) -> None:
        if not getattr(self, "_defer_saves", False):
            atomic_json(self.path, self._data)

    @_persisted
    def mutation(self, user_id: str, endpoint: str, key: str, body: dict[str, Any],
                 operation: Callable[[], dict[str, Any]]) -> tuple[dict[str, Any], bool]:
        """Single local-POSIX commit for domain state and its 24h ACK receipt.

        Auth and Pydantic validation belong to the route, before this boundary.
        Only synchronous, local operations may run here: never network I/O.
        An unknown outcome after replace is safe to retry with the same key.
        """
        key = validate_mutation_key(key)
        owner = hashlib.sha256(user_id.encode()).hexdigest()
        namespace = hashlib.sha256(_canonical([user_id, endpoint, key]).encode()).hexdigest()
        fingerprint = hashlib.sha256(_canonical(body).encode()).hexdigest()
        now = _receipt_time()
        receipts = self._data.setdefault("idempotency_v1", {})
        if not isinstance(receipts, dict):
            raise ValueError("invalid idempotency ledger; manual recovery required")
        for receipt_key, receipt in list(receipts.items()):
            if (not isinstance(receipt, dict) or type(receipt.get("expires_at")) not in (int, float)
                    or not isinstance(receipt.get("owner"), str)
                    or not isinstance(receipt.get("fingerprint"), str)
                    or not isinstance(receipt.get("result"), dict)):
                raise ValueError("invalid idempotency receipt; manual recovery required")
            if receipt["expires_at"] <= now:
                del receipts[receipt_key]
        cached = receipts.get(namespace)
        if cached is not None:
            if cached["fingerprint"] != fingerprint:
                raise IdempotencyConflict("Ключ уже использован для другого запроса")
            return json.loads(_canonical(cached["result"])), True
        if (len(receipts) >= IDEMPOTENCY_MAX_RECEIPTS
                or sum(v["owner"] == owner for v in receipts.values()) >= IDEMPOTENCY_PER_USER):
            raise ResourceLimitError("Лимит квитанций синхронизации исчерпан; сохранённые ключи доступны")
        self._defer_saves = True
        try:
            result = json.loads(_canonical(operation()))
            receipts[namespace] = {"owner": owner, "fingerprint": fingerprint,
                                   "expires_at": now + IDEMPOTENCY_TTL_SECONDS, "result": result}
            if len(_canonical(receipts).encode()) > IDEMPOTENCY_MAX_BYTES:
                raise ResourceLimitError("Недостаточно места для квитанции; результат не подтверждён")
        finally:
            self._defer_saves = False
        self._save()
        return json.loads(_canonical(result)), False

    def _user(self, user_id: str) -> dict[str, Any]:
        users = self._data.setdefault("users", {})
        return users.setdefault(user_id, {
            "streak": 0,
            "points": 0,
            "miss": 0,
            "streak_peak": 0,
            "counted_days": 0,
            "perfect_days": 0,
            "early_plans": 0,
            "comebacks": 0,
            "flashcards": 0,
            "duels": 0,
            "plan_built": 0,
            "unlocked": [],
            "days": {},       # date → счётчики дня
            "last_active": None,
        })

    def _day(self, user: dict[str, Any], day: str) -> dict[str, Any]:
        days = user.setdefault("days", {})
        return days.setdefault(day, {
            "done": 0, "total": 0, "blitz": 0, "oral_seen": False,
            "study_min": 0, "blitz_scores": [], "counted": False,
            "missed": False, "grew": False,
        })

    # --------------------- стрик-машина ---------------------

    def _close_day_if_needed(self, user: dict[str, Any], today: date) -> None:
        """Ленивое закрытие прошедших дней: miss-логика и сброс стрика.

        День закрывается, когда наступает следующий: если он провален
        (<65%), в нём задавался устный «параграфный» предмет и блиц не
        сделан — пропуск +1; три пропуска подряд — сброс стрика в 0.
        """
        last = user.get("last_active")
        if not last or last >= today.isoformat():
            return
        cur = date.fromisoformat(last)
        while cur < today:
            day = self._day(user, cur.isoformat())
            if not day["counted"] and not day["missed"]:
                if day["oral_seen"] and day["blitz"] == 0:
                    user["miss"] = int(user.get("miss", 0)) + 1
                    day["missed"] = True
                    if int(user.get("miss", 0)) >= MISS_LIMIT:
                        user["streak"] = 0
                        user["miss"] = 0
            cur += timedelta(days=1)

    def _prev_day_failed(self, user: dict[str, Any], today: date) -> bool:
        y = (today - timedelta(days=1)).isoformat()
        day = user.get("days", {}).get(y)
        return bool(day and not day.get("counted"))

    def _ratio(self, day: dict[str, Any]) -> float:
        total = int(day.get("total", 0))
        done = int(day.get("done", 0))
        return done / total if total > 0 else 0.0

    def _maybe_count_day(self, user: dict[str, Any], day_str: str) -> None:
        """День засчитывается при первом достижении порога 65%."""
        day = self._day(user, day_str)
        if self._ratio(day) < DAY_RATIO_PASS:
            return
        if not day.get("counted"):
            day["counted"] = True
            user["counted_days"] = int(user.get("counted_days", 0)) + 1
            self._award(user, POINTS_DAY_COUNTED)
            if self._ratio(day) >= 0.999:
                user["perfect_days"] = int(user.get("perfect_days", 0)) + 1
                self._award(user, POINTS_PERFECT_DAY)
        self._maybe_grow_streak(user, day, day_str)

    def _maybe_grow_streak(self, user: dict[str, Any],
                           day: dict[str, Any], day_str: str) -> None:
        """Рост стрика — один раз в день; после провального дня — только
        через блиц-дуэль (по ТЗ). Заморозка не сбрасывает стрик."""
        if not day.get("counted") or day.get("grew"):
            return
        prev_failed = self._prev_day_failed(user, date.fromisoformat(day_str))
        made_duel = int(day.get("blitz", 0)) > 0
        if not prev_failed or made_duel:
            user["streak"] = int(user.get("streak", 0)) + 1
            day["grew"] = True
            user["streak_peak"] = max(int(user.get("streak_peak", 0)),
                                      int(user["streak"]))
            user["miss"] = 0
            if prev_failed and made_duel:
                user["comebacks"] = int(user.get("comebacks", 0)) + 1
        # prev_failed и без блица — стрик заморожен на день, не сброс.

    def _award(self, user: dict[str, Any], points: int) -> None:
        idx = 0
        for i, (threshold, _, _) in enumerate(LEVELS):
            if int(user.get("points", 0)) >= threshold:
                idx = i
        mult = LEVELS[idx][2]
        user["points"] = int(user.get("points", 0)) + int(round(points * mult))

    # ------------------------- события -------------------------

    @_persisted
    def event(self, user_id: str, kind: str, payload: dict[str, Any],
              today: date | None = None) -> dict[str, Any]:
        today = today or _today()
        day_str = today.isoformat()
        user = self._user(user_id)
        self._close_day_if_needed(user, today)
        day = self._day(user, day_str)
        user["last_active"] = day_str

        # v15: идемпотентность. Повтор события с тем же event_id (ретрай сети,
        # двойное нажатие, повторная отправка из офлайн-очереди) не начисляет
        # очки и не меняет счётчики. Без event_id — прежнее поведение.
        raw_event_id = str(payload.get("event_id") or "")
        event_id = (raw_event_id if len(raw_event_id) <= EVENT_ID_MAX else
                    "sha256:" + hashlib.sha256(raw_event_id.encode()).hexdigest())
        legacy_prefix = raw_event_id[:EVENT_ID_MAX] if len(raw_event_id) > EVENT_ID_MAX else None
        if event_id:
            if kind == "task_done":
                ledger = user.setdefault("completion_ids_v1", {})
                if not user.get("completion_ids_v1_seeded"):
                    # Conservative, lossless import of still-retained V29 barriers.
                    # Expired history cannot be reconstructed; never claim otherwise.
                    for seen_day, ids in user.get("seen_events", {}).items():
                        for old_id in ids:
                            old_key = old_id[7:] if old_id.startswith("sha256:") else hashlib.sha256(old_id.encode()).hexdigest()
                            ledger.setdefault(old_key, seen_day)
                    user["completion_ids_v1_seeded"] = True
                digest = hashlib.sha256(raw_event_id.encode()).hexdigest()
                legacy_digest = hashlib.sha256(legacy_prefix.encode()).hexdigest() if legacy_prefix is not None else None
                if digest in ledger or (legacy_digest is not None and legacy_digest in ledger):
                    prof = self.profile(user_id, today=today)
                    prof["duplicate"] = True
                    return prof
                # Never evict business dedup keys as a side effect of receipt TTL.
                if len(ledger) >= 50000:
                    raise ResourceLimitError("Лимит журнала завершений; нужна сверка, запись не удалена")
            seen = user.setdefault("seen_events", {})
            for d in [d for d in seen if d < (today - timedelta(days=2)).isoformat()]:
                seen.pop(d, None)
            # Legacy versions truncated long IDs. Preserve their conservative
            # dedup barrier; new long IDs use the entire-content hash.
            if any(event_id in ids or (legacy_prefix is not None and legacy_prefix in ids)
                   for ids in seen.values()):
                prof = self.profile(user_id, today=today)
                prof["duplicate"] = True
                return prof
            bucket = seen.setdefault(day_str, [])
            if len(bucket) >= EVENT_IDS_PER_DAY:
                raise ResourceLimitError("Дневной лимит новых event_id исчерпан; сохранённые события доступны")
            bucket.append(event_id)
            if kind == "task_done":
                ledger[digest] = day_str

        if kind == "task_done":
            day["total"] = max(int(day.get("total", 0)),
                               int(payload.get("day_total", 0)))
            day["done"] = max(int(day.get("done", 0)),
                              int(payload.get("day_done", 0)))
            if payload.get("oral_eligible"):
                day["oral_seen"] = True
            # Фактическое время из фокус-таймера (если был) честнее норматива.
            actual = payload.get("actual_minutes")
            timed = isinstance(actual, (int, float)) and actual > 0
            minutes = (min(240, max(1, int(actual))) if timed
                       else int(payload.get("planned_minutes", 0) or 0))
            day["study_min"] = int(day.get("study_min", 0)) + max(0, minutes)
            # Master v2.0 · Feature 3: статистика различает фактическое время (фокус-таймер)
            # и оценку времени (норматив задания), а также число принятых (без дублей) «Готово».
            split = "actual_min" if timed else "estimate_min"
            day[split] = int(day.get(split, 0)) + max(0, minutes)
            day["tasks_done"] = int(day.get("tasks_done", 0)) + 1
            self._award(user, POINTS_TASK_ORAL if payload.get("type") == "oral"
                        else POINTS_TASK_WRITTEN)
            self._maybe_count_day(user, day_str)

        elif kind == "plan_built":
            user["plan_built"] = int(user.get("plan_built", 0)) + 1
            if datetime.now().hour < 16:
                user["early_plans"] = int(user.get("early_plans", 0)) + 1

        elif kind == "duel_completed":
            day["blitz"] = int(day.get("blitz", 0)) + 1
            # v16.1: результат приходит от клиента — сервер не верит ему на слово:
            # число верных в шкале 0..3 (как в дуэли), мусор → 0. Очки за дуэль не зависят от score.
            day.setdefault("blitz_scores", []).append(_duel_score(payload.get("score", 0)))
            user["duels"] = int(user.get("duels", 0)) + 1
            try:
                attempt = max(1, int(payload.get("attempt", 1)))
            except (TypeError, ValueError):
                attempt = 1
            self._award(user, POINTS_DUEL if attempt <= 1
                        else POINTS_DUEL_SECOND_CHANCE)
            # Дуэль может разморозить уже собранный, но замороженный день.
            self._maybe_count_day(user, day_str)

        elif kind == "flashcard_used":
            user["flashcards"] = int(user.get("flashcards", 0)) + 1
            self._award(user, POINTS_FLASHCARD)

        self._sync_achievements(user)
        self._save()
        return self.profile(user_id, today=today)

    # --------------------- достижения ---------------------

    def _sync_achievements(self, user: dict[str, Any]) -> None:
        unlocked = set(user.get("unlocked", []))
        user["streak_peak"] = max(int(user.get("streak_peak", 0)),
                                  int(user.get("streak", 0)))
        for ach in ACHIEVEMENTS:
            if ach["id"] in unlocked:
                continue
            if int(user.get(ach["counter"], 0)) >= int(ach["target"]):
                unlocked.add(ach["id"])
        user["unlocked"] = sorted(unlocked)

    # ------------------------- контракты -------------------------

    @_persisted
    def profile(self, user_id: str, today: date | None = None) -> dict[str, Any]:
        today = today or _today()
        user = self._user(user_id)
        self._close_day_if_needed(user, today)
        self._sync_achievements(user)
        self._save()
        points = int(user.get("points", 0))
        level, name, to_next, percent = _level_of(points)
        from app.diary_service import subject_averages
        return {
            "current_streak": int(user.get("streak", 0)),
            "total_points": points,
            "level": level,
            "level_name": name,
            "points_to_next_level": to_next,
            "level_progress_percent": percent,
            "achievements": [
                {
                    "title": a["title"],
                    "description": a["description"],
                    "unlocked": a["id"] in set(user.get("unlocked", [])),
                    "progress_percent": min(100, round(
                        int(user.get(a["counter"], 0))
                        / int(a["target"]) * 100)),
                }
                for a in ACHIEVEMENTS
            ],
            "grades": subject_averages(user_id),
        }

    @_persisted
    def my_week(self, user_id: str, days: int = 7,
                today: date | None = None) -> dict[str, Any]:
        today = today or _today()
        user = self._user(user_id)
        self._close_day_if_needed(user, today)
        out: list[dict[str, Any]] = []
        # Master v2.0 · Feature 3: период статистики до 31 дня (как разрешает маршрут /my-week, le=31).
        for offset in range(max(1, min(31, days)) - 1, -1, -1):
            d = today - timedelta(days=offset)
            day = user.get("days", {}).get(d.isoformat(), {})
            scores = day.get("blitz_scores", []) or []
            study = int(day.get("study_min", 0))
            # Дни до Master v2.0 хранили только сумму: разбивку не выдумываем (split_known=False).
            split_known = study == 0 or "actual_min" in day or "estimate_min" in day
            out.append({
                "date": d.isoformat(),
                "weekday": ["monday", "tuesday", "wednesday", "thursday",
                            "friday", "saturday", "sunday"][d.weekday()],
                "study_minutes": study,
                "counted": bool(day.get("counted")),
                "duels": int(day.get("blitz", 0)),
                "blitz_avg": (round(sum(scores) / len(scores), 1)
                              if scores else None),
                "actual_minutes": int(day.get("actual_min", 0)) if split_known else None,
                "estimate_minutes": int(day.get("estimate_min", 0)) if split_known else None,
                "tasks_done": int(day["tasks_done"]) if "tasks_done" in day else (0 if study == 0 and not day.get("done") else None),
            })
        total = sum(d["study_minutes"] for d in out)
        duels = sum(d["duels"] for d in out)
        all_scores = [s for d in out
                      for s in user.get("days", {}).get(d["date"], {})
                      .get("blitz_scores", [])]
        avg = round(sum(all_scores) / len(all_scores), 1) if all_scores else None
        return {
            "days": out,
            "week_study_minutes": total,
            "week_duels": duels,
            "blitz_average": avg,
            "counted_days_total": int(user.get("counted_days", 0)),
        }

STORE = ProgressStore()