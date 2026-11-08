"""P0 MAX: приёмник обезличенных сигналов загрузки (POST /api/v1/diagnostics/boot).

Шлёт его ES5-сторож frontend/src/bootguard.js, когда мини-приложение не дошло до интерфейса
(бандл не разобрался, CSP, зависание, экран восстановления) и один раз за сессию — при успешном запуске
внутри MAX. Зачем: в инциденте «Техническая заминка» сервер видел только GET / и /favicon.ico,
и было невозможно понять, на каком этапе остановился клиент.

Гарантии:
• стоит СНАРУЖИ слоёв авторизации: не требует и не принимает личность, ничего не читает и не пишет в БД;
• тело ≤ 2 КиБ, только JSON-объект; каждое поле — из белого списка (перечисление/regex/диапазон),
  всё прочее отбрасывается — в журнал не попадают initData, токены, имена, полный User-Agent, IP;
• лимит частоты: на адрес клиента и общий (скользящее окно), сверх — 429 без записи в журнал;
• одна строка журнала `boot_diag …` без переводов строк (защита от инъекций в лог);
• SFERUM_BOOT_DIAGNOSTICS=0 — выключатель (запрос уходит дальше и получает обычный 404/405).
"""
from __future__ import annotations

import json
import logging
import os
import re
import time
from collections import OrderedDict, deque

PATH = "/api/v1/diagnostics/boot"
MAX_BODY = 2048
PER_CLIENT, PER_CLIENT_WINDOW = 20, 60.0
GLOBAL, GLOBAL_WINDOW = 600, 3600.0
log = logging.getLogger("uvicorn.error")

_ENUMS = {
    "kind": {"fallback", "recovery", "slow", "ok"},
    "stage": {"guard", "bundle", "bridge", "launch", "session", "verify", "role", "render", "done"},
    "platform": {"", "ios", "android", "desktop", "web", "other"},
    "launch": {"none", "hash", "storage"},
    "err": {"", "header", "syntax", "reference", "type", "range", "other", "csp"},
    "res": {"", "bridge", "telegram", "script", "thirdparty", "csp"},
}
_PATTERNS = {
    "v": re.compile(r"^(?:[0-9a-f]{6,16}|__SF_BUILD__|dev)$"),
    "id": re.compile(r"^[0-9A-F]{8}$"),
    "code": re.compile(r"^[a-z_]{0,32}$"),
    "ua": re.compile(r"^[a-z0-9-]{0,40}$"),
}
_INTS = {"inmax": (0, 1), "iframe": (0, 1), "bridge": (0, 1), "handler": (0, 1), "ascii": (-1, 1), "len": (0, 4), "rfb": (0, 1),
         "ready": (-1, 600000), "ms": (0, 600000), "errors": (0, 1000)}
_ORDER = ("kind", "stage", "code", "platform", "inmax", "iframe", "bridge", "handler", "launch", "ascii", "len",
          "ready", "rfb", "ms", "errors", "err", "res", "ua", "v", "id")


def sanitize(payload: object) -> dict | None:
    """Белый список полей. None — тело не похоже на сигнал сторожа (не объект/нет kind+id)."""
    if not isinstance(payload, dict):
        return None
    out: dict[str, object] = {}
    for key, allowed in _ENUMS.items():
        value = payload.get(key, "")
        if isinstance(value, str) and value in allowed:
            out[key] = value
        elif key != "kind":
            out[key] = "invalid"
    for key, rx in _PATTERNS.items():
        value = payload.get(key, "")
        out[key] = value if isinstance(value, str) and rx.match(value) else "invalid"
    for key, (lo, hi) in _INTS.items():
        value = payload.get(key)
        out[key] = value if type(value) is int and lo <= value <= hi else "invalid"
    if "kind" not in out or out["id"] == "invalid":
        return None
    return out


def line(fields: dict) -> str:
    return "boot_diag " + " ".join(f"{k}={fields[k]}" for k in _ORDER if k in fields)


class _Window:
    def __init__(self) -> None:
        self.clients: OrderedDict[str, deque] = OrderedDict()
        self.total: deque = deque()

    def allow(self, client: str, now: float) -> bool:
        while self.total and now - self.total[0] > GLOBAL_WINDOW:
            self.total.popleft()
        hits = self.clients.get(client)
        if hits is None:
            hits = self.clients[client] = deque()
            while len(self.clients) > 2048:  # ограниченная память: вытесняем самого старого клиента
                self.clients.popitem(last=False)
        else:
            self.clients.move_to_end(client)
        while hits and now - hits[0] > PER_CLIENT_WINDOW:
            hits.popleft()
        if len(hits) >= PER_CLIENT or len(self.total) >= GLOBAL:
            return False
        hits.append(now)
        self.total.append(now)
        return True


class BootDiagnostics:
    """ASGI-middleware: обрабатывает ровно POST /api/v1/diagnostics/boot, остальное — без изменений."""

    def __init__(self, app, enabled: bool | None = None, clock=time.monotonic):
        self.app, self.clock, self.window = app, clock, _Window()
        self.enabled = (os.getenv("SFERUM_BOOT_DIAGNOSTICS", "1").strip().lower() not in {"0", "false", "no", "off"}) if enabled is None else enabled

    async def __call__(self, scope, receive, send):
        if not (self.enabled and scope["type"] == "http" and scope["path"] == PATH and scope["method"] == "POST"):
            return await self.app(scope, receive, send)
        for k, v in scope.get("headers", []):
            if k.lower() == b"content-length":
                try:
                    if int(v) > MAX_BODY:
                        return await _reply(send, 413)
                except ValueError:
                    return await _reply(send, 400)
        body, more = b"", True
        while more:
            message = await receive()
            if message["type"] != "http.request":
                return
            body += message.get("body", b"")
            more = message.get("more_body", False)
            if len(body) > MAX_BODY:
                return await _reply(send, 413)
        client = (scope.get("client") or ("unknown", 0))[0] or "unknown"
        if not self.window.allow(str(client), self.clock()):
            return await _reply(send, 429)
        try:
            fields = sanitize(json.loads(body.decode("utf-8")))
        except (UnicodeDecodeError, ValueError):
            fields = None
        if fields is None:
            return await _reply(send, 400)
        log.warning(line(fields))
        return await _reply(send, 204)


async def _reply(send, status: int) -> None:
    await send({"type": "http.response.start", "status": status,
                "headers": [(b"cache-control", b"no-store"), (b"content-length", b"0")]})
    await send({"type": "http.response.body", "body": b""})
