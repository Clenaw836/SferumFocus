"""Детерминированный планировщик вечера «СферумФокус».

Единственная точка грубой оценки времени (estimate_minutes) — её же
импортирует diary_service, расхождений оценок нет. Точная оценка
вписанных заданий — по нормативной таблице (academic.py, см. ai_engine).

Логика сборки:
  1. Письменные задачи идут первыми (свежая голова), устные — в конец.
  2. Работа режется на Pomodoro-сегменты 25/5; перерыв — и между
     сегментами одной задачи, и между задачами.
  3. rest_slots (ужин и т.п.) — «стены» по абсолютному времени: работа
     не пересекает слот, слот всегда присутствует в плане.
  4. «Мои дела»: обязательное дело с точным временем (is_fixed +
     start_time) — тоже стена (вид "personal"); прошедшее отбрасывается,
     начавшееся обрезается, пересечения обрезаются по предыдущему.
     Гибкое дело — после учёбы в первый подходящий промежуток (стены
     перешагиваются); не влезло — summary.unplaced_personal.
  5. deficit_minutes = переполнение окна; summary.need_* — разбор
     потребности (задания+перерывы / обязательные / гибкие / отдых) и
     capacity_minutes; tradeoff_suggestions никогда не трогают обязательные.
  6. survival: каждая задача ужимается до 15 мин; невлезающие — честно
     откладываются (survival_dropped); гибкие дела снимаются,
     обязательные остаются.

Время: «HH:MM», поддерживается «24:00» (= 1440 минут). Отбой раньше
начала окна (включая «00:00») трактуется как полночь СЛЕДУЮЩЕГО дня —
окно не сжимается молча до двух часов. Формат входных строк проверяется
на уровне Pydantic-моделей (models.py), мусор сюда не доходит.
"""
from __future__ import annotations

import math
from typing import Any

WORK_CHUNK = 25
BREAK_LEN = 5
SURVIVAL_CAP = 15
SLEEP_SHIFT_MAX = 30  # дальше сон не предлагаем двигать никогда
FLEX_PART = 15  # минимальный кусок гибкого дела при делении через стены
TASK_MIN_PART = 10  # кусок задания короче не создаём: ни хвост помидора, ни огрызок перед ужином


def seg_count(minutes: int) -> int:
    """Сколько помидоров займёт задание: хвост < TASK_MIN_PART присоединяется к последнему."""
    n = max(1, math.ceil(minutes / WORK_CHUNK))
    if n > 1 and minutes - (n - 1) * WORK_CHUNK < TASK_MIN_PART:
        n -= 1
    return n

def minutes_of(hhmm: str) -> int:
    """«HH:MM» → минуты от полуночи («24:00» → 1440). Некорректный вход → 0."""
    try:
        h, m = str(hhmm).split(":")
        return int(h) * 60 + int(m)
    except (ValueError, AttributeError):
        return 0

def hhmm_of(total: int) -> str:
    """Минуты → «HH:MM»; значения ≥ 1440 заворачиваются через полночь."""
    total = max(0, int(total)) % 1440
    return f"{total // 60:02d}:{total % 60:02d}"

def estimate_minutes(text: str) -> int:
    """Грубая оценка минут по формулировке (для mock-задач дневника).

    Точная оценка вписанных заданий — estimate_from_norms (academic.py).
    """
    t = (text or "").lower()
    if any(k in t for k in ("сочинени", "эссе", "реферат", "доклад")):
        return 50
    if any(k in t for k in ("проект", "презентац", "лаборатор")):
        return 45
    if any(k in t for k in ("пересказ", "выучить", "наизусть", "прочитать")):
        return 30
    if any(k in t for k in ("§", "параграф", "упр", "упражнени", "задач", "тест")):
        return 25
    if "повтор" in t:
        return 15
    return 20

def _sort_key(task: dict[str, Any]) -> tuple[int, int]:
    written_first = 0 if task.get("type") == "written" else 1
    return (written_first, -int(task.get("planned_minutes", 0) or 0))

def _abs_minute(hhmm: str, start: int, end: int) -> int:
    """Абсолютная минута события в окне [start, end): если окно уходит за
    полночь, «00:30» означает следующий день."""
    m = minutes_of(hhmm)
    if m < start and m + 1440 < end:
        m += 1440
    return m


def build_plan(
    *,
    tasks: list[dict[str, Any]],
    start_time: str,
    bedtime: str,
    rest_slots: list[dict[str, Any]] | None = None,
    personal_activities: list[dict[str, Any]] | None = None,
    survival: bool = False,
    compact_breaks: bool = False,
    order: str = "default",
    post_school_rest_minutes: int = 0,
) -> dict[str, Any]:
    rest_slots = rest_slots or []
    personal_activities = personal_activities or []

    start = minutes_of(start_time)
    end = minutes_of(bedtime)
    if end <= start:
        # «00:00» или отбой раньше начала — это полночь следующего дня,
        # а не «окно два часа» молча.
        end += 1440
    capacity = end - start

    queue: list[dict[str, Any]] = []
    # «Я устал»: сначала короткое задание (разгон), потом сложнее
    key = (lambda x: (int(x.get("planned_minutes", 0) or 0), 0 if x.get("type") == "written" else 1)) if order == "short_first" else _sort_key
    for task in sorted(tasks, key=key):
        item = dict(task)
        planned = int(item.get("planned_minutes", 0) or 0)
        if survival:
            planned = min(planned, SURVIVAL_CAP)
        item["planned_minutes"] = max(1, planned)
        queue.append(item)

    # --- Стены: rest-слоты и обязательные дела с точным временем ---
    # [начало, конец, подпись, вид]; прошедшие отброшены, начавшиеся — обрезаны.
    raw_walls: list[list[Any]] = []
    if post_school_rest_minutes > 0:
        raw_walls.append([start, min(end, start + post_school_rest_minutes), "Отдых после школы", "rest"])
    for r in rest_slots:
        a = _abs_minute(r.get("start", "0:00"), start, end)
        b = minutes_of(r.get("end", "0:00"))
        if b <= minutes_of(r.get("start", "0:00")):
            b += 1440
        b += a - minutes_of(r.get("start", "0:00"))
        s, e = max(a, start), min(b, end)
        if e > s:
            raw_walls.append([s, e, r.get("label") or "Отдых", "rest"])
    flexible: list[dict[str, Any]] = []
    for act in personal_activities:
        dur = int(act.get("duration_minutes", 0) or 0)
        if dur <= 0:
            continue
        st = act.get("start_time")
        if act.get("is_fixed", False) and st:
            a = _abs_minute(st, start, end)
            s, e = max(a, start), min(a + dur, end)
            if e > s:
                raw_walls.append([s, e, act.get("title") or "Дело", "personal"])
        elif act.get("is_fixed", False) or not survival:
            # обязательное без точного времени ставится как гибкое,
            # но в survival не снимается и в компромиссах не участвует
            flexible.append(act)
    raw_walls.sort(key=lambda w: (w[0], w[1]))
    # Пересечения: позднее событие обрезается по концу предыдущего.
    walls: list[list[Any]] = []
    for w in raw_walls:
        s = max(w[0], walls[-1][1]) if walls else w[0]
        if w[1] > s:
            walls.append([s, w[1], w[2], w[3]])

    # --- Потребность (для честного дефицита) ---
    need_study = sum(t["planned_minutes"] for t in queue)
    total_segs = sum(seg_count(t["planned_minutes"]) for t in queue)
    if compact_breaks:
        # перерыв внутри задания — раз в 50 мин; между заданиями — всегда (отдых не ломаем)
        intra = sum((seg_count(t["planned_minutes"]) - 1) // 2 for t in queue)
        need_breaks = (intra + max(0, len(queue) - 1)) * BREAK_LEN if queue else 0
    else:
        need_breaks = (max(0, total_segs - 1) * BREAK_LEN) if queue else 0
    need_rest = sum(w[1] - w[0] for w in walls if w[3] == "rest")
    need_fixed = sum(w[1] - w[0] for w in walls if w[3] == "personal")
    need_flexible = sum(int(a["duration_minutes"]) for a in flexible)
    deficit = max(0, need_study + need_breaks + need_rest + need_fixed
                  + need_flexible - capacity)

    entries: list[dict[str, Any]] = []
    counters = {"work": 0, "break": 0, "rest": 0, "personal": 0}

    def push(kind: str, s: int, e: int, label: str,
             segment: str | None = None, task: str | None = None) -> None:
        if e <= s:
            return
        entries.append({
            "start": hhmm_of(s), "end": hhmm_of(e), "kind": kind,
            "label": label, "segment": segment, "task": task,
        })
        counters[kind] += e - s

    t = start
    wall_idx = 0
    dropped: list[str] = []

    def skip_wall() -> bool:
        """Если стоим в стене — отрисовать её и перешагнуть. True = время подвинулось."""
        nonlocal t, wall_idx
        while wall_idx < len(walls) and t >= walls[wall_idx][1]:
            wall_idx += 1
        if wall_idx < len(walls) and t >= walls[wall_idx][0]:
            s, e, label, kind = walls[wall_idx]
            push(kind, t, e, label)
            t = e
            wall_idx += 1
            return True
        return False

    def next_wall() -> int:
        return walls[wall_idx][0] if wall_idx < len(walls) else end

    for qi, task in enumerate(queue):
        remaining = int(task["planned_minutes"])
        seg_no = 0
        seg_idx: list[int] = []
        while remaining > 0:
            if skip_wall():
                continue
            if t >= end:
                dropped.append(task["title"])
                break
            seg_len = min(WORK_CHUNK, remaining)
            if 0 < remaining - seg_len < TASK_MIN_PART:
                seg_len = remaining  # короткий хвост — в этот же кусок
            real_wall = wall_idx < len(walls) and next_wall() < end
            if t + seg_len > next_wall():
                avail = next_wall() - t
                if real_wall:
                    # не режем задание на огрызки вокруг ужина/секции
                    if 0 < remaining - avail < TASK_MIN_PART:
                        avail = remaining - TASK_MIN_PART
                    if avail < TASK_MIN_PART:
                        t = next_wall()
                        continue
                seg_len = avail
            if seg_len <= 0:
                dropped.append(task["title"])
                break
            seg_no += 1
            seg_idx.append(len(entries))
            push("work", t, t + seg_len, task["title"], task=task["title"])
            t += seg_len
            remaining -= seg_len
            if remaining > 0 and (not compact_breaks or seg_no % 2 == 0) and t + BREAK_LEN <= next_wall():
                push("break", t, t + BREAK_LEN, "Перерыв")
                t += BREAK_LEN
        if len(seg_idx) > 1:
            for n, i in enumerate(seg_idx):
                entries[i]["segment"] = f"{n + 1}/{len(seg_idx)}"
        if remaining <= 0 and qi + 1 < len(queue) and t + BREAK_LEN <= next_wall():
            push("break", t, t + BREAK_LEN, "Перерыв")
            t += BREAK_LEN

    # --- Гибкие дела: после учёбы, в свободные промежутки; не влезло в один —
    #     делится на части (≥ FLEX_PART мин) через ужин/обязательные дела;
    #     не уместилось целиком до отбоя — честно в unplaced_personal ---
    unplaced: list[str] = []
    for act in flexible:
        remaining = int(act["duration_minutes"])
        title = act.get("title") or "Дело"
        idx: list[int] = []
        while remaining > 0:
            skip_wall()
            if t >= end:
                break
            gap = min(end, next_wall()) - t
            take = min(remaining, gap)
            if take < min(remaining, FLEX_PART):
                if wall_idx >= len(walls):
                    break
                t = max(t, walls[wall_idx][0])  # промежуток мал — к следующей стене
                continue
            idx.append(len(entries))
            push("personal", t, t + take, title)
            t += take
            remaining -= take
        if len(idx) > 1:
            for n, i in enumerate(idx, 1):
                entries[i]["segment"] = f"{n}/{len(idx)}"
        if remaining > 0:
            unplaced.append(title)

    # --- Дорисовка оставшихся стен (ужин существует, даже если учёба кончилась раньше) ---
    while wall_idx < len(walls):
        s, e, label, kind = walls[wall_idx]
        if e > t:
            push(kind, max(t, s), e, label)
            t = e
        wall_idx += 1

    free_left = max(0, end - t) if deficit == 0 else 0

    # --- Подсказки-компромиссы (обязательные дела не трогаем никогда) ---
    suggestions: list[str] = []
    if deficit > 0:
        for act in flexible:
            if act.get("is_fixed", False):
                continue
            dur = int(act["duration_minutes"])
            title = act.get("title") or "развлечения"
            if dur > deficit:
                suggestions.append(f"Сократить «{title}» на {deficit} мин")
            else:
                suggestions.append(f"Перенести «{title}» на другой день (−{dur} мин)")
        orals = [x for x in tasks if x.get("type") == "oral"]
        if orals:
            oral_sum = sum(int(x.get("planned_minutes", 0) or 0) for x in orals)
            suggestions.append(f"Перенести устное на утро (−{oral_sum} мин)")
        # Сон — ограничение, а не ресурс: «лечь позже» предлагаем только на небольшой сдвиг.
        if deficit <= SLEEP_SHIFT_MAX:
            suggestions.append(f"Лечь позже на {deficit} мин")
        else:
            suggestions.append("Перенести часть заданий на завтра — сон не сдвигаем")

    survival_dropped = None
    if survival and dropped:
        names = ", ".join(f"«{n}»" for n in dropped[:3])
        survival_dropped = {
            "message": (
                f"Режим выживания: {names} не помещаются сегодня — "
                "перенос на завтра. Сделай несгораемый минимум по остальным."
            )
        }

    return {
        "plan": entries,
        "summary": {
            "window_start": hhmm_of(start),
            "window_end": hhmm_of(end),
            "total_work_minutes": counters["work"],
            "total_break_minutes": counters["break"],
            "total_rest_minutes": counters["rest"],
            "total_personal_minutes": counters["personal"],
            "free_minutes_left": free_left,
            "utilization_percent": min(100, round(counters["work"] / max(1, capacity) * 100)),
            "capacity_minutes": capacity,
            "need_work_minutes": need_study + need_breaks,
            "need_fixed_minutes": need_fixed,
            "need_flexible_minutes": need_flexible,
            "need_rest_minutes": need_rest,
            "unplaced_personal": unplaced,
            "study_work_minutes": need_study,
            "mandatory_rest_minutes": need_breaks + need_rest,
            "clean_gamepass_minutes": max(0, capacity - need_study - need_breaks - need_rest - need_fixed - need_flexible),
            "homework_end_time": (next((e["end"] for e in reversed(entries) if e["kind"] == "work"), None)
                                  if not dropped else None),
        },
        "deficit_minutes": deficit,
        "tradeoff_suggestions": suggestions,
        "survival_dropped": survival_dropped,
    }
