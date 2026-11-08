"""Учительский контур: тепловая карта класса и расписание на день.

Доступ проверяется в main.py по роли, которую определяет сервер (resolve_role): подпись MAX +
справочник школы или одноразовое приглашение, либо токен демо-песочницы. Заголовок X-User-Role —
только синтетический стенд профиля test (v2.4 Step 1). Здесь только генерация контрактов.
"""
from __future__ import annotations

from typing import Any

from app import mock_diary

def heatmap() -> dict[str, Any]:
    return mock_diary.heatmap()

def day_schedule() -> dict[str, Any]:
    return mock_diary.teacher_day()