"""Общие академические утилиты: хеш, справочники, нормативы, классификация.

НОРМАТИВНАЯ ТАБЛИЦА «класс | предмет | минуты на номер / на параграф»
живёт здесь (константы ниже). Она же текстом (norm_table_text) уходит
в промпт ИИ-парсера — ИИ-оценка и офлайн-оценка (estimate_from_norms)
откалиброваны по одним числам.

Классификация «устный предмет по параграфам» (ORAL_PARA_SUBJECTS)
определяет доступность блиц-дуэли и логику стрика. Задания вида
«выучить §/параграф, ответить на вопросы» (PARA_STUDY_MARKERS) ведут
в дуэль независимо от предмета — это явная установка «выучить параграф».
"""
from __future__ import annotations

import hashlib
import re

WEEKDAYS_RU = [
    "понедельник", "вторник", "среда", "четверг",
    "пятница", "суббота", "воскресенье",
]
WEEKDAYS_EN = ["monday", "tuesday", "wednesday", "thursday",
               "friday", "saturday", "sunday"]

SUBJECTS = ["Алгебра", "Геометрия", "Русский язык", "Литература",
            "Физика", "История", "Биология", "География", "Английский язык"]

def stable_hash(value: str) -> int:
    """Детерминированный 32-битный хеш строки (sha256, первые 4 байта)."""
    digest = hashlib.sha256(value.encode("utf-8")).digest()
    return int.from_bytes(digest[:4], "big")

# ---------------------------------------------------------------------------
# Нормативная таблица: класс × предмет → минуты на единицу работы
# ---------------------------------------------------------------------------

# База для 8 класса: минуты на ОДИН номер / ОДИН параграф.
_BASE_EXERCISE_8 = 12   # номер, упражнение
_BASE_PARAGRAPH_8 = 25  # прочтение параграфа

_GRADE_FACTOR: dict[int, float] = {
    5: 0.7, 6: 0.8, 7: 0.9, 8: 1.0, 9: 1.1, 10: 1.2, 11: 1.25,
}

# Предметная группа → коэффициент (объём текстов, темп письменной работы).
_SUBJECT_GROUPS: dict[str, tuple[str, ...]] = {
    "math": ("алгебр", "геометри", "математик", "физик", "информатик"),
    "lang": ("русск", "английск", "немецк", "французск", "испанск"),
    "natural": ("биолог", "географ", "хими", "эколог", "астроном"),
    "humanities": ("истори", "обществознани", "литератур", "чтени"),
}
_GROUP_FACTOR: dict[str, float] = {
    "math": 1.0, "lang": 0.9, "natural": 1.0, "humanities": 1.15,
}

# Канонические предметы таблицы (колонки).
_TABLE_SUBJECTS: tuple[str, ...] = (
    "Алгебра", "Геометрия", "Физика", "Информатика",
    "Русский язык", "Английский язык",
    "Биология", "География", "Химия",
    "История", "Обществознание", "Литература",
)
_SUBJECT_GROUP_OF: dict[str, str] = {}
for _subj in _TABLE_SUBJECTS:
    for _g, _keys in _SUBJECT_GROUPS.items():
        if any(k in _subj.lower() for k in _keys):
            _SUBJECT_GROUP_OF[_subj] = _g
            break

# Устные предметы «на параграфах» — зона блиц-дуэли (по ТЗ: история,
# литература, география и другие, где в основе параграфы, а не номера).
ORAL_PARA_SUBJECTS: tuple[str, ...] = (
    "истори", "литератур", "географ", "биолог", "обществознани",
)

# Явные маркеры «выучить параграф / ответить на вопросы» — дуэль доступна
# и для письменных предметов: ученику нужно закрыть параграф, а не номера.
PARA_STUDY_MARKERS: tuple[str, ...] = (
    "выучить", "заучить", "ответить на вопрос", "ответить на в-сы",
    "вопросы после", "устный опрос",
)

_PARA_MARKER = re.compile(r"§|параграф\w*")
_NUM_MARKER = re.compile(r"№|упр\w*|упражнени\w*|задач\w*|задани\w*")
_UNIT_RE = re.compile(r"(\d+)(?:\s*[-–—]\s*(\d+))?")

def known_grade(grade: int | str | None) -> int | None:
    """Unknown is not grade 8. Legacy parse_grade remains API-compatible."""
    m = re.search(r"\d{1,2}", str(grade or ""))
    n = int(m.group()) if m else None
    return n if n in _GRADE_FACTOR else None

def parse_grade(grade: int | str | None) -> int:
    """«8А» / «8» / «8 класс» → 8. Вне диапазона 5–11 → дефолт 8."""
    m = re.search(r"\d{1,2}", str(grade or ""))
    n = int(m.group()) if m else 8
    return n if 5 <= n <= 11 else 8

def subject_of(title: str) -> str | None:
    """Канонический предмет таблицы по формулировке задания, или None."""
    t = (title or "").lower()
    for subj in _TABLE_SUBJECTS:
        if subj.lower()[:6] in t:
            return subj
    return None

def subjects_in(text: str) -> list[str]:
    """Все предметы таблицы, упомянутые в тексте (для проверки «одно задание — один предмет»)."""
    t = (text or "").lower()
    return [subj for subj in _TABLE_SUBJECTS if subj.lower()[:6] in t]

def _group_of(title: str) -> str:
    subj = subject_of(title)
    if subj:
        return _SUBJECT_GROUP_OF.get(subj, "math")
    for group, keys in _SUBJECT_GROUPS.items():
        if any(k in (title or "").lower() for k in keys):
            return group
    return "math"

def _round5(minutes: float) -> int:
    return max(5, min(600, int(minutes / 5 + 0.5) * 5))

def _units_in(segment: str) -> int:
    """Число единиц в сегменте: «387, 388» → 2; «355–357» → 3."""
    total = 0
    for m in _UNIT_RE.finditer(segment):
        start = int(m.group(1))
        end = int(m.group(2) or start)
        if 0 < start <= 9999 and end >= start:
            total += min(10, end - start + 1)  # защита от «стр. 5–200»
    return total

def _marker_units(text: str, marker_re: re.Pattern[str]) -> int:
    """Сумма единиц после каждого маркера (до следующего маркера)."""
    # Сегмент маркера заканчивается на следующем маркере ЛЮБОГО типа:
    # иначе в «§13, упр. 355–357» номера упражнений засчитывались бы ещё и
    # как параграфы (135 мин вместо 60).
    boundaries = sorted(b.start() for r in (_PARA_MARKER, _NUM_MARKER)
                        for b in r.finditer(text))
    total = 0
    for m in marker_re.finditer(text):
        seg_end = next((b for b in boundaries if b >= m.end()), len(text))
        total += _units_in(text[m.end():seg_end])
    return total

def _kind_of(t: str) -> str:
    if any(k in t for k in ("сочинени", "эссе", "реферат", "доклад", "проект")):
        return "essay"
    if any(k in t for k in ("выучить", "наизусть", "заучить")):
        return "memorize"
    if any(k in t for k in ("пересказ", "перескажи", "прочитать", "прочтени",
                            "читать")):
        return "retell"
    if "§" in t or "параграф" in t:
        return "paragraph"
    return "exercise"

def estimate_from_norms(title: str, grade: int | str | None = 8) -> int:
    """Оценка минут по таблице «класс × предмет × число единиц».

    «Алгебра, №387, 388» (8 кл.)     → 2 × 12 × 1.0            → 25 мин
    «Алгебра: §13, упр. 355–357»     → 25 + 3×12               → 60 мин
    «Литература: пересказ глав 2–3»  → 25 × 1.15               → 30 мин
    """
    g = known_grade(grade)
    if g is None:
        from app.scheduler import estimate_minutes
        return estimate_minutes(title)
    t = (title or "").lower()
    group = _group_of(title)
    gf = _GRADE_FACTOR.get(g, 1.0)
    grp = _GROUP_FACTOR.get(group, 1.0)

    minutes = 0.0
    paras = _marker_units(t, _PARA_MARKER)
    nums = _marker_units(t, _NUM_MARKER)
    if paras:
        minutes += paras * _BASE_PARAGRAPH_8 * gf * grp
    if nums:
        minutes += nums * _BASE_EXERCISE_8 * gf * grp
    if minutes <= 0:
        kind = _kind_of(t)
        base = {"essay": 50.0, "memorize": 35.0}.get(
            kind,
            _BASE_PARAGRAPH_8 if kind in ("paragraph", "retell")
            else _BASE_EXERCISE_8,
        )
        minutes = base * gf * grp
    return _round5(minutes)

def norm_table_text(grade: int | None = None) -> str:
    """Таблица «класс | предмет | № мин | § мин» — уходит в промпт ИИ.

    Именно эти числа ИИ использует для planned_minutes; офлайн-фоллбек
    считает по тем же константам (estimate_from_norms) — расхождений нет.
    grade=None — все классы 5–11 (документация, тесты); grade=N — только
    строки класса ученика (v15: промпт парсера на ~2,7 тыс. символов короче,
    остальные строки модели не нужны).
    """
    header = "| Класс | Предмет | №/упражнение, мин | §/параграф, мин |"
    sep = "|---|---|---|---|"
    rows: list[str] = []
    grades = range(5, 12) if grade is None else [parse_grade(grade)]
    for g in grades:
        gf = _GRADE_FACTOR[g]
        first = True
        for subj in _TABLE_SUBJECTS:
            group = _SUBJECT_GROUP_OF.get(subj, "math")
            ex = int(_BASE_EXERCISE_8 * gf * _GROUP_FACTOR[group] + 0.5)
            pa = int(_BASE_PARAGRAPH_8 * gf * _GROUP_FACTOR[group] + 0.5)
            if first:
                rows.append(f"| {g} | {subj} | {ex} | {pa} |")
                first = False
            else:
                rows.append(f"| | {subj} | {ex} | {pa} |")
    return "\n".join([header, sep] + rows)

# ---------------------------------------------------------------------------
# Классификация «устный предмет по параграфам» → доступность блиц-дуэли
# ---------------------------------------------------------------------------

def is_oral_para_subject(title: str) -> bool:
    """Предмет, где в основе параграфы (история, лит-ра, география…)."""
    t = (title or "").lower()
    return any(k in t for k in ORAL_PARA_SUBJECTS)

def task_blitz_eligible(title: str, task_type: str) -> bool:
    """Дуэль доступна: устным предметам «на параграфах» И любому заданию
    с явным «выучить / ответить на вопросы» (даже письменному предмету).

    «Литература: пересказ глав 2–3»            → True
    «История: выучить §5, ответить на вопросы» → True (written)
    «Алгебра: №387»                            → False
    «Физика: §14, упр. 12»                     → False (нет маркеров заучивания)
    """
    t = (title or "").lower()
    if any(m in t for m in PARA_STUDY_MARKERS):
        return True
    return task_type == "oral" and is_oral_para_subject(title)