"""Authenticated native school APIs. Browser never receives provider credentials."""
from __future__ import annotations
import asyncio,os,secrets,time
from typing import Literal
from urllib.parse import urlsplit
import httpx
from fastapi import APIRouter,Depends,HTTPException,Request
from fastapi.responses import HTMLResponse,JSONResponse
from fastapi.routing import APIRoute
from fastapi.exceptions import RequestValidationError
class SafeRoute(APIRoute):
    def get_route_handler(self):
        handler=super().get_route_handler()
        async def safe(request):
            from app.api_errors import CodedError
            try:return await handler(request)
            except CodedError as exc:return exc.response()
            except RequestValidationError as exc:
                return JSONResponse({'detail':'Неверный формат запроса','errors':[{'loc':e['loc'],'type':e['type']} for e in exc.errors()]},status_code=422)
        return safe
from pydantic import BaseModel,ConfigDict,Field,StrictInt,StrictBool,SecretStr
from app.diary_providers import UnsupportedPortal,ProviderUnavailable,ReauthRequired
from app.sgo_client import NetSchoolClient,SgoAuthRejected,SgoUnsupported
from app.sgo_directory import Directory
from app.sgo_resolver import SchoolResolver
from app.sgo_oauth import SchoolOAuth,OAuthStateInvalid
from app.esia_provider import gate as esia_gate
from app.api_errors import CodedError
NOT_TRUSTED='Сервер этой школы не входит в проверенный каталог. Выберите школу из списка.'

router=APIRouter(prefix='/api/platform',route_class=SafeRoute)
class Strict(BaseModel):model_config=ConfigDict(extra='forbid')
class Selection(Strict):school_uid:str=Field(min_length=1,max_length=160)
class Resolve(Strict):
    url:str|None=Field(default=None,max_length=300)
    host_id:str|None=Field(default=None,max_length=100)
    q:str=Field(default='',max_length=120)
class Login(Strict):
    role:Literal['student','teacher']='student'
    login:str=Field(min_length=1,max_length=200)
    password:SecretStr=Field(min_length=1,max_length=300,repr=False)
    student_id:int|None=Field(default=None,gt=0)
    user_consent_ai:StrictBool=False
    consent_policy_version:str|None=Field(default=None,max_length=80)
class Locations(Strict):
    host_id:str=Field(min_length=1,max_length=100)
    context:dict[str,StrictInt]=Field(default_factory=dict,max_length=5)
class Exchange(Strict):
    state:str=Field(min_length=20,max_length=200)
    code:str=Field(min_length=1,max_length=2000,repr=False)
    method:str=Field(default='gosuslugi_esia',pattern='^(gosuslugi_esia|moya_shkola)$')

def deps(request):
    from app.platform_routes import account,vault
    from app.platform_auth import store
    a=account(request);return a,store(),vault()
def limited(request,kind,limit=10):
    from app.platform_routes import rate
    from app.platform_auth import store
    rate(request,'sgo-'+kind,limit*4)
    a=getattr(request.state,'platform_account',None)
    if a and not store().rate('sgo-'+kind+':'+a['uid'],limit,300):
        from app.platform_routes import too_many
        raise too_many('sgo-'+kind+':'+a['uid'],'Слишком много запросов; повтори позже')
def failed(exc):
    if isinstance(exc,(SgoAuthRejected,ReauthRequired)):return HTTPException(422,str(exc) or 'СГО требует повторный вход')
    if isinstance(exc,(UnsupportedPortal,SgoUnsupported,ValueError)):return HTTPException(409,str(exc) if isinstance(exc,(UnsupportedPortal,SgoUnsupported)) else 'Проверь школу и начни вход заново')
    return HTTPException(502,'Региональный портал временно недоступен. Данные входа не сохранены.')
ERRORS=(SgoAuthRejected,SgoUnsupported,UnsupportedPortal,ProviderUnavailable,ReauthRequired,httpx.HTTPError,TimeoutError,OSError,ValueError,KeyError,TypeError)

def public_binding(d):
    if not d:return None
    return {k:d.get(k) for k in ('school_uid','host_id','name','short_name','city','region','base_url','host_status','supported_auth_methods','sgo_student_id','student_display_name','class_name','last_login_at','scid','role')}

@router.get('/bootstrap')
def bootstrap(request:Request):
    a,repo,v=deps(request)
    from app.user_roles import role_fields
    return {**role_fields(repo,a['uid']),'uid':a['uid'],'school':public_binding(Directory(repo).binding(a['uid'])),'diary_connection':v.status(a['uid'])}

@router.get('/directory/regions')
def regions(request:Request):
    from app.school_regions import region_items
    from app.school_registry import catalog
    a,repo,v=deps(request)
    items=region_items(Directory(repo).hosts(),catalog()['portals'])
    with repo.tx() as db:
        counts={r['region']:dict(r) for r in db.execute("SELECT s.region,COUNT(*) AS schools,COUNT(DISTINCT NULLIF(city,'')) AS cities FROM schools_directory s JOIN sgo_hosts_registry h ON h.host_id=s.host_id WHERE h.is_active=1 GROUP BY s.region")}
    for item in items:
        stats=counts.get(item['name'],{})
        item.update(cached_schools=stats.get('schools',0),cached_city_labels=stats.get('cities',0),institution_catalog_complete=False)
    return {'items':items, 'catalog_available': catalog().get('_available', True)}

@router.get('/directory/providers')
def providers(request:Request,region:str):
    from app.school_registry import catalog,public_services
    a,repo,v=deps(request)
    if len(region)>150:raise HTTPException(422,'Слишком длинный регион')
    from app.school_regions import canonical_region
    region=canonical_region(region)
    hosts=[h for h in Directory(repo).hosts() if canonical_region(h['region_name'])==region]
    records={p['base_url']:p for p in catalog()['portals']}
    return {'items':[dict(h,name='Сетевой Город. Образование',kind='netschool',
                         integration='native_candidate',authenticated=False,
                         sources=records.get(h['base_url'],{}).get('sources',[]),
                         public_probe=records.get(h['base_url'],{}).get('public_probe'),
                         auth_policy=records.get(h['base_url'],{}).get('auth_policy','portal_dependent')) for h in hosts],
            'services':public_services(region),
            'catalog_available': catalog().get('_available', True),
            'catalog_notice': catalog().get('notice') if not catalog().get('_available', True) else None,
            'external':{'name':'Госуслуги Моя школа','url':'https://www.gosuslugi.ru/myschool','configured':False}}

@router.get('/directory/coverage')
def coverage(request:Request):
    from app.school_registry import catalog
    a,repo,v=deps(request);data=catalog();hosts=Directory(repo).hosts()
    from app.school_regions import REGIONS,region_items
    items=region_items(hosts,data['portals'])
    with repo.tx() as db:cached=db.execute("SELECT COUNT(*),COUNT(DISTINCT region||'|'||NULLIF(city,'')) FROM schools_directory").fetchone()
    return {'cached_institutions':cached[0],'cached_city_labels':cached[1],'institution_catalog_complete':False,'catalog_available':data.get('_available', True),'catalog_version':data['catalog_version'],'regions_reviewed':data['regions_reviewed'],
            'listed_regions':len(REGIONS),'regions_with_native_candidates':sum(x['portals']>0 for x in items if x['name'] in REGIONS),
            'regions_without_regional_portal':sum(x['portals']==0 and x['other_services']==0 for x in items if x['name'] in REGIONS),
            'region_import_verified_globally':False,
            'catalog_portals':len(data['portals']),'national_services':len(data['national']),
            'native_candidates':len(hosts),'public_api_responded':sum(h['last_status']=='online' for h in hosts),
            'build_time_anonymous_audit':{'checked':sum('public_probe' in p for p in data['portals']),
                'compatible':sum(p.get('public_probe',{}).get('status')=='public_api_compatible' for p in data['portals']),
                'authenticated':False},
            'login_verified_globally':False,'notice':data['notice']}

@router.get('/directory/cities')
def cities(request:Request,host_id:str):
    a,repo,v=deps(request)
    try:Directory(repo).host(host_id)
    except UnsupportedPortal as exc:raise failed(exc)
    with repo.tx() as db:
        rows=[dict(x) for x in db.execute("SELECT city,COUNT(*) AS schools FROM schools_directory WHERE host_id=? AND city<>'' GROUP BY city ORDER BY city LIMIT 1000",(host_id,))]
    return {'items':rows,'source':'portal_cache','complete':False}

@router.post('/directory/locations')
async def locations(body:Locations,request:Request):
    a,repo,v=deps(request);limited(request,'locations',30)
    try:Directory(repo).trusted_host(body.host_id)
    except UnsupportedPortal:raise CodedError(422,'HOST_NOT_TRUSTED',NOT_TRUSTED) from None
    try:return await asyncio.wait_for(SchoolResolver(repo).locations(body.host_id,body.context),15)
    except ERRORS as exc:raise failed(exc)

@router.get('/schools/search')
async def search(request:Request,q:str='',region:str|None=None,live:bool=False,host_id:str|None=None,city:str|None=None,flat:bool=False,limit:int=40,offset:int=0,include_institutions:bool=False,region_code:str|None=None,municipality:str|None=None):
    a,repo,v=deps(request)
    if len(q)>120 or (region and len(region)>150) or (city and len(city)>300) or (host_id and len(host_id)>100):raise HTTPException(422,'Слишком длинный запрос')
    if not 1<=limit<=100 or not 0<=offset<=1000000:raise HTTPException(422,'Недопустимая страница поиска')
    if region_code and (not region_code.isascii() or not region_code.isdigit() or len(region_code)!=2):raise HTTPException(422,'Неверный код региона')
    if municipality and len(municipality)>300:raise HTTPException(422,'Слишком длинное название муниципалитета')
    probes=[]
    if live:
        limited(request,'discover',6)
        try:probes=(await SchoolResolver(repo).live_search(q,region,host_id,flat_only=flat))['probes']
        except ERRORS as exc:raise failed(exc)
    def _local():  # v3.0 DB-01: чтение каталога школ (SQLite) — в пуле потоков, а не в event loop
        found=Directory(repo).search(q,region,host_id,city,limit+1,offset)
        extra=[]
        if include_institutions and not host_id:
            from app.institution_catalog import search as institution_search
            with repo.tx() as db:extra=institution_search(db,q,region,limit+1,offset,region_code=region_code,municipality=municipality,city=city)
        return found,extra
    rows,institutions=await asyncio.to_thread(_local)
    more=len(rows)>limit or len(institutions)>limit
    return {'items':rows[:limit],'institutions':institutions[:limit],'probes':probes,'has_more':more,
            'next_offset':offset+(limit if more else max(len(rows),len(institutions))),
            'coverage':'partial_public_catalog','institutions_are_login_bindings':False}


@router.post('/schools/resolve-host')
async def resolve(body:Resolve,request:Request):
    a,repo,v=deps(request);limited(request,'resolve',6);directory=Directory(repo)
    if bool(body.url)==bool(body.host_id):raise HTTPException(422,'Нужен адрес или идентификатор узла')
    # v2.3.2 (D2) · Адрес из запроса только СОПОСТАВЛЯЕТСЯ с доверенным каталогом: ни регистрации узла,
    # ни сетевого запроса к неизвестному адресу. Нет в каталоге → 422 HOST_NOT_TRUSTED.
    try:
        if body.url:
            from app.diary_providers import portal_origin
            origin=portal_origin(body.url)
            match=[h for h in directory.hosts() if h['base_url']==origin]
            if not match:raise CodedError(422,'HOST_NOT_TRUSTED',NOT_TRUSTED)
            host=directory.trusted_host(match[0]['host_id'])
        else:host=directory.trusted_host(body.host_id)
    except UnsupportedPortal:raise CodedError(422,'HOST_NOT_TRUSTED',NOT_TRUSTED) from None
    try:
        result=await asyncio.wait_for(SchoolResolver(repo).discover(host['host_id'],body.q),20)
        return {**result,'base_url':host['base_url'],'items':directory.search(body.q,host_id=host['host_id']),'credentials_sent':False}
    except ERRORS as exc:raise failed(exc)

@router.post('/school/select')
@router.post('/schools/select')
def select(body:Selection,request:Request):
    a,repo,v=deps(request);limited(request,'select',30)
    principal=request.state.platform_principal;tg=int(principal[3:]) if principal.startswith('tg:') else None
    directory=Directory(repo)
    try:
        # v2.3.2 (D5): школа недоверенного узла не выбирается (422 HOST_NOT_TRUSTED); прежний контракт
        # для неизвестной школы/учреждения (409 через failed) сохранён.
        if not directory.trusted(directory.host(directory.school(body.school_uid)['host_id'])):
            raise CodedError(422,'HOST_NOT_TRUSTED',NOT_TRUSTED,domain='sgo')
        return {'school':public_binding(directory.select(a['uid'],body.school_uid,tg))}
    except ERRORS as exc:raise failed(exc)

@router.get('/school/auth-options')
async def school_auth_options(request:Request):
    """Public portal capabilities for this account's selected school, not a grant."""
    a,repo,v=deps(request);limited(request,'capabilities',20)
    directory=Directory(repo);school=directory.binding(a['uid'])
    if not school:raise HTTPException(409,'Сначала выбери школу')
    from app.sgo_client import SgoHTTP
    response={'school_uid':school['school_uid'],'status':'unknown','school_password_login':None,
              'esia_advertised':False,'provider_version':None}
    try:
        doc=await asyncio.wait_for(SgoHTTP(directory.trusted_host(school['host_id'])).request('GET','/logindata',optional=True),10)
        if isinstance(doc,dict):
            response['status']='checked'
            value=doc.get('schoolLogin')
            response['school_password_login']=value if type(value) is bool else None
            response['esia_advertised']=doc.get('esiaLogin') is True
            version=doc.get('version')
            if isinstance(version,str) and len(version)<=40:response['provider_version']=version
    except ERRORS:
        response['status']='temporarily_unavailable'
    return response

@router.post('/diary/connect')
@router.post('/sgo/diary/connect')
async def connect(body:Login,request:Request):
    a,repo,v=deps(request);limited(request,'login',5);directory=Directory(repo);uid=a['uid']
    from app import ai_gate
    if body.user_consent_ai and body.consent_policy_version != ai_gate.CONSENT_POLICY_VERSION:raise HTTPException(409,'Текст согласия изменился. Обновите приложение и ознакомьтесь с ним снова.')
    school=directory.binding(uid)
    if not school:raise HTTPException(409,'Сначала выбери школу')
    try:host=directory.trusted_host(school['host_id'])
    except UnsupportedPortal:raise CodedError(422,'HOST_NOT_TRUSTED',NOT_TRUSTED) from None
    existing=v.get(uid)
    if existing and existing['provider']!='netschool':raise HTTPException(409,'Сначала отключи текущий дневник')
    if 'sgo_credentials' not in school['supported_auth_methods']:raise HTTPException(409,'Этот регион отключил прямой вход; выбери другой способ')
    flow=repo.digest(secrets.token_urlsafe(32))
    def _open_flow():  # v3.0 DB-01: транзакции входа — в пуле потоков
        with repo.tx() as db:
            db.execute('DELETE FROM sgo_auth_flows WHERE student_uid=?',(uid,))
            db.execute('INSERT INTO sgo_auth_flows VALUES(?,?,?,?,?,?)',(flow,uid,school['school_uid'],'consumed',time.time()+60,'{}'))
    def _close_flow():
        with repo.tx() as db:db.execute('DELETE FROM sgo_auth_flows WHERE digest=?',(flow,))
    await asyncio.to_thread(_open_flow)
    try:
        session,snapshot=await asyncio.wait_for(NetSchoolClient(host).login(school,body.login,body.password.get_secret_value(),body.student_id,role=body.role),40)
        session.update(school_uid=school['school_uid'],auth_method='sgo_credentials')
        v.bind(uid,'netschool',portal=host['base_url'],session=session,expires=time.time()+86400,snapshot=snapshot.model_dump(),expected_school=school['school_uid'],expected_flow=flow)
        from app.user_roles import set_user_role
        from app.sgo_profiles import save_session
        actual_role = session.get('role', body.role)
        save_session(repo, v, uid=uid, role=actual_role, scid=str(school['scid']), base_url=host['base_url'], login=body.login, native=session, ttl=86400)
        set_user_role(repo, uid, actual_role)
        directory.mark(host['host_id'],'online')
    except ERRORS as exc:raise failed(exc)
    finally:
        body.password=SecretStr('')
        await asyncio.to_thread(_close_flow)
    if body.user_consent_ai:ai_gate.grant(repo,uid)
    return {'role':actual_role,'is_teacher':actual_role=='teacher','diary_connection':v.status(uid),'school':public_binding(directory.binding(uid)),'reload_required':True}

METHODS={'esia':'gosuslugi_esia','myschool':'moya_shkola'}
@router.post('/diary/auth/{kind}/start',dependencies=[Depends(esia_gate)])
def oauth_start(kind:str,request:Request):
    a,repo,v=deps(request);limited(request,'oauth',10)
    if kind not in METHODS:raise HTTPException(404,'Неизвестный способ')
    try:return SchoolOAuth(repo,v).begin(a['uid'],METHODS[kind])
    except ERRORS as exc:raise failed(exc)

@router.post('/diary/auth/token-exchange',dependencies=[Depends(esia_gate)])
@router.post('/diary/auth/myschool/connect',dependencies=[Depends(esia_gate)])
async def exchange(body:Exchange,request:Request):
    a,repo,v=deps(request);limited(request,'exchange',10)
    try:await asyncio.wait_for(SchoolOAuth(repo,v).finish(body.state,body.code,body.method,a['uid']),40)
    except ERRORS as exc:raise failed(exc)
    return {'diary_connection':v.status(a['uid']),'reload_required':True}

@router.get('/diary/auth/{kind}/callback',response_class=HTMLResponse,dependencies=[Depends(esia_gate)])
async def callback(kind:str,request:Request):
    # This narrow anonymous return endpoint is authorized by one-use state+PKCE,
    # not by a school token supplied by the browser. No user data in the response.
    from app.platform_auth import store,enabled
    from app.platform_routes import vault
    if not enabled() or kind not in METHODS:raise HTTPException(404,'Недоступно')
    pairs=list(request.query_params.multi_items())
    if len(pairs)!=2 or {k for k,v in pairs}!={'state','code'}:raise HTTPException(422,'Нужны однократные state и code')
    state=request.query_params['state'];code=request.query_params['code']
    if not 20<=len(state)<=200 or not 1<=len(code)<=2000:raise HTTPException(422,'Неверный ответ шлюза')
    limited(request,'callback',20)
    try:await asyncio.wait_for(SchoolOAuth(store(),vault()).finish(state,code,METHODS[kind]),40)
    except ERRORS as exc:raise failed(exc)
    return HTMLResponse('<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Дневник подключён</title><body><h1>Дневник подключён</h1><p>Вернись в мини-приложение и обнови подключение.</p><a href="/">Открыть СферумФокус</a></body></html>',headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; base-uri 'none'; frame-ancestors 'none'"})

@router.post('/diary/sync')
async def sync(request:Request):
    from app.sgo_client import NativeDiaryAdapter
    from app.grade_watcher import GradeWatcher
    a,repo,v=deps(request);limited(request,'sync',3);conn=v.get(a['uid'])
    if not conn or not conn.get('session') or conn['session'].get('protocol')!='netschool-native-v1':return v.status(a['uid'])
    from app.connector_store import ConnectorQueue
    queue=ConnectorQueue(repo);queue.enqueue(a['uid']);job=queue.claim_one(a['uid'])
    if not job:raise HTTPException(409,'Обновление уже выполняется сервером; проверь статус синхронизации')
    token=job['lease_token']
    try:
        out=await asyncio.wait_for(GradeWatcher(repo,v).sync(a['uid'],NativeDiaryAdapter(Directory(repo),conn['session']['host_id']),fence=lambda db:queue.valid(db,a['uid'],token)),25)
        queue.finish(a['uid'],token,out['status']);return out
    except ERRORS as exc:
        queue.finish(a['uid'],token,'error');raise failed(exc)
    finally:queue.release(a['uid'],token)

@router.post('/diary/auth/{kind}/callback',dependencies=[Depends(esia_gate)])
async def callback_post(kind:str,body:Exchange,request:Request):
    if kind not in METHODS or METHODS[kind]!=body.method:raise HTTPException(422,'Способ входа не совпадает')
    return await exchange(body,request)

# Stable versioned API for all three environments. The existing /auth/* APIs
# remain compatible; this router never accepts a user-supplied access token.
oauth_router=APIRouter(prefix='/api/v1/diary/oauth',route_class=SafeRoute)
class OAuthCard(Strict):
    school_uid:str=Field(min_length=1,max_length=160)
    portal_url:str=Field(min_length=8,max_length=300)
    scid:StrictInt=Field(gt=0)
    method:str=Field(default='gosuslugi_esia',pattern='^(gosuslugi_esia|moya_shkola)$')
class OAuthCancel(Strict):
    tx_id:str=Field(pattern=r'^[A-Za-z0-9_-]{43}$')

@oauth_router.post('/start',dependencies=[Depends(esia_gate)])
def oauth_transaction_start(body:OAuthCard,request:Request):
    a,repo,v=deps(request);limited(request,'oauth-start',8)
    try:
        result=SchoolOAuth(repo,v).start_card(a['uid'],body.school_uid,body.portal_url,body.scid,body.method)
    except ERRORS as exc:raise failed(exc)
    return JSONResponse(result,headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer'})

@oauth_router.get('/status',dependencies=[Depends(esia_gate)])
def oauth_transaction_status(request:Request,tx_id:str):
    import re
    a,repo,v=deps(request);limited(request,'oauth-status',240)
    if not re.fullmatch(r'[A-Za-z0-9_-]{43}',tx_id):raise HTTPException(422,'Неверный идентификатор транзакции')
    try:result=SchoolOAuth(repo,v).status(a['uid'],tx_id)
    except ERRORS as exc:raise failed(exc)
    return JSONResponse(result,headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer'})

@oauth_router.post('/cancel',dependencies=[Depends(esia_gate)])
def oauth_transaction_cancel(body:OAuthCancel,request:Request):
    a,repo,v=deps(request);limited(request,'oauth-cancel',15)
    try:result=SchoolOAuth(repo,v).cancel(a['uid'],body.tx_id)
    except ERRORS as exc:raise failed(exc)
    return JSONResponse(result,headers={'Cache-Control':'no-store'})

@oauth_router.get('/callback',dependencies=[Depends(esia_gate)])
async def oauth_transaction_callback(request:Request):
    from fastapi.responses import RedirectResponse
    from app.platform_auth import store,enabled
    from app.platform_routes import vault
    from app.oauth_receipt import page,issue,COOKIE,PATH
    if not enabled():raise HTTPException(404,'Недоступно')
    pairs=list(request.query_params.multi_items());keys={k for k,_ in pairs}
    if (len(pairs)!=len(keys) or 'state' not in keys or
        not (keys=={'state','code'} or keys in ({'state','error'},{'state','error','error_description'}))):
        return page(status_code=422)
    state=request.query_params['state'];code=request.query_params.get('code')
    if not 20<=len(state)<=200 or (code is not None and not 1<=len(code)<=2000):
        return page(status_code=422)
    try:
        limited(request,'oauth-callback',30)
        service=SchoolOAuth(store(),vault());outcome='connected'
        if code is None:
            service.provider_error(state);outcome='failed'
        else:await asyncio.wait_for(service.finish(state,code),40)
    except HTTPException as exc:
        return page(status_code=exc.status_code,reason='busy' if exc.status_code==429 else 'failed')
    except ERRORS as exc:
        # Fixed public messages: never reflect provider exception bodies or URLs.
        status=failed(exc).status_code
        return page(status_code=status,reason='expired' if isinstance(exc,OAuthStateInvalid) else 'unavailable' if status==502 else 'failed')
    except Exception:
        # No stack, state, code, exception repr, or raw provider response in logs.
        import logging
        logging.getLogger('sferumfocus.oauth').warning('oauth_callback_failed')
        return page(status_code=502,reason='unavailable')
    response=RedirectResponse('/api/v1/diary/oauth/result?outcome='+outcome,status_code=303,
        headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer'})
    response.set_cookie(COOKIE,issue(store(),outcome),max_age=60,path=PATH,httponly=True,
        secure=request.url.scheme=='https' or os.getenv('SFERUM_ENV')=='production',samesite='lax')
    return response

@oauth_router.get('/result',response_class=HTMLResponse)
def oauth_result(request:Request,outcome:str='failed'):
    from app.oauth_receipt import page,verified,COOKIE,PATH
    from app.platform_auth import store
    connected=outcome=='connected' and verified(store(),request.cookies.get(COOKIE,''),outcome)
    response=page(connected=connected,reason='denied' if outcome=='failed' else 'failed')
    response.delete_cookie(COOKIE,path=PATH,httponly=True,samesite='lax',
        secure=request.url.scheme=='https' or os.getenv('SFERUM_ENV')=='production')
    return response
