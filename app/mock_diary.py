"""Mock-дневник «Сетевого города»: детерминированные данные без интеграций.

Все числа выводятся из stable_hash(user_id) — у одного пользователя данные
стабильны между запросами, у разных — отличаются. last_bell «14:45» равен
концу последнего урока (требование согласованности SchoolDay).

Профиль наград (rewards_profile) удалён: реальный путь — app/progress.py.
"""
from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from app.academic import SUBJECTS, estimate_from_norms, stable_hash

SCHOOL_NAME = "МОУ СОШ №17"
GRADE = "8А"
QUARTER_START = "2026-09-01"
QUARTER_END = "2026-10-30"

MOCK_LESSONS: list[dict[str, str]] = [
    {"starts_at": "08:30", "ends_at": "09:15", "subject": "Алгебра"},
    {"starts_at": "09:25", "ends_at": "10:10", "subject": "Русский язык"},
    {"starts_at": "10:25", "ends_at": "11:10", "subject": "Литература"},
    {"starts_at": "11:25", "ends_at": "12:10", "subject": "Физика"},
    {"starts_at": "12:20", "ends_at": "13:05", "subject": "История"},
    {"starts_at": "13:55", "ends_at": "14:45", "subject": "Физкультура"},
]

MOCK_TASKS: list[dict[str, Any]] = [
    {"title": "Алгебра: §13, упр. 355–357 (квадратные уравнения)",
     "type": "written", "deadline": None,
     "planned_minutes": estimate_from_norms("Алгебра: §13, упр. 355–357 (квадратные уравнения)", GRADE)},
    {"title": "Физика: §14, упр. 12; повторить формулы скорости",
     "type": "written", "deadline": None,
     "planned_minutes": estimate_from_norms("Физика: §14, упр. 12; повторить формулы скорости", GRADE)},
    {"title": "Русский язык: упр. 187 (пунктуация)",
     "type": "written", "deadline": None,
     "planned_minutes": estimate_from_norms("Русский язык: упр. 187 (пунктуация)", GRADE)},
    {"title": "Литература: пересказ глав 2–3 «Капитанской дочки»",
     "type": "oral", "deadline": None,
     "planned_minutes": estimate_from_norms("Литература: пересказ глав 2–3 «Капитанской дочки»", GRADE)},
]

DEFAULT_SETTINGS: dict[str, Any] = {
    "recommended_start": "15:30",
    "bedtime": "22:00",
    "rest_slots": [{"start": "20:00", "end": "20:40", "label": "Ужин"}],
    "personal_activities": [
        {"title": "Игры на ПК", "duration_minutes": 120,
         "is_fixed": False, "time_window": None},
    ],
}

_STUDENTS = [
    "Иванов А.", "Петрова М.", "Сидоров К.", "Кузнецова Д.",
    "Смирнов П.", "Орлова Е.", "Васильев И.", "Морозова А.",
    "Николаев С.", "Фёдорова О.", "Григорьев Д.", "Захарова В.",
]

_TEACHER_LESSONS: list[dict[str, Any]] = [
    {"starts_at": "08:30", "ends_at": "09:15", "subject": "Алгебра",
     "class_label": "8А", "topic": "Квадратные уравнения",
     "prep_recommendation": "Повторить разложение на множители; проверить д/з упр. 355"},
    {"starts_at": "09:25", "ends_at": "10:10", "subject": "Алгебра",
     "class_label": "8Б", "topic": "Квадратные уравнения",
     "prep_recommendation": "Собрать тетради 8Б; разбор типичных ошибок упр. 350"},
    {"starts_at": "10:25", "ends_at": "11:10", "subject": "Геометрия",
     "class_label": "8А", "topic": "Теорема Пифагора",
     "prep_recommendation": "Подготовить доказательство у доски; чертёжные инструменты"},
    {"starts_at": "12:20", "ends_at": "13:05", "subject": "Алгебра",
     "class_label": "9А", "topic": "Неравенства второй степени",
     "prep_recommendation": "Проверить контрольные 9А; метод интервалов"},
]

def school_day(today: date | None = None) -> dict[str, Any]:
    today = today or date.today()
    return {
        "date": today.isoformat(),
        "lessons": [dict(l) for l in MOCK_LESSONS],
        "last_bell": MOCK_LESSONS[-1]["ends_at"],
    }

def grades(user_id: str) -> list[dict[str, Any]]:
    h = stable_hash(user_id)
    base = [
        ("Алгебра", 4.7), ("Русский язык", 4.3), ("Литература", 5.0),
        ("Физика", 4.2), ("История", 4.6),
    ]
    out: list[dict[str, Any]] = []
    for i, (subj, avg) in enumerate(base):
        shift = ((h >> (i * 3)) % 5 - 2) / 10  # −0.2…+0.2
        avg = round(max(3.0, min(5.0, avg + shift)), 1)
        trend_code = (h >> (i * 2)) % 3
        trend = "up" if trend_code == 0 else "down" if trend_code == 1 else "flat"
        out.append({"subject": subj, "average": avg, "trend": trend})
    return out

def quarter_schedule(days: int = 5, today: date | None = None) -> dict[str, Any]:
    today = today or date.today()
    out: list[dict[str, Any]] = []
    for offset in range(max(1, min(14, days))):
        d = today + timedelta(days=offset)
        h = stable_hash(d.isoformat())
        wd = d.weekday()
        if wd >= 5:  # выходные
            out.append({"date": d.isoformat(),
                        "weekday": ["saturday", "sunday"][wd - 5],
                        "lessons": [], "substitutions": []})
            continue
        count = 4 + h % 3
        lessons = [{"subject": SUBJECTS[(h + i * 3) % len(SUBJECTS)]}
                   for i in range(count)]
        substitutions: list[dict[str, str]] = []
        if offset == 1 and len(lessons) > 2:
            substitutions.append({
                "slot": "3-й урок",
                "was": lessons[2]["subject"],
                "became": "История",
                "reason": "школьные сборы",
            })
        out.append({
            "date": d.isoformat(),
            "weekday": ["monday", "tuesday", "wednesday", "thursday",
                        "friday"][wd],
            "lessons": lessons,
            "substitutions": substitutions,
        })
    return {"quarter_start": QUARTER_START, "quarter_end": QUARTER_END, "days": out}

def teacher_day(today: date | None = None) -> dict[str, Any]:
    today = today or date.today()
    return {"date": today.isoformat(),
            "lessons": [dict(l) for l in _TEACHER_LESSONS]}

def heatmap() -> dict[str, Any]:
    roster: list[dict[str, Any]] = []
    for i, name in enumerate(_STUDENTS):
        h = stable_hash(name)
        submitted = (h % 4) != 0
        blitz = h % 4
        total = 4
        done_tasks = total if submitted else 1 + h % 3
        problems: list[dict[str, Any]] = []
        if not submitted or blitz < 2:
            subj = SUBJECTS[h % len(SUBJECTS)]
            problems.append({
                "title": f"{subj}: тема №{5 + h % 10}",
                "error_rate": 25 + h % 50,
                "error_line": 3 + h % 12 if blitz < 2 else None,
                "hint": "Отработать базовые преобразования",
            })
        roster.append({
            "display_name": name,
            "homework_submitted": submitted,
            "blitz_score": blitz,
            "blitz_max": 3,
            "submitted_tasks": done_tasks,
            "total_tasks": total,
            "error_rate": round((3 - blitz) * 100 / 3),
            "problem_tasks": problems,
            # Ответов по вопросам mock-дневник не отдаёт — честно пусто.
            "error_details": [],
        })
    subjects = sorted({p["title"].split(":")[0]
                       for r in roster for p in r["problem_tasks"]})
    avg = round(sum(r["blitz_score"] for r in roster) / len(roster), 1)
    missed = sum(1 for r in roster if not r["homework_submitted"])
    worst = subjects[0] if subjects else "—"
    brief = (
        f"Фокус урока: {worst}. Не сдали ДЗ: {missed} из {len(roster)} — "
        f"начать разбор с них. Средний блиц {avg}/3: "
        + ("тема усвоена, можно идти дальше." if avg >= 2 else
           "слабые места есть — вернуться к базовым определениям.")
    )
    return {
        "class_label": GRADE,
        "generated_for": "07:15",
        "blitz_average": avg,
        "submitted_count": len(roster) - missed,
        "class_size": len(roster),
        "subjects": [{"subject": s} for s in subjects],
        "roster": roster,
        "five_minute_brief": brief,
        "is_demo": True,
    }