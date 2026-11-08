"""v17.1 — инструменты ученика: подробности задания, закрытие блицем, сборщик расписания.

Честность данных: реального API «Сферума»/«Сетевого города» нет. Подробности и тема
урока берутся из демо-дневника (is_demo=True) или из текста задания ученика.
Вопросы блица подбираются детерминированно по ключевым словам темы (без ИИ —
никаких выдуманных фактов); у каждого набора есть «уверенность» — доля вопросов,
совпавших с темой, а не только с предметом.
"""
from __future__ import annotations

import hashlib
import re
import time
from datetime import date, timedelta
from typing import Any

from app.ephemeral import FileStore
from app.academic import estimate_from_norms, subject_of

# ---------- демо-«Сетевой город»: тема урока и учитель по предмету ----------
DEMO_TOPICS: dict[str, str] = {
    "Алгебра": "Квадратные уравнения. Дискриминант. Теорема Виета",
    "Физика": "Равномерное прямолинейное движение. Скорость",
    "Русский язык": "Пунктуация: однородные члены, обособление",
    "Литература": "А. С. Пушкин «Капитанская дочка»: главы 2–3",
    "Геометрия": "Теорема Пифагора",
    "История": "Пётр I: реформы",
}
DEMO_TEACHERS: dict[str, str] = {
    "Алгебра": "Иванова Н. П.", "Геометрия": "Иванова Н. П.", "Физика": "Котов А. С.",
    "Русский язык": "Лебедева О. В.", "Литература": "Лебедева О. В.", "История": "Сергеев Д. М.",
}

# ---------- банк вопросов: (предмет, ключи темы, вопрос, варианты [0 — верный], почему) ----------
_BANK: list[tuple[str, tuple[str, ...], str, list[str], str]] = [
    ("Физика", ("скорост", "движен"), "Формула скорости при равномерном движении", ["v = s / t", "v = s · t", "v = t / s", "v = m / V"], "Путь за единицу времени."),
    ("Физика", ("скорост",), "72 км/ч — это…", ["20 м/с", "72 м/с", "7,2 м/с", "36 м/с"], "72 000 м / 3600 с = 20 м/с."),
    ("Физика", ("скорост", "движен"), "Путь за 10 с при v = 5 м/с", ["50 м", "2 м", "15 м", "0,5 м"], "s = v · t."),
    ("Физика", ("скорост",), "Единица скорости в СИ", ["м/с", "км/ч", "м/мин", "км/с"], "СИ: метр и секунда."),
    ("Физика", ("движен", "скорост"), "Время в пути: 120 км при 60 км/ч", ["2 ч", "0,5 ч", "180 ч", "1 ч"], "t = s / v."),
    ("Физика", ("плотност",), "Плотность вещества", ["ρ = m / V", "ρ = m · V", "ρ = V / m", "ρ = F / S"], "Масса единицы объёма."),
    ("Физика", ("сил", "тяжест"), "Сила тяжести", ["F = m · g", "F = m / g", "F = g / m", "F = m + g"], "g ≈ 9,8 Н/кг."),
    ("Алгебра", ("квадрат", "дискриминант"), "Дискриминант ax² + bx + c = 0", ["b² − 4ac", "b² + 4ac", "4ac − b²", "b − 4ac"], "D = b² − 4ac."),
    ("Алгебра", ("квадрат", "дискриминант"), "Сколько корней, если D < 0?", ["Ни одного", "Один", "Два", "Бесконечно много"], "Корень из отрицательного числа не извлекается."),
    ("Алгебра", ("виет", "квадрат"), "Для x² + px + q = 0 сумма корней равна…", ["−p", "p", "q", "−q"], "Теорема Виета."),
    ("Алгебра", ("квадрат", "виет"), "Корни x² − 5x + 6 = 0", ["2 и 3", "−2 и −3", "1 и 6", "−1 и 6"], "Сумма 5, произведение 6."),
    ("Алгебра", ("квадрат",), "Приведённое квадратное уравнение — когда…", ["a = 1", "b = 0", "c = 0", "D = 0"], "Старший коэффициент равен 1."),
    ("Русский язык", ("пунктуац", "однородн"), "Нужна ли запятая: «Я купил хлеб и молоко»?", ["Нет", "Да, перед «и»", "Да, после «купил»", "Нужно тире"], "Одиночный союз «и» между однородными — без запятой."),
    ("Русский язык", ("пунктуац", "однородн"), "Перед «но» между однородными членами…", ["ставится запятая", "запятая не нужна", "ставится тире", "ставится двоеточие"], "Противительный союз — запятая."),
    ("Русский язык", ("обособлен", "пунктуац"), "Причастный оборот после определяемого слова…", ["обособляется", "не обособляется", "берётся в кавычки", "выделяется тире"], "«Книга, лежащая на столе, …»."),
    ("Русский язык", ("пунктуац", "обобщ"), "После обобщающего слова перед однородными ставят…", ["двоеточие", "тире", "запятую", "ничего"], "«Купил фрукты: яблоки, груши»."),
    ("Литература", ("капитан", "пушкин", "гринёв", "гринев"), "Кто рассказчик в «Капитанской дочке»?", ["Пётр Гринёв", "Швабрин", "Савельич", "Пугачёв"], "Записки Петра Андреевича Гринёва."),
    ("Литература", ("капитан", "пушкин", "главы 2"), "Что Гринёв подарил вожатому в буран?", ["Заячий тулуп", "Шпагу", "Деньги", "Коня"], "Глава 2 «Вожатый»."),
    ("Литература", ("капитан", "пушкин"), "Как зовут слугу Гринёва?", ["Савельич", "Зурин", "Иван Кузьмич", "Пугачёв"], "Архип Савельич — дядька."),
    ("Литература", ("капитан", "пушкин"), "Жанр «Капитанской дочки»", ["Исторический роман (повесть)", "Поэма", "Комедия", "Басня"], "Историческое произведение о пугачёвщине."),
    ("Геометрия", ("пифагор",), "Гипотенуза при катетах 3 и 4", ["5", "7", "6", "12"], "√(9 + 16) = 5."),
    ("Геометрия", ("пифагор",), "Теорема Пифагора", ["c² = a² + b²", "c = a + b", "c² = a² − b²", "c = a·b"], "Квадрат гипотенузы."),
    ("Геометрия", ("треугол",), "Сумма углов треугольника", ["180°", "360°", "90°", "270°"], "Теорема о сумме углов."),
    ("История", ("пётр", "петр", "реформ"), "Год основания Санкт-Петербурга", ["1703", "1612", "1812", "1725"], "Заложен Петром I."),
    ("История", ("пётр", "петр", "реформ"), "«Табель о рангах» ввёл…", ["Пётр I", "Иван IV", "Екатерина II", "Александр I"], "1722 г."),
    ("История", ("пётр", "петр", "войн"), "Полтавская битва — год", ["1709", "1700", "1721", "1812"], "Победа над шведами."),
]

PASS_SHARE = 0.6
MAX_QUIZZES = 5000
_QUIZZES = FileStore("quizzes", ttl=1800, max_items=MAX_QUIZZES)  # v18: файл на опрос, переживает рестарт; id → {title, answers, why}


def _norm(s: str) -> str:
    return (s or "").lower().replace("ё", "е")


def lesson_topic(subject: str | None, title: str, diary_mode: str) -> tuple[str | None, str]:
    """Тема урока + источник. Демо-«Сетевой город» → тема по предмету; иначе — из текста задания."""
    if subject and diary_mode == "mock" and subject in DEMO_TOPICS:
        return DEMO_TOPICS[subject], "Сетевой город · демо"
    m = re.search(r"\(([^)]{3,80})\)", title) or re.search(r";\s*(.{3,80})$", title)
    return (m.group(1).strip(), "из текста задания") if m else (None, "нет темы")


def task_details(title: str, diary_tasks: list[dict[str, Any]], diary_mode: str, lessons_by_day,
                 today: date, grade: str | int | None = 8) -> dict[str, Any]:
    subj = subject_of(title)
    task = next((t for t in diary_tasks if t.get("title") == title), None)
    from_diary = task is not None and task.get("source") in (None, "diary", "sferum")
    detail = title.split(":", 1)[1].strip() if ":" in title else title
    refs = re.findall(r"§\s*\d+(?:[–-]\d+)?|упр\.\s*\d+(?:[–-]\d+)?|стр\.\s*\d+(?:[–-]\d+)?|глав[аы]?\s*\d+(?:[–-]\d+)?", title, re.I)
    topic, topic_src = lesson_topic(subj, title, diary_mode)
    due = None
    if subj:
        for k in range(1, 8):
            d = today + timedelta(days=k)
            if any(_norm(l.get("subject")) == _norm(subj) for l in (lessons_by_day(d) or [])):
                due = d.isoformat()
                break
    minutes = (task or {}).get("planned_minutes") or estimate_from_norms(title, grade)
    demo = diary_mode == "mock"
    return {
        "title": title, "subject": subj, "text": detail, "refs": refs,
        "source": ("Сферум · демо-дневник" if demo else "Дневник") if from_diary else "добавлено вручную",
        "teacher": DEMO_TEACHERS.get(subj or "") if demo and from_diary else None,
        "issued_on": (today - timedelta(days=1)).isoformat() if demo and from_diary else None,
        "due": (task or {}).get("deadline") or due, "due_source": "дедлайн задания" if (task or {}).get("deadline") else ("следующий урок по расписанию" if due else None),
        "topic": topic, "topic_source": topic_src,
        "planned_minutes": minutes, "estimate_source": "оценка из задания" if task else ("приблизительная оценка: класс неизвестен" if grade is None else "нормативы по классу и объёму"),
        "type": (task or {}).get("type"), "is_demo": demo,
        "notice": "Реального API «Сферума» нет — это демо-данные дневника." if demo else None,
    }


def close_quiz(uid: str, title: str, topic: str | None, n: int = 4) -> dict[str, Any]:
    """Вопросы для закрытия задания. Ранжируем банк по совпадению ключей с темой+заданием."""
    subj = subject_of(title)
    hay = _norm(f"{title} {topic or ''}")
    scored = []
    for i, (s, keys, q, opts, why) in enumerate(_BANK):
        if s != subj:
            continue
        hits = sum(1 for k in keys if _norm(k) in hay)
        scored.append((hits, i))
    if not scored:
        return {"ok": False, "quiz_id": None, "questions": [], "confidence": 0.0,
                "message": "Для этого предмета пока нет вопросов — закрой задание кнопкой «Готово»."}
    scored.sort(key=lambda x: (-x[0], x[1]))
    pick = [i for _, i in scored[:n]]
    matched = sum(1 for h, i in scored[:n] if h > 0)
    # v17.1 red team: порядок вариантов — новый на каждую попытку (иначе после разбора ответы «по позиции»)
    seed = int(hashlib.sha256(f"{uid}|{title}|{time.time_ns()}".encode()).hexdigest(), 16)
    questions, answers, whys = [], [], []
    for j, i in enumerate(pick):
        _, _, q, opts, why = _BANK[i]
        order = sorted(range(len(opts)), key=lambda k: (seed >> (j * 4 + k)) & 7 ^ k)
        questions.append({"question": q, "options": [opts[k] for k in order]})
        answers.append(order.index(0))
        whys.append(why)
    qid = hashlib.sha256(f"{uid}|{title}|{time.time()}".encode()).hexdigest()[:20]
    _QUIZZES.put(qid, uid, {"title": title, "answers": answers, "why": whys})   # лимит/TTL — внутри FileStore
    conf = round(matched / len(pick), 2)
    return {"ok": True, "quiz_id": qid, "questions": questions, "topic": topic, "confidence": conf,
            "confidence_label": "по теме урока" if conf >= 0.75 else "частично по теме" if conf > 0 else "по предмету в целом",
            "pass_share": PASS_SHARE, "source": "rules"}


def check_quiz(uid: str, quiz_id: str, answers: list[int]) -> dict[str, Any]:
    got = _QUIZZES.take(quiz_id, uid)                # одна проверка на опрос (атомарно): повтор — новый опрос
    if not got:
        return {"ok": False, "error": "Опрос устарел — начни заново"}
    title, right, whys = got["title"], got["answers"], got["why"]
    marks = [i < len(answers) and answers[i] == r for i, r in enumerate(right)]
    correct = sum(marks)
    passed = correct >= max(1, round(len(right) * PASS_SHARE + 1e-9))
    return {"ok": True, "title": title, "correct": correct, "total": len(right), "passed": passed,
            "marks": marks, "right": right, "why": whys}


# ---------- сборщик расписания ----------
def _m(s: str) -> int:
    h, m = s.split(":")
    return int(h) * 60 + int(m)


def _t(x: int) -> str:
    x = max(0, min(x, 24 * 60 - 1))
    return f"{x // 60:02d}:{x % 60:02d}"


def build_schedule(p: dict[str, Any]) -> dict[str, Any]:
    """Уроки по параметрам ученика + прогноз тайм-менеджмента до сна. Ничего не сохраняет."""
    start, n, L, br = _m(p["start"]), p["lessons"], p["lesson_minutes"], p["break_minutes"]
    long_after, long_min = p.get("long_break_after"), p.get("long_break_minutes", 20)
    subjects = [s for s in (p.get("subjects") or []) if s][:n]
    lessons, t = [], start
    for i in range(n):
        lessons.append({"n": i + 1, "subject": subjects[i] if i < len(subjects) else f"Урок {i + 1}",
                        "start": _t(t), "end": _t(t + L)})
        t += L
        if i < n - 1:
            t += long_min if long_after and i + 1 == long_after else br
    last_bell = t
    home = last_bell + p["travel_minutes"]
    bed = _m(p["bedtime"])
    extras = []
    for e in p.get("extras") or []:
        s = _m(e["start"]) if e.get("start") else None
        extras.append({"title": e["title"], "start": _t(s) if s is not None else None,
                       "end": _t(s + e["minutes"]) if s is not None else None, "minutes": e["minutes"],
                       "conflict": s is not None and s < home})
    rest = p.get("rest_minutes", 60)
    hw = p.get("homework_minutes", 0)
    fixed = sum(e["minutes"] for e in extras)
    free = max(0, bed - home)
    left = free - fixed - rest - hw
    status = "ok" if left >= 30 else "tight" if left >= 0 else "overload"
    tips = []
    if any(e["conflict"] for e in extras):
        tips.append("Дело стоит раньше, чем ты будешь дома — проверь время или дорогу.")
    if status == "overload":
        tips.append(f"Не хватает {-left} мин: перенеси часть заданий на утро или сократи свободное время.")
    elif status == "tight":
        tips.append("Впритык: начни задания сразу после отдыха, без длинных пауз.")
    else:
        tips.append(f"Запас {left} мин — можно разбить задания на помидоры 25/5.")
    hw_start = home + min(rest, 30)
    date_s = p["date"]
    payload = date_s + "\n" + "\n".join(f"{l['n']} {l['subject']} {l['start']}-{l['end']}" for l in lessons)
    return {
        "date": date_s, "lessons": lessons, "last_bell": _t(last_bell), "home_at": _t(home),
        "extras": extras, "forecast": {
            "free_minutes": free, "extras_minutes": fixed, "rest_minutes": rest, "homework_minutes": hw,
            "left_minutes": left, "status": status, "homework_start": _t(hw_start),
            "done_by": _t(hw_start + hw) if hw else None, "tips": tips,
        },
        "import_payload": payload,
        "named": len(subjects) == n,
    }
