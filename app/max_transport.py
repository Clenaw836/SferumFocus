"""MAX transport: verified TLS, encrypted SQLite inbox/outbox, one POSIX owner.

No exactly-once claim: unknown POST outcomes are quarantined, not resent blindly.
Known rejections (429/attachment.not.ready) may retry. Terminal encrypted payloads
are erased; dedup tombstones expire after 7 days. Production runs one API worker.
"""
from __future__ import annotations
import asyncio
import contextvars
import hashlib
import json
import logging
import os
from pathlib import Path
import sqlite3
import ssl
import time
from contextlib import contextmanager
from urllib.parse import urlsplit

import httpx
from cryptography.fernet import Fernet

log = logging.getLogger('sferumfocus.max_transport')
CURRENT_EVENT = contextvars.ContextVar('max_event', default=None)
ROOT_SHA256 = 'd26d2d0231b7c39f92cc738512ba54103519e4405d68b5bd703e9788ca8ecf31'


def tls_context(ca_file=None):
    """Augment system roots, never replace them; no network/download at startup."""
    ctx = ssl.create_default_context()
    bundled = Path(__file__).with_name('certs') / 'russian_trusted_root_ca.pem'
    pem = bundled.read_text(encoding='ascii')
    if hashlib.sha256(ssl.PEM_cert_to_DER_cert(pem)).hexdigest() != ROOT_SHA256:
        raise ValueError('MAX bundled trust anchor integrity failure')
    ctx.load_verify_locations(cadata=pem)
    extra = ca_file or os.getenv('MAX_CA_FILE')
    if extra:
        ctx.load_verify_locations(cafile=str(extra))
    return ctx


def api_client(token, base='https://platform-api2.max.ru'):
    u = urlsplit(base)
    if (u.scheme != 'https' or u.hostname != 'platform-api2.max.ru'
            or u.username or u.password or u.query or u.fragment
            or u.path not in {'', '/'} or u.port not in {None, 443}):
        raise ValueError('MAX_API_BASE must be the official HTTPS API origin')
    return httpx.AsyncClient(base_url=base.rstrip('/'), headers={'Authorization': token},
                             verify=tls_context(), follow_redirects=False,
                             trust_env=False, timeout=45)


def split_text(text, limit=4000):
    """Plain text only: lossless paragraph/word splitting, Unicode-safe."""
    if not text:
        return ['']
    chunks = []
    while len(text) > limit:
        cut = text.rfind('\n', 0, limit + 1)
        if cut < limit // 2:
            cut = text.rfind(' ', 0, limit + 1)
        if cut < limit // 2:
            cut = limit
        chunks.append(text[:cut])
        text = text[cut:]
    if text:
        chunks.append(text)
    return chunks


class MaxQueue:
    def __init__(self, path, key, clock=time.time):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.cipher = Fernet(key.encode() if isinstance(key, str) else key)
        self.clock = clock
        fd = os.open(self.path, os.O_CREAT | os.O_RDWR, 0o600)
        os.close(fd)
        os.chmod(self.path, 0o600)
        with self.tx() as db:
            schema = '''
            CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,payload TEXT,state TEXT NOT NULL,created REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS sends(id TEXT PRIMARY KEY,recipient INTEGER NOT NULL,payload TEXT,state TEXT NOT NULL,due REAL NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,created REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS pacing(recipient INTEGER PRIMARY KEY,next_at REAL NOT NULL);
            '''
            for statement in schema.split(';'):
                if statement.strip():
                    db.execute(statement)
            if 'lane' not in {r[1] for r in db.execute('PRAGMA table_info(events)')}:
                db.execute('ALTER TABLE events ADD COLUMN lane INTEGER NOT NULL DEFAULT 0')
            db.execute('CREATE INDEX IF NOT EXISTS max_event_lane ON events(state,lane)')
            db.execute('CREATE INDEX IF NOT EXISTS max_send_due ON sends(state,due)')

    @contextmanager
    def tx(self):
        db = sqlite3.connect(self.path, timeout=5, isolation_level=None)
        db.row_factory = sqlite3.Row
        try:
            db.execute('PRAGMA busy_timeout=5000')
            db.execute('PRAGMA journal_mode=WAL')          # v3.0 DB-01
            db.execute('PRAGMA synchronous=FULL')
            db.execute('BEGIN IMMEDIATE')
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def seal(self, value):
        return self.cipher.encrypt(json.dumps(value, ensure_ascii=False).encode()).decode()

    def open(self, value):
        return json.loads(self.cipher.decrypt(value.encode()))

    def accept(self, update):
        if not isinstance(update, dict) or update.get('update_type') not in {'message_created', 'bot_started'}:
            return False
        # Event type + message ID is stable across retries of the same message.
        mid = ((update.get('message') or {}).get('body') or {}).get('mid')
        raw = json.dumps([update['update_type'], mid] if mid else update,
                         sort_keys=True, ensure_ascii=False, separators=(',', ':'))
        identity = hashlib.sha256(raw.encode()).hexdigest()
        user = ((update.get('message') or {}).get('sender') or {}) if update['update_type'] == 'message_created' else (update.get('user') or {})
        lane = user.get('user_id')
        if isinstance(lane, bool) or not isinstance(lane, int) or not 0 < lane < 2**63:
            raise ValueError('Invalid MAX event sender')
        with self.tx() as db:
            old = self.clock() - 7 * 86400
            db.execute("DELETE FROM events WHERE state NOT IN ('pending','running') AND created<?", (old,))
            db.execute("DELETE FROM sends WHERE state NOT IN ('pending','sending') AND created<?", (old,))
            if db.execute('SELECT 1 FROM events WHERE id=?', (identity,)).fetchone():
                return False
            if db.execute("SELECT count(*) FROM events WHERE lane=? AND state IN ('pending','running')", (lane,)).fetchone()[0] >= 50:
                raise ValueError('MAX per-user inbox capacity reached')
            if db.execute("SELECT count(*) FROM events WHERE state IN ('pending','running')").fetchone()[0] >= 2000:
                raise ValueError('MAX inbox capacity reached')
            return bool(db.execute('INSERT OR IGNORE INTO events(id,payload,state,created,lane) VALUES(?,?,?,?,?)',
                (identity, self.seal(update), 'pending', self.clock(), lane)).rowcount)

    def claim_event(self):
        with self.tx() as db:
            db.execute("UPDATE events SET state='expired',payload=NULL WHERE state='pending' AND created<?", (self.clock() - 86400,))
            row = db.execute("""SELECT e.* FROM events e WHERE e.state='pending'
                AND NOT EXISTS(SELECT 1 FROM events busy WHERE busy.lane=e.lane AND busy.state='running')
                ORDER BY e.rowid LIMIT 1""").fetchone()
            if not row:
                return None
            db.execute("UPDATE events SET state='running' WHERE id=?", (row['id'],))
            return row['id'], self.open(row['payload'])

    def finish_event(self, identity, state='done'):
        with self.tx() as db:
            db.execute('UPDATE events SET state=?,payload=NULL WHERE id=?', (state, identity))

    def enqueue(self, recipient, text, attachments=None, key=None):
        if isinstance(recipient, bool) or not isinstance(recipient, int) or recipient <= 0:
            raise ValueError('Invalid MAX recipient')
        import secrets
        key = key or secrets.token_hex(24)
        parts = split_text(text)
        with self.tx() as db:
            if db.execute("SELECT count(*) FROM sends WHERE state IN ('pending','sending')").fetchone()[0] + len(parts) > 10000:
                raise ValueError('MAX outbox capacity reached')
            for i, part in enumerate(parts):
                body = {'text': part}
                if attachments and i == len(parts) - 1:
                    body['attachments'] = attachments
                db.execute('INSERT OR IGNORE INTO sends(id,recipient,payload,state,due,created) VALUES(?,?,?,?,?,?)',
                           (f'{key}:{i:05}', recipient, self.seal(body), 'pending', self.clock(), self.clock()))

    def claim_send(self):
        now = self.clock()
        with self.tx() as db:
            db.execute("UPDATE sends SET state='expired',payload=NULL WHERE state='pending' AND created<?", (now - 86400,))
            row = db.execute('''SELECT s.* FROM sends s LEFT JOIN pacing p ON p.recipient=s.recipient
                WHERE s.state='pending' AND s.due<=? AND COALESCE(p.next_at,0)<=?
                AND NOT EXISTS (SELECT 1 FROM sends prev WHERE prev.recipient=s.recipient
                  AND prev.state IN ('pending','sending') AND prev.rowid<s.rowid)
                ORDER BY s.rowid LIMIT 1''', (now, now)).fetchone()
            if not row:
                return None
            db.execute("UPDATE sends SET state='sending',attempts=attempts+1 WHERE id=?", (row['id'],))
            # 0.55 rather than exactly 0.5 leaves scheduling/clock jitter margin.
            db.execute('INSERT OR REPLACE INTO pacing VALUES(?,?)', (row['recipient'], now + .55))
            return dict(row)

    def finish_send(self, row, state, delay=0):
        with self.tx() as db:
            db.execute('UPDATE sends SET state=?,due=?,payload=? WHERE id=?',
                       (state, self.clock() + delay, row['payload'] if state == 'pending' else None, row['id']))
            if state in {'uncertain', 'failed'}:
                # Do not send a tail of a multi-part answer after its head failed.
                prefix = row['id'].rsplit(':', 1)[0] + ':'
                db.execute("UPDATE sends SET state=?,payload=NULL WHERE state='pending' AND substr(id,1,?)=?",
                           (state, len(prefix), prefix))

    def recover(self):
        # Called only after obtaining the exclusive runtime lock. An interrupted
        # handler/send may already have performed a side effect: no blind replay.
        with self.tx() as db:
            db.execute("UPDATE sends SET state='uncertain',payload=NULL WHERE state='sending'")
            db.execute("UPDATE events SET state='uncertain',payload=NULL WHERE state='running'")
            old = self.clock() - 7 * 86400
            db.execute("DELETE FROM sends WHERE state NOT IN ('pending','sending') AND created<?", (old,))
            db.execute("DELETE FROM events WHERE state NOT IN ('pending','running') AND created<?", (old,))
            db.execute('DELETE FROM pacing WHERE next_at<?', (old,))

    def marker(self, value=None):
        with self.tx() as db:
            if value is not None:
                db.execute("INSERT OR REPLACE INTO meta VALUES('marker',?)", (str(int(value)),))
            r = db.execute("SELECT value FROM meta WHERE key='marker'").fetchone()
            return int(r[0]) if r else None

    def counts(self):
        with self.tx() as db:
            return {table: {r[0]: r[1] for r in db.execute(f'SELECT state,count(*) FROM {table} GROUP BY state')}
                    for table in ('events', 'sends')}


class MaxRuntime:
    def __init__(self, bot, queue):
        self.bot, self.queue = bot, queue
        self.bot.queue = queue
        self._lock_fd = None
        self._next_global = 0.0

    def acquire(self):
        import fcntl
        if self._lock_fd is not None:
            raise RuntimeError('MAX runtime already owned')
        fd = os.open(str(self.queue.path) + '.runtime.lock', os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(fd)
            raise RuntimeError('Another MAX runtime is active; polling and webhook cannot run together') from None
        self._lock_fd = fd
        self.queue.recover()

    async def close(self):
        try:
            await self.bot.http.aclose()
        finally:
            if self._lock_fd is not None:
                os.close(self._lock_fd)
                self._lock_fd = None

    async def event_once(self):
        item = self.queue.claim_event()
        if not item:
            return False
        identity, update = item
        token = CURRENT_EVENT.set([identity, 0])
        try:
            await self.bot.handle(update)
        except asyncio.CancelledError:
            self.queue.finish_event(identity, 'uncertain')
            raise
        except Exception:
            self.queue.finish_event(identity, 'failed')
            log.warning('MAX event failed; payload omitted')
        else:
            self.queue.finish_event(identity)
        finally:
            CURRENT_EVENT.reset(token)
        return True

    async def send_once(self):
        # 25/s is deliberately below the platform's global 30 requests/s.
        if time.monotonic() < self._next_global:
            return False
        row = self.queue.claim_send()
        if not row:
            return False
        self._next_global = time.monotonic() + .04
        try:
            response = await self.bot.http.post('/messages', params={'user_id': row['recipient']},
                                                  json=self.queue.open(row['payload']))
        except asyncio.CancelledError:
            self.queue.finish_send(row, 'uncertain')
            raise
        except httpx.RequestError:
            self.queue.finish_send(row, 'uncertain')
            log.warning('MAX send outcome unknown; not replayed automatically')
            return True
        try:
            data = response.json()
        except ValueError:
            data = {}
        code = data.get('code') if isinstance(data, dict) else None
        if response.status_code == 429 or code == 'attachment.not.ready':
            try:
                delay = min(3600, max(1, float(response.headers.get('Retry-After', '2'))))
            except ValueError:
                delay = 2
            self.queue.finish_send(row, 'pending' if row['attempts'] < 9 else 'failed',
                                   max(delay, min(300, 2 ** row['attempts'])))
        elif 200 <= response.status_code < 300 and isinstance(data, dict) and data.get('success') is not False and ('message' in data or data.get('success') is True):
            self.queue.finish_send(row, 'sent')
        elif response.status_code >= 500 or (200 <= response.status_code < 300 and not data):
            self.queue.finish_send(row, 'uncertain')
        else:
            self.queue.finish_send(row, 'failed')
        return True

    async def events(self):
        while True:
            try:
                if not await self.event_once():
                    await asyncio.sleep(.2)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.warning('MAX inbox unavailable; retrying safely')
                await asyncio.sleep(2)

    async def sends(self):
        while True:
            try:
                if not await self.send_once():
                    await asyncio.sleep(.05)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.warning('MAX outbox unavailable; retrying safely')
                await asyncio.sleep(2)


def configured_runtime():
    from app.bot import MaxBot
    from app.config import MAX_BOT_TOKEN, MAX_API_BASE, SFERUM_DATA_DIR
    if not MAX_BOT_TOKEN:
        raise ValueError('MAX_BOT_TOKEN required')
    key = os.getenv('DIARY_ENCRYPTION_KEY', '')
    if not key:
        raise ValueError('DIARY_ENCRYPTION_KEY required for encrypted MAX queues')
    namespace = hashlib.sha256(MAX_BOT_TOKEN.encode()).hexdigest()[:16]
    queue = MaxQueue(Path(SFERUM_DATA_DIR) / f'max-{namespace}.sqlite3', key)
    return MaxRuntime(MaxBot(MAX_BOT_TOKEN, base=MAX_API_BASE, queue=queue), queue)
