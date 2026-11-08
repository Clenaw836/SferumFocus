"""Фасад дневника. Сейчас — mock-режим; точка расширения под живые
интеграции «Сетевого города» (diary_mode переключит контракт на «live»).

estimate_minutes импортирован из scheduler — единая точка оценок времени,
расхождений между парсером и планировщиком нет.
student_grade() отдаёт класс ученика из дневника — его использует
ИИ-оценка времени заданий (нормативная таблица в ai_engine).
initial_state аннотирует задачи blitz_eligible (устный предмет
«на параграфах» → дуэль доступна) — по классификации academic.py.
"""
from __future__ import annotations

from datetime import date
from typing import Any

from app import inbox, mock_diary, schedule
from app.academic import parse_grade, known_grade, task_blitz_eligible
from app.config import SFERUM_USE_MOCK
from app.scheduler import estimate_minutes  # noqa: F401  (реэкспорт единой точки)

__all__ = ["estimate_minutes", "initial_state", "student_grade",
           "student_grade_number"]

def student_grade() -> str:
    """Класс ученика из дневника («8А»)."""
    return mock_diary.GRADE

def student_grade_number(user_id: str | None = None) -> int | None:
    """Resolve from the authenticated account. No account: legacy demo callers."""
    if user_id is None:
        return known_grade(mock_diary.GRADE)
    return known_grade(initial_state(user_id).get("grade"))

def _annotated(tasks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for t in tasks:
        item = dict(t)
        item["blitz_eligible"] = task_blitz_eligible(
            item.get("title", ""), item.get("type", "written"))
        out.append(item)
    return out

def initial_state(user_id: str, day: date | None = None) -> dict[str, Any]:
    from app.platform_auth import enabled
    if enabled():
        return _platform_initial_state(user_id,day)
    if not SFERUM_USE_MOCK:
        # Живые интеграции не подключены: честно остаёмся в mock,
        # чтобы контракт фронта не нарушался.
        pass
    diary = _annotated(mock_diary.MOCK_TASKS)
    seen = {t["title"] for t in diary}
    from_bot = [dict(t, source="bot") for t in _annotated(inbox.today_tasks(user_id))
                if t.get("title") not in seen]
    return {
        "diary_mode": "mock",
        "diary_tasks": diary + from_bot,
        "settings": {
            "recommended_start": mock_diary.DEFAULT_SETTINGS["recommended_start"],
            "bedtime": mock_diary.DEFAULT_SETTINGS["bedtime"],
            "rest_slots": [dict(r) for r in mock_diary.DEFAULT_SETTINGS["rest_slots"]],
            "personal_activities": [
                dict(a) for a in mock_diary.DEFAULT_SETTINGS["personal_activities"]
            ],
            "recommended_bedtime": mock_diary.DEFAULT_SETTINGS["bedtime"],
            "wake_time": "06:45", "travel_minutes": 45, "prep_minutes": 15,
            "school_week_days": schedule.school_week_days(user_id),
        },
        # Школьный день — через провайдер расписания (база + подтверждённые изменения ученика)
        "school_day": schedule.school_day(user_id, day or date.today()),
        "schedule": schedule.ResolvedSchedule(user_id).info(),
        "school_name": mock_diary.SCHOOL_NAME,
        "grade": mock_diary.GRADE,
    }

def _platform_initial_state(user_id: str, day: date | None = None) -> dict[str, Any]:
    """Same facade and bot merge; never use fake school data in live/manual mode."""
    from app.platform_auth import store
    from app.diary_vault import EncryptedDiaryVault
    from app.models import TaskItem, LessonSlot
    with store().tx() as db:
        row=db.execute('SELECT uid FROM accounts WHERE data_key=?',(user_id,)).fetchone()
    if not row:
        raise ValueError('Verified account required')
    vault=EncryptedDiaryVault(store());connection=vault.get(row[0])
    demo=(connection and connection['provider']=='demo') or (not connection and SFERUM_USE_MOCK)
    from app.diary_cache import cache_metadata
    cache=cache_metadata(connection)
    snapshot=connection['snapshot'] if connection else {}
    tasks=[TaskItem.model_validate(t).model_dump() for t in snapshot.get('tasks',[])] if connection else []
    if demo:tasks=[dict(t) for t in mock_diary.MOCK_TASKS]
    seen={t['title'] for t in tasks}
    tasks += [dict(t,source='bot') for t in inbox.today_tasks(user_id) if t.get('title') not in seen]
    target=day or date.today()
    lessons=[LessonSlot.model_validate(t).model_dump() for t in snapshot.get('lessons',[])] if snapshot.get('school_date')==target.isoformat() else []
    return {
        'diary_mode':'mock' if demo else 'live' if connection and connection['provider']=='netschool' else 'manual',
        'diary_status':'demo' if demo else connection['status'] if connection else 'unsupported_manual',
        'diary_provider':connection['provider'] if connection else None,
        'diary_portal':connection.get('portal') if connection else None,
        'is_stale':cache['is_stale'],'last_synced_at':cache['last_synced_at'],
        'snapshot_available':cache['snapshot_available'],
        'bell_schedule_present':snapshot.get('bell_schedule_present',False) if not demo else False,
        'diary_tasks':_annotated(tasks),
        'settings':{**mock_diary.DEFAULT_SETTINGS,'personal_activities':mock_diary.DEFAULT_SETTINGS['personal_activities'] if demo else [],'recommended_bedtime':mock_diary.DEFAULT_SETTINGS['bedtime'],'wake_time':'06:45','travel_minutes':45,'prep_minutes':15,'school_week_days':schedule.school_week_days(user_id)},
        'school_day':schedule.school_day(user_id,target),
        'schedule':schedule.ResolvedSchedule(user_id).info(),
        'school_name':mock_diary.SCHOOL_NAME if demo else snapshot.get('school_name') or None,
        'grade':mock_diary.GRADE if demo else snapshot.get('grade') or None,
    }


def subject_averages(user_id: str) -> list[dict]:
    """Weighted means over loaded provider marks; no fabricated progress grades."""
    from app.platform_auth import enabled,store
    if not enabled():return mock_diary.grades(user_id)
    with store().tx() as db:row=db.execute('SELECT uid FROM accounts WHERE data_key=?',(user_id,)).fetchone()
    if not row:return []
    from app.diary_vault import EncryptedDiaryVault
    from app.grade_watcher import subject_recovery
    conn=EncryptedDiaryVault(store()).get(row[0])
    if conn and conn['provider']=='demo':return mock_diary.grades(user_id)
    if not conn or conn['status'] in {'revoked','reauth_required'}:return []
    plans=subject_recovery(conn['snapshot'].get('grades',[]))
    return [{'subject':s,'average':p['average'],'trend':'flat'} for s,p in sorted(plans.items()) if p]
