"""Проверка подписи стартовых данных MAX (window.WebApp.initData).

Алгоритм — дословно по https://dev.max.ru/docs/webapps/validation:
  1) разобрать initData (key=value&…), hash — ровно один раз, исключить;
  2) URL-декодировать значения, отсортировать по ключу, склеить «k=v» через \\n;
  3) secret_key = HMAC_SHA256(key="WebAppData", msg=BOT_TOKEN);
  4) hex(HMAC_SHA256(key=secret_key, msg=launch_params)) == hash.
auth_date старше max_age (по докам рекомендуют 1 час) — отклоняем.

Подключение — ASGI-middleware: фронт шлёт initData в заголовке X-Max-Init-Data.
• подпись верна → X-User-Id подменяется на «max:<user.id>» (клиенту больше не верим);
• подпись неверна/просрочена → 401;
• заголовка нет → демо-режим (браузер жюри), если не включён MAX_REQUIRE_AUTH=1.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import re
import time
from typing import Any
from urllib.parse import parse_qsl

from app import metrics

HEADER = b"x-max-init-data"


class InitDataError(ValueError):
    pass


def sign(pairs: dict[str, str], bot_token: str) -> str:
    launch = "\n".join(f"{k}={v}" for k, v in sorted(pairs.items()))
    secret = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
    return hmac.new(secret, launch.encode(), hashlib.sha256).hexdigest()


def validate(init_data: str, bot_token: str, max_age: int = 3600, now: float | None = None) -> dict[str, Any]:
    if not isinstance(init_data,str) or not isinstance(bot_token,str) or not init_data or not bot_token or len(init_data)>16384:
        raise InitDataError("нет initData или токена бота")
    if re.search(r'%(?![0-9a-fA-F]{2})',init_data):raise InitDataError('неверная URL-кодировка')
    try:pairs = parse_qsl(init_data.replace('+','%2B'), keep_blank_values=True, strict_parsing=True,encoding='utf-8',errors='strict')
    except (ValueError,UnicodeError):raise InitDataError('неверные стартовые данные') from None
    keys = [k for k, _ in pairs]
    if len(keys) != len(set(keys)):
        raise InitDataError("параметр встречается дважды")
    data = dict(pairs)
    got = data.pop("hash", None)
    if not got:
        raise InitDataError("нет hash")
    # Reject malformed/non-ASCII digests before compare_digest (which raises TypeError).
    if len(got) != 64 or any(c not in "0123456789abcdefABCDEF" for c in got):
        raise InitDataError("неверный формат hash")
    if not hmac.compare_digest(sign(data, bot_token), got.lower()):
        # Official MAX example uses decodeURIComponent (literal + is not space).
        # Retain the old form-urlencoded transport only if ITS complete HMAC verifies.
        # Never parse identity using an encoding different from the verified one.
        legacy=dict(parse_qsl(init_data,keep_blank_values=True,strict_parsing=True,encoding='utf-8',errors='strict'))
        legacy.pop('hash',None)
        if '+' not in init_data or not hmac.compare_digest(sign(legacy,bot_token),got.lower()):
            raise InitDataError("подпись не совпала")
        data=legacy
    try:
        auth = int(data.get("auth_date", "0"))
    except ValueError as e:
        raise InitDataError("плохой auth_date") from e
    t = time.time() if now is None else now
    eff_age = max(60, max_age or 3600)  # 0/None не отключают expiry; минимум 60 с против replay
    if t - auth > eff_age:
        raise InitDataError("initData просрочены")
    if auth - t > 300:  # часы клиента/подделка: auth_date из будущего
        raise InitDataError("auth_date из будущего")
    out: dict[str, Any] = dict(data)
    for k in ("user", "chat"):
        if k in out:
            try:
                out[k] = json.loads(out[k])
            except ValueError:
                pass
    if 'user' in out:
        user=out['user']
        if not isinstance(user,dict) or type(user.get('id')) is not int or user['id']<=0:
            raise InitDataError('неверный идентификатор пользователя MAX')
    return out


def auth_mode(bot_token: str, required: bool) -> str:
    """v18.1 (D-06): режим входа одной строкой — для /capabilities и предупреждения при старте.
    misconfigured — подпись обязательна, а токена нет (API отвечает 503);
    required — только подписанные запросы; verified — подпись проверяется, НО неподписанные
    запросы принимаются как демо (X-User-Id клиента) — не прод; demo — подписи нет вовсе."""
    if required:
        return "required" if bot_token else "misconfigured"
    return "verified" if bot_token else "demo"


class MaxAuthMiddleware:
    def __init__(self, app, bot_token: str, required: bool = False, max_age: int = 3600):
        self.app, self.token, self.required, self.max_age = app, bot_token, required, max_age

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope["path"].startswith("/api/"):
            return await self.app(scope, receive, send)
        # «max:<id>» выдаёт ТОЛЬКО этот слой после проверки подписи — клиентский
        # заголовок с таким префиксом (подделка личности) отбрасывается всегда.
        # x-auth (max|demo) ставит только этот слой — клиентский заголовок отбрасывается.
        headers = [(k, v) for k, v in scope.get("headers", [])
                   if not (k == b"x-user-id" and v.startswith(b"max:")) and k != b"x-auth"]
        scope = dict(scope, headers=headers)
        if sum(k.lower()==HEADER for k,v in headers)>1:
            return await _deny(send,'Повтор заголовка авторизации MAX',400)
        raw = next((v for k, v in headers if k.lower() == HEADER), None)
        if self.required and not self.token:
            # P1 (v17.1): «обязательная авторизация» без токена бота раньше пропускала всех как demo — fail-closed.
            return await _deny(send, "Сервер не настроен: нет токена бота MAX", 503)
        if raw is None or not self.token:
            if self.required and self.token:
                return await _deny(send, "Открой приложение из MAX")
            # v2.4 Step 1: an unsigned request never chooses its identity. X-User-Id is accepted only as a
            # server-signed device token (app.device_identity) and rewritten to its random part; any other
            # value is refused. Only the automated TEST profile keeps the synthetic raw-id harness.
            from app import device_identity
            claimed = [v for k, v in headers if k == b"x-user-id"]
            if len(claimed) > 1:
                return await _deny(send, "Повтор заголовка X-User-Id", 400)
            if scope["path"] == device_identity.PATH:
                headers = [(k, v) for k, v in headers if k != b"x-user-id"]
            elif claimed:
                ident = device_identity.verify(claimed[0].decode("latin-1"))
                if ident:
                    headers = [(k, v) for k, v in headers if k != b"x-user-id"] + [(b"x-user-id", ident.encode())]
                elif not device_identity.harness():
                    metrics.op("device_identity", "rejected")
                    return await _deny(send, "Демо-профиль браузера не подтверждён сервером — откройте приложение заново",
                                       401, "device_identity_invalid")
            scope = dict(scope, headers=headers + [(b"x-auth", b"demo")])
            return await self.app(scope, receive, send)
        try:
            data = validate(raw.decode("latin-1"), self.token, self.max_age)
        except InitDataError:
            metrics.op("max_initdata", "rejected")
            return await _deny(send, "Сессия MAX устарела — открой приложение заново")
        metrics.op("max_initdata", "verified")  # v2.1: счётчик для /api/v1/health/deep (без id и содержимого)
        uid = (data.get("user") or {}).get("id") if isinstance(data.get("user"), dict) else None
        if uid is None:  # подпись верна, но пользователя нет — не с чем связать данные
            return await _deny(send, "Сессия MAX без пользователя — открой приложение заново")
        headers = [(k, v) for k, v in headers if k != b"x-user-id"] + [(b"x-user-id", f"max:{uid}".encode()), (b"x-auth", b"max")]
        # v2: имя из ПОДПИСАННОГО профиля MAX — только для отображения (ФИО в профиле), не для прав.
        state = dict(scope.get("state") or {})
        state["max_user"] = signed_names(data.get("user"))
        scope = dict(scope, headers=headers, state=state)
        return await self.app(scope, receive, send)


def signed_names(user: Any) -> dict[str, str]:
    """first/last name (+ photo_url) из проверенного initData (обрезаны, без управляющих символов).

    Master v2.0 · Feature 1: photo_url — документированное поле объекта user в initData
    (dev.max.ru/docs/webapps/bridge, «Объект WebAppUser»). Берём его ТОЛЬКО из подписанных данных,
    только https без логина/пароля и без пробелов/кавычек. Фото — оформление, а не доказательство личности."""
    out: dict[str, str] = {}
    if isinstance(user, dict):
        for k in ("first_name", "last_name", "username"):
            v = user.get(k)
            if isinstance(v, str):
                v = "".join(ch for ch in v if ch.isprintable()).strip()[:64]
                if v:
                    out[k] = v
        photo = safe_photo_url(user.get("photo_url"))
        if photo:
            out["photo_url"] = photo
    return out


def safe_photo_url(value: Any) -> str | None:
    """https-URL фото из подписанного профиля или None (ничего не «чиним» и не дописываем)."""
    from urllib.parse import urlsplit
    if not isinstance(value, str) or not 12 <= len(value) <= 1024:
        return None
    if any(c.isspace() or ord(c) < 0x21 or ord(c) > 0x7E or c in "\"'<>`\\" for c in value):
        return None
    try:
        p = urlsplit(value)
        port = p.port
    except ValueError:
        return None
    if p.scheme != "https" or not p.hostname or p.username or p.password or port not in (None, 443):
        return None
    return value


async def _deny(send, msg: str, status: int = 401, reason_code: str | None = None) -> None:
    payload: dict[str, Any] = {"detail": msg}
    if reason_code:
        payload["reason_code"] = reason_code
    body = json.dumps(payload, ensure_ascii=False).encode()
    await send({"type": "http.response.start", "status": status,
                "headers": [(b"content-type", b"application/json; charset=utf-8"), (b"cache-control", b"no-store"),
                            (b"content-length", str(len(body)).encode())]})
    await send({"type": "http.response.body", "body": body})
