"""Оценки по загруженному снимку, не заменяют итоговую отметку школы."""
from __future__ import annotations
from fractions import Fraction
from typing import Any, Iterable
from app.grade_marks import weighted


def needed(total: Fraction, weight: Fraction, count: int, target: Fraction, mark: int) -> int | None:
    """Сколько будущих отметок весом 1 доведут среднее до цели; None — недостижимо."""
    if not count:
        return None
    deficit = target * weight - total
    if deficit <= 0:
        return 0
    if mark <= target:
        return None
    n = deficit / (mark - target)
    return -(-n.numerator // n.denominator)


def analyze_snapshot(grades: Iterable[Any]) -> list[dict[str, Any]]:
    groups: dict[str, list[Any]] = {}
    for item in grades:
        row = item.model_dump() if hasattr(item, 'model_dump') else item
        if isinstance(row, dict) and isinstance(row.get('subject'), str) and row['subject'].strip():
            groups.setdefault(row['subject'], []).append(row)
    out = []
    for subject, marks in sorted(groups.items()):
        total, weight, count = weighted(marks)
        if not count:
            continue
        goals = []
        for name, threshold in ((4, Fraction(18, 5)), (5, Fraction(23, 5))):
            goals.append({'target_grade': name, 'assumed_threshold': float(threshold),
                          'fives_needed': needed(total, weight, count, threshold, 5),
                          'fours_needed': needed(total, weight, count, threshold, 4), 'future_weight': 1})
        out.append({'subject': subject, 'weighted_average': round(float(total / weight), 2),
                    'mark_count': count, 'weight_sum': float(weight), 'goals': goals,
                    'official_quarter_grade': None})
    return out
