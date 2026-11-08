"""Registered regional Authorization Code + S256 PKCE, durable and uid-bound.

A NetSchool ESIA login URL is not automatically an OAuth client endpoint. Only
operator-configured gateways that return a code for our registered redirect URI
are accepted. Portal/ESIA browser cookies are never read by this application.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import time
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from app.sgo_client import NetSchoolClient, SgoHTTP, SgoUnsupported
from app.sgo_directory import Directory

SCHEMA = '''
CREATE TABLE IF NOT EXISTS sgo_oauth_transactions(
 tx_id TEXT PRIMARY KEY,uid TEXT NOT NULL,school_uid TEXT NOT NULL,method TEXT NOT NULL,
 flow_digest TEXT NOT NULL UNIQUE,expires REAL NOT NULL,status TEXT NOT NULL,
 connection_id TEXT,error_code TEXT);
CREATE INDEX IF NOT EXISTS oauth_transactions_uid ON sgo_oauth_transactions(uid);
'''
class OAuthStateInvalid(SgoUnsupported):
    """Safe public category, never contains a raw state or provider response."""


METHODS = {'gosuslugi_esia', 'moya_shkola'}
TERMINAL = {'connected', 'failed', 'cancelled', 'expired'}


def public_origin():
    origin = os.getenv('SFERUM_PUBLIC_ORIGIN', '')
    u = urlsplit(origin)
    local = (u.scheme == 'http' and u.hostname == '127.0.0.1'
             and os.getenv('SFERUM_ENV') in {'test', 'demo'})
    if (not (u.scheme == 'https' or local) or not u.hostname or u.username
            or u.password or u.path or u.query or u.fragment):
        raise SgoUnsupported('Нужен настроенный публичный HTTPS origin приложения')
    return origin


class SchoolOAuth:
    def __init__(self, repo, vault, client=None):
        self.repo, self.vault, self.client = repo, vault, client
        self.directory = Directory(repo)

    def profile(self, school, method):
        if method not in METHODS:
            raise SgoUnsupported('Неизвестный способ входа')
        host = self.directory.host(school['host_id'])
        profile = host['metadata'].get('oauth', {}).get(method)
        if not isinstance(profile, dict):
            raise SgoUnsupported('Для этого узла не настроен зарегистрированный OAuth-шлюз. Пароль Госуслуг здесь не вводится.')
        for key in ('authorization_url', 'token_url', 'client_id', 'redirect_uri'):
            if not isinstance(profile.get(key), str) or not profile[key]:
                raise SgoUnsupported('Неполная конфигурация OAuth-шлюза')
        origin = public_origin()
        for key in ('authorization_url', 'token_url', 'redirect_uri'):
            u = urlsplit(profile[key])
            local_callback = key == 'redirect_uri' and origin.startswith('http://127.0.0.1:')
            if (u.scheme != 'https' and not local_callback) or not u.hostname or u.username or u.password or u.fragment:
                raise SgoUnsupported('Нужен безопасный HTTPS OAuth URL')
            if u.port not in {None, 443} and not local_callback:
                raise SgoUnsupported('OAuth URL должен использовать стандартный HTTPS порт')
        kind = 'esia' if method == 'gosuslugi_esia' else 'myschool'
        allowed = {origin + f'/api/platform/diary/auth/{kind}/callback',
                   origin + '/api/v1/diary/oauth/callback'}
        if method == 'gosuslugi_esia':
            allowed.add(origin + '/api/v1/diary/auth/esia/callback')
        if profile['redirect_uri'] not in allowed:
            raise SgoUnsupported('OAuth callback не совпадает с зарегистрированным origin приложения')
        if urlsplit(profile['token_url']).query:
            raise SgoUnsupported('Token endpoint query не поддерживается')
        if profile.get('redirect_parameter', 'redirect_uri') not in {'redirect_uri', 'returnUrl'}:
            raise SgoUnsupported('Неподдерживаемый параметр возврата OAuth')
        school_parameter = profile.get('school_parameter')
        if school_parameter is not None and school_parameter not in {'scid', 'school_id', 'schoolId'}:
            raise SgoUnsupported('Неподдерживаемый параметр школы OAuth')
        return host, profile

    def start_card(self, uid, school_uid, portal_url, scid, method='gosuslugi_esia'):
        school = self.directory.school(school_uid)
        host, _ = self.profile(school, method)
        if portal_url != host['base_url'] or scid != school['scid']:
            raise SgoUnsupported('Карточка школы не совпадает с подтверждённым каталогом')
        # All fields come from the server-side registry, never a supplied host.
        self.directory.select(uid, school_uid)
        return self.begin(uid, method)

    def begin(self, uid, method):
        school = self.directory.binding(uid)
        if not school:
            raise SgoUnsupported('Сначала выбери школу')
        host, p = self.profile(school, method)
        state, verifier, tx_id = secrets.token_urlsafe(32), secrets.token_urlsafe(48), secrets.token_urlsafe(32)
        digest, expires = self.repo.digest(state), time.time() + 300
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
        with self.repo.tx() as db:
            db.execute("UPDATE sgo_oauth_transactions SET status='cancelled',error_code='replaced' WHERE uid=? AND status IN ('waiting_external','processing')", (uid,))
            db.execute('DELETE FROM sgo_oauth_transactions WHERE expires<?', (time.time() - 86400,))
            db.execute('DELETE FROM sgo_auth_flows WHERE expires<=? OR student_uid=?', (time.time(), uid))
            db.execute('INSERT INTO sgo_auth_flows VALUES(?,?,?,?,?,?)',
                       (digest, uid, school['school_uid'], method, expires,
                        self.vault.seal(uid, 'oauth', {'verifier': verifier, 'profile': p, 'portal': host['base_url']})))
            db.execute('INSERT INTO sgo_oauth_transactions(tx_id,uid,school_uid,method,flow_digest,expires,status) VALUES(?,?,?,?,?,?,?)',
                       (tx_id, uid, school['school_uid'], method, digest, expires, 'waiting_external'))
        args = {'response_type': 'code', 'client_id': p['client_id'],
                p.get('redirect_parameter', 'redirect_uri'): p['redirect_uri'],
                'scope': p.get('scope', ''), 'state': state,
                'code_challenge': challenge, 'code_challenge_method': 'S256'}
        if p.get('school_parameter'):
            args[p['school_parameter']] = str(school['scid'])
        u = urlsplit(p['authorization_url'])
        reserved = set(args) | {'redirect_uri', 'returnUrl', 'code_verifier'}
        extras = [(k, v) for k, v in parse_qsl(u.query) if k not in reserved]
        authorize_url = urlunsplit((u.scheme, u.netloc, u.path, urlencode(extras + list(args.items())), ''))
        return {'authorize_url': authorize_url, 'authorization_url': authorize_url,
                'tx_id': tx_id, 'expires_in': 300, 'method': method, 'status': 'waiting_external'}

    def status(self, uid, tx_id):
        with self.repo.tx() as db:
            row = db.execute('SELECT * FROM sgo_oauth_transactions WHERE tx_id=? AND uid=?', (tx_id, uid)).fetchone()
            if not row:
                raise SgoUnsupported('Транзакция входа не найдена')
            r = dict(row)
            binding = db.execute('SELECT school_uid FROM student_school_binding WHERE student_uid=?', (uid,)).fetchone()
            if not binding or binding[0] != r['school_uid']:
                r['status'], r['error_code'] = 'cancelled', 'school_changed'
            elif r['status'] not in TERMINAL:
                if r['expires'] <= time.time():
                    r['status'], r['error_code'] = 'expired', 'expired'
                elif not db.execute('SELECT 1 FROM sgo_auth_flows WHERE digest=?', (r['flow_digest'],)).fetchone():
                    r['status'], r['error_code'] = 'cancelled', 'cancelled'
            if r['status'] in TERMINAL - {'connected'}:
                db.execute('DELETE FROM sgo_auth_flows WHERE digest=?', (r['flow_digest'],))
            db.execute('UPDATE sgo_oauth_transactions SET status=?,error_code=? WHERE tx_id=?', (r['status'], r['error_code'], tx_id))
        if r['status'] == 'connected':
            conn = self.vault.get(uid)
            if (not conn or conn['status'] != 'connected' or not conn.get('session')
                    or conn['session'].get('connection_id') != r['connection_id']):
                r['status'] = 'cancelled'
        return {'tx_id': tx_id, 'status': r['status'], 'error_code': r['error_code'],
                'expires_in': max(0, int(r['expires'] - time.time())), 'demo': False}

    def cancel(self, uid, tx_id):
        self.status(uid, tx_id)
        with self.repo.tx() as db:
            r = db.execute('SELECT * FROM sgo_oauth_transactions WHERE tx_id=? AND uid=?', (tx_id, uid)).fetchone()
            if not r:
                raise SgoUnsupported('Транзакция входа больше не существует')
            # Cancelling an already completed wait must not revoke a diary.
            if r['status'] == 'connected':
                return {'tx_id': tx_id, 'status': 'connected'}
            db.execute('DELETE FROM sgo_auth_flows WHERE digest=?', (r['flow_digest'],))
            db.execute("UPDATE sgo_oauth_transactions SET status='cancelled',error_code='cancelled' WHERE tx_id=?", (tx_id,))
        return {'tx_id': tx_id, 'status': 'cancelled'}

    def provider_error(self, state):
        digest = self.repo.digest(state)
        with self.repo.tx() as db:
            row = db.execute("SELECT * FROM sgo_oauth_transactions WHERE flow_digest=? AND status='waiting_external' AND expires>?", (digest, time.time())).fetchone()
            if not row:
                raise OAuthStateInvalid('OAuth state недействителен или истёк')
            db.execute('DELETE FROM sgo_auth_flows WHERE digest=?', (digest,))
            db.execute("UPDATE sgo_oauth_transactions SET status='failed',error_code='provider_denied' WHERE tx_id=?", (row['tx_id'],))

    async def finish(self, state, code, method=None, uid=None):
        digest = self.repo.digest(state)
        with self.repo.tx() as db:
            row = db.execute("SELECT * FROM sgo_auth_flows WHERE digest=? AND expires>? AND method IN ('gosuslugi_esia','moya_shkola')", (digest, time.time())).fetchone()
            if not row or (uid is not None and row['student_uid'] != uid) or (method is not None and row['method'] != method):
                raise OAuthStateInvalid('OAuth state недействителен или истёк')
            tx = db.execute("SELECT * FROM sgo_oauth_transactions WHERE flow_digest=? AND status='waiting_external'", (digest,)).fetchone()
            if not tx:
                raise SgoUnsupported('Вход отменён или уже использован')
            uid, school_key, method = row['student_uid'], row['school_uid'], row['method']
            secret = self.vault.open(uid, 'oauth', row['payload'])
            db.execute("UPDATE sgo_auth_flows SET method='consumed',payload='{}' WHERE digest=?", (digest,))
            db.execute("UPDATE sgo_oauth_transactions SET status='processing' WHERE tx_id=?", (tx['tx_id'],))
        try:
            school = self.directory.binding(uid)
            if not school or school['school_uid'] != school_key:
                raise SgoUnsupported('Школа изменилась: начни вход заново')
            host, p = self.profile(school, method)
            if secret['profile'] != p or secret['portal'] != host['base_url']:
                raise SgoUnsupported('Конфигурация шлюза изменилась; начни вход заново')
            u = urlsplit(p['token_url'])
            token_host = host['host_id'] if u.netloc == urlsplit(host['base_url']).netloc else 'oauth-token'
            token_http = SgoHTTP({'host_id': token_host, 'base_url': f'https://{u.netloc}', 'api_prefix': '', 'metadata': {}}, client=self.client)
            payload = {'grant_type': 'authorization_code', 'code': code, 'code_verifier': secret['verifier'],
                       'redirect_uri': p['redirect_uri'], 'client_id': p['client_id']}
            if p.get('client_secret_env'):
                value = os.getenv(p['client_secret_env'], '')
                if not value:
                    raise SgoUnsupported('OAuth client secret не настроен')
                payload['client_secret'] = value
            grant = await token_http.request('POST', u.path, data=payload)
            token = grant.get(p.get('token_field', 'at')) if isinstance(grant, dict) else None
            if not isinstance(token, str) or not 1 <= len(token) <= 8192 or any(ord(c) < 33 or ord(c) > 126 for c in token):
                raise SgoUnsupported('Шлюз не вернул подтверждённый grant СГО')
            # Cookie material comes exclusively from the trusted back-channel,
            # never from callback cookies (which belong to OUR origin).
            portal_hostname = urlsplit(host['base_url']).hostname
            cookies = [c for c in token_http.export_cookies() if c['domain'].lstrip('.') == portal_hostname]
            session = {'access_token': token, 'host_id': host['host_id'], 'protocol': 'netschool-native-v1',
                       'school_uid': school_key, 'cookies': cookies, 'auth_method': method}
            client, http = NetSchoolClient(host, self.client), SgoHTTP(host, cookies, self.client)
            await client._initialize(http, session)
            if session.get('provider_school_id') is not None and str(session['provider_school_id']) != str(school['scid']):
                raise SgoUnsupported('Полученный дневник относится к другой школе')
            snapshot = await client.fetch(session, http=http, school=school)
            raw_expiry = grant.get('expires_in', 86400)
            if isinstance(raw_expiry, bool):
                raise SgoUnsupported('Неверный срок действия grant')
            lifetime = int(raw_expiry)
            if lifetime <= 0:
                raise SgoUnsupported('Срок grant уже истёк')
            self.vault.bind(uid, 'netschool', portal=host['base_url'], session=session,
                            expires=time.time() + min(86400, lifetime), snapshot=snapshot.model_dump(),
                            expected_school=school_key, expected_flow=digest, expected_oauth_tx=tx['tx_id'])
            return {'connected': True, 'uid': uid, 'session': session, 'snapshot': snapshot}
        except BaseException:
            # A code is single-use even when the network fails or the request is
            # cancelled. Retry means a NEW authorization, not a blind code replay.
            with self.repo.tx() as db:
                db.execute('DELETE FROM sgo_auth_flows WHERE digest=?', (digest,))
                db.execute("UPDATE sgo_oauth_transactions SET status='failed',error_code='exchange_failed' WHERE tx_id=? AND status='processing'", (tx['tx_id'],))
            raise
