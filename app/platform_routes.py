"""Account/session/linking and diary APIs. No uid/owner is accepted from a client."""
from __future__ import annotations
import json
import os
import sqlite3
from app.auth_diagnostics import report
import time
from datetime import date
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from urllib.parse import urlsplit
from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field, StrictBool, field_validator
from app.platform_auth import COOKIE, cookie_of, csrf, enabled, store
from app.platform_store import Conflict
from app.diary_vault import EncryptedDiaryVault
from app.diary_providers import DiarySnapshot, portal_origin, profiles, UnsupportedPortal
from app.grade_watcher import DEFAULT_PREFS
from app.sgo_routes import Login as NativeLogin

router=APIRouter()
class Strict(BaseModel):model_config=ConfigDict(extra='forbid')
class Code(Strict):code:str=Field(pattern=r'^\d{6}$')
class Confirmation(Strict):request_id:str=Field(min_length=10,max_length=100)
class Connect(Strict):
    provider:str=Field(pattern='^(manual|demo|netschool)$')
    portal:str|None=Field(default=None,max_length=300)
class NotificationPrefs(Strict):
    enabled:bool=False
    private:bool=True
    quiet_start:str=Field(default='22:00',pattern=r'^(?:[01]\d|2[0-3]):[0-5]\d$')
    quiet_end:str=Field(default='07:00',pattern=r'^(?:[01]\d|2[0-3]):[0-5]\d$')
    timezone:str=Field(default='Europe/Moscow',max_length=100)
    # v3.2: новые ДЗ — отдельный переключатель и лимит сообщений в день (1–2), чтобы бот не спамил
    homework:bool=False
    homework_per_day:int=Field(default=2,ge=1,le=2)
    @field_validator('timezone')
    @classmethod
    def timezone_valid(cls,v):
        try:ZoneInfo(v)
        except (ZoneInfoNotFoundError,ValueError) as exc:raise ValueError('Unknown timezone') from exc
        return v
class SharedWrite(Strict):
    version:int=Field(ge=0)
    payload:dict

def account(request):
    value=getattr(request.state,'platform_account',None)
    if not value:raise HTTPException(401,'Требуется проверенная сессия')
    return value

def vault():
    try:return EncryptedDiaryVault(store())
    except ValueError:raise HTTPException(503,'Зашифрованное хранилище не настроено')

def web_origin(request):
    expected=os.getenv('SFERUM_PUBLIC_ORIGIN','')
    if not expected or request.headers.get('origin')!=expected:raise HTTPException(403,'Origin не принят')
    return expected

SHARED_ADDRESS_FACTOR=max(1,int(os.getenv('RATE_LIMIT_SHARED_ADDRESS_FACTOR','40') or 40))

def too_many(bucket,detail='Слишком много запросов'):
    """v2.3.2 (D5) · 429 всегда с Retry-After и машиночитаемым кодом RATE_LIMITED."""
    from app.api_errors import CodedError
    return CodedError(429,'RATE_LIMITED',detail,retry_after=store().retry_after(bucket))

def rate(request,kind,limit):
    # Peer address, never untrusted X-Forwarded-For. Configure trusted proxy at ASGI (FORWARDED_ALLOW_IPS).
    # V2.3 BUG-003: a signed MAX/Telegram account is limited per account; its address gets a class-sized
    # ceiling, so one school NAT does not lock a class out. Anonymous and guest requests keep the strict
    # per-address limit. No global bucket: one client could exhaust it and block everyone.
    peer=request.client.host if request.client else 'unknown'
    who=getattr(request.state,'platform_principal',None)
    signed=getattr(request.state,'platform_auth',None) in {'telegram','max'} or str(who or '').startswith(('tg:','max:'))
    if signed and who:
        if not store().rate(kind+':acct:'+str(who),limit,300):raise too_many(kind+':acct:'+str(who))
        limit*=SHARED_ADDRESS_FACTOR
    if not store().rate(kind+':'+peer,limit,300):raise too_many(kind+':'+peer)

class AiConsentChoice(Strict):
    granted: StrictBool
    policy_version: str = Field(min_length=1, max_length=80)

@router.get('/api/v1/ai/consent')
def ai_consent_get(request: Request, response: Response):
    from app.ai_gate import consent_state
    uid = account(request)['uid']
    response.headers['Cache-Control'] = 'no-store'
    return consent_state(store(), uid)

@router.put('/api/v1/ai/consent')
def ai_consent_set(body: AiConsentChoice, request: Request, response: Response):
    from app import ai_gate
    uid = account(request)['uid']
    rate(request, 'ai-consent', 30)
    if body.granted and body.policy_version != ai_gate.CONSENT_POLICY_VERSION:
        raise HTTPException(409, 'Текст согласия изменился. Обновите приложение и ознакомьтесь с ним снова.')
    if body.granted:
        ai_gate.grant(store(), uid)
    else:
        ai_gate.revoke(store(), uid)
    response.headers['Cache-Control'] = 'no-store'
    return ai_gate.consent_state(store(), uid)

@router.post('/api/v1/auth/web-session')
def web_session(request:Request,response:Response):
    if not enabled():
        report('platform_mode_disabled')
        raise HTTPException(503,'Мультиплатформенный режим выключен')
    origin=web_origin(request)
    if request.headers.get('x-web-bootstrap')!='1':raise HTTPException(403,'Нужен запрос приложения')
    try:
        old=cookie_of(dict(request.headers));principal=store().session(old) if old else None
        # A signed host bootstrap must never adopt another browser account's cookie.
        verified=getattr(request.state,'platform_principal',None) if getattr(request.state,'platform_auth',None) in {'telegram','max'} else None
        if principal and (not verified or principal==verified):
            signed=old
        else:
            rate(request,'bootstrap',20);signed=store().issue_session(verified)
    except (ValueError,OSError,sqlite3.Error) as exc:
        report('web_session_store_unavailable', exc)
        raise HTTPException(503,'Веб-сессии не настроены')
    secure=urlsplit(origin).scheme=='https'
    if not secure and os.getenv('SFERUM_ENV','production') not in {'test','demo'}:raise HTTPException(503,'Нужен HTTPS')
    response.set_cookie(COOKIE,signed,httponly=True,secure=secure,samesite='none' if secure else 'lax',max_age=7*86400,path='/')
    response.headers['Cache-Control']='no-store'
    return {'csrf_token':csrf(signed)}

@router.get('/api/v1/auth/session')
def session_info(request:Request):
    a=account(request);cookie=getattr(request.state,'platform_cookie','')
    return {'uid':a['uid'],'principal':request.state.platform_principal,'auth':request.state.platform_auth,'profiles':store().profiles(a['uid']),'csrf_token':csrf(cookie) if cookie else None}

@router.post('/api/v1/auth/logout')
def logout(request:Request,response:Response):
    account(request);cookie=getattr(request.state,'platform_cookie','')
    if cookie:store().revoke_session(cookie)
    origin=os.getenv('SFERUM_PUBLIC_ORIGIN','')
    secure=urlsplit(origin).scheme=='https'
    response.delete_cookie(COOKIE,path='/',httponly=True,secure=secure,samesite='none' if secure else 'lax');return {'logged_out':True}

@router.post('/api/v1/auth/link-code')
def link_code(request:Request):
    account(request);rate(request,'link-issue',20)
    try:return {'code':store().create_code(request.state.platform_principal),'expires_in':300,'confirmation_required':True}
    except Conflict as exc:raise HTTPException(409,str(exc))

@router.post('/api/v1/auth/link-request')
def request_link(body:Code,request:Request):
    account(request);rate(request,'link-redeem',20)
    try:return {'request_id':store().request_link(request.state.platform_principal,body.code),'status':'awaiting_source_confirmation'}
    except Conflict as exc:raise HTTPException(409,str(exc))

@router.get('/api/v1/auth/link-requests')
def link_requests(request:Request):
    account(request);return {'requests':store().link_requests(request.state.platform_principal)}

@router.post('/api/v1/auth/link-confirm')
def link_confirm(body:Confirmation,request:Request):
    account(request)
    try:return {'uid':store().confirm_link(request.state.platform_principal,body.request_id),'reload_required':True}
    except Conflict as exc:raise HTTPException(409,str(exc))

@router.get('/api/v1/diary/catalog')
def catalog(request:Request):
    account(request)
    try:items=[{k:p.get(k) for k in ['id','name','region','origin']} for p in profiles()]
    except (ValueError,KeyError):raise HTTPException(503,'Каталог не настроен')
    return {'portals':items,'custom_https_url_supported':True,'unverified_portals':'unsupported_manual'}

@router.get('/api/v1/diary/status')
def diary_status(request:Request):return vault().status(account(request)['uid'])

@router.post('/api/v1/diary/connect')
async def diary_connect(body:Connect|NativeLogin,request:Request):
    if isinstance(body,NativeLogin):
        from app.sgo_routes import connect as native_connect
        return await native_connect(body,request)
    uid=account(request)['uid']
    if body.provider=='netschool':
        try:origin=portal_origin(body.portal or '')
        except UnsupportedPortal as exc:raise HTTPException(422,str(exc))
        # Public URL enrollment does not authorize access or accept cookies.
        return {'status':'unsupported_manual','portal':origin,'reason':'Нужен подтверждённый контракт авторизации провайдера; токены через браузер не принимаются'}
    if body.provider=='demo' and os.getenv('SFERUM_ENV','production') not in {'demo','test'}:raise HTTPException(403,'DEMO недоступен')
    existing=vault().get(uid)
    if existing and existing['provider']!=body.provider:raise HTTPException(409,'Сначала явно отключи существующий дневник')
    vault().bind(uid,body.provider)
    return vault().status(uid)

@router.post('/api/v1/diary/manual-import')
def manual_import(body:DiarySnapshot,request:Request):
    uid=account(request)['uid'];current=vault().get(uid)
    if current and current['provider']!='manual':raise HTTPException(409,'Сначала отключи другой дневник')
    # Validate task/lesson payload using existing application contracts.
    from app.models import TaskItem,LessonSlot
    try:
        body.tasks=[TaskItem.model_validate(t).model_dump() for t in body.tasks]
        body.lessons=[LessonSlot.model_validate(t).model_dump() for t in body.lessons]
    except ValueError:raise HTTPException(422,'Неверный формат заданий/уроков')
    vault().bind(uid,'manual',snapshot=body.model_dump());return {'status':'unsupported_manual','imported':True}

@router.get('/api/v1/sgo/grades')
@router.get('/api/v1/diary/grades')
def grades(request:Request):
    conn=vault().get(account(request)['uid'])
    from app.grade_watcher import GradeWatcher,subject_recovery,is_low_grade
    from app.sgo_profiles import get_profile
    # v2.1: `private` — приватность PUSH-уведомлений (по умолчанию True), она НЕ скрывает оценки на экране.
    # Раньше экран читал её и всем показывал «Показ оценок скрыт…». Показ на экране — только hide_grades.
    uid=account(request)['uid'];private=GradeWatcher(store(),vault()).preferences(uid)['private']
    hidden=get_profile(store(),uid)['hide_grades']
    linked=bool(conn) and conn['status'] not in {'revoked','reauth_required'}
    items=conn['snapshot'].get('grades',[]) if linked else []
    from app.diary_cache import cache_metadata
    from app.grade_marks import weighted_average
    plans=subject_recovery(items)
    from app.grade_calculator import analyze_snapshot
    subject_analysis=[] if hidden else analyze_snapshot(items)
    average=weighted_average(items)   # v2.2: «5/4», «4-», вес 0 и текстовые отметки — по одному правилу (app/grade_marks.py)
    meta=cache_metadata(conn)
    # v2.1: stale_cache — снимок старше окна свежести (СГО не ответил), но оценки показываем честно с пометкой.
    state='sgo_unlinked' if not linked else ('privacy_hidden' if hidden else (('stale_cache' if meta['is_stale'] else 'ok') if items else 'empty'))
    from app.user_roles import role_fields
    return {**role_fields(store(),uid),'status':conn['status'] if conn else 'unsupported_manual','private':private,'hide_grades':hidden,
            'grades_state':state,'average_score':None if hidden else average,
            'scope':'loaded_snapshot','period':None,'official_quarter_grades':None,
            'subject_analysis':subject_analysis,**meta,
            'grades':[] if hidden else [{**g,'recovery_plan':plans.get(g['subject']) if is_low_grade(g['value']) else None} for g in items]}

@router.get('/api/v1/diary/sync')
def diary_sync_status(request:Request):
    from app.connector_store import ConnectorQueue
    uid=account(request)['uid']
    return {**ConnectorQueue(store()).status(uid),'connection':vault().status(uid)}

@router.get('/api/v1/diary/health')
def diary_health(request:Request):
    from app.connection_health import present_health
    from app.connector_store import ConnectorQueue
    uid=account(request)['uid']
    return present_health(vault().status(uid), ConnectorQueue(store()).status(uid))

@router.post('/api/v1/diary/sync')
def diary_sync_request(request:Request):
    from app.connector_store import ConnectorQueue
    uid=account(request)['uid'];rate(request,'diary-sync',30)
    if not store().rate('diary-sync:'+uid,5,300):raise too_many('diary-sync:'+uid,'Подожди перед повторным обновлением')
    queue=ConnectorQueue(store())
    if not queue.enqueue(uid):raise HTTPException(409,'Сначала подключи дневник или обнови вход')
    return {'queued':True,**queue.status(uid)}

@router.post('/api/v1/diary/disconnect')
async def disconnect(request:Request):
    from app.diary_disconnect import disconnect_diary
    return await disconnect_diary(store(),vault(),account(request)['uid'])

@router.get('/api/v1/diary/notifications')
def get_notifications(request:Request):
    uid=account(request)['uid']
    with store().tx() as db:
        row=db.execute('SELECT payload FROM preferences WHERE uid=?',(uid,)).fetchone()
        states=[dict(r) for r in db.execute('SELECT state,count(*) AS total FROM notices WHERE uid=? GROUP BY state',(uid,))]
    return {'preferences':{**DEFAULT_PREFS,**(json.loads(row[0]) if row else {})},'delivery':states}

@router.post('/api/v1/diary/notifications')
def notifications(body:NotificationPrefs,request:Request):
    uid=account(request)['uid']
    if (body.enabled or body.homework) and len([p for p in store().profiles(uid) if p.startswith('tg:')])!=1:raise HTTPException(409,'Сначала привяжи один Telegram-профиль и разреши сообщения боту')
    with store().tx() as db:db.execute('INSERT OR REPLACE INTO preferences VALUES(?,?)',(uid,json.dumps(body.model_dump())))
    return body.model_dump()

# Tutor context lives one day: a conversation untouched for 24 h is erased on the next read (data minimisation;
# the client additionally drops per-task threads older than a day before saving).
TUTOR_TTL_SECONDS=24*3600

TUTOR_SKEW_SECONDS=120  # a server clock stepping back (NTP) must not erase a thread saved a moment ago

def _tutor_fresh(payload,now):
    at=payload.get('_saved_at') if isinstance(payload,dict) else None
    return isinstance(at,(int,float)) and not isinstance(at,bool) and -TUTOR_SKEW_SECONDS<=now-at<=TUTOR_TTL_SECONDS

@router.get('/api/v1/shared/{name}')
def shared_get(name:str,request:Request):
    uid=account(request)['uid']
    if name not in {'tutor','plan'}:raise HTTPException(404,'Неизвестный документ')
    v=vault()
    with store().tx() as db:
        row=db.execute('SELECT version,payload FROM shared WHERE uid=? AND name=?',(uid,name)).fetchone()
        if not row:return {'version':0,'payload':{}}
        payload=v.open(uid,'shared:'+name,row[1])
        if name!='tutor':return {'version':row[0],'payload':payload}
        now=int(time.time())
        if isinstance(payload,dict) and payload and '_saved_at' not in payload:
            # Legacy (pre-v3) row: age unknown. It stays readable (R1/R2 migration contract) and its one-day clock starts now.
            payload={**payload,'_saved_at':now}
            db.execute('UPDATE shared SET payload=? WHERE uid=? AND name=? AND version=?',(v.seal(uid,'shared:tutor',payload),uid,name,row[0]))
        if not _tutor_fresh(payload,now):
            if payload:db.execute('UPDATE shared SET payload=? WHERE uid=? AND name=? AND version=?',(v.seal(uid,'shared:tutor',{}),uid,name,row[0]))
            return {'version':row[0],'payload':{},'expired':bool(payload)}
        saved=payload.pop('_saved_at')
        return {'version':row[0],'payload':payload,'saved_at':saved}

@router.put('/api/v1/shared/{name}')
def shared_put(name:str,body:SharedWrite,request:Request):
    uid=account(request)['uid']
    if name not in {'tutor','plan'}:raise HTTPException(404,'Неизвестный документ')
    encoded=json.dumps(body.payload,ensure_ascii=False)
    if len(encoded.encode())>65536:raise HTTPException(413,'Документ слишком большой')
    v=vault()
    with store().tx() as db:
        row=db.execute('SELECT version FROM shared WHERE uid=? AND name=?',(uid,name)).fetchone();current=row[0] if row else 0
        if current!=body.version:raise HTTPException(409,'Версия изменилась; загрузите актуальную, не перезаписывая чужие изменения')
        payload={**body.payload,'_saved_at':int(time.time())} if name=='tutor' else body.payload
        db.execute('INSERT OR REPLACE INTO shared VALUES(?,?,?,?)',(uid,name,current+1,v.seal(uid,'shared:'+name,payload)))
        db.execute('UPDATE accounts SET used=1 WHERE uid=?',(uid,))
    return {'version':current+1}

# Native school API remains separated from the backward-compatible facade.
from app.sgo_routes import router as school_router, oauth_router
router.include_router(school_router)
router.include_router(oauth_router)
from app.handoff_routes import router as handoff_router
router.include_router(handoff_router)
# v2.1: мастер подключения (роль/школа/СГО) и обзор дневника по роли.
from app.onboarding_routes import router as onboarding_router
router.include_router(onboarding_router)
# v4: единая карта способов входа (СГО / Госуслуги через OAuth-шлюз / своя сессия портала).
from app.sgo_auth import router as sgo_auth_router
router.include_router(sgo_auth_router)


from app.teacher_grades_and_role import router as teacher_journal_router
router.include_router(teacher_journal_router)
