"""Напоминание бота MAX о конце фокус-сессии.

Ученик нажал «Старт» и свернул MAX — таймер в мини-аппе не виден. Когда
запланированное время выходит, бот пишет в личный чат: «25 минут на Алгебру
вышли» + кнопка-диплинк startapp=focus, которая открывает тот же таймер.

Работает только для подписанного пользователя MAX (`max:<id>` из initData) и
при заданном MAX_BOT_TOKEN — иначе честно возвращает scheduled=false.
Хранение в памяти процесса: рестарт сервера = напоминание теряется (таймер
в приложении от этого не зависит — он считается по timestamp на устройстве).
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Awaitable, Callable

logger = logging.getLogger("sferumfocus.focus")

Sender = Callable[[int, str, list[dict[str, Any]]], Awaitable[None]]
MAX_DELAY = 4 * 3600


class Reminders:
    def __init__(self) -> None:
        self._tasks: dict[int, asyncio.Task[None]] = {}
        self.sender: Sender | None = None

    def _default_sender(self) -> Sender | None:
        from app import bot
        from app.config import MAX_BOT_TOKEN
        if not MAX_BOT_TOKEN:
            return None
        client = bot.MaxBot(MAX_BOT_TOKEN)
        return client.send

    def cancel(self, uid: int) -> bool:
        t = self._tasks.pop(uid, None)
        if t and not t.done():
            t.cancel()
            return True
        return False

    def schedule(self, uid: int, subject: str, delay: float) -> bool:
        send = self.sender or self._default_sender()
        if send is None:
            return False
        self.cancel(uid)
        delay = max(0.0, min(float(delay), MAX_DELAY))

        async def fire() -> None:
            try:
                await asyncio.sleep(delay)
                from app import bot
                await send(uid, f"⏱ Время на «{subject}» вышло. Закончил? Отметь — и вечер пересчитается.",
                           bot.keyboard("Открыть таймер", start="focus"))
            except asyncio.CancelledError:
                pass
            except Exception as exc:  # сеть/бот: напоминание — не критичный путь
                logger.warning("focus reminder failed: %s", exc)
            finally:
                if self._tasks.get(uid) is asyncio.current_task():
                    self._tasks.pop(uid, None)

        self._tasks[uid] = asyncio.get_running_loop().create_task(fire())
        return True

    def pending(self, uid: int) -> bool:
        t = self._tasks.get(uid)
        return bool(t and not t.done())


REMINDERS = Reminders()


def max_uid(user_id: str | None) -> int | None:
    """`max:123` → 123; всё остальное (демо, браузер) → None."""
    if not user_id or not user_id.startswith("max:"):
        return None
    try:
        return int(user_id[4:])
    except ValueError:
        return None
