"""Входящие задания от бота MAX → Mini App.

Бот (app/bot.py) разбирает домашку, присланную в чат, и кладёт задачи сюда по
user_id вида «max:<id>» — тем же, что Mini App шлёт в X-User-Id (берёт из
window.WebApp.initDataUnsafe.user.id). initial-state подмешивает их к дневнику
с source="bot", поэтому открывший приложение по кнопке видит задания сразу.

Хранение — JSON рядом с progress.json, атомарная запись (tmp + os.replace).
Файл перечитывается на каждый запрос: бот и API могут жить в разных процессах.
"""
from __future__ import annotations

import json
import os
from datetime import date
from pathlib import Path
from typing import Any

from app.config import SFERUM_DATA_DIR
from app.progress import quarantine
from app.json_storage import file_lock, atomic_json

INBOX_FILE = Path(SFERUM_DATA_DIR) / "inbox.json"
MAX_TASKS_PER_DAY = 30

def _read(path: Path) -> dict[str, Any]:
    try:
        if path.exists():
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
            quarantine(path)  # v15: не затирать повреждённый файл следующей записью
    except ValueError:
        quarantine(path)
    return {}

def _write(path: Path, data: dict[str, Any]) -> None:
    atomic_json(path, data)

def add(user_id: str, tasks: list[dict[str, Any]], *, path: Path | None = None,
        today: date | None = None) -> int:
    """Добавляет задачи пользователю на сегодня (дедуп по title). Возвращает число новых."""
    p = path or INBOX_FILE
    day = (today or date.today()).isoformat()
    with file_lock(p):
        data = _read(p)
        user = data.setdefault(user_id, {})
        # чистим прошлые дни — инбокс живёт один день
        for d in [k for k in user if k != day]:
            user.pop(d, None)
        bucket: list[dict[str, Any]] = user.setdefault(day, [])
        titles = {t.get("title") for t in bucket}
        added = 0
        for t in tasks:
            title = str(t.get("title", "")).strip()
            if not title or title in titles or len(bucket) >= MAX_TASKS_PER_DAY:
                continue
            bucket.append({k: t[k] for k in ("title", "type", "deadline", "planned_minutes", "blitz_eligible") if k in t})
            titles.add(title)
            added += 1
        _write(p, data)
        return added

def today_tasks(user_id: str, *, path: Path | None = None, today: date | None = None) -> list[dict[str, Any]]:
    day = (today or date.today()).isoformat()
    p = path or INBOX_FILE
    with file_lock(p):
        return list(_read(p).get(user_id, {}).get(day, []))
