"""Детерминированный движок школьного дня (v16, Smart Scheduler).

ОДНА чистая функция ``compute_day(inp)``: одинаковый вход → одинаковый выход.
Внутри нет ``datetime.now()``, случайных чисел и ИИ. Время приходит явно
(``now_local`` — настенные часы в действующем часовом поясе, см. ``resolve_clock``).

Паритет 1:1 с ``frontend/src/lib/dayEngine.ts`` — проверяет
``tests/test_v16_day_parity.py`` (47 фиксированных случаев). Любая правка — в ОБОИХ местах.

Состояния дня (``day_state``):
    MORNING          04:00 … выход из дома (первый урок − дорога)
    BEFORE_SCHOOL    выход … первый звонок
    IN_LESSON        идёт урок
    BETWEEN_LESSONS  перемена / окно между уроками
    SCHOOL_ENDING    идёт последний урок, до звонка ≤ ENDING_MIN минут
    TRAVEL_HOME      последний звонок … дома (последний звонок + дорога)
    AFTER_SCHOOL     дома, но до старта вечера (настройка/«задержусь»)
    EVENING          старт вечера … сон
    NIGHT            после сна или 00:00–03:59 (граница учебного дня — 04:00)
    NO_SCHOOL        источник ПОДТВЕРДИЛ: уроков нет (выходной)
    UNKNOWN          расписания нет / не загрузилось — день не угадываем

Отсутствие расписания НИКОГДА не трактуется как выходной (NO_SCHOOL только при
``available=True`` и пустом списке активных уроков).
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any

ENGINE_VERSION = "16.0"
DAY_EDGE = 4 * 60            # граница учебного дня 04:00
ENDING_MIN = 10              # «последние минуты» последнего урока
PREP_MIN_BREAK = 5           # подготовку к уроку предлагаем, если до него ≥ 5 мин
STATES = ("MORNING", "BEFORE_SCHOOL", "IN_LESSON", "BETWEEN_LESSONS", "SCHOOL_ENDING",
          "TRAVEL_HOME", "AFTER_SCHOOL", "EVENING", "NIGHT", "NO_SCHOOL", "UNKNOWN")
# совместимость со старой петлёй дня (lib/daycycle.ts::Phase) — её используют помощник и события
LEGACY_PHASE = {"MORNING": "morning", "BEFORE_SCHOOL": "school", "IN_LESSON": "school",
                "BETWEEN_LESSONS": "school", "SCHOOL_ENDING": "school", "TRAVEL_HOME": "travel",
                "AFTER_SCHOOL": "evening", "EVENING": "evening", "NIGHT": "night",
                "NO_SCHOOL": "free", "UNKNOWN": "free"}
STATUS_OK = ("fresh", "imported", "demo", "stale", "partial", "conflict")


# ------------------------------------------------------------------ время

def to_min(hhmm: str | None) -> int | None:
    if not hhmm or not isinstance(hhmm, str):
        return None
    p = hhmm.split(":")
    if len(p) != 2 or not p[0].isdigit() or not p[1].isdigit():
        return None
    h, m = int(p[0]), int(p[1])
    if h > 23 or m > 59:
        return None
    return h * 60 + m


def hhmm(m: int) -> str:
    v = m % 1440
    return f"{v // 60:02d}:{v % 60:02d}"


def school_date(now_local: str) -> tuple[str, int]:
    """'2026-10-08T00:30' → ('2026-10-07', 1470): до 04:00 — ещё вчерашний учебный день."""
    d = date.fromisoformat(now_local[:10])
    m = int(now_local[11:13]) * 60 + int(now_local[14:16])
    if m < DAY_EDGE:
        return (d - timedelta(days=1)).isoformat(), m + 1440
    return d.isoformat(), m


def add_days(iso: str, n: int) -> str:
    return (date.fromisoformat(iso) + timedelta(days=n)).isoformat()


def resolve_clock(now_utc: str, device_offset_min: int, school_tz: str | None,
                  school_offset_min: int | None = None) -> dict[str, Any]:
    """Три разных времени: устройство, пояс расписания, время в источнике.

    * ``school_tz`` не задан → считаем по часам телефона, пояс НЕ угадываем.
    * задан и смещение отличается от телефона → предупреждение «+N ч», уроки
      интерпретируем в поясе школы (расписание — свойство школы, не телефона).
    ``school_offset_min`` можно передать явно (тесты/клиент без tzdata).
    """
    t = datetime.fromisoformat(now_utc.replace("Z", "+00:00"))
    if t.tzinfo is None:
        t = t.replace(tzinfo=timezone.utc)
    off = device_offset_min
    source = "device"
    warn = None
    if school_tz:
        so = school_offset_min
        if so is None:
            try:
                from zoneinfo import ZoneInfo
                so = int(t.astimezone(ZoneInfo(school_tz)).utcoffset().total_seconds() // 60)
            except Exception:  # noqa: BLE001 — нет tzdata/неверный пояс: не угадываем
                so = None
        if so is None:
            warn = {"code": "tz_invalid", "text": f"Пояс школы «{school_tz}» не распознан — считаю по часам телефона"}
        else:
            off, source = so, "school"
            diff = so - device_offset_min
            if diff:
                sign = "+" if diff > 0 else "−"
                h, mm = divmod(abs(diff), 60)
                lbl = f"{sign}{h} ч" + (f" {mm} мин" if mm else "")
                warn = {"code": "clock_mismatch", "diff_min": diff,
                        "text": f"Часы телефона и школы расходятся ({lbl}) — время уроков по школе"}
    local = (t.astimezone(timezone.utc) + timedelta(minutes=off)).strftime("%Y-%m-%dT%H:%M")
    return {"now_local": local, "offset_min": off, "source": source,
            "school_tz": school_tz or None, "device_offset_min": device_offset_min, "warning": warn}


# ------------------------------------------------------------------ предметы и задания

def subj_key(s: str | None) -> str:
    """Ключ предмета: первые 5 букв первого слова ('Русский язык' ~ 'Русский: упр.')."""
    if not s:
        return ""
    w = s.split(":")[0].strip().lower().replace("ё", "е")
    w = w.split(" ")[0] if w else ""
    return w[:5]


def task_subject(title: str) -> str:
    return title.split(":")[0].strip() if ":" in title else title.strip()


def task_detail(title: str) -> str | None:
    if ":" not in title:
        return None
    d = title.split(":", 1)[1].strip()
    return d or None


def _ord(n: int) -> str:
    return f"{n}-м"


# ------------------------------------------------------------------ уроки

def _active(lessons: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], bool, bool]:
    """Активные уроки с валидным временем, по началу. → (уроки, partial, conflict)."""
    out, partial = [], False
    for x in lessons or []:
        if (x.get("status") or "active") != "active":
            continue
        s, e = to_min(x.get("start_time")), to_min(x.get("end_time"))
        if s is None or e is None or e <= s:
            partial = True
            continue
        out.append({**x, "_s": s, "_e": e})
    out.sort(key=lambda x: (x["_s"], x.get("lesson_number") or 0))
    conflict = any(out[i]["_s"] < out[i - 1]["_e"] for i in range(1, len(out)))
    return out, partial, conflict


def _lesson_out(x: dict[str, Any] | None) -> dict[str, Any] | None:
    if not x:
        return None
    return {"n": x.get("lesson_number"), "subject": x.get("subject"), "start": hhmm(x["_s"]),
            "end": hhmm(x["_e"]), "room": x.get("room"), "topic": x.get("topic")}


# ------------------------------------------------------------------ приоритет домашки

def prioritize(tasks: list[dict[str, Any]], done: list[str], tomorrow: list[dict[str, Any]],
               today_date: str) -> list[dict[str, Any]]:
    """Детерминированный порядок: урок завтра раньше → срок раньше → письменное → длиннее → название."""
    tom = {}
    for x in tomorrow:
        k = subj_key(x.get("subject"))
        if k and k not in tom:
            tom[k] = x
    rows = []
    for t in tasks:
        title = t.get("title") or ""
        if not title or title in done:
            continue
        k = subj_key(task_subject(title))
        les = tom.get(k)
        due = t.get("due")
        mins = int(t.get("planned_minutes") or 0)
        typ = t.get("type") or "written"
        if les is not None:
            reason = f"завтра {_ord(les.get('lesson_number') or 0)} уроком {les.get('subject')}"
            rank = (0, les["_s"])
        elif due and due <= add_days(today_date, 1):
            reason = "срок — завтра" if due == add_days(today_date, 1) else "срок прошёл"
            rank = (1, 0)
        elif due:
            reason = f"срок {due[8:10]}.{due[5:7]}"
            rank = (2, 0)
        else:
            reason = "урока завтра нет — можно позже"
            rank = (3, 0)
        rows.append({"title": title, "subject": task_subject(title), "minutes": mins, "type": typ,
                     "due": due, "reason": reason, "_r": rank, "_d": due or "9999-99-99",
                     "_w": 0 if typ != "oral" else 1})
    rows.sort(key=lambda r: (r["_r"][0], r["_r"][1], r["_d"], r["_w"], -r["minutes"], r["title"]))
    for i, r in enumerate(rows):
        r["priority"] = i + 1
        if i == 0 and r["_r"][0] == 3 and r["minutes"] >= 30:
            r["reason"] = "самое длинное — пока есть силы"
        for k in ("_r", "_d", "_w"):
            r.pop(k)
    return rows


# ------------------------------------------------------------------ подписи

def fnv1a(s: str) -> str:
    h = 0x811C9DC5
    for b in s.encode("utf-8"):
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return f"{h:08x}"


def _dur(m: int) -> str:
    m = max(0, m)
    h, r = divmod(m, 60)
    if not h:
        return f"{r} мин"
    return f"{h} ч {r} мин" if r else f"{h} ч"


# ------------------------------------------------------------------ главный расчёт

def compute_day(inp: dict[str, Any]) -> dict[str, Any]:
    now_local: str = inp["now_local"]
    sdate, now = school_date(now_local)
    tdate = add_days(sdate, 1)
    days: dict[str, Any] = inp.get("days") or {}
    st = inp.get("settings") or {}
    tv = st.get("travel_minutes")
    travel = max(0, min(240, int(tv if tv is not None else 45)))
    bed0 = to_min(st.get("bedtime"))
    bed0 = 22 * 60 if bed0 is None else bed0
    bed = bed0 + 1440 if bed0 < 12 * 60 else bed0
    rec_start = to_min(st.get("evening_start"))
    rec_start = 15 * 60 + 30 if rec_start is None else rec_start
    sched = inp.get("schedule") or {}
    sstatus = sched.get("status") or "none"
    tasks = inp.get("tasks") or []
    done = inp.get("done") or []
    warnings: list[dict[str, Any]] = []
    if inp.get("clock_warning"):
        warnings.append(inp["clock_warning"])

    today = days.get(sdate) or {}
    tomorrow = days.get(tdate) or {}
    t_avail = bool(today.get("available")) and sstatus in STATUS_OK
    act, partial, conflict = _active(today.get("lessons") or [])
    tom_act, _, _ = _active(tomorrow.get("lessons") or []) if tomorrow.get("available") else ([], False, False)

    # качество данных
    if not t_avail:
        quality = "none"
    elif conflict:
        quality = "conflict"
    elif partial or sstatus == "partial":
        quality = "partial"
    elif sstatus == "stale":
        quality = "stale"
    elif sched.get("is_demo") or sstatus == "demo":
        quality = "demo"
    else:
        quality = "ok"
    if sstatus == "stale":
        warnings.append({"code": "schedule_stale", "text": "Расписание устарело — показываю последнее сохранённое"})
    if sched.get("is_demo") or sstatus == "demo":
        warnings.append({"code": "schedule_demo", "text": "Демо-расписание — не настоящие уроки"})
    if conflict:
        warnings.append({"code": "schedule_conflict", "text": "Уроки в расписании пересекаются — проверь время"})
    if partial:
        warnings.append({"code": "schedule_partial", "text": "У части уроков нет времени — они не учтены"})
    if not t_avail:
        warnings.append({"code": "schedule_missing", "text": "Расписания на сегодня нет — день не угадываю"})

    first = act[0]["_s"] if act else None
    last = max(x["_e"] for x in act) if act else None
    leave = first - travel if first is not None else None
    home = last + travel if last is not None else None
    start = to_min(st.get("start_override")) if st.get("start_override") else None
    if start is None:
        start = home if home is not None and home > rec_start else rec_start

    cur = next((x for x in act if x["_s"] <= now < x["_e"]), None)
    nxt = next((x for x in act if x["_s"] > now), None)
    prev = None
    for x in act:
        if x["_e"] <= now:
            prev = x

    # ---------- состояние ----------
    if now >= bed:
        state = "NIGHT"
    elif not t_avail:
        state = "EVENING" if now >= start else "UNKNOWN"
    elif not act:
        state = "NO_SCHOOL" if not partial else "UNKNOWN"
    elif now < leave:
        state = "MORNING"
    elif now < first:
        state = "BEFORE_SCHOOL"
    elif now < last:
        if cur is not None:
            state = "SCHOOL_ENDING" if cur["_e"] == last and last - now <= ENDING_MIN else "IN_LESSON"
        else:
            state = "BETWEEN_LESSONS"
    elif now < home:
        state = "TRAVEL_HOME"
    elif now < start:
        state = "AFTER_SCHOOL"
    else:
        state = "EVENING"

    # ---------- уроки со статусами PAST / CURRENT / NEXT ----------
    lessons_out = []
    for x in sorted(today.get("lessons") or [], key=lambda y: y.get("lesson_number") or 0):
        s, e = to_min(x.get("start_time")), to_min(x.get("end_time"))
        if (x.get("status") or "active") != "active":
            ls = "cancelled"
        elif s is None or e is None:
            ls = "unknown"
        elif cur is not None and x.get("lesson_number") == cur.get("lesson_number") and s == cur["_s"]:
            ls = "current"
        elif e <= now:
            ls = "past"
        elif nxt is not None and x.get("lesson_number") == nxt.get("lesson_number") and s == nxt["_s"]:
            ls = "next"
        else:
            ls = "later"
        lessons_out.append({"n": x.get("lesson_number"), "subject": x.get("subject"),
                            "start": x.get("start_time"), "end": x.get("end_time"), "status": ls})
    remaining = sum(1 for x in act if x["_e"] > now)

    # ---------- ближайшее событие и момент следующего пересчёта ----------
    marks: list[tuple[int, str, str]] = []
    if act:
        marks.append((leave, "leave", "выход из дома"))
        for x in act:
            marks.append((x["_s"], "lesson_start", f"начало: {x.get('subject')}"))
            marks.append((x["_e"], "lesson_end", f"конец: {x.get('subject')}"))
        marks.append((last - ENDING_MIN, "ending", "последние минуты"))
        marks.append((home, "home", "дома"))
    marks.append((start, "evening", "старт вечера"))
    marks.append((bed, "bed", "сон"))
    marks.append((1440 + DAY_EDGE, "day_edge", "новый учебный день"))
    future = sorted((m for m in marks if m[0] > now), key=lambda m: (m[0], m[1]))
    ne = None
    for m in future:
        if m[1] in ("ending",):
            continue
        ne = {"kind": m[1], "at": hhmm(m[0]), "in_min": m[0] - now, "label": m[2]}
        break
    next_change = future[0][0] if future else 1440 + DAY_EDGE

    # ---------- домашка, время, дефицит ----------
    hw = prioritize(tasks, done, tom_act, sdate)
    hw_total = sum(r["minutes"] for r in hw)
    eve_from = max(now, start) if state not in ("NIGHT",) else bed
    if state in ("MORNING", "BEFORE_SCHOOL", "IN_LESSON", "BETWEEN_LESSONS", "SCHOOL_ENDING", "TRAVEL_HOME"):
        eve_from = max(start, home if home is not None else start)
    avail = max(0, bed - eve_from)
    deficit = max(0, hw_total - avail) if hw else 0
    if deficit and state in ("AFTER_SCHOOL", "EVENING", "NO_SCHOOL", "UNKNOWN", "TRAVEL_HOME"):
        warnings.append({"code": "deficit", "minutes": deficit,
                         "text": f"До сна не хватает {_dur(deficit)} — нужен план спасения"})

    # ---------- подготовка к уроку (тема — только с источником) ----------
    prep = None
    target = None
    if state in ("MORNING", "BEFORE_SCHOOL", "BETWEEN_LESSONS", "IN_LESSON") and nxt is not None:
        target, tday = nxt, sdate
    elif state in ("MORNING",) and act:
        target, tday = act[0], sdate
    elif state in ("SCHOOL_ENDING", "TRAVEL_HOME", "AFTER_SCHOOL", "EVENING", "NO_SCHOOL") and tom_act:
        target, tday = tom_act[0], tdate
    if target is not None:
        k = subj_key(target.get("subject"))
        rel = [t.get("title") for t in tasks if subj_key(task_subject(t.get("title") or "")) == k]
        topic, src = None, "unknown"
        if target.get("topic"):
            topic, src = str(target["topic"])[:120], "schedule"
        else:
            for title in rel:
                d = task_detail(title or "")
                if d:
                    topic, src = d[:120], "task"
                    break
        prep = {"subject": target.get("subject"), "n": target.get("lesson_number"), "date": tday,
                "start": hhmm(target["_s"]), "starts_in": (target["_s"] - now) if tday == sdate else None,
                "topic": topic, "topic_source": src, "related_tasks": rel[:5]}

    # ---------- одно рекомендованное действие + причина ----------
    top = hw[0] if hw else None
    if state == "NIGHT":
        action = ({"kind": "carry_to_morning", "label": "Перенести на утро",
                   "reason": f"сон важнее — осталось {len(hw)} {_plural(len(hw), 'задание', 'задания', 'заданий')}"}
                  if hw else {"kind": "sleep", "label": "Спать", "reason": "всё сделано"})
    elif state == "MORNING":
        action = {"kind": "morning", "label": "Собраться", "reason": f"выход в {hhmm(leave)}"}
    elif state == "BEFORE_SCHOOL":
        action = ({"kind": "prep_lesson", "label": f"Повторить: {prep['subject']}", "reason": f"первый урок в {prep['start']}"}
                  if prep else {"kind": "view_schedule", "label": "Расписание", "reason": "скоро уроки"})
    elif state == "IN_LESSON":
        action = {"kind": "view_schedule", "label": "Расписание",
                  "reason": f"идёт урок до {hhmm(cur['_e'])} — телефон подождёт"}
    elif state == "BETWEEN_LESSONS":
        gap = (nxt["_s"] - now) if nxt else 0
        action = ({"kind": "prep_lesson", "label": f"Подготовиться: {nxt.get('subject')}",
                   "reason": f"перемена {_dur(gap)} — успеешь повторить"}
                  if nxt and gap >= PREP_MIN_BREAK else
                  {"kind": "view_schedule", "label": "Расписание", "reason": "короткая перемена"})
    elif state == "SCHOOL_ENDING":
        action = {"kind": "view_evening", "label": "План на вечер", "reason": f"уроки закончатся в {hhmm(last)}"}
    elif state == "TRAVEL_HOME":
        action = {"kind": "view_evening", "label": "План на вечер", "reason": f"дома в {hhmm(home)}"}
    elif state == "AFTER_SCHOOL":
        action = {"kind": "rest", "label": "Отдохнуть", "reason": f"вечер начнётся в {hhmm(start)}"}
    elif state == "UNKNOWN":
        action = {"kind": "add_schedule", "label": "Добавить расписание", "reason": "без расписания не знаю, где ты сейчас"}
    elif top is not None:
        action = {"kind": "start_task", "label": f"Первым — {top['subject']}", "reason": top["reason"], "target": top["title"]}
    elif tom_act:
        action = {"kind": "prep_tomorrow", "label": "Посмотреть завтра", "reason": "заданий нет — проверь завтрашние уроки"}
    else:
        action = {"kind": "free", "label": "Свободен", "reason": "заданий нет"}

    # ---------- завтра ----------
    tom_out = {"date": tdate, "available": bool(tomorrow.get("available")),
               "count": len(tom_act), "first": hhmm(tom_act[0]["_s"]) if tom_act else None,
               "subjects": [x.get("subject") for x in tom_act]}
    if not tomorrow.get("available") and state in ("TRAVEL_HOME", "AFTER_SCHOOL", "EVENING", "NO_SCHOOL", "NIGHT"):
        warnings.append({"code": "tomorrow_missing", "text": "Расписания на завтра нет — добавь его, я покажу превью"})

    # ---------- «куда уходит время» (R-PLN-10): минуты учебного дня ----------
    school_min = (last - first) if act else 0
    budget = {"school": school_min, "travel": (2 * travel) if act else 0, "homework": hw_total,
              "free": max(0, avail - hw_total), "sleep_at": hhmm(bed)}

    countdown = state in ("MORNING", "BEFORE_SCHOOL", "IN_LESSON", "BETWEEN_LESSONS", "SCHOOL_ENDING", "TRAVEL_HOME")
    sig = "|".join([ENGINE_VERSION, sdate, str(now), state, sstatus, str(len(act)),
                    ",".join(r["title"] for r in hw), str(travel), str(bed), str(start)])
    return {
        "engine_version": ENGINE_VERSION,
        "date": sdate, "now": hhmm(now), "minute": now,
        "day_state": state, "phase": LEGACY_PHASE[state],
        "schedule_status": sstatus, "data_quality": quality, "last_sync_at": sched.get("last_sync_at"),
        "current_lesson": ({**_lesson_out(cur), "ends_in": cur["_e"] - now,
                            "progress_pct": (now - cur["_s"]) * 100 // max(1, cur["_e"] - cur["_s"])} if cur else None),
        "next_lesson": ({**_lesson_out(nxt), "starts_in": nxt["_s"] - now} if nxt else None),
        "previous_lesson": _lesson_out(prev),
        "remaining_lessons": remaining,
        "lessons": lessons_out,
        "school": {"first": hhmm(first) if first is not None else None, "last": hhmm(last) if last is not None else None,
                   "leave": hhmm(leave) if leave is not None else None, "home": hhmm(home) if home is not None else None},
        "travel_home": {"minutes": travel, "home_at": hhmm(home) if home is not None else None,
                        "active": state == "TRAVEL_HOME", "remaining": (home - now) if state == "TRAVEL_HOME" else None},
        "evening_start": hhmm(start),
        "next_event": ne,
        "homework": hw, "homework_minutes": hw_total,
        "available_time": {"from": hhmm(eve_from), "to": hhmm(bed), "minutes": avail, "deficit": deficit},
        "lesson_prep": prep,
        "recommended_action": action,
        "tomorrow": tom_out,
        "time_budget": budget,
        "warnings": warnings,
        "refresh": {"next_change_min": next_change, "next_change_at": hhmm(next_change),
                    "per_minute": countdown},
        "plan_version": fnv1a(sig),
    }


def _plural(n: int, one: str, few: str, many: str) -> str:
    a, b = abs(n) % 100, abs(n) % 10
    if 10 < a < 20:
        return many
    if 1 < b < 5:
        return few
    if b == 1:
        return one
    return many
