"""Durable baseline + event outbox; no blind retry after ambiguous delivery.

Telegram sendMessage has no caller idempotency key. Commit-before-send trades
possible loss for no automatic duplicates: interrupted sends become uncertain.
This is explicitly not an exactly-once delivery guarantee.
"""
from __future__ import annotations
import hashlib
import json
import time
from datetime import datetime,timedelta,timezone
from zoneinfo import ZoneInfo
from app.diary_providers import ReauthRequired, ProviderUnavailable

DEFAULT_PREFS={'enabled':False,'private':True,'quiet_start':'22:00','quiet_end':'07:00','timezone':'Europe/Moscow','homework':False,'homework_per_day':2}
HOMEWORK_LIST_MAX=5

def _task_key(t):
    return str(t.get('id') or f"{t.get('title','')}|{t.get('deadline','')}")[:400]

def local_day(prefs,now):
    try:zone=ZoneInfo(prefs.get('timezone') or 'Europe/Moscow')
    except Exception:zone=ZoneInfo('Europe/Moscow')
    return datetime.fromtimestamp(now,zone).date().isoformat()

def due_time(prefs,now):
    local=datetime.fromtimestamp(now,ZoneInfo(prefs['timezone']))
    start=int(prefs['quiet_start'][:2])*60+int(prefs['quiet_start'][3:]);end=int(prefs['quiet_end'][:2])*60+int(prefs['quiet_end'][3:]);minute=local.hour*60+local.minute
    quiet=(start<=minute<end) if start<end else (minute>=start or minute<end) if start>end else False
    if not quiet:return now
    target=local.replace(hour=end//60,minute=end%60,second=0,microsecond=0)
    if target<=local:target+=timedelta(days=1)
    return target.timestamp()

def grade_recovery_trajectory(grades):
    """Exact, deterministic projection over supplied numeric marks only.

    A future five has weight one. No grade history is inferred from averages;
    the caller must label the scope (the loaded provider snapshot, not a quarter).
    Invalid explicit weights/marks are excluded, never silently replaced by one.
    v2.2: marks are parsed by app.grade_marks (one rule for the whole app): «5/4» counts as 5 and 4
    (it used to be read as the fraction 5/4 = 1.25), «4-» as 4, text marks (Н, Б, УП, Зач…) are skipped.
    """
    from fractions import Fraction
    from app.grade_marks import weighted
    total,weight_sum,count=weighted(grades)
    if not count:return None
    average=total/weight_sum
    target=Fraction(4) if average<4 else Fraction(9,2)
    needed=max(Fraction(0),(target*weight_sum-total)/(5-target))
    k=-(-needed.numerator//needed.denominator)
    return {'average':float(average),'target':float(target),'fives_needed':k,
            'projected_average':float((total+5*k)/(weight_sum+k)),
            'grade_count':count,'weight_sum':float(weight_sum),
            'scope':'loaded_snapshot','future_weight':1}


def is_low_grade(value):
    from app.grade_marks import is_low
    return is_low(value)


def subject_recovery(grades):
    groups={}
    for grade in grades:
        item=grade.model_dump() if hasattr(grade,'model_dump') else grade
        groups.setdefault(item['subject'],[]).append(item)
    return {subject:grade_recovery_trajectory(items) for subject,items in groups.items()}

class DeliveryRejected(Exception):
    def __init__(self,retry_after=None):self.retry_after=retry_after

class GradeWatcher:
    def __init__(self,repo,vault):self.repo=repo;self.vault=vault
    def preferences(self,uid):
        with self.repo.tx() as db:
            row=db.execute('SELECT payload FROM preferences WHERE uid=?',(uid,)).fetchone()
            return {**DEFAULT_PREFS,**(json.loads(row[0]) if row else {})}
    async def sync(self,uid,adapter,now=None,fence=None):
        now=time.time() if now is None else now
        conn=self.vault.get(uid)
        if not conn or conn['status'] not in {'connected','temporarily_unavailable'} or not conn['session']:return {'status':conn['status'] if conn else 'unsupported_manual','events':0}
        try:snapshot=await adapter.fetch(conn['session'])
        except ReauthRequired:
            return self._failure_result(uid,'reauth_required',conn,fence)
        except (ProviderUnavailable,TimeoutError):
            return self._failure_result(uid,'temporarily_unavailable',conn,fence)
        connection_id=conn['session']['connection_id'];prefs=self.preferences(uid)
        current={g.identity:g.model_dump() for g in snapshot.grades};events=[]
        recovery=subject_recovery(snapshot.grades)
        with self.repo.tx() as db:
            if fence is not None and not fence(db):return {'status':'revoked','events':0}
            # Disconnect/rebind during the network request must not resurrect data.
            actual=db.execute('SELECT ciphertext FROM connections WHERE uid=?',(uid,)).fetchone()
            if not actual or not actual[0] or self.vault.open(uid,'session',actual[0])['connection_id']!=connection_id:return {'status':'revoked','events':0}
            version=db.execute('SELECT revision FROM diary_sync_versions WHERE uid=?',(uid,)).fetchone()
            if (version[0] if version else 0)!=conn['_sync_revision']:
                return {'status':'connected','events':0,'stale':True}
            db.execute('INSERT INTO diary_sync_versions(uid,revision) VALUES(?,1) ON CONFLICT(uid) DO UPDATE SET revision=revision+1',(uid,))
            row=db.execute('SELECT payload FROM grade_snapshots WHERE uid=? AND connection_id=?',(uid,connection_id)).fetchone()
            previous=self.vault.open(uid,'grades',row[0]) if row else None
            rev=(previous['revision']+1) if previous else 0
            if previous:
                for gid,grade in current.items():
                    old=previous['grades'].get(gid)
                    if old is None or old['value']!=grade['value']:
                        events.append({'kind':'new_grade' if old is None else 'updated_grade','grade':grade,'previous':old['value'] if old else None})
            snapshot=snapshot.model_copy(update={'synced_at':datetime.fromtimestamp(now,timezone.utc).isoformat()})
            # v3.2 · новые ДЗ: сравнение с прошлым снимком (первый снимок — база, без сообщений); не больше
            # homework_per_day сообщений в день по часовому поясу ученика — все новые задания одной сводкой.
            tasks_now={_task_key(t):{'title':str(t.get('title') or '')[:300],'deadline':t.get('deadline')} for t in snapshot.tasks if t.get('title')}
            prev_tasks=previous.get('tasks') if previous else None
            fresh=[v for k,v in tasks_now.items() if prev_tasks is not None and k not in prev_tasks]
            today=local_day(prefs,now);quota=(previous or {}).get('hw_quota') or {}
            used=quota.get('n',0) if quota.get('day')==today else 0
            hw_event=None
            if fresh and prefs.get('homework') and used<int(prefs.get('homework_per_day') or 2):
                hw_event={'kind':'new_homework','tasks':fresh[:HOMEWORK_LIST_MAX],'total':len(fresh)};used+=1
            db.execute('INSERT OR REPLACE INTO grade_snapshots VALUES(?,?,?)',(uid,connection_id,self.vault.seal(uid,'grades',{'grades':current,'revision':rev,'is_baseline':previous is None,'tasks':tasks_now,'hw_quota':{'day':today,'n':used}})))
            if hw_event:
                eid=hashlib.sha256(f'{uid}:{connection_id}:{rev}:hw:{json.dumps(hw_event,sort_keys=True)}'.encode()).hexdigest()
                db.execute('INSERT OR IGNORE INTO notices(id,uid,payload,state,due) VALUES(?,?,?,?,?)',(eid,uid,self.vault.seal(uid,'notice',hw_event),'pending',due_time(prefs,now)))
            db.execute("UPDATE connections SET status='connected',snapshot=?,ciphertext=? WHERE uid=?",(self.vault.seal(uid,'snapshot',snapshot.model_dump()),self.vault.seal(uid,'session',conn['session']),uid))
            for event in events if prefs['enabled'] else []:
                plan=recovery.get(event['grade']['subject'])
                event['recovery_plan']=plan if is_low_grade(event['grade']['value']) else None
                if plan:event['grade']['average']=plan['average']
                eid=hashlib.sha256(f'{uid}:{connection_id}:{rev}:{event["grade"]["grade_id"]}:{json.dumps(event,sort_keys=True)}'.encode()).hexdigest()
                db.execute('INSERT OR IGNORE INTO notices(id,uid,payload,state,due) VALUES(?,?,?,?,?)',(eid,uid,self.vault.seal(uid,'notice',event),'pending',due_time(prefs,now)))
        return {'status':'connected','events':len(events)+(1 if hw_event else 0),'is_baseline':previous is None}
    def _failure_result(self,uid,status,conn,fence):
        if self.vault.set_status(uid,status,conn['session']['connection_id'],fence=fence,expected_revision=conn['_sync_revision']):
            return {'status':status,'events':0}
        current=self.vault.get(uid)
        return {'status':current['status'] if current else 'revoked','events':0,'stale':True}
    def recover_interrupted(self):
        with self.repo.tx() as db:db.execute("UPDATE notices SET state='uncertain' WHERE state='sending'")
    async def drain(self,sender,now=None):
        now=time.time() if now is None else now;sent=0
        with self.repo.tx() as db:rows=[dict(x) for x in db.execute("SELECT * FROM notices WHERE state='pending' AND due<=? ORDER BY due LIMIT 100",(now,))]
        for row in rows:
            uid=row['uid'];prefs=self.preferences(uid)
            if not (prefs['enabled'] or prefs.get('homework')):continue
            event=self.vault.open(uid,'notice',row['payload'])
            if not (prefs.get('homework') if event.get('kind')=='new_homework' else prefs['enabled']):continue
            due=due_time(prefs,now)
            if due>now:
                with self.repo.tx() as db:db.execute('UPDATE notices SET due=? WHERE id=? AND state=?',(due,row['id'],'pending'))
                continue
            connection=self.vault.get(uid)
            if not connection or connection['status'] not in {'connected','temporarily_unavailable'}:continue
            profiles=self.repo.profiles(uid);tg=[x[3:] for x in profiles if x.startswith('tg:')]
            if len(tg)!=1:continue
            with self.repo.tx() as db:
                cursor=db.execute("UPDATE notices SET state='sending',attempts=attempts+1 WHERE id=? AND state='pending'",(row['id'],))
                if cursor.rowcount!=1:continue
            try:
                message_id=await sender(tg[0],event,prefs['private'])
                state='sent';sent+=1;next_due=now
            except DeliveryRejected as exc:
                state='pending' if exc.retry_after is not None else 'failed';message_id=None;next_due=now+max(1,exc.retry_after or 0)
            except Exception:
                # A timeout may happen after Telegram accepted the message. Never
                # auto-retry it and do not log credentials, URLs or grade payload.
                state='uncertain';message_id=None;next_due=now
            with self.repo.tx() as db:db.execute("UPDATE notices SET state=?,telegram_id=?,due=? WHERE id=? AND state='sending'",(state,str(message_id) if message_id is not None else None,next_due,row['id']))
        return sent
