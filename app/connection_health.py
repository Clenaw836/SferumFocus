"""User-scoped connection presentation. No provider payloads, tokens or error codes."""
from __future__ import annotations
import time
from datetime import datetime
from urllib.parse import urlsplit


def present_health(connection: dict, sync: dict, *, now: float | None = None) -> dict:
    now = time.time() if now is None else now
    provider = connection.get('provider')
    status = connection.get('status')
    last = (sync.get('sync') or {}).get('last_success')
    stamp=connection.get('last_synced_at')
    if stamp:
        try:last=datetime.fromisoformat(stamp.replace('Z','+00:00')).timestamp()
        except (ValueError,TypeError):pass
    age = max(0, now - last) if isinstance(last, (int, float)) and last > 0 else None
    host = None
    try:
        host = urlsplit(connection.get('portal') or '').hostname
    except ValueError:
        pass
    if status == 'reauth_required':
        state = 'reauth_required'
    elif provider == 'demo' or status == 'demo':
        state = 'demo'
    elif provider != 'netschool' or status in {'revoked', 'unsupported_manual'}:
        state = 'not_connected'
    elif status == 'temporarily_unavailable' or not sync.get('worker_online') or age is None or age > 900 or connection.get('is_stale'):
        state = 'delayed'
    elif status == 'connected':
        state = 'connected'
    else:
        state = 'not_connected'
    return {'state':state, 'portal_host':host, 'last_success':last,
            'worker_online':bool(sync.get('worker_online')), 'checked_at':now,
            'snapshot_available':bool(connection.get('snapshot_available')),
            'is_stale':bool(connection.get('is_stale')),
            'last_synced_at':connection.get('last_synced_at'), 'execution':'server'}
