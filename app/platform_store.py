"""Persistent single-host SQLite repository. Secrets are never plaintext columns.

Separate immutable account uid from the legacy data_key: existing MAX data is
not silently moved/deleted. Linking two used accounts requires an explicit future
merge tool; this release refuses it rather than losing data.
"""
from __future__ import annotations
from contextlib import contextmanager
from app.json_storage import file_lock
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import sqlite3
import time
import uuid

class Conflict(ValueError):
    """Safe refusal: expiry, race, conflicting accounts or capacity."""

SCHEMA = '''
CREATE TABLE IF NOT EXISTS accounts(uid TEXT PRIMARY KEY, data_key TEXT UNIQUE NOT NULL, used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS identities(principal TEXT PRIMARY KEY, uid TEXT NOT NULL REFERENCES accounts(uid));
CREATE TABLE IF NOT EXISTS sessions(digest TEXT PRIMARY KEY, principal TEXT NOT NULL, expires REAL NOT NULL);
CREATE TABLE IF NOT EXISTS codes(digest TEXT PRIMARY KEY, owner TEXT NOT NULL, expires REAL NOT NULL, target TEXT, request_id TEXT UNIQUE);
CREATE TABLE IF NOT EXISTS limits(bucket TEXT PRIMARY KEY, expires REAL NOT NULL, attempts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS connections(uid TEXT PRIMARY KEY, provider TEXT NOT NULL, portal TEXT, status TEXT NOT NULL, expires REAL, ciphertext BLOB, snapshot TEXT);
CREATE TABLE IF NOT EXISTS diary_sync_versions(uid TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS preferences(uid TEXT PRIMARY KEY, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS grade_snapshots(uid TEXT NOT NULL, connection_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(uid,connection_id));
CREATE TABLE IF NOT EXISTS notices(id TEXT PRIMARY KEY, uid TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL, due REAL NOT NULL, telegram_id TEXT, attempts INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS shared(uid TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(uid,name));
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires);
CREATE INDEX IF NOT EXISTS sessions_principal ON sessions(principal);
CREATE INDEX IF NOT EXISTS identities_uid ON identities(uid);
CREATE INDEX IF NOT EXISTS codes_expires ON codes(expires);
CREATE INDEX IF NOT EXISTS limits_expires ON limits(expires);
CREATE INDEX IF NOT EXISTS notices_uid_state_due ON notices(uid,state,due);

'''

class PlatformStore:
    def __init__(self, path: str | Path, key: str):
        if len(key.encode()) < 32:
            raise ValueError('SESSION_SIGNING_KEY must contain at least 32 bytes')
        self.path = Path(path); self.key = key.encode()
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = os.open(self.path, os.O_CREAT | os.O_RDWR, 0o600); os.close(fd)
        os.chmod(self.path, 0o600)
        with self.tx() as db:
            for statement in SCHEMA.split(';'):
                if statement.strip():db.execute(statement)
            from app.connector_store import SCHEMA as CONNECTOR_SCHEMA
            for statement in CONNECTOR_SCHEMA.split(';'):
                if statement.strip():db.execute(statement)
            from app.sgo_directory import migrate
            migrate(db)
            # Recovery 2: additive, versioned teacher->student assignment tables.
            from app.assignments import platform_migrate
            platform_migrate(db)
            # v2.1: роль/школа/приватность, сессии СГО и SWR-кэш (идемпотентно, ALTER для недостающих колонок).
            from app.sgo_profiles import migrate as migrate_profiles
            migrate_profiles(db)
            from app.user_roles import migrate as migrate_roles
            migrate_roles(db)
            from app.teacher_journal_store import migrate as migrate_journal
            migrate_journal(db)

    @contextmanager
    def tx(self):
        # Local POSIX process + reentrant thread lock. Held for SHORT database
        # transactions only, never across await/network IO. SIGKILL releases flock;
        # SQLite's rollback journal, not replacing the database inode, recovers writes.
        with file_lock(self.path):
            db = sqlite3.connect(self.path, timeout=10)
            db.row_factory = sqlite3.Row
            try:
                db.execute('PRAGMA busy_timeout=10000')
                db.execute('PRAGMA journal_mode=WAL')      # v3.0 DB-01: читатели не ждут писателя
                db.execute('PRAGMA synchronous=FULL')
                db.execute('PRAGMA foreign_keys=ON')
                db.execute('PRAGMA secure_delete=ON')
                db.execute('BEGIN IMMEDIATE')
                yield db
                db.commit()
            except BaseException:
                db.rollback()
                raise
            finally:
                db.close()

    def digest(self, value: str) -> str:
        return hmac.new(self.key, value.encode(), hashlib.sha256).hexdigest()

    def _identity(self, db, principal):
        row = db.execute('SELECT a.* FROM identities i JOIN accounts a ON a.uid=i.uid WHERE principal=?', (principal,)).fetchone()
        if row: return dict(row)
        uid = str(uuid.uuid4())
        db.execute('INSERT INTO accounts(uid,data_key) VALUES(?,?)', (uid, principal))
        db.execute('INSERT INTO identities VALUES(?,?)', (principal, uid))
        return {'uid': uid, 'data_key': principal, 'used': 0}

    def identity(self, principal: str, used=False):
        with self.tx() as db:
            account = self._identity(db, principal)
            if used: db.execute('UPDATE accounts SET used=1 WHERE uid=?', (account['uid'],))
            return account

    def rate(self, bucket: str, limit=5, window=300, now=None):
        now = time.time() if now is None else now
        # Caller must commit the attempt even when subsequently refusing it.
        with self.tx() as db:
            db.execute('DELETE FROM limits WHERE expires<=?', (now,))
            row=db.execute('SELECT * FROM limits WHERE bucket=?', (bucket,)).fetchone()
            if row and row['attempts'] >= limit: return False
            db.execute('INSERT INTO limits VALUES(?,?,1) ON CONFLICT(bucket) DO UPDATE SET attempts=attempts+1', (bucket,now+window))
            return True

    def retry_after(self, bucket: str, now=None) -> int:
        """v2.3.2 · Секунды до сброса окна лимита (для Retry-After); 1, если окно уже истекло."""
        now = time.time() if now is None else now
        with self.tx() as db:
            row = db.execute('SELECT expires FROM limits WHERE bucket=?', (bucket,)).fetchone()
        return max(1, int(-(-(float(row[0]) - now) // 1))) if row else 1

    def issue_session(self, principal: str | None = None, ttl=7*86400):
        principal = principal or 'web:' + str(uuid.uuid4())
        raw = secrets.token_urlsafe(32); signed = raw + '.' + self.digest('session:'+raw)
        with self.tx() as db:
            db.execute('DELETE FROM sessions WHERE expires<=?', (time.time(),))
            self._identity(db, principal)
            db.execute('INSERT INTO sessions VALUES(?,?,?)', (self.digest(raw),principal,time.time()+ttl))
        return signed

    def session(self, signed: str):
        try: raw, signature = signed.split('.')
        except ValueError: return None
        if len(signed)>256 or not hmac.compare_digest(self.digest('session:'+raw).encode(),signature.encode()): return None
        with self.tx() as db:
            row=db.execute('SELECT principal FROM sessions WHERE digest=? AND expires>?',(self.digest(raw),time.time())).fetchone()
            return row['principal'] if row else None

    def revoke_session(self, signed):
        with self.tx() as db: db.execute('DELETE FROM sessions WHERE digest=?',(self.digest(signed.split('.')[0]),))

    def create_code(self, principal: str, now=None):
        now=time.time() if now is None else now
        if not self.rate('issue:'+principal,5,300,now): raise Conflict('Слишком много кодов; подожди 5 минут')
        for _ in range(10):
            code=f'{secrets.randbelow(1000000):06d}'
            with self.tx() as db:
                db.execute('DELETE FROM codes WHERE expires<=?',(now,))
                db.execute('DELETE FROM codes WHERE owner=?',(principal,))
                if db.execute('SELECT 1 FROM codes WHERE digest=?',(self.digest(code),)).fetchone(): continue
                db.execute('INSERT INTO codes(digest,owner,expires) VALUES(?,?,?)',(self.digest(code),principal,now+300))
                return code
        raise Conflict('Попробуй позже')

    def request_link(self, target: str, code: str, now=None):
        now=time.time() if now is None else now
        if not self.rate('redeem:'+target,5,300,now): raise Conflict('Лимит попыток; подожди 5 минут')
        with self.tx() as db:
            row=db.execute('SELECT * FROM codes WHERE digest=? AND expires>?',(self.digest(code),now)).fetchone()
            if not row or row['target'] or row['owner']==target: raise Conflict('Код недоступен')
            self._identity(db,target)
            rid=secrets.token_urlsafe(24)
            db.execute('UPDATE codes SET target=?,request_id=? WHERE digest=?',(target,rid,self.digest(code)))
            return rid

    def link_requests(self, owner):
        with self.tx() as db:
            return [dict(x) for x in db.execute('SELECT request_id,target,expires FROM codes WHERE owner=? AND target IS NOT NULL AND expires>?',(owner,time.time()))]

    def confirm_link(self, owner, rid, now=None):
        now=time.time() if now is None else now
        with self.tx() as db:
            row=db.execute('SELECT * FROM codes WHERE owner=? AND request_id=? AND expires>?',(owner,rid,now)).fetchone()
            if not row: raise Conflict('Запрос недоступен')
            source=self._identity(db,owner); target=self._identity(db,row['target'])
            if source['uid']!=target['uid']:
                n=db.execute('SELECT count(*) FROM identities WHERE uid=?',(target['uid'],)).fetchone()[0]
                used=target['used'] or n!=1
                for table in ['connections','preferences','shared','grade_snapshots','notices']:
                    used=used or bool(db.execute(f'SELECT 1 FROM {table} WHERE uid=? LIMIT 1',(target['uid'],)).fetchone())
                used=used or bool(db.execute('SELECT 1 FROM student_school_binding WHERE student_uid=? LIMIT 1',(target['uid'],)).fetchone())
                if used: raise Conflict('Оба аккаунта содержат данные: автоматическое слияние запрещено')
                # Preserve pre-existing legacy JSON data; never silently orphan it.
                needle=json.dumps(row['target'], ensure_ascii=False).encode()
                for path in self.path.parent.rglob('*.json'):
                    if path.stat().st_size > 64*1024*1024:
                        raise Conflict('Найдены прежние данные: требуется отдельная миграция')
                    raw = path.read_bytes()
                    if needle not in raw:
                        continue
                    # A profile read materializes this exact empty legacy record.
                    # Permit only that record, retaining the file unchanged.
                    if path.name == 'progress.json':
                        try:
                            document = json.loads(raw)
                            profile = document.get('users', {}).get(row['target'])
                            empty = {k: 0 for k in ('streak','points','miss','streak_peak','counted_days','perfect_days','early_plans','comebacks','flashcards','duels','plan_built')}
                            empty.update(unlocked=[], days={}, last_active=None)
                            rest = json.loads(raw)
                            rest.get('users', {}).pop(row['target'], None)
                            if profile == empty and needle not in json.dumps(rest, ensure_ascii=False).encode():
                                continue
                        except (ValueError, TypeError, AttributeError):
                            raise Conflict('Прежние данные не читаются: требуется миграция') from None
                    raise Conflict('Найдены прежние данные: требуется отдельная миграция')
                db.execute('UPDATE identities SET uid=? WHERE uid=?',(source['uid'],target['uid']))
                db.execute('DELETE FROM accounts WHERE uid=?',(target['uid'],))
            db.execute('DELETE FROM codes WHERE digest=?',(row['digest'],))
            # Revocation/reauth prevents a stale tab continuing with its old data scope.
            return source['uid']

    def profiles(self, uid):
        with self.tx() as db: return [x[0] for x in db.execute('SELECT principal FROM identities WHERE uid=?',(uid,))]
