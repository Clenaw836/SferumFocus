"""Server-to-server MAX hook. This one route uses its own secret, NOT web cookies.

No user-facing registration endpoint. Only server configuration may subscribe.
"""
from __future__ import annotations
import asyncio
import hmac
import json
import logging
import os
import re
import sqlite3
from contextlib import asynccontextmanager
from urllib.parse import urlsplit
from fastapi import APIRouter, HTTPException, Request

from app.max_transport import configured_runtime

router = APIRouter()
MAX_BODY = 1024 * 1024


@router.post('/hooks/max')
async def max_hook(request: Request):
    runtime = getattr(request.app.state, 'max_runtime', None)
    expected = getattr(request.app.state, 'max_webhook_secret', '')
    if runtime is None or not expected:
        raise HTTPException(503, 'MAX webhook is not configured')
    values = request.headers.getlist('x-max-bot-api-secret')
    if len(values) != 1 or not hmac.compare_digest(values[0].encode(), expected.encode()):
        raise HTTPException(403, 'Invalid webhook secret')
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > MAX_BODY:
            raise HTTPException(413, 'Event too large')
    try:
        update = json.loads(raw)
    except (ValueError, UnicodeError):
        raise HTTPException(400, 'Invalid event JSON') from None
    if not isinstance(update, dict) or not isinstance(update.get('update_type'), str):
        raise HTTPException(400, 'Invalid event')
    if update['update_type'] == 'bot_started' and not isinstance(update.get('user'), dict):
        raise HTTPException(400, 'Invalid start event')
    if update['update_type'] == 'message_created':
        msg = update.get('message')
        if not isinstance(msg, dict) or not isinstance(msg.get('body'), dict) or not isinstance(msg.get('sender'), dict):
            raise HTTPException(400, 'Invalid message event')
    if update['update_type'] in {'message_created', 'bot_started'}:
        user = update['message']['sender'] if update['update_type'] == 'message_created' else update['user']
        uid = user.get('user_id')
        if isinstance(uid, bool) or not isinstance(uid, int) or not 0 < uid < 2**63:
            raise HTTPException(400, 'Invalid sender')
    # Synchronous local SQLite FULL commit before ACK. Never await Groq or a
    # school provider here. Failure to commit returns 503 so MAX can redeliver.
    try:
        runtime.queue.accept(update)
    except (OSError, ValueError, sqlite3.Error):
        raise HTTPException(503, 'Event queue unavailable') from None
    return {'success': True}


def settings():
    mode = os.getenv('MAX_BOT_MODE', 'disabled').strip().lower()
    if mode not in {'disabled', 'polling', 'webhook'}:
        raise ValueError('MAX_BOT_MODE must be disabled, polling or webhook')
    if mode != 'webhook':
        return mode, '', ''
    secret = os.getenv('MAX_WEBHOOK_SECRET', '')
    origin = os.getenv('SFERUM_PUBLIC_ORIGIN', '')
    u = urlsplit(origin)
    if (u.scheme != 'https' or not u.hostname or u.username or u.password
            or u.path or u.query or u.fragment or u.port not in {None, 443}):
        raise ValueError('MAX webhook requires SFERUM_PUBLIC_ORIGIN on HTTPS port 443')
    if not re.fullmatch(r'[a-zA-Z0-9_-]{32,256}', secret):
        raise ValueError('MAX_WEBHOOK_SECRET must contain 32..256 URL-safe characters')
    return mode, origin + '/hooks/max', secret


async def subscribe(runtime, url, secret):
    r = await runtime.bot.http.get('/subscriptions')
    r.raise_for_status()
    data = r.json()
    if data.get('success') is False or 'subscriptions' not in data:
        raise ValueError('MAX subscription listing rejected')
    existing = data['subscriptions']
    if any(s.get('url') != url for s in existing):
        raise ValueError('Another MAX webhook exists; refusing to take over a different service')
    r = await runtime.bot.http.post('/subscriptions', json={
        'url': url, 'secret': secret, 'update_types': ['message_created', 'bot_started']})
    r.raise_for_status()
    if r.json().get('success') is not True:
        raise ValueError('MAX subscription registration rejected')


async def maintain_subscription(app, runtime, url, secret):
    """Register AFTER ASGI startup; a provider may probe the public hook URL.

    A network outage does not crash/restart the website. /ready shows the state.
    Re-register periodically so a dropped MAX subscription is restored.
    """
    import httpx
    await asyncio.sleep(1)
    delay = 2
    while True:
        try:
            await subscribe(runtime, url, secret)
            app.state.max_subscription_status = 'registered'
            app.state.max_subscription_reason = None
            delay = 2
            await asyncio.sleep(300)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            reason = ('max_http_' + str(exc.response.status_code)
                      if isinstance(exc, httpx.HTTPStatusError) else
                      'configuration_or_subscription_conflict' if isinstance(exc, ValueError) else
                      'max_network_or_storage_error')
            app.state.max_subscription_status = 'error'
            app.state.max_subscription_reason = reason
            logging.getLogger('sferumfocus.max_transport').warning('MAX subscription unavailable reason=%s', reason)
            await asyncio.sleep(delay)
            delay = min(300, delay * 2)


@asynccontextmanager
async def webhook_lifespan(app):
    mode, url, secret = settings()
    if mode == 'polling' and os.getenv('SFERUM_ENV', 'production') not in {'test', 'demo'}:
        raise ValueError('Production MAX delivery requires webhook mode')
    if mode != 'webhook':
        yield
        return
    from app.deployment import DeploymentPolicy
    if DeploymentPolicy().errors():
        raise ValueError("Deployment is not ready for MAX webhook")
    runtime = configured_runtime()
    tasks = []
    try:
        runtime.acquire()
        app.state.max_runtime = runtime
        app.state.max_webhook_secret = secret
        app.state.max_subscription_status = 'pending'
        app.state.max_subscription_reason = None
        tasks = [asyncio.create_task(runtime.events()) for _ in range(4)] + [asyncio.create_task(runtime.sends())]
        if os.getenv('MAX_WEBHOOK_AUTO_REGISTER', '1').lower() in {'1', 'true'}:
            tasks.append(asyncio.create_task(maintain_subscription(app, runtime, url, secret)))
        else:
            app.state.max_subscription_status = 'operator_managed'
        yield
    finally:
        app.state.max_runtime = None
        app.state.max_webhook_secret = ''
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await runtime.close()
