"""Durable single-host connector queue. No provider secrets in job/lease rows.

SQLite BEGIN IMMEDIATE serializes claims across API/worker processes. Leases and
fencing prevent duplicate polls and stale writes after a reconnect/disconnect.
Not a distributed multi-node database: use the same local POSIX volume.
"""
from __future__ import annotations
import time,secrets

SCHEMA='''
CREATE TABLE IF NOT EXISTS connector_jobs(uid TEXT PRIMARY KEY REFERENCES connections(uid) ON DELETE CASCADE, portal TEXT NOT NULL, next_due REAL NOT NULL, lease_token TEXT, lease_until REAL NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, last_attempt REAL, last_success REAL, last_result TEXT NOT NULL DEFAULT 'queued', requested INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS connector_due ON connector_jobs(next_due,lease_until);
CREATE TABLE IF NOT EXISTS connector_workers(worker_id TEXT PRIMARY KEY, heartbeat REAL NOT NULL);
CREATE TABLE IF NOT EXISTS connector_locks(name TEXT PRIMARY KEY, token TEXT NOT NULL, expires REAL NOT NULL);
CREATE TABLE IF NOT EXISTS connector_catalog(host_id TEXT PRIMARY KEY, next_due REAL NOT NULL, token TEXT, lease_until REAL NOT NULL DEFAULT 0, last_success REAL, last_result TEXT NOT NULL DEFAULT 'queued');
'''
ACTIVE="provider='netschool' AND status IN ('connected','temporarily_unavailable') AND ciphertext IS NOT NULL"
RESULTS={'connected','temporarily_unavailable','reauth_required','revoked','unsupported_manual','error'}

class ConnectorQueue:
    def __init__(self,repo):self.repo=repo
    def reconcile(self,now=None):
        now=time.time() if now is None else now
        with self.repo.tx() as db:
            db.execute(f"DELETE FROM connector_jobs WHERE uid NOT IN (SELECT uid FROM connections WHERE {ACTIVE})")
            db.execute(f"INSERT OR IGNORE INTO connector_jobs(uid,portal,next_due) SELECT uid,COALESCE(portal,''),? FROM connections WHERE {ACTIVE}",(now,))
            db.execute('DELETE FROM connector_workers WHERE heartbeat<?',(now-86400,))
    def enqueue(self,uid,now=None):
        now=time.time() if now is None else now
        with self.repo.tx() as db:
            row=db.execute(f'SELECT portal FROM connections WHERE uid=? AND {ACTIVE}',(uid,)).fetchone()
            if not row:return False
            db.execute('INSERT INTO connector_jobs(uid,portal,next_due,requested) VALUES(?,?,?,1) ON CONFLICT(uid) DO UPDATE SET next_due=MIN(next_due,excluded.next_due),requested=1',(uid,row[0] or '',now))
        return True
    def claim(self,limit=4,now=None,lease=180):
        if not 1<=limit<=16 or lease<150:raise ValueError('Invalid claim bounds')
        now=time.time() if now is None else now;claimed=[]
        with self.repo.tx() as db:
            # Fetch a bounded candidate page. Due time advances on every completion,
            # so large installations do not starve accounts after the first 500.
            rows=db.execute(f"SELECT * FROM (SELECT j.*,ROW_NUMBER() OVER(PARTITION BY j.portal ORDER BY j.next_due,j.uid) AS portal_rank FROM connector_jobs j JOIN connections c ON c.uid=j.uid WHERE j.next_due<=? AND j.lease_until<=? AND c.{ACTIVE}) WHERE portal_rank<=2 ORDER BY next_due,uid LIMIT 256",(now,now)).fetchall()
            for row in rows:
                if len(claimed)>=limit:break
                # At most two concurrent requests to a regional portal across processes.
                if db.execute('SELECT count(*) FROM connector_jobs WHERE portal=? AND lease_until>?',(row['portal'],now)).fetchone()[0]>=2:continue
                token=secrets.token_urlsafe(24)
                db.execute('UPDATE connector_jobs SET lease_token=?,lease_until=?,last_attempt=?,last_result=? WHERE uid=?',(token,now+lease,now,'syncing',row['uid']))
                claimed.append({**dict(row),'lease_token':token,'lease_until':now+lease})
        return claimed
    def claim_one(self,uid,now=None):
        """Lease for the backward-compatible synchronous server API."""
        now=time.time() if now is None else now
        with self.repo.tx() as db:
            row=db.execute(f"SELECT j.* FROM connector_jobs j JOIN connections c ON c.uid=j.uid WHERE j.uid=? AND j.lease_until<=? AND c.{ACTIVE}",(uid,now)).fetchone()
            if not row:return None
            if db.execute('SELECT count(*) FROM connector_jobs WHERE portal=? AND lease_until>?',(row['portal'],now)).fetchone()[0]>=2:return None
            token=secrets.token_urlsafe(24)
            db.execute('UPDATE connector_jobs SET lease_token=?,lease_until=?,last_attempt=?,last_result=?,requested=0 WHERE uid=?',(token,now+180,now,'syncing',uid))
            return {**dict(row),'lease_token':token}

    @staticmethod
    def valid(db,uid,token,now=None):
        return bool(db.execute('SELECT 1 FROM connector_jobs WHERE uid=? AND lease_token=? AND lease_until>?',(uid,token,time.time() if now is None else now)).fetchone())
    def finish(self,uid,token,result,interval=300,now=None):
        if result not in RESULTS:raise ValueError('Unrecognized outcome')
        now=time.time() if now is None else now
        with self.repo.tx() as db:
            row=db.execute('SELECT * FROM connector_jobs WHERE uid=? AND lease_token=?',(uid,token)).fetchone()
            if not row:return False
            if result in {'reauth_required','revoked','unsupported_manual'}:
                db.execute('DELETE FROM connector_jobs WHERE uid=? AND lease_token=?',(uid,token));return True
            ok=result=='connected';failures=0 if ok else min(16,row['failures']+1)
            # Exponential bounded network backoff. Never retry bad credentials.
            delay=min(480,max(60,interval)) if ok else min(1800,60*2**min(failures-1,5))
            requested=row['requested'] # a user request made during the poll survives
            due=now if requested else now+delay
            db.execute('UPDATE connector_jobs SET lease_token=NULL,lease_until=0,next_due=?,failures=?,last_result=?,last_success=CASE WHEN ? THEN ? ELSE last_success END,requested=0 WHERE uid=? AND lease_token=?',(due,failures,result,ok,now,uid,token))
        return True
    def begin(self,uid,token):
        with self.repo.tx() as db:db.execute('UPDATE connector_jobs SET requested=0 WHERE uid=? AND lease_token=?',(uid,token))
    def release(self,uid,token):
        with self.repo.tx() as db:db.execute('UPDATE connector_jobs SET lease_token=NULL,lease_until=0 WHERE uid=? AND lease_token=?',(uid,token))
    def heartbeat(self,worker_id,now=None):
        with self.repo.tx() as db:db.execute('INSERT INTO connector_workers VALUES(?,?) ON CONFLICT(worker_id) DO UPDATE SET heartbeat=excluded.heartbeat',(worker_id,time.time() if now is None else now))
    def stop(self,worker_id):
        with self.repo.tx() as db:db.execute('DELETE FROM connector_workers WHERE worker_id=?',(worker_id,))
    def lock(self,name,now=None,ttl=180):
        now=time.time() if now is None else now;token=secrets.token_urlsafe(24)
        with self.repo.tx() as db:
            row=db.execute('SELECT expires FROM connector_locks WHERE name=?',(name,)).fetchone()
            if row and row[0]>now:return None
            db.execute('INSERT OR REPLACE INTO connector_locks VALUES(?,?,?)',(name,token,now+ttl))
        return token
    def unlock(self,name,token):
        with self.repo.tx() as db:db.execute('DELETE FROM connector_locks WHERE name=? AND token=?',(name,token))
    def status(self,uid,now=None):
        now=time.time() if now is None else now
        with self.repo.tx() as db:
            row=db.execute('SELECT next_due,last_attempt,last_success,last_result,lease_until FROM connector_jobs WHERE uid=?',(uid,)).fetchone()
            online=bool(db.execute('SELECT 1 FROM connector_workers WHERE heartbeat>? LIMIT 1',(now-45,)).fetchone())
        return {'execution':'server','worker_online':online,'sync':dict(row) if row else None}
    def catalog_claim(self,now=None):
        now=time.time() if now is None else now
        with self.repo.tx() as db:
            # Only preconfigured registry hosts, not user-enrolled arbitrary hosts.
            db.execute("INSERT OR IGNORE INTO connector_catalog(host_id,next_due) SELECT host_id,? FROM sgo_hosts_registry WHERE is_active=1 AND host_id NOT LIKE 'custom-%'",(now,))
            row=db.execute('SELECT j.host_id FROM connector_catalog j JOIN sgo_hosts_registry h ON h.host_id=j.host_id WHERE h.is_active=1 AND next_due<=? AND lease_until<=? ORDER BY next_due,j.host_id LIMIT 1',(now,now)).fetchone()
            if not row:return None
            token=secrets.token_urlsafe(24)
            db.execute('UPDATE connector_catalog SET token=?,lease_until=? WHERE host_id=?',(token,now+90,row[0]))
        return {'host_id':row[0],'token':token}
    def catalog_finish(self,host_id,token,ok,now=None):
        now=time.time() if now is None else now
        with self.repo.tx() as db:db.execute('UPDATE connector_catalog SET next_due=?,token=NULL,lease_until=0,last_result=?,last_success=CASE WHEN ? THEN ? ELSE last_success END WHERE host_id=? AND token=?',(now+(86400 if ok else 3600),'received' if ok else 'unavailable',ok,now,host_id,token))
