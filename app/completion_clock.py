"""Optional FINAL completion clock. Old clients retain their V29 contract.
Late prior-day events require reconciliation, not silent credit to receive-day.
"""
from datetime import datetime, timezone
from app.day_engine import resolve_clock, school_date


def completion_day(payload: dict, *, now: datetime | None = None, school_tz: str | None = None):
    if 'study_day' not in payload:
        return None
    offset = payload.get('offset_minutes')
    if type(offset) is not int or not -840 <= offset <= 840:
        raise ValueError('Некорректный часовой пояс завершения')
    try:
        occurred = datetime.fromisoformat(str(payload['occurred_at']).replace('Z','+00:00'))
        if occurred.tzinfo is None: raise ValueError()
        now = now or datetime.now(timezone.utc)
        if (occurred-now).total_seconds() > 300: raise ValueError()
        event_day = school_date(resolve_clock(occurred.isoformat(),offset,school_tz)['now_local'])[0]
        current_day = school_date(resolve_clock(now.isoformat(),offset,school_tz)['now_local'])[0]
        if payload['study_day'] != event_day: raise ValueError()
    except (KeyError, TypeError, ValueError, OverflowError) as exc:
        raise ValueError('Некорректное время завершения') from exc
    if event_day != current_day:
        raise LookupError('Завершение прошлого учебного дня сохранено на устройстве и требует сверки')
    return datetime.fromisoformat(event_day).date()
