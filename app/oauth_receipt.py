"""Small no-store OAuth receipt; a hint never replaces authenticated status polling."""
from __future__ import annotations

import html
import hmac
import os
import secrets
import time
from urllib.parse import urlsplit
from fastapi.responses import HTMLResponse

COOKIE = 'sf_oauth_receipt'
PATH = '/api/v1/diary/oauth/result'


def issue(repo, outcome: str) -> str:
    payload = f'{outcome}:{int(time.time()) + 60}:{secrets.token_urlsafe(12)}'
    return payload + ':' + repo.digest('oauth-receipt:' + payload)


def verified(repo, value: str, outcome: str) -> bool:
    try:
        kind, expires, nonce, signature = value.split(':')
        expiry = int(expires)
        return (kind == outcome and outcome in {'connected', 'failed'}
                and time.time() < expiry <= time.time() + 65 and len(nonce) == 16
                and hmac.compare_digest(signature, repo.digest('oauth-receipt:' + ':'.join((kind, expires, nonce)))))
    except (ValueError, TypeError, AttributeError):
        return False


def return_links() -> list[tuple[str, str]]:
    """Only operator-configured messenger destinations; no callback query redirect."""
    links = []
    for env, label, hosts in [('SFERUM_TELEGRAM_RETURN_URL', 'Вернуться в Telegram', {'t.me'}),
                              ('SFERUM_MAX_RETURN_URL', 'Вернуться в MAX', {'max.ru'})]:
        value = os.getenv(env, '')
        try:
            u = urlsplit(value)
            if (u.scheme == 'https' and u.hostname in hosts and not u.username
                    and not u.password and u.port in {None, 443} and not u.fragment
                    and not any(ord(c) < 32 for c in value)):
                links.append((label, value))
        except ValueError:
            pass
    return links


def page(*, connected: bool = False, status_code: int = 200, reason: str = 'failed') -> HTMLResponse:
    nonce = secrets.token_urlsafe(24)
    title = 'Дневник подключён' if connected else 'Вход не завершён'
    messages = {
        'expired': 'Ссылка входа недействительна или время подтверждения истекло. Начните новый вход в приложении.',
        'denied': 'Вход отменён на стороне провайдера. Можно повторить попытку.',
        'busy': 'Слишком много попыток. Немного подождите и начните вход заново.',
        'unavailable': 'Шлюз временно недоступен. Начните новый вход немного позже.',
        'failed': 'Не удалось подтвердить вход. Вернитесь в приложение и повторите попытку.',
    }
    text = ('Можно вернуться в мини-приложение: дневник обновится автоматически.'
            if connected else messages.get(reason, messages['failed']))
    links = [('Открыть СферумФокус' if connected else 'Повторить попытку', '/?connect=diary'), *return_links()]
    actions = ''.join(f'<a class="action" href="{html.escape(url, quote=True)}" rel="noreferrer">{html.escape(label)}</a>' for label, url in links)
    # Code/state are stripped even on an error response (before any further user navigation).
    script = "try { history.replaceState(null, '', '/api/v1/diary/oauth/result'); } catch (_) {}\n"
    if connected:
        script += """try { if (window.opener && !window.opener.closed) {
  window.opener.postMessage({ type: 'sgo_connected' }, location.origin);
} } catch (_) {}
setTimeout(function () { window.close(); }, 1200);
"""
    document = f'''<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#101113"><title>{title} · СферумФокус</title>
<style nonce="{nonce}">
:root {{ color-scheme:dark; font-family:Arial,sans-serif; background:#101113; color:#f4f4f5; }}
* {{ box-sizing:border-box; }} body {{ margin:0; padding:24px; padding: max(24px, env(safe-area-inset-top)) max(20px, env(safe-area-inset-right)) max(24px, env(safe-area-inset-bottom)) max(20px, env(safe-area-inset-left)); min-height:100svh; display:grid; place-items:center; }}
main {{ max-width:460px; width:100%; padding:26px; border:1px solid #4b4c52; border-radius:24px; background:#191b1f; }}
h1 {{ font-size:26px; line-height:1.2; margin:0 0 16px; }} p {{ color:#c6c7ce; line-height:1.55; }}
nav {{ display:grid; gap:12px; margin-top:24px; }} .action {{ min-height:48px; display:flex; align-items:center; justify-content:center; padding:12px 16px; border-radius:14px; text-align:center; background:#ffa66a; color:#201208; font-weight:700; text-decoration:none; touch-action:manipulation; }}
.action:focus-visible {{ outline:3px solid #fff; outline-offset:4px; }} .action:active {{ background:#f0b98f; }}
small {{ display:block; margin-top:20px; line-height:1.5; color:#c6c7ce; }}
</style></head><body><main aria-labelledby="heading"><h1 id="heading">{title}</h1>
<p role="status">{text}</p><nav aria-label="Вернуться в приложение">{actions}</nav>
<small>Если окно не закрылось, вернитесь в открытый Telegram / MAX. Пароль Госуслуг здесь не вводится.</small></main>
<script nonce="{nonce}">{script}</script></body></html>'''
    return HTMLResponse(document, status_code=status_code, headers={
        'Cache-Control': 'no-store', 'Pragma': 'no-cache', 'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
        'Content-Security-Policy': f"default-src 'none'; script-src 'nonce-{nonce}'; style-src 'nonce-{nonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    })
