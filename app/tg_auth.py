"""Verify Telegram HMAC over received decoded values, never re-serialize user JSON."""
from __future__ import annotations
import hashlib
import hmac
import json
import re
import time
from urllib.parse import parse_qsl

REASONS=frozenset({'invalid_launch','invalid_encoding','duplicate_keys','invalid_hash',
                  'signature_invalid','auth_expired','auth_future','invalid_user','malformed'})

class TelegramAuthError(ValueError):
    """Fixed diagnostic code only; the exception never contains launch data."""
    def __init__(self, reason='malformed'):
        self.reason=reason if reason in REASONS else 'malformed'
        super().__init__('Invalid or expired Telegram launch data')


def validate(raw: str, token: str, max_age: int = 86400, now: float | None = None) -> dict:
    if not isinstance(raw,str) or not isinstance(token,str) or not token or not raw or len(raw)>16384:raise TelegramAuthError('invalid_launch')
    if type(max_age) is not int or not 60 <= max_age <= 86400:raise TelegramAuthError('malformed')
    if re.search(r'%(?![0-9a-fA-F]{2})',raw):raise TelegramAuthError('invalid_encoding')
    try:
        pairs=parse_qsl(raw,keep_blank_values=True,strict_parsing=True,encoding='utf-8',errors='strict')
        if len({k for k,_ in pairs})!=len(pairs):raise TelegramAuthError('duplicate_keys')
        data=dict(pairs);digest=data.pop('hash')
        if not re.fullmatch('[0-9a-fA-F]{64}',digest):raise TelegramAuthError('invalid_hash')
        # photo_url / or \/ stays EXACTLY as supplied inside the signed user value.
        # The optional signature field participates in bot-token HMAC like any other field.
        # Ed25519 third-party verification is a different protocol, not used here.
        check='\n'.join(f'{k}={v}' for k,v in sorted(data.items()))
        secret=hmac.new(b'WebAppData',token.encode(),hashlib.sha256).digest()
        expected=hmac.new(secret,check.encode(),hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected,digest.lower()):raise TelegramAuthError('signature_invalid')
        stamp=int(data['auth_date']);clock=time.time() if now is None else now
        if stamp>clock+60:raise TelegramAuthError('auth_future')
        if clock-stamp>max_age:raise TelegramAuthError('auth_expired')
        user=json.loads(data['user']);uid=user.get('id') if isinstance(user,dict) else None
        if type(uid) is not int or not 0<uid<2**63:raise TelegramAuthError('invalid_user')
        return {**data,'user':user}
    except TelegramAuthError:raise
    except (ValueError,KeyError,TypeError,UnicodeError) as exc:
        raise TelegramAuthError('malformed') from exc


def claimed_user_id(raw: str) -> int | None:
    """Untrusted hint ONLY for matching an already-authenticated cookie.

    Never use this function to create a principal or issue a new session.
    A mismatch forces normal HMAC validation instead of switching cookie owners.
    """
    if not isinstance(raw, str) or not raw or len(raw) > 16384:
        return None
    if re.search(r'%(?![0-9a-fA-F]{2})', raw):
        return None
    try:
        pairs = parse_qsl(raw, keep_blank_values=True, strict_parsing=True,
                          encoding='utf-8', errors='strict')
        if len({key for key, _ in pairs}) != len(pairs):
            return None
        user = json.loads(dict(pairs)['user'])
        uid = user.get('id') if isinstance(user, dict) else None
        return uid if type(uid) is int and 0 < uid < 2**63 else None
    except (ValueError, TypeError, KeyError, UnicodeError):
        return None


def transport_diagnostics(raw: str, token: str) -> dict[str, bool | int]:
    """Safe structural facts only; never return hashes, values, IDs or secret digests.

    These hints diagnose transport/configuration, never relax validate(). A wrapped
    URL-encoded string is rejected, not silently decoded a second time.
    """
    if not isinstance(raw, str):
        raw = ''
    if not isinstance(token, str):
        token = ''
    # Bound work on attacker-controlled input just like the validator.
    bounded = raw[:16385]
    return {
        'launch_length': len(bounded),
        'raw_has_hash_field': bool(re.search(r'(?:^|&)hash=', bounded)),
        'looks_double_encoded': bool(re.search(r'(?:^|%26)hash%3[dD]', bounded)),
        'token_present': bool(token),
        'token_has_outer_whitespace': bool(token and token != token.strip()),
    }
