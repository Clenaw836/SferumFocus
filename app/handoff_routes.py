"""Capability-authorized import of the user's OWN SGO session.
External bookmarklet submits a top-level POST form: no SOP bypass or CORS wildcard.
"""
from __future__ import annotations
import asyncio,json,os
from urllib.parse import parse_qs,urlsplit
from fastapi import APIRouter,Request,HTTPException,Response,Depends
from fastapi.responses import HTMLResponse,JSONResponse
from pydantic import Field,ValidationError
from app.sgo_routes import SafeRoute,Strict,deps,limited,failed,ERRORS
from app.diary_handoff import Handoff,sandbox_enabled
from app.sgo_oauth import SchoolOAuth
from app.esia_provider import config as esia_config,gate as esia_gate,bridge_gate

def private_response(response:Response):
    response.headers['Cache-Control']='no-store'
    response.headers['Referrer-Policy']='no-referrer'

router=APIRouter(prefix='/api/v1/diary/auth',route_class=SafeRoute,dependencies=[Depends(private_response)])
class Start(Strict):mode:str=Field(default='oauth',pattern='^(oauth|sandbox)$')
class Challenge(Strict):challenge_id:str=Field(min_length=30,max_length=100)
class TwoFA(Challenge):code:str=Field(pattern=r'^[0-9]{6}$',repr=False)
class Cap(Challenge):bridge_secret:str=Field(min_length=30,max_length=100,repr=False)
class CookieValue(Strict):
    name:str=Field(pattern=r'^(NSSESSIONID|ESRNSec)$')
    value:str=Field(min_length=1,max_length=8192,repr=False)
class Bridge(Cap):
    link_code:str=Field(pattern=r'^[0-9]{6}$',repr=False)
    access_token:str=Field(min_length=1,max_length=8192,repr=False)
    cookies:list[CookieValue]=Field(default_factory=list,max_length=2,repr=False)

def flow(request):
    a,r,v=deps(request);return a,Handoff(r,v)

def public_origin():
    origin=os.getenv('SFERUM_PUBLIC_ORIGIN','');p=urlsplit(origin)
    local=p.scheme=='http' and p.hostname=='127.0.0.1' and os.getenv('SFERUM_ENV') in {'test','demo'}
    if not (p.scheme=='https' or local) or not p.hostname or p.username or p.password or p.path or p.query or p.fragment:raise HTTPException(503,'Нужен публичный HTTPS origin приложения')
    return origin

@router.get('/capabilities')
def capabilities(request:Request,method:str='gosuslugi_esia'):
    a,h=flow(request);school=h.directory.binding(a['uid']);configured=False
    # v2.3.2 (D3) · Без сетевых запросов. Флаг выключен/конфликт → ни одного активного способа Госуслуг.
    esia=esia_config();test_env=os.getenv('SFERUM_ENV') in {'test','demo'}
    if school and esia.enabled:
        try:SchoolOAuth(h.repo,h.vault).profile(school,method);configured=True
        except ValueError:pass
    return {'oauth_configured':configured,'sandbox_enabled':esia.enabled and sandbox_enabled(),
            'bridge_enabled':esia.enabled and test_env,'esia_state':esia.state,
            'bridge_confirmation_required':True,'esia_codes_in_app':False}

@router.post('/start',dependencies=[Depends(esia_gate)])
@router.post('/esia/start',dependencies=[Depends(esia_gate)])
def start(body:Start,request:Request):
    if body.mode=='sandbox':bridge_gate()
    a,h=flow(request);limited(request,'esia-start',8);origin=public_origin()
    try:
        if body.mode=='sandbox':
            d=h.start_sandbox(a['uid']);d['authorization_url']=origin+'/diary-sandbox#challenge_id='+d['challenge_id']+'&bridge_secret='+d['bridge_secret'];d.pop('link_code');d.pop('bridge_secret');return d
        s=SchoolOAuth(h.repo,h.vault).begin(a['uid'],'gosuslugi_esia')
        state=parse_qs(urlsplit(s['authorization_url']).query)['state'][0]
        conn=h.vault.get(a['uid']);old=((conn or {}).get('session') or {}).get('connection_id')
        d=h.create(a['uid'],'oauth',{'oauth_state':state,'previous_connection_id':old});d.pop('bridge_secret');d.pop('link_code');return {**d,**s}
    except ERRORS as exc:raise failed(exc)

@router.get('/status/{challenge_id}',dependencies=[Depends(esia_gate)])
def status(challenge_id:str,request:Request):
    a,h=flow(request)
    try:return h.status(a['uid'],challenge_id)
    except ERRORS as exc:raise failed(exc)

@router.post('/verify-2fa',dependencies=[Depends(bridge_gate)])
@router.post('/esia/verify-2fa',dependencies=[Depends(bridge_gate)])
def verify(body:TwoFA,request:Request):
    a,h=flow(request);limited(request,'sandbox-verify',30)
    try:return h.verify_sandbox(a['uid'],body.challenge_id,body.code)
    except ERRORS as exc:raise failed(exc)

@router.post('/resend-2fa',dependencies=[Depends(bridge_gate)])
@router.post('/esia/resend-2fa',dependencies=[Depends(bridge_gate)])
def resend(body:Challenge,request:Request):
    a,h=flow(request);limited(request,'sandbox-resend',8)
    try:return h.resend_sandbox(a['uid'],body.challenge_id)
    except ERRORS as exc:raise failed(exc)

@router.post('/bridge/start',dependencies=[Depends(bridge_gate)])
def bridge_start(request:Request):
    a,h=flow(request);limited(request,'bridge-start',8);origin=public_origin()
    try:d=h.create(a['uid'],'bridge')
    except ERRORS as exc:raise failed(exc)
    # The script is tied to the exact selected SGO origin. No ESIA reads, no
    # HttpOnly reads, no scans of other tabs or arbitrary storage keys.
    script="""javascript:(()=>{if(location.origin!==PORTAL){alert('Открой выбранный портал СГО, не Госуслуги.');return;}if(!confirm('Передать свою сессию СГО в СферумФокус? Подтверди ученика затем в мини-приложении.'))return;const at=sessionStorage.getItem('at')||localStorage.getItem('at');if(!at){alert('Токен at недоступен. HttpOnly и ограничения портала не обходятся. Используй официальный шлюз.');return;}const cookies=document.cookie.split(';').map(s=>s.trim()).filter(s=>/^(NSSESSIONID|ESRNSec)=/.test(s)).map(s=>({name:s.slice(0,s.indexOf('=')),value:s.slice(s.indexOf('=')+1)}));const f=document.createElement('form');f.method='POST';f.action=TARGET;f.target='_blank';f.rel='noopener noreferrer';const i=document.createElement('input');i.type='hidden';i.name='payload';i.value=JSON.stringify({...CAP,access_token:at,cookies});f.append(i);document.body.append(f);f.submit();f.remove();})()"""
    script=script.replace('PORTAL',json.dumps(d['sgo_url'])).replace('TARGET',json.dumps(origin+'/api/v1/diary/auth/bridge-bind')).replace('CAP',json.dumps({k:d[k] for k in ('challenge_id','bridge_secret','link_code')}))
    return {**d,'bookmarklet':script,'confirmation_required':True,'warning':'Передаются только собственный at и доступные JS cookies СГО. HttpOnly, CSP, IP-привязка не обходятся.'}

@router.post('/bridge-bind',dependencies=[Depends(bridge_gate)])
async def bridge_bind(request:Request):
    from app.platform_auth import store,enabled
    from app.platform_routes import vault,rate
    if not enabled():raise HTTPException(503,'Мультиплатформенный режим выключен')
    rate(request,'bridge-bind',20)
    content=bytearray()
    async for part in request.stream():
        content.extend(part)
        if len(content)>32768:raise HTTPException(413,'Слишком большой запрос')
    form=request.headers.get('content-type','').split(';')[0]=='application/x-www-form-urlencoded'
    try:
        if form:
            fields=parse_qs(content.decode('utf-8'),strict_parsing=True)
            if set(fields)!={'payload'} or len(fields['payload'])!=1:raise ValueError()
            obj=json.loads(fields['payload'][0])
        else:
            if request.headers.get('content-type','').split(';')[0]!='application/json':raise ValueError()
            obj=json.loads(content)
        body=Bridge.model_validate(obj)
    except (ValueError,UnicodeError,ValidationError):raise HTTPException(422,'Неверный формат привязки; секретные поля не отображаются') from None
    h=Handoff(store(),vault())
    try:
        r=h.capable(body.challenge_id,body.bridge_secret);school=h.directory.binding(r['uid']);domain=urlsplit(school['base_url']).hostname
        cookies=[{'name':c.name,'value':c.value,'domain':domain,'path':'/','secure':True} for c in body.cookies]
        if len({c['name'] for c in cookies})!=len(cookies):raise ValueError('Duplicate cookies')
        result=await asyncio.wait_for(h.stage_bridge(body.challenge_id,body.bridge_secret,body.link_code,body.access_token,cookies,request.headers.get('origin','')),40)
    except ERRORS as exc:raise failed(exc)
    finally:body.access_token='';body.bridge_secret='';body.cookies=[]
    if form:return HTMLResponse('<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Подтвердите привязку</title><h1>Сессия проверена</h1><p>Вернитесь в СферумФокус и подтвердите, что показан ваш ученик. Пока этого не произошло, дневник не подключён.</p></html>',headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'"})
    return result

@router.post('/bridge/confirm',dependencies=[Depends(bridge_gate)])
def confirm(body:Challenge,request:Request):
    a,h=flow(request);limited(request,'bridge-confirm',10)
    try:return h.confirm(a['uid'],body.challenge_id)
    except ERRORS as exc:raise failed(exc)

@router.post('/cancel')
def cancel(body:Challenge,request:Request):
    a,h=flow(request)
    try:return h.cancel(a['uid'],body.challenge_id)
    except ERRORS as exc:raise failed(exc)

@router.post('/sandbox/show-code',dependencies=[Depends(bridge_gate)])
def sandbox_code(body:Cap,request:Request):
    from app.platform_auth import enabled,store
    from app.platform_routes import vault,rate
    if not enabled() or not sandbox_enabled():raise HTTPException(404,'Sandbox выключен')
    if request.headers.get('origin')!=public_origin():raise HTTPException(403,'Origin не принят')
    rate(request,'sandbox-code',30)
    try:return {'code':Handoff(store(),vault()).sandbox_code(body.challenge_id,body.bridge_secret),'demo':True}
    except ERRORS as exc:raise failed(exc)

@router.get('/esia/callback',response_class=HTMLResponse,dependencies=[Depends(esia_gate)])
async def callback(request:Request):
    from app.sgo_routes import callback as registered_callback
    return await registered_callback('esia',request)
