"""Профиль наград: на реальном движке progress.py.

Стрик, очки, уровень и достижения — настоящие, из событий
(task_done / duel_completed / plan_built / flashcard_used);
оценки по-прежнему из mock-дневника (дневник — отдельный контур).
"""
from __future__ import annotations

from typing import Any

from app.progress import STORE

def get_profile(user_id: str) -> dict[str, Any]:
    return STORE.profile(user_id)