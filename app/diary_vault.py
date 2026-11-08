"""Encrypted session vault with uid/purpose binding. Key never stored in SQLite."""
from __future__ import annotations
from cryptography.fernet import Fernet, InvalidToken
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from app.session_cipher import SessionCipher
import base64
import json
import os
import time
import uuid
from app.diary_providers import DiarySnapshot

class EncryptedDiaryVault:
    def __init__(self,repo,key: str | None=None):
        self.repo=repo
        encoded_key = key if key is not None else os.getenv('DIARY_ENCRYPTION_KEY','')
        try:self.cipher=Fernet(encoded_key.encode())
        except (ValueError,TypeError) as exc:raise ValueError('DIARY_ENCRYPTION_KEY must be a Fernet key') from exc
        configured=os.getenv('DIARY_AES_KEYRING_JSON','')
        try:
            if configured:
                raw=json.loads(configured)
                if not isinstance(raw,dict):raise ValueError()
                keys={v:base64.b64decode(k,altchars=b'-_',validate=True) for v,k in raw.items()}
            else:
                # Domain-separated derived key; do not reuse Fernet's raw key as AES.
                keys={'v1':HKDF(algorithm=hashes.SHA256(),length=32,salt=None,info=b'sferumfocus/diary/aesgcm/v1').derive(base64.urlsafe_b64decode(encoded_key))}
            self.records=SessionCipher(keys,os.getenv('DIARY_AES_KEY_VERSION','v1'))
        except (ValueError,TypeError,AttributeError):raise ValueError('Invalid diary AES keyring configuration') from None
    @staticmethod
    def _context(uid,purpose):
        return json.dumps([uid,purpose],ensure_ascii=False,separators=(',',':')).encode()
    def seal(self,uid,purpose,value):
        raw=json.dumps({'uid':uid,'purpose':purpose,'value':value},ensure_ascii=False,separators=(',',':'))
        return self.records.encrypt(raw,self._context(uid,purpose))
    def open(self,uid,purpose,ciphertext):
        try:
            token=ciphertext.decode('ascii') if isinstance(ciphertext,bytes) else ciphertext
            raw=self.records.decrypt(token,self._context(uid,purpose)) if ':' in token else self.cipher.decrypt(token.encode())
            data=json.loads(raw)
            if data['uid']!=uid or data['purpose']!=purpose:raise ValueError('vault context mismatch')
            return data['value']
        except (InvalidToken,InvalidTag,KeyError,TypeError,ValueError,UnicodeError):raise ValueError('Encrypted record invalid') from None
    def bind(self,uid,provider,*,portal=None,session=None,expires=None,snapshot=None,expected_school=None,expected_flow=None,expected_oauth_tx=None):
        if provider not in {'manual','demo','netschool'}:raise ValueError('unknown provider')
        if provider=='netschool' and (not expires or expires<=time.time() or not session or not session.get('access_token')):raise ValueError('A valid expiring provider grant is required')
        secret={**(session or {}),'connection_id':str(uuid.uuid4())}
        status={'manual':'unsupported_manual','demo':'demo','netschool':'connected'}[provider]
        snap=DiarySnapshot.model_validate({**(snapshot or {}),'role':secret.get('role','student'),'is_teacher':secret.get('role')=='teacher'}).model_dump()
        with self.repo.tx() as db:
            if expected_oauth_tx is not None:
                tx=db.execute("SELECT 1 FROM sgo_oauth_transactions WHERE tx_id=? AND uid=? AND flow_digest=? AND status='processing' AND expires>?",(expected_oauth_tx,uid,expected_flow,time.time())).fetchone()
                if not tx:raise ValueError('OAuth транзакция отменена или истекла')
            if expected_flow is not None:
                flow=db.execute('SELECT 1 FROM sgo_auth_flows WHERE digest=? AND student_uid=? AND expires>? AND method=?',(expected_flow,uid,time.time(),'consumed')).fetchone()
                if not flow:raise ValueError('Вход отменён или истёк')
                db.execute('DELETE FROM sgo_auth_flows WHERE digest=?',(expected_flow,))
            if expected_school is not None:
                row=db.execute('SELECT school_uid FROM student_school_binding WHERE student_uid=?',(uid,)).fetchone()
                if not row or row[0]!=expected_school:raise ValueError('Школа изменилась во время входа')
            db.execute('INSERT INTO diary_sync_versions(uid,revision) VALUES(?,0) ON CONFLICT(uid) DO UPDATE SET revision=revision+1',(uid,))
            db.execute('DELETE FROM notices WHERE uid=?',(uid,));db.execute('DELETE FROM grade_snapshots WHERE uid=?',(uid,))
            db.execute('INSERT INTO connections VALUES(?,?,?,?,?,?,?) ON CONFLICT(uid) DO UPDATE SET provider=excluded.provider,portal=excluded.portal,status=excluded.status,expires=excluded.expires,ciphertext=excluded.ciphertext,snapshot=excluded.snapshot',
                (uid,provider,portal,status,expires,self.seal(uid,'session',secret),self.seal(uid,'snapshot',snap)))
            if expected_oauth_tx is not None:
                db.execute("UPDATE sgo_oauth_transactions SET status='connected',connection_id=?,error_code=NULL WHERE tx_id=?",(secret['connection_id'],expected_oauth_tx))
            db.execute('DELETE FROM connector_jobs WHERE uid=?',(uid,))
            if provider=='netschool' and secret.get('role')!='teacher':
                db.execute('INSERT INTO connector_jobs(uid,portal,next_due) VALUES(?,?,?)',(uid,portal or '',time.time()))
            if provider=='netschool' and secret.get('protocol')=='netschool-native-v1':
                from app.sgo_directory import utc
                db.execute('UPDATE student_school_binding SET sgo_student_id=?,student_display_name=?,class_name=?,last_login_at=?,preferred_auth_method=? WHERE student_uid=?',(secret.get('student_id'),secret.get('student_name'),secret.get('class_name'),utc(),secret.get('auth_method','sgo_credentials'),uid))
                baseline={g.identity:g.model_dump() for g in DiarySnapshot.model_validate(snap).grades}
                db.execute('INSERT INTO grade_snapshots VALUES(?,?,?)',(uid,secret['connection_id'],self.seal(uid,'grades',{'grades':baseline,'revision':0,'is_baseline':True})))
    def refresh_snapshot(self,uid,snapshot,*,connection_id,revision,expires):
        """V2.3 BUG-001: a user refresh writes the snapshot every screen reads. Fenced: a disconnect, a rebind
        or a newer watcher write during the network request wins, and nothing is resurrected."""
        snap=DiarySnapshot.model_validate(snapshot or {}).model_dump()
        if not snap.get('synced_at'):
            from datetime import datetime,timezone
            snap['synced_at']=datetime.now(timezone.utc).isoformat()
        with self.repo.tx() as db:
            row=db.execute("SELECT ciphertext FROM connections WHERE uid=? AND provider='netschool'",(uid,)).fetchone()
            if not row or not row[0] or self.open(uid,'session',row[0]).get('connection_id')!=connection_id:return False
            version=db.execute('SELECT revision FROM diary_sync_versions WHERE uid=?',(uid,)).fetchone()
            if (version[0] if version else 0)!=revision:return False
            db.execute('INSERT INTO diary_sync_versions(uid,revision) VALUES(?,1) ON CONFLICT(uid) DO UPDATE SET revision=revision+1',(uid,))
            db.execute("UPDATE connections SET status='connected',snapshot=?,expires=MAX(COALESCE(expires,0),?) WHERE uid=?",(self.seal(uid,'snapshot',snap),expires,uid))
        return True
    def get(self,uid):
        with self.repo.tx() as db:
            row=db.execute('SELECT * FROM connections WHERE uid=?',(uid,)).fetchone()
            if not row:return None
            data=dict(row)
            version=db.execute('SELECT revision FROM diary_sync_versions WHERE uid=?',(uid,)).fetchone()
            data['_sync_revision']=version[0] if version else 0
            if data['expires'] and data['expires']<=time.time() and data['status'] in {'connected','temporarily_unavailable'}:
                data['status']='reauth_required';db.execute("UPDATE connections SET status='reauth_required',ciphertext=NULL WHERE uid=?",(uid,));data['ciphertext']=None
            data['session']=self.open(uid,'session',data.pop('ciphertext')) if data['ciphertext'] else None
            data['snapshot']=self.open(uid,'snapshot',data['snapshot']) if data['snapshot'] else {}
            return data
    def status(self,uid):
        r=self.get(uid)
        from app.diary_cache import cache_metadata
        public={'status':r['status'],'provider':r['provider'],'portal':r['portal'],'expires':r['expires']} if r else {'status':'unsupported_manual','provider':'manual','portal':None,'expires':None}
        from app.user_roles import role_fields
        return {**public,**cache_metadata(r),**role_fields(self.repo,uid)}
    def set_status(self,uid,status,expected_connection_id=None,*,fence=None,expected_revision=None):
        with self.repo.tx() as db:
            if fence is not None and not fence(db):return False
            if expected_revision is not None:
                version=db.execute('SELECT revision FROM diary_sync_versions WHERE uid=?',(uid,)).fetchone()
                if (version[0] if version else 0)!=expected_revision:return False
            if expected_connection_id is not None:
                row=db.execute('SELECT ciphertext FROM connections WHERE uid=?',(uid,)).fetchone()
                if not row or not row[0] or self.open(uid,'session',row[0]).get('connection_id') != expected_connection_id:
                    return False
            db.execute('UPDATE connections SET status=? WHERE uid=?',(status,uid))
            db.execute('INSERT INTO diary_sync_versions(uid,revision) VALUES(?,1) ON CONFLICT(uid) DO UPDATE SET revision=revision+1',(uid,))
            if status in {'reauth_required','revoked'}:
                db.execute('UPDATE connections SET ciphertext=NULL WHERE uid=?',(uid,))
                db.execute("UPDATE notices SET state='cancelled' WHERE uid=? AND state IN ('pending','sending')",(uid,))
            return True
    def disconnect(self,uid):
        with self.repo.tx() as db:
            db.execute('DELETE FROM sgo_auth_flows WHERE student_uid=?',(uid,))
            db.execute('DELETE FROM sgo_oauth_transactions WHERE uid=?',(uid,))
            db.execute('DELETE FROM diary_handoffs WHERE uid=?',(uid,))
            db.execute('UPDATE student_school_binding SET sgo_student_id=NULL,student_display_name=NULL,class_name=NULL,last_login_at=NULL WHERE student_uid=?',(uid,))
            for table in ['connector_jobs','connections','grade_snapshots','notices','diary_sync_versions']:
                db.execute(f'DELETE FROM {table} WHERE uid=?',(uid,))
        return {'status':'revoked','deleted':True}
