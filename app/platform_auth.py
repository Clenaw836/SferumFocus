"""Host dispatcher; the original MAX verifier remains unchanged.

Enabled explicitly via PLATFORM_AUTH_ENABLED. Existing demo deployments retain
old policy; all new /auth and /diary APIs fail closed without platform mode.
"""
from __future__ import annotations
import json
import os
import sqlite3
import logging
from app.auth_diagnostics import report
from functools import lru_cache
from http.cookies import SimpleCookie
from pathlib import Path
import hmac
from app.max_auth import MaxAuthMiddleware
from app.tg_auth import validate as validate_telegram, TelegramAuthError, claimed_user_id, transport_diagnostics
from app.platform_store import PlatformStore

COOKIE='sf_session'
def enabled(): return os.getenv('PLATFORM_AUTH_ENABLED','').lower() in {'1','true'}
@lru_cache(maxsize=1)
def store():
    from app.config import SFERUM_DATA_DIR
    repo=PlatformStore(Path(SFERUM_DATA_DIR)/'platform.sqlite3',os.getenv('SESSION_SIGNING_KEY',''))
    from app.sgo_resolver import load_directory_config
    load_directory_config(repo)
    return repo
def csrf(cookie): return store().digest('csrf:'+cookie)
def cookie_of(headers):
    try:
        c=SimpleCookie();c.load(headers.get('cookie',''));return c[COOKIE].value if COOKIE in c else ''
    except Exception: return ''

async def deny(send, status, text, reason_code=None):
    payload={'detail':text}
    if reason_code:payload['reason_code']=reason_code
    body=json.dumps(payload).encode()
    await send({'type':'http.response.start','status':status,'headers':[(b'content-type',b'application/json'),(b'cache-control',b'no-store')]})
    await send({'type':'http.response.body','body':body})

class PlatformAuthMiddleware:
    def __init__(self, app, bot_token, required=False, max_age=3600):
        self.app=app; self.legacy=MaxAuthMiddleware(app,bot_token,required,max_age)
        self.strict_max=MaxAuthMiddleware(self.max_verified,bot_token,True,max_age)

    async def max_verified(self,scope,receive,send):
        h={k.decode():v.decode('latin-1') for k,v in scope['headers']}
        return await self.verified(scope,receive,send,h['x-user-id'],'max')

    async def verified(self,scope,receive,send,principal,auth,cookie=''):
        try:
            repo=store()
            account=repo.identity(principal,used=scope['method'] not in {'GET','HEAD','OPTIONS'} and not scope['path'].startswith(('/api/v1/auth/','/api/v1/diary/','/api/v1/metrics/')))
        except (ValueError,OSError,sqlite3.Error) as exc:
            report('identity_store_unavailable', exc)
            return await deny(send,503,'Хранилище идентификации не настроено','identity_store_unavailable')
        state=dict(scope.get('state',{}));state.update(platform_principal=principal,platform_auth=auth,platform_account=account,platform_cookie=cookie)
        # Every downstream legacy API receives canonical data_key. No client can
        # override it, x-auth or the verified principal using custom headers.
        stripped={b'x-user-id',b'x-auth',b'x-verified-principal',b'x-user-role'}
        if cookie:stripped.update({b'x-telegram-init-data',b'x-max-init-data'})
        headers=[(k,v) for k,v in scope['headers'] if k.lower() not in stripped]
        headers += [(b'x-user-id',account['data_key'].encode()),(b'x-auth',auth.encode())]
        return await self.app(dict(scope,state=state,headers=headers),receive,send)

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http' or not scope['path'].startswith('/api/'):
            return await self.app(scope, receive, send)
        pairs = scope.get('headers', [])
        h = {k.decode().lower(): v.decode('latin-1') for k, v in pairs}
        tg = h.get('x-telegram-init-data', '')
        mx = h.get('x-max-init-data', '')
        cookie = cookie_of(h)
        if (scope['path'] in {'/api/v1/auth/web-session', '/api/v1/webapp/whoami'}
                and os.getenv('SFERUM_AUTH_DIAGNOSTICS', '1').lower() in {'1', 'true'}):
            logging.getLogger('uvicorn.error').info(
                'auth_transport path=%s cookie_header_present=%s sf_session_present=%s '
                'telegram_present=%s max_present=%s', scope['path'], 'cookie' in h,
                bool(cookie), bool(tg), bool(mx))
        if not enabled():
            if scope['path'].startswith(('/api/v1/auth/', '/api/v1/diary/',
                                         '/api/v1/shared/', '/api/platform/')):
                return await deny(send, 503, 'Мультиплатформенный режим не настроен')
            return await self.legacy(scope, receive, send)
        sensitive = {b'x-telegram-init-data', b'x-max-init-data', b'cookie',
                     b'x-csrf-token', b'origin', b'x-web-bootstrap'}
        for name in sensitive:
            if sum(k.lower() == name for k, _ in pairs) > 1:
                return await deny(send, 400, 'Повтор заголовка авторизации')
        if tg and mx:
            return await deny(send, 400, 'Неоднозначная среда запуска')
        # Callback/capability endpoints validate their own state/capability.
        if scope['method'] == 'OPTIONS':
            return await self.app(scope, receive, send)
        if scope['method'] == 'GET' and scope['path'] in {
            '/api/platform/diary/auth/esia/callback',
            '/api/platform/diary/auth/myschool/callback',
            '/api/v1/diary/auth/esia/callback',
            '/api/v1/diary/oauth/callback', '/api/v1/diary/oauth/result',
        }:
            return await self.app(scope, receive, send)
        if scope['method'] == 'POST' and scope['path'] in {
            '/api/v1/diary/auth/bridge-bind', '/api/v1/diary/auth/sandbox/show-code',
        }:
            return await self.app(scope, receive, send)
        bootstrap = (scope['method'] == 'POST'
                     and scope['path'] == '/api/v1/auth/web-session')
        try:
            principal = store().session(cookie) if cookie else None
        except (ValueError, OSError, sqlite3.Error) as exc:
            report('web_session_store_unavailable', exc)
            return await deny(send, 503, 'Веб-сессии не настроены',
                              'web_session_store_unavailable')
        cookie_auth = None
        if principal and not (bootstrap and (tg or mx)):
            if not tg and not mx:
                cookie_auth = 'web'
            elif tg and principal.startswith('tg:'):
                hint = claimed_user_id(tg)
                # The hint never grants access. Only this existing cookie does.
                if hint is not None and principal == f'tg:{hint}':
                    cookie_auth = 'telegram'
        if cookie_auth:
            if scope['method'] not in {'GET', 'HEAD', 'OPTIONS'} and not bootstrap:
                origin = os.getenv('SFERUM_PUBLIC_ORIGIN', '')
                if (not origin or h.get('origin') != origin
                        or not hmac.compare_digest(h.get('x-csrf-token', '').encode(),
                                                   csrf(cookie).encode())):
                    return await deny(send, 403, 'Проверка Origin/CSRF не пройдена')
            # Bootstrap has its own exact Origin, X-Web-Bootstrap and rate checks.
            # Identity/uid is always resolved from the cookie's stored principal.
            return await self.verified(scope, receive, send, principal, cookie_auth, cookie)
        if mx:
            return await self.strict_max(scope, receive, send)
        if tg:
            token = os.getenv('TELEGRAM_BOT_TOKEN', '')
            if not token:
                report('missing_telegram_token')
                return await deny(send, 503, 'Telegram не настроен', 'missing_telegram_token')
            try:
                launch_max_age = int(os.getenv('TELEGRAM_AUTH_MAX_AGE', '86400'))
                if not 60 <= launch_max_age <= 86400:
                    raise ValueError
            except ValueError:
                logging.getLogger('uvicorn.error').warning(
                    'auth_configuration_error reason_code=invalid_telegram_max_age')
                return await deny(send, 503, 'Некорректный срок Telegram initData',
                                  'invalid_telegram_max_age')
            try:
                user = validate_telegram(tg, token, max_age=launch_max_age)['user']['id']
            except TelegramAuthError as exc:
                logging.getLogger('uvicorn.error').warning(
                    'telegram_auth_rejected reason_code=%s', 'telegram_' + exc.reason)
                if os.getenv('SFERUM_AUTH_DIAGNOSTICS', '1').lower() in {'1', 'true'}:
                    facts = transport_diagnostics(tg, token)
                    logging.getLogger('uvicorn.error').warning(
                        'telegram_auth_transport launch_length=%s raw_has_hash_field=%s '
                        'looks_double_encoded=%s token_present=%s token_has_outer_whitespace=%s',
                        facts['launch_length'], facts['raw_has_hash_field'],
                        facts['looks_double_encoded'], facts['token_present'],
                        facts['token_has_outer_whitespace'])
                return await deny(send, 401,
                                  'Сессия Telegram недействительна; открой приложение заново',
                                  'telegram_' + exc.reason)
            # A first login (including bootstrap) MUST pass HMAC and auth_date.
            # platform_routes issues/rebinds its cookie using this verified state.
            return await self.verified(scope, receive, send, f'tg:{user}', 'telegram')
        if bootstrap:
            # Standalone browser guest, never a guessed Telegram identity.
            return await self.app(scope, receive, send)
        return await deny(send, 401, 'Нужна сессия браузера')
