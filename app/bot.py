"""Бот MAX для «СферумФокус»: вход в продукт прямо из мессенджера.

Сценарий: ученик пересылает боту домашку из чата класса (текст или фото) →
бот разбирает задания тем же ИИ-слоем, что и Mini App, оценивает время по
нормативной таблице и кладёт задачи в app.inbox → отвечает списком и кнопкой
«Построить план дня» (диплинк https://max.ru/<bot>?startapp=plan). Mini App
открывается сразу с этими заданиями и собирает план.

Запуск:  MAX_BOT_TOKEN=... MAX_BOT_NAME=... python -m app.bot
Транспорт: MAX_BOT_MODE=polling только для demo/test; production webhook
работает в FastAPI lifespan. Inbox/Outbox — зашифрованный SQLite на сервере.

Используются задокументированные методы Bot API (dev.max.ru/docs-api):
GET /updates (marker, timeout, types), POST /messages?user_id=…,
вложение inline_keyboard с кнопкой type="link".
"""
from __future__ import annotations

import asyncio
import base64
import logging
import os
from typing import Any

import httpx

from app import ai_engine, diary_service, inbox
from app.config import MAX_API_BASE, MAX_BOT_NAME, MAX_BOT_TOKEN

logger = logging.getLogger("sferumfocus.bot")

WELCOME = (
    "Привет! Я СферумФокус.\n\n"
    "Перешли мне домашку из чата класса — текстом или фото доски. "
    "Я разберу задания, посчитаю время по нормативам и соберу вечер: "
    "ты сразу увидишь, во сколько освободишься.\n\n"
    "/blitz — блиц-дуэль на минуту, /demo — демо-вечер."
)

def app_link(start: str = "plan") -> str | None:
    return f"https://max.ru/{MAX_BOT_NAME}?startapp={start}" if MAX_BOT_NAME else None

def keyboard(text: str, start: str = "plan") -> list[dict[str, Any]]:
    url = app_link(start)
    if not url:
        return []
    return [{"type": "inline_keyboard",
             "payload": {"buttons": [[{"type": "link", "text": text, "url": url}]]}}]

def format_tasks(tasks: list[dict[str, Any]]) -> str:
    total = sum(int(t.get("planned_minutes") or 0) for t in tasks)
    h, m = divmod(total, 60)
    dur = f"{h} ч {m} мин" if h and m else (f"{h} ч" if h else f"{m} мин")
    lines = [f"Принял: {len(tasks)} · ≈ {dur}"]
    for t in tasks[:8]:
        mark = " · можно закрыть дуэлью" if t.get("blitz_eligible") else ""
        lines.append(f"• {t['title']} — {t.get('planned_minutes', 20)} мин{mark}")
    lines.append("\nОткрой «План дня» — план уже собран.")
    return "\n".join(lines)

def homework_card(account_key: str, today=None) -> str | None:
    """v3.2 · карточка ДЗ при открытии бота: ближайшие 3 дня со сроками из подключённого дневника
    (и задания, присланные боту). Демо-дневник не показываем — ученик ещё ничего не подключал."""
    from datetime import date as _date
    try:
        st = diary_service.initial_state(account_key, None)
    except Exception:  # noqa: BLE001 — карточка необязательна: приветствие уйдёт и без неё
        return None
    if st.get("diary_mode") == "mock":
        return None
    today = today or _date.today()
    by: dict[str, list[dict[str, Any]]] = {}
    for t in st.get("diary_tasks") or []:
        d = str(t.get("deadline") or "")[:10]
        if len(d) == 10 and d >= today.isoformat() and t.get("title"):
            by.setdefault(d, []).append(t)
    if not by:
        return None
    wd = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"]
    lines = ["📚 Домашние задания"]
    for d in sorted(by)[:3]:
        day = _date.fromisoformat(d)
        rel = "Сегодня" if day == today else "Завтра" if (day - today).days == 1 else wd[day.weekday()].capitalize()
        lines.append(f"\n{rel}, {day.day:02d}.{day.month:02d}")
        for t in by[d][:5]:
            lines.append(f"• {str(t['title'])[:120]} — {int(t.get('planned_minutes') or 20)} мин")
        if len(by[d]) > 5:
            lines.append(f"…и ещё {len(by[d]) - 5}")
    lines.append("\nВсе задания — в «Плане дня».")
    return "\n".join(lines)

class MaxBot:
    def __init__(self, token: str, base: str = MAX_API_BASE, *, queue=None, client=None) -> None:
        from app.max_transport import api_client
        self.http = client if client is not None else api_client(token, base)
        self.queue = queue

    async def send(self, user_id: int, text: str, attachments: list[dict[str, Any]] | None = None) -> None:
        from app.max_transport import CURRENT_EVENT
        if self.queue is None:
            raise RuntimeError("MAX durable queue is not configured")
        event = CURRENT_EVENT.get()
        key = None
        if event is not None:
            key = f"event-{event[0]}-{event[1]}"
            event[1] += 1
        self.queue.enqueue(user_id, text, attachments, key=key)

    async def handle(self, upd: dict[str, Any]) -> None:
        kind = upd.get("update_type")
        if kind == "bot_started":
            uid = (upd.get("user") or {}).get("user_id")
            if uid:
                await self.send(uid, WELCOME, keyboard("Открыть СферумФокус"))
                await self._homework(uid)
            return
        if kind != "message_created":
            return
        msg = upd.get("message") or {}
        uid = (msg.get("sender") or {}).get("user_id")
        body = msg.get("body") or {}
        if not uid:
            return
        text = (body.get("text") or "").strip()
        images = [a for a in (body.get("attachments") or []) if a.get("type") == "image"]
        if text.lower() in {"/start", "старт", "привет"} and not images:
            await self.send(uid, WELCOME, keyboard("Открыть СферумФокус"))
            await self._homework(uid)
            return
        if text.lower() in {"/dz", "/hw", "дз", "домашка"} and not images:
            card = homework_card(_account_key(uid))
            await self.send(uid, card or "Сроков сдачи в дневнике нет. Подключи «Сетевой Город» в мини-приложении или пришли задание сюда текстом или фото.",
                            keyboard("Открыть план дня"))
            return
        if text.lower() in {"/blitz", "блиц"} and not images:
            await self.send(uid, "⚡ Блиц-дуэль: 5 вопросов по теме вечера, 15 секунд на ответ. Побей свой рекорд — или брось вызов классу.",
                            keyboard("Начать блиц", start="blitz"))
            return
        if text.lower() in {"/demo", "демо"} and not images:
            # Сценический прогон: чистый день, без сети (startapp=demo → ?demo в мини-аппе)
            await self.send(uid, "Демо-вечер: 4 задания из чата 8А. Нажми «Построить план дня» — и смотри на солнце.",
                            keyboard("Открыть демо", start="demo"))
            return
        try:
            tasks = await self.parse(uid, text, images)
        except ai_engine.ContentFlaggedError as exc:
            await self.send(uid, f"Не засчитано — {exc.reason}. Перепиши без этого, и я разберу.")
            return
        except ai_engine.RateLimitError as exc:
            await self.send(uid, f"Слишком часто. Подожди {exc.retry_after} с и пришли ещё раз.")
            return
        except (ai_engine.HomeworkParseError, ai_engine.AIServiceError) as exc:
            await self.send(uid, f"Не разобрал: {exc}. Пример: «Алгебра №387, 388; история §8».")
            return
        if not tasks:
            await self.send(uid, "Заданий не нашёл. Напиши предмет и номера, например: «Физика §14, упр. 12».")
            return
        inbox.add(_account_key(uid), tasks)
        await self.send(uid, format_tasks(tasks), keyboard("Построить план дня"))

    async def _homework(self, uid: int) -> None:
        try:
            card = homework_card(_account_key(uid))
        except Exception:  # noqa: BLE001
            card = None
        if card:
            await self.send(uid, card, keyboard("Открыть план дня"))

    async def parse(self, uid: int, text: str, images: list[dict[str, Any]]) -> list[dict[str, Any]]:
        grade = diary_service.student_grade_number(_account_key(uid))
        if images:
            if not ai_engine.has_key():
                raise ai_engine.HomeworkParseError("фото распознаёт ИИ, а ключ на сервере не задан — пришли текстом")
            url = (images[0].get("payload") or {}).get("url")
            if not url or not str(url).startswith("https://"):
                raise ai_engine.HomeworkParseError("не получил файл фото")
            async with httpx.AsyncClient(timeout=30) as c:
                r = await c.get(url)
                r.raise_for_status()
                raw = r.content
                if len(raw) > 8 * 1024 * 1024:
                    raise ai_engine.HomeworkParseError("фото слишком большое — пришли текстом")
            return await ai_engine.parse_homework_input(
                media_type="photo", base64=base64.b64encode(raw).decode(), mime="image/jpeg",
                grade=grade, user_id=_account_key(uid))
        if not text:
            return []
        return await ai_engine.parse_homework_input(
            media_type="voice", text=text, grade=grade, user_id=_account_key(uid))

    async def run(self) -> None:
        from app.max_transport import MaxRuntime
        if os.getenv('MAX_BOT_MODE', 'disabled') != 'polling':
            raise ValueError('For local polling set MAX_BOT_MODE=polling; webhook runs in the API')
        if os.getenv('SFERUM_ENV', 'production') not in {'test', 'demo'}:
            raise ValueError('Production MAX delivery requires webhook mode')
        if self.queue is None:
            raise ValueError('Encrypted MAX queue required')
        runtime = MaxRuntime(self, self.queue)
        tasks = []
        try:
            runtime.acquire()
            r = await self.http.get('/subscriptions')
            r.raise_for_status()
            data = r.json()
            if data.get('success') is False or 'subscriptions' not in data:
                raise ValueError('Cannot verify MAX subscription state')
            if data['subscriptions']:
                raise ValueError('Disable the existing MAX webhook before polling')
            tasks = [asyncio.create_task(runtime.events()) for _ in range(4)] + [asyncio.create_task(runtime.sends())]
            while True:
                try:
                    params: dict[str, Any] = {'timeout': 30, 'types': 'message_created,bot_started'}
                    marker = self.queue.marker()
                    if marker is not None:
                        params['marker'] = marker
                    r = await self.http.get('/updates', params=params)
                    r.raise_for_status()
                    data = r.json()
                    for update in data.get('updates') or []:
                        self.queue.accept(update)
                    # Advance only after every event was committed. A crash before
                    # this write replays harmlessly through the inbox deduplicator.
                    if data.get('marker') is not None:
                        self.queue.marker(data['marker'])
                except (httpx.HTTPError, ValueError):
                    logger.warning('MAX poll failed; details omitted, retrying')
                    await asyncio.sleep(3)
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            await runtime.close()

def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    if not MAX_BOT_TOKEN:
        raise SystemExit("Задай MAX_BOT_TOKEN (платформа MAX для партнёров → Чат-боты → Настройки)")
    from app.max_transport import configured_runtime
    asyncio.run(configured_runtime().bot.run())


def format_grade_notification(event: dict, private: bool = False) -> str:
    """Telegram-safe HTML; grades/school text cannot inject markup."""
    from html import escape
    if event.get('kind')=='new_homework':
        total=int(event.get('total') or len(event.get('tasks') or []))
        if private:
            return f'📚 <b>Новое домашнее задание: {total}</b>\nПодробности — в мини-приложении.'
        lines=[f'📚 <b>Новое домашнее задание{f": {total}" if total>1 else ""}</b>']
        for t in (event.get('tasks') or [])[:5]:
            d=str(t.get('deadline') or '')
            due=f' — до {d[8:10]}.{d[5:7]}' if len(d)>=10 else ''
            lines.append('• '+escape(str(t.get('title') or ''))+due)
        if total>5:lines.append(f'…и ещё {total-5} — в мини-приложении')
        return '\n'.join(lines)
    if private:
        return '🔔 <b>В дневнике новое событие</b>\nПодробности — в мини-приложении.'
    grade=event['grade'];old=event.get('previous')
    title='🌟 Новая оценка' if event['kind']=='new_grade' else f'🔄 Оценка изменена (было {escape(str(old))} → стало {escape(str(grade["value"]))})'
    d=str(grade.get('date') or '')
    lines=[f'<b>{title}</b>',f'Урок: {escape(grade["subject"])} · <b>{escape(str(grade["value"]))}</b>',
           escape(f'{d[8:10]}.{d[5:7]}.{d[:4]}' if len(d)>=10 else d)]
    if grade.get('work_type'):lines.append('Работа: '+escape(grade['work_type']))
    if grade.get('topic'):lines.append('Тема: '+escape(grade['topic']))
    if grade.get('average') is not None:lines.append('Средний балл: '+escape(str(grade['average'])))
    from app.grade_watcher import is_low_grade
    plan=event.get('recovery_plan')
    if plan and is_low_grade(grade['value']):
        k=plan['fives_needed'];r=k%100
        word='оценок' if 11<=r<=14 else 'оценка' if k%10==1 else 'оценки' if 2<=k%10<=4 else 'оценок'
        lines.append(f'🌱 Всё поправимо. По загруженным оценкам средний балл {plan["average"]:.2f}. Для {plan["target"]:.2f} нужно ещё {k} {word} «5» весом 1. Это расчёт, не обещание итоговой оценки.')
    return '\n'.join(lines)


def _account_key(uid: int) -> str:
    from app.platform_auth import enabled,store
    principal=f"max:{uid}"
    return store().identity(principal,used=True)['data_key'] if enabled() else principal

if __name__ == "__main__":
    main()

