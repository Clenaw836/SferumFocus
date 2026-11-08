"""Own-account handoff capabilities. No ESIA credentials, no cookie interception.
Six digits are a pairing hint, NOT sufficient authorization. A 256-bit capability
and final confirmation in the verified source account are mandatory.
"""
from __future__ import annotations
import hmac,json,os,secrets,time
from urllib.parse import parse_qs
from app.sgo_directory import Directory
from app.sgo_client import NetSchoolClient,SgoHTTP,SgoUnsupported

SCHEMA='''CREATE TABLE IF NOT EXISTS diary_handoffs(id TEXT PRIMARY KEY,uid TEXT NOT NULL,school_uid TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,expires REAL NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,cap_digest TEXT NOT NULL,code_digest TEXT NOT NULL,payload TEXT NOT NULL);CREATE INDEX IF NOT EXISTS handoff_uid ON diary_handoffs(uid);CREATE TABLE IF NOT EXISTS directory_query_cache(host_id TEXT NOT NULL,query TEXT NOT NULL,expires REAL NOT NULL,PRIMARY KEY(host_id,query));'''

def sandbox_enabled():return os.getenv('SFERUM_ESIA_SANDBOX')=='1' and os.getenv('SFERUM_ENV') in {'test','demo'}

class Handoff:
    def __init__(self,repo,vault,client=None):self.repo=repo;self.vault=vault;self.directory=Directory(repo);self.client=client
    def create(self,uid,kind,extra=None):
        school=self.directory.binding(uid)
        if not school:raise SgoUnsupported('Сначала выбери школу')
        if kind=='sandbox' and not sandbox_enabled():raise SgoUnsupported('Sandbox выключен: он не заменяет реальную ЕСИА')
        ident=secrets.token_urlsafe(32);cap=secrets.token_urlsafe(32);code=f'{secrets.randbelow(1000000):06d}'
        with self.repo.tx() as db:
            db.execute('DELETE FROM diary_handoffs WHERE expires<=? OR uid=?',(time.time(),uid))
            db.execute('INSERT INTO diary_handoffs(id,uid,school_uid,kind,status,expires,cap_digest,code_digest,payload) VALUES(?,?,?,?,?,?,?,?,?)',
                (ident,uid,school['school_uid'],kind,'2fa_required' if kind=='sandbox' else 'waiting_external',time.time()+(180 if kind=='sandbox' else 300),self.repo.digest(cap),self.repo.digest(ident+':'+code),self.vault.seal(uid,'handoff',extra or {})))
        return {'challenge_id':ident,'bridge_secret':cap,'link_code':code,'expires_in':180 if kind=='sandbox' else 300,'status':'2fa_required' if kind=='sandbox' else 'waiting_external','demo':kind=='sandbox','sgo_url':school['base_url']}
    def row(self,ident,uid=None):
        with self.repo.tx() as db:r=db.execute('SELECT * FROM diary_handoffs WHERE id=?',(ident,)).fetchone()
        if not r or (uid is not None and uid!=r['uid']):raise SgoUnsupported('Привязка не найдена')
        row=dict(r)
        if row['expires']<=time.time():
            with self.repo.tx() as db:db.execute('DELETE FROM diary_handoffs WHERE id=?',(ident,))
            raise SgoUnsupported('Срок привязки истёк; создай новую')
        school=self.directory.binding(row['uid'])
        if not school or school['school_uid']!=row['school_uid']:raise SgoUnsupported('Школа изменилась; начни привязку заново')
        return row
    def capable(self,ident,cap):
        row=self.row(ident)
        if not hmac.compare_digest(row['cap_digest'],self.repo.digest(cap)):raise SgoUnsupported('Ключ привязки недействителен')
        return row
    def status(self,uid,ident):
        r=self.row(ident,uid);extra=self.vault.open(uid,'handoff',r['payload'])
        if r['kind']=='oauth' and r['status']=='waiting_external':
            conn=self.vault.get(uid);session=(conn or {}).get('session') or {}
            if conn and conn['status']=='connected' and session.get('connection_id')!=extra.get('previous_connection_id') and session.get('school_uid')==r['school_uid'] and session.get('auth_method')=='gosuslugi_esia':
                with self.repo.tx() as db:db.execute("UPDATE diary_handoffs SET status='connected',payload=? WHERE id=?",(self.vault.seal(uid,'handoff',{}),ident))
                r['status']='connected'
        result={'challenge_id':ident,'status':r['status'],'demo':r['kind']=='sandbox','expires_in':max(0,int(r['expires']-time.time()))}
        if r['kind']=='sandbox' and r['status']=='2fa_required':result['resend_in']=max(0,int(extra.get('resend_after',time.time()+60)-time.time()+.999))
        if r['status']=='awaiting_confirmation':
            s=extra['session'];result['learner']={'name':s.get('student_name',''),'class_name':s.get('class_name',''),'portal':extra['portal']}
        return result
    def sandbox_code(self,ident,cap):
        if not sandbox_enabled():raise SgoUnsupported('Sandbox выключен')
        r=self.capable(ident,cap)
        if r['kind']!='sandbox' or r['status']!='2fa_required':raise SgoUnsupported('Тестовая проверка завершена')
        return self.vault.open(r['uid'],'handoff',r['payload'])['test_code']
    def start_sandbox(self,uid):
        d=self.create(uid,'sandbox');code=f'{secrets.randbelow(1000000):06d}'
        with self.repo.tx() as db:db.execute('UPDATE diary_handoffs SET code_digest=?,payload=? WHERE id=?',(self.repo.digest(d['challenge_id']+':'+code),self.vault.seal(uid,'handoff',{'test_code':code,'resend_after':time.time()+60}),d['challenge_id']))
        return d
    def resend_sandbox(self,uid,ident):
        if not sandbox_enabled():raise SgoUnsupported('Sandbox выключен')
        r=self.row(ident,uid)
        with self.repo.tx() as db:
            current=db.execute('SELECT * FROM diary_handoffs WHERE id=?',(ident,)).fetchone()
            if not current or current['uid']!=uid or current['expires']<=time.time():raise SgoUnsupported('Привязка отменена или истекла')
            r=dict(current)
            if r['kind']!='sandbox' or r['status']!='2fa_required' or r['attempts']>=5:raise SgoUnsupported('Проверка завершена или заблокирована')
            extra=self.vault.open(uid,'handoff',r['payload']);now=time.time()
            if now<extra.get('resend_after',now+60):raise SgoUnsupported('Повторный код доступен через 60 секунд')
            code=f'{secrets.randbelow(1000000):06d}'
            while code==extra.get('test_code'):code=f'{secrets.randbelow(1000000):06d}'
            db.execute('UPDATE diary_handoffs SET code_digest=?,payload=? WHERE id=?',(self.repo.digest(ident+':'+code),self.vault.seal(uid,'handoff',{'test_code':code,'resend_after':now+60}),ident))
        # Never reset attempt budget or extend original TTL on resend.
        return self.status(uid,ident)
    def verify_sandbox(self,uid,ident,code):
        if not sandbox_enabled():raise SgoUnsupported('Sandbox выключен')
        self.row(ident,uid);ok=False
        with self.repo.tx() as db:
            r=db.execute('SELECT * FROM diary_handoffs WHERE id=?',(ident,)).fetchone()
            if not r or r['uid']!=uid or r['expires']<=time.time():raise SgoUnsupported('Привязка отменена или истекла')
            if r['kind']!='sandbox' or r['status']!='2fa_required' or r['attempts']>=5:raise SgoUnsupported('Тестовая проверка заблокирована или завершена')
            ok=hmac.compare_digest(r['code_digest'],self.repo.digest(ident+':'+code))
            status='connected' if ok else 'locked' if r['attempts']+1>=5 else '2fa_required'
            db.execute('UPDATE diary_handoffs SET attempts=attempts+1,status=?,payload=? WHERE id=?',(status,self.vault.seal(uid,'handoff',{'demo_session':True}) if ok else r['payload'],ident))
        if not ok:raise SgoUnsupported('Неверный тестовый код; максимум 5 попыток')
        # Intentionally separate from real DiaryVault: cannot counterfeit a
        # connected school account or overwrite an existing real diary.
        return self.status(uid,ident)
    async def stage_bridge(self,ident,cap,code,token,cookies,origin):
        r=self.capable(ident,cap);uid=r['uid'];school=self.directory.binding(uid)
        app_origin=os.getenv('SFERUM_PUBLIC_ORIGIN','')
        if not app_origin or origin not in {app_origin,school['base_url']}:raise SgoUnsupported('Origin не совпадает с выбранным порталом')
        if r['kind']!='bridge':raise SgoUnsupported('Это не мост сессии')
        accepted=False
        with self.repo.tx() as db:
            current=db.execute('SELECT * FROM diary_handoffs WHERE id=?',(ident,)).fetchone()
            if not current or current['status']!='waiting_external' or current['expires']<=time.time():raise SgoUnsupported('Код уже использован или истёк')
            accepted=hmac.compare_digest(current['code_digest'],self.repo.digest(ident+':'+code))
            db.execute('UPDATE diary_handoffs SET attempts=attempts+1,status=? WHERE id=?',('validating' if accepted else 'locked' if current['attempts']+1>=5 else 'waiting_external',ident))
        if not accepted:raise SgoUnsupported('Неверный код привязки')
        try:
            host=self.directory.host(school['host_id']);session={'protocol':'netschool-native-v1','host_id':host['host_id'],'school_uid':school['school_uid'],'access_token':token,'cookies':cookies,'auth_method':'session_bridge'}
            native=NetSchoolClient(host,self.client);http=SgoHTTP(host,cookies,self.client)
            await native._initialize(http,session)
            expected=school.get('scid') or school.get('login_params',{}).get('scid')
            if session.get('provider_school_id') is not None and str(session['provider_school_id'])!=str(expected):raise SgoUnsupported('Сессия относится к другой школе')
            snapshot=await native.fetch(session,http=http,school=school)
            value={'session':session,'snapshot':snapshot.model_dump(),'portal':host['base_url']}
            with self.repo.tx() as db:
                actual=db.execute("SELECT 1 FROM diary_handoffs WHERE id=? AND status='validating' AND expires>?",(ident,time.time())).fetchone()
                binding=db.execute('SELECT school_uid FROM student_school_binding WHERE student_uid=?',(uid,)).fetchone()
                if not actual or not binding or binding[0]!=school['school_uid']:raise SgoUnsupported('Привязка отменена')
                db.execute("UPDATE diary_handoffs SET status='awaiting_confirmation',payload=? WHERE id=?",(self.vault.seal(uid,'handoff',value),ident))
            return {'status':'awaiting_confirmation','confirmation_required':True}
        except Exception:
            with self.repo.tx() as db:db.execute("UPDATE diary_handoffs SET status='failed',payload=? WHERE id=?",(self.vault.seal(uid,'handoff',{}),ident))
            raise
    def confirm(self,uid,ident):
        r=self.row(ident,uid)
        if r['kind']!='bridge' or r['status']!='awaiting_confirmation':raise SgoUnsupported('Нет сессии для подтверждения')
        data=self.vault.open(uid,'handoff',r['payload']);flow=self.repo.digest('handoff:'+ident)
        # CAS consumes confirmation once; vault atomically checks expected_flow
        # and expected_school before persisting session + baseline.
        with self.repo.tx() as db:
            cur=db.execute("UPDATE diary_handoffs SET status='confirming' WHERE id=? AND status='awaiting_confirmation'",(ident,))
            if cur.rowcount!=1:raise SgoUnsupported('Привязка уже использована')
            db.execute('INSERT INTO sgo_auth_flows VALUES(?,?,?,?,?,?)',(flow,uid,r['school_uid'],'consumed',r['expires'],'{}'))
        success=False
        try:
            self.vault.bind(uid,'netschool',portal=data['portal'],session=data['session'],snapshot=data['snapshot'],expires=time.time()+86400,expected_school=r['school_uid'],expected_flow=flow)
            success=True
        finally:
            with self.repo.tx() as db:
                db.execute('DELETE FROM sgo_auth_flows WHERE digest=?',(flow,))
                db.execute("UPDATE diary_handoffs SET status=?,payload=? WHERE id=?",('connected' if success else 'failed',self.vault.seal(uid,'handoff',{}),ident))
        return self.status(uid,ident)
    def cancel(self,uid,ident):
        self.row(ident,uid)
        with self.repo.tx() as db:
            db.execute('DELETE FROM diary_handoffs WHERE id=? AND uid=?',(ident,uid))
            db.execute('DELETE FROM sgo_auth_flows WHERE student_uid=?',(uid,))
        return {'status':'cancelled'}
