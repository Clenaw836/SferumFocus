"""v2.2 · Отметки СГО: одна функция разбора для среднего балла, плана исправления, «Что, если…» и уведомлений.

Раньше было три разных разбора: ``_numeric_grade`` (средний балл) превращал «4-» в 4, но терял «5/4»;
``grade_recovery_trajectory`` читал «5/4» как дробь Fraction("5/4") = 1.25 и портил план исправления;
фронтенд пропускал и «5/4», и «4-». Теперь правило одно (паритет с frontend/src/lib/gradeTarget.ts::marksOf):

* «5», «4», 3, 4.5 — обычная отметка в диапазоне 1…5;
* «5/4» (до трёх частей) — двойная отметка за одну работу (например, содержание и грамотность):
  каждая часть входит в средний с весом работы — так её считает и журнал СГО;
* «4-», «5+» — плюс/минус не меняет балл отметки;
* «Н», «Б», «УП», «ОСВ», «Зач», «Незач», «н/а», «ОП», «Ув», «долг» … — текстовые отметки (пропуск, болезнь,
  зачёт, освобождение, задолженность): показываются как есть и в средний не входят;
* вес работы: пусто → 1; число 0 < w ≤ 1000 (до трёх знаков после запятой) → w; 0, отрицательный, логический
  или битый вес → работа в средний не входит (а не «подставляем 1»).
"""
from __future__ import annotations

import re
from fractions import Fraction
from typing import Any, Iterable

__all__ = ["marks_of", "weight_of", "weighted_average", "is_low", "is_text_mark", "TEXT_MARKS"]

_DEC = re.compile(r"^\d{1,4}(?:[.,]\d{1,3})?$")
_PART = re.compile(r"^(\d{1,4}(?:[.,]\d{1,3})?)[+-]?$")
_SPLIT = re.compile(r"\s*/\s*")
# Только для подписи в интерфейсе и тестов: в средний не входит любая нечисловая отметка, не только эти.
TEXT_MARKS = frozenset({"н", "нб", "б", "уп", "ув", "осв", "зач", "зачёт", "зачет", "незач", "н/а", "на", "оп", "нп",
                        "долг", "•", "-", "отс"})


def _decimal(text: str) -> Fraction | None:
    return Fraction(text.replace(",", ".")) if _DEC.match(text) else None


def marks_of(value: Any) -> list[Fraction]:
    """Числовые части отметки (1…5). Пустой список — отметка в средний не входит."""
    if value is None or isinstance(value, bool):
        return []
    if isinstance(value, (int, float)):
        value = str(value)
    if not isinstance(value, str):
        return []
    text = value.strip()
    if not text or len(text) > 32:
        return []
    parts = _SPLIT.split(text)
    if len(parts) > 3:
        return []
    out: list[Fraction] = []
    for part in parts:
        m = _PART.match(part)
        if not m:
            return []                      # «5/Н», «зачёт», «6+» — не число, в средний не входит
        n = _decimal(m.group(1))
        if n is None or not 1 <= n <= 5:
            return []
        out.append(n)
    return out


def weight_of(raw: Any) -> Fraction | None:
    """Вес работы: пусто → 1; иначе 0 < w ≤ 1000. None — работа не учитывается."""
    if raw is None or raw == "":
        return Fraction(1)
    if isinstance(raw, bool):
        return None
    if isinstance(raw, (int, float)):
        raw = str(raw)
    if not isinstance(raw, str):
        return None
    w = _decimal(raw.strip())
    return w if w is not None and 0 < w <= 1000 else None


def _item(grade: Any) -> dict[str, Any]:
    if hasattr(grade, "model_dump"):
        return grade.model_dump()
    return grade if isinstance(grade, dict) else {}


def weighted(grades: Iterable[Any]) -> tuple[Fraction, Fraction, int]:
    """(Σ отметка·вес, Σ вес, число учтённых отметок) — общая основа среднего и плана исправления."""
    total = Fraction(0)
    weight_sum = Fraction(0)
    count = 0
    for grade in grades:
        item = _item(grade)
        w = weight_of(item.get("weight"))
        if w is None:
            continue
        for mark in marks_of(item.get("value")):
            total += mark * w
            weight_sum += w
            count += 1
    return total, weight_sum, count


def weighted_average(grades: Iterable[Any]) -> float | None:
    total, weight_sum, count = weighted(grades)
    return round(float(total / weight_sum), 2) if count else None


def is_low(value: Any) -> bool:
    """«2», «3», «3-», «5/3» — повод предложить план исправления."""
    return any(m in (2, 3) for m in marks_of(value))


def is_text_mark(value: Any) -> bool:
    return isinstance(value, str) and value.strip().casefold() in TEXT_MARKS
