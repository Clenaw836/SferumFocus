"""Поиск школ и параметров входа (scid, cid, sid, pid, cn, sft) на любом узле «Сетевого Города».

* resolve_school_params(base_url, school_query) — автономный резолвер без БД: prepareloginform →
  schools/search → (если плоского поиска нет) ограниченный обход дерева /loginform. Неоднозначность
  никогда не решается молча: SchoolAmbiguous со списком кандидатов.
* SchoolResolver — каталог приложения (sgo_hosts_registry / schools_directory): дерево районов,
  обнаружение школ и живой поиск по доверенным узлам.

Запросы анонимные (без логина/пароля), транспорт — app.sgo_client.SgoHTTP (SSRF-проверка, лимит 2 МБ).
"""
from __future__ import annotations
import asyncio,json,os,re,time
from dataclasses import dataclass,field
from typing import Any
from urllib.parse import urlsplit
import httpx
from app.sgo_client import SgoHTTP,SgoAuthRejected,SgoUnsupported
from app.sgo_directory import Directory,PARAMS,utc,valid_location_id
from app.diary_providers import ProviderUnavailable,ReauthRequired,UnsupportedPortal
from app.school_names import UnresolvedSchoolName

LEVELS=[('countries','cid'),('states','sid'),('provinces','pid'),('cities','cn'),('funcs','sft')]
NEXT_LIST={'cid':'states','sid':'provinces','pid':'cities','cn':'funcs','sft':'schools'}
def loginform_reply(doc,last):
    # Live NetSchool /loginform returns {items: [...], lastElem: "pid"},
    # unlike the full prepareloginform dictionary.
    if isinstance(doc,dict) and 'items' in doc:
        if not isinstance(doc['items'],list) or doc.get('lastElem',last)!=last:
            raise SgoUnsupported('Несовместимый ответ выбора населённого пункта')
        return {NEXT_LIST[last]:doc['items']}
    return doc
class SchoolResolver:
    def __init__(self,repo,client=None):self.directory=Directory(repo);self.client=client
    async def locations(self,host_id,context):
        """Explicit legacy hierarchy traversal: no first-12-cities truncation.
        Choices come from this portal only, never regional IDs inferred from names.
        """
        if set(context)-set(PARAMS[:-1]) or any(not valid_location_id(k,v) for k,v in context.items()):
            raise ValueError('Invalid location context')
        host=self.directory.trusted_host(host_id);h=SgoHTTP(host,client=self.client)
        if context:
            last=next(k for _,k in reversed(LEVELS) if k in context)
            doc=await h.request('GET','/loginform',params={**context,'LASTNAME':last},optional=True)
            doc=loginform_reply(doc,last)
        else:
            doc=await h.request('GET','/prepareloginform',optional=True)
        if not isinstance(doc,dict):raise SgoUnsupported('Этот портал не предоставляет дерево районов; используйте поиск по названию школы')
        ctx={**context,**{k:doc[k] for k in PARAMS[:-1] if type(doc.get(k)) is int}}
        self.directory.remember_cities(host_id,doc)
        city=self.directory.city_name(host_id,ctx.get('cn'))
        saved=[]
        for row in doc.get('schools',[])[:5000]:
            if not isinstance(row,dict):continue
            entry={**ctx,'city':city,**row};entry.setdefault('scid',row.get('id'))
            if type(entry.get('scid')) is int and entry['scid']>0:
                try:saved.append(self.directory.school(self.directory.save(host,entry)))
                except UnresolvedSchoolName:continue
        levels=[]
        for name,param in LEVELS:
            rows=doc.get(name,[])
            if not isinstance(rows,list):continue
            options=[{'id':r['id'],'name':str(r.get('name') or r.get('label') or r['id'])[:300]}
                     for r in rows[:5000] if isinstance(r,dict) and valid_location_id(param,r.get('id'))]
            if options:levels.append({'key':param,'items':options})
        return {'context':ctx,'levels':levels,'items':saved,'source':'portal_live',
                'complete':all(not isinstance(doc.get(k),list) or len(doc[k])<=5000 for k in ('schools',*(n for n,_ in LEVELS)))}
    async def discover(self,host_id,query='',flat_only=False):
        host=self.directory.trusted_host(host_id);h=SgoHTTP(host,client=self.client);found=set();calls=0
        try:
            form=await h.request('GET','/prepareloginform',optional=True);calls+=1
            if form is None:form={}
            if not isinstance(form,dict):raise ProviderUnavailable('Неизвестный формат дерева школ')
            defaults={k:form[k] for k in PARAMS[:-1] if type(form.get(k)) is int}
            self.directory.remember_cities(host_id,form)
            def collect(doc,context):
                rows=doc.get('schools',doc.get('items',[])) if isinstance(doc,dict) else doc
                if not isinstance(rows,list):return
                city_names={x['id']:str(x.get('name','')) for x in form.get('cities',[]) if isinstance(x,dict) and type(x.get('id')) is int}
                if isinstance(doc,dict):
                    context={**context,**{k:doc[k] for k in PARAMS[:-1] if type(doc.get(k)) is int}}
                    city_names.update({x['id']:str(x.get('name','')) for x in doc.get('cities',[]) if isinstance(x,dict) and type(x.get('id')) is int})
                for row in rows[:1000]:
                    if not isinstance(row,dict):continue
                    entry={**context,**row}
                    # Real flat search uses provinceId/cityId, NOT pid/cn.
                    # Inheriting the prepare form's default town would log into
                    # the wrong organisation context for search hits elsewhere.
                    for wire,key in (('provinceId','pid'),('cityId','cn'),('schoolFuncType','sft')):
                        if type(row.get(wire)) is int and key not in row:entry[key]=row[wire]
                    if not row.get('city'):entry['city']=city_names.get(entry.get('cn')) or self.directory.city_name(host_id,entry.get('cn'))
                    if 'scid' not in entry:entry['scid']=row.get('id')
                    if type(entry.get('scid')) is int and entry.get('scid')>0:
                        try:found.add(self.directory.save(host,entry))
                        except UnresolvedSchoolName:continue
            collect(form,defaults)
            # Flat search is supported by newer versions; 404 means legacy tree.
            flat=await h.request('GET','/schools/search',params={'name':query[:120]},optional=True);calls+=1
            # A flat hit may belong to another town. Never attach the prepare
            # form's default district/city/type to an unrelated school.
            collect(flat,{k:v for k,v in defaults.items() if k in {'cid','sid'}})
            queue=[] if flat_only else [(form,defaults,0)]
            while queue and calls<32:
                doc,context,depth=queue.pop(0)
                if depth>=len(LEVELS):collect(doc,context);continue
                name,param=LEVELS[depth];items=doc.get(name,[]) if isinstance(doc,dict) else []
                if not items:
                    if param in context:queue.append((doc,context,depth+1))
                    continue
                for item in items[:12]:
                    if calls>=32:break
                    if not isinstance(item,dict) or type(item.get('id')) is not int:continue
                    # Changing a parent invalidates old child defaults.
                    ctx={k:v for k,v in context.items() if k not in dict(LEVELS[depth+1:]).values()}
                    ctx[param]=item['id']
                    # Unique choices can share a complete prepareloginform response.
                    next_doc=doc if len(items)==1 and (depth+1==len(LEVELS) or LEVELS[depth+1][0] in doc) else await h.request('GET','/loginform',params={**ctx,'LASTNAME':param})
                    if next_doc is not doc:
                        calls+=1
                        next_doc=loginform_reply(next_doc,param)
                    if isinstance(next_doc,dict):self.directory.remember_cities(host_id,next_doc)
                    collect(next_doc,ctx);queue.append((next_doc,ctx,depth+1))
            if not form and flat is None:raise SgoUnsupported('Портал не предоставляет поддерживаемый API школ')
            self.directory.mark(host_id,'online')
            return {'host_id':host_id,'host_status':'online','resolved':len(found),
                    'bounded':bool(queue) or any(len(form.get(n,[]))>12 for n,_ in LEVELS if isinstance(form.get(n),list)),
                    'requests':calls,'directory_complete':False}
        except (ProviderUnavailable,SgoUnsupported,SgoAuthRejected,ReauthRequired,UnsupportedPortal,ValueError,TypeError,KeyError,OSError,TimeoutError,httpx.HTTPError) as exc:
            self.directory.mark(host_id,'unavailable')
            return {'host_id':host_id,'host_status':'unavailable','resolved':len(found),'reason':'Не удалось подтвердить публичный протокол этого узла','error_code':type(exc).__name__}
    async def live_search(self,query,region=None,host_id=None,flat_only=False):
        from app.school_regions import canonical_region
        if region:region=canonical_region(region)
        # Explicit live request, not unbounded network activity per keypress.
        candidates=[self.directory.trusted_host(host_id)] if host_id else [self.directory.trusted_host(h['host_id']) for h in self.directory.hosts() if not region or h['region_name']==region]
        sem=asyncio.Semaphore(3)
        async def one(host):
            cache_key=query.strip().casefold()
            if flat_only:
                with self.directory.repo.tx() as db:
                    hit=db.execute('SELECT 1 FROM directory_query_cache WHERE host_id=? AND query=? AND expires>?',(host['host_id'],cache_key,time.time())).fetchone()
                if hit:return {'host_id':host['host_id'],'cached':True,'host_status':host['last_status']}
            # Cache failed/positive probes for one minute to protect public portals.
            from datetime import datetime,timezone
            if host.get('last_probed_at') and host.get('last_status')=='unavailable':
                try:
                    if (datetime.now(timezone.utc)-datetime.fromisoformat(host['last_probed_at'])).total_seconds()<60:return {'host_id':host['host_id'],'cached':True,'host_status':host['last_status']}
                except ValueError: pass
            async with sem:
                try:
                    result=await asyncio.wait_for(self.discover(host['host_id'],query,flat_only=flat_only),timeout=15)
                    if flat_only and result.get('host_status')=='online':
                        with self.directory.repo.tx() as db:
                            db.execute('DELETE FROM directory_query_cache WHERE expires<=?',(time.time(),))
                            db.execute('INSERT OR REPLACE INTO directory_query_cache VALUES(?,?,?)',(host['host_id'],cache_key,time.time()+300))
                    return result
                except TimeoutError:self.directory.mark(host['host_id'],'unavailable');return {'host_id':host['host_id'],'host_status':'unavailable','reason':'Истёк таймаут поиска'}
        tasks=[asyncio.create_task(one(h)) for h in candidates[:12]]
        done,pending=await asyncio.wait(tasks,timeout=20) if tasks else (set(),set())
        for task in pending:task.cancel()
        await asyncio.gather(*pending,return_exceptions=True)
        probes=[task.result() for task in tasks if task in done]
        probes += [{'host_status':'not_verified','reason':'Общий лимит поиска: уточни адрес портала'} for task in pending]
        return {'items':self.directory.search(query,region,host_id),'probes':probes}

def load_directory_config(repo):
    directory=Directory(repo)
    raw=json.loads(os.getenv('SGO_DIRECTORY_JSON') or '{}')
    if not isinstance(raw,dict) or len(raw.get('hosts',[]))>200 or len(raw.get('schools',[]))>50000:raise ValueError('Invalid directory config')
    for h in raw.get('hosts',[]):
        # v2.3.2 · Узел из конфигурации оператора помечается источником: только такие (и каталожные) доверены.
        host=directory.register(h['base_url'],h['region_name'],{**h.get('metadata',{}),'source':'operator_config'})
        prefix=h.get('api_prefix','/webapi')
        if not isinstance(prefix,str) or not prefix.startswith('/') or any(c in prefix for c in ('//','..','?','#','\\')):raise ValueError('Invalid API prefix')
        oauth=h.get('metadata',{}).get('oauth',{})
        with repo.tx() as db:
            db.execute('UPDATE sgo_hosts_registry SET api_prefix=?,esia_auth_url=?,myschool_auth_url=? WHERE host_id=?',(prefix,oauth.get('gosuslugi_esia',{}).get('authorization_url'),oauth.get('moya_shkola',{}).get('authorization_url'),host['host_id']))
            methods=(['sgo_credentials'] if h.get('metadata',{}).get('direct_login',True) else [])+[m for m in ('gosuslugi_esia','moya_shkola') if oauth.get(m)]
            db.execute('UPDATE schools_directory SET supported_auth_methods=? WHERE host_id=?',(json.dumps(methods),host['host_id']))
    for school in raw.get('schools',[]):directory.save(directory.host(school['base_url']),school)

    if 'institution_bindings' in raw:
        from app.institution_diary_links import replace_bindings
        replace_bindings(repo,raw['institution_bindings'])


# ================================================================== автономный резолвер параметров школы
class SchoolNotFound(LookupError):
    """На узле нет школы, подходящей под запрос."""


class SchoolAmbiguous(LookupError):
    """Под запрос подходит несколько школ: нужен явный выбор пользователя."""
    def __init__(self,message:str,candidates:list[dict]):
        super().__init__(message);self.candidates=candidates


RESOLVE_MAX_CALLS=40
RESOLVE_MAX_ROWS=5000
_STOP_WORDS={'моу','мбоу','гбоу','мау','маоу','мкоу','гоу','ноу','чоу','оу','сош','сш','школа','средняя',
             'общеобразовательная','основная','муниципальное','бюджетное','автономное',
             'казенное','казённое','государственное','учреждение','общеобразовательное','образовательное','им',
             'имени','г','город','города','района','район','with','no','n'}
_ALIASES={'сш':'школа','сош':'школа','оош':'школа','нош':'школа'}


def _norm(text:Any)->str:
    s=str(text or '').casefold().replace('ё','е')
    s=re.sub(r'[«»"\'`“”„(),.;:!?/\\-]+',' ',s)
    s=s.replace('№',' № ')
    return re.sub(r'\s+',' ',s).strip()


def _numbers(text:str)->set[str]:
    return {n.lstrip('0') or '0' for n in re.findall(r'\d+',text)}


def _tokens(text:str)->set[str]:
    return {_ALIASES.get(t,t) for t in _norm(text).split() if t and t!='№' and not t.isdigit()}


def school_match_score(query:str,row:dict)->float:
    """0 — не подходит; больше — лучше. Номера из запроса обязаны совпасть (школа №12 ≠ №121)."""
    name=' '.join(str(row.get(k) or '') for k in ('name','shortName','fullName'))
    q=_norm(query)
    if not q:return 0.0
    if q.isdigit() and str(row.get('id'))==q:return 100.0          # запрос — прямо scid
    qn=_numbers(q);rn=_numbers(name)
    if qn and not qn<=rn:return 0.0
    qt=_tokens(q)-_STOP_WORDS;rt=_tokens(name)
    meaningful=qt-{'школа'}
    if not qn and not meaningful:return 0.1                          # «МОУ СШ» — подходит всем: только выбор
    hits=sum(1 for t in meaningful if any(r.startswith(t) or t.startswith(r) for r in rt if len(r)>=3))
    if meaningful and not hits and not qn:return 0.0
    score=10.0*len(qn)+3.0*hits-2.0*(len(meaningful)-hits)
    if score<=0:score=0.5 if qn else 0.0
    if _norm(row.get('shortName') or '')==q or _norm(row.get('name') or '')==q:score+=20
    return score


def _host_for(base_url:str)->dict:
    from app.diary_providers import portal_origin
    origin=portal_origin(base_url)
    return {'host_id':'adhoc:'+(urlsplit(origin).hostname or origin),'base_url':origin,'api_prefix':'/webapi','metadata':{}}


def _location(row:dict,context:dict)->dict:
    entry={k:context[k] for k in PARAMS[:-1] if context.get(k) is not None}
    for k in PARAMS[:-1]:
        if type(row.get(k)) is int:entry[k]=row[k]
    for wire,key in (('countryId','cid'),('stateId','sid'),('provinceId','pid'),('cityId','cn'),
                     ('schoolFuncType','sft'),('funcType','sft')):
        if type(row.get(wire)) is int:entry[key]=row[wire]
    if isinstance(row.get('funcType'),dict) and type(row['funcType'].get('id')) is int:entry['sft']=row['funcType']['id']
    return entry


@dataclass
class _Found:
    rows:dict=field(default_factory=dict)          # scid → (row, context, source)
    calls:int=0


async def _collect_tree(h:SgoHTTP,form:dict,defaults:dict,found:_Found)->None:
    """Ограниченный обход дерева страна → регион → округ → город → тип ОО (/loginform)."""
    queue=[(form,defaults,0)]
    while queue and found.calls<RESOLVE_MAX_CALLS:
        doc,context,depth=queue.pop(0)
        for row in (doc.get('schools') or [])[:RESOLVE_MAX_ROWS] if isinstance(doc,dict) else []:
            if isinstance(row,dict) and type(row.get('id')) is int:
                found.rows.setdefault(row['id'],(row,context,'loginform'))
        if depth>=len(LEVELS):continue
        name,param=LEVELS[depth];items=doc.get(name) or [] if isinstance(doc,dict) else []
        if not items:
            if param in context:queue.append((doc,context,depth+1))
            continue
        for item in items[:30]:
            if found.calls>=RESOLVE_MAX_CALLS:break
            if not isinstance(item,dict) or type(item.get('id')) is not int:continue
            ctx={k:v for k,v in context.items() if k not in dict(LEVELS[depth+1:]).values()}
            ctx[param]=item['id']
            if len(items)==1 and (depth+1==len(LEVELS) or LEVELS[depth+1][0] in doc):
                queue.append((doc,ctx,depth+1));continue
            nxt=await h.request('GET','/loginform',params={**ctx,'LASTNAME':param},optional=True);found.calls+=1
            nxt=loginform_reply(nxt,param) if nxt is not None else None
            if isinstance(nxt,dict):queue.append((nxt,ctx,depth+1))


async def resolve_school_params(base_url:str,school_query:str,*,client:httpx.AsyncClient|None=None,
                                walk_tree:bool=True)->dict:
    """Параметры входа школы на узле base_url по названию/номеру («МОУ СШ №121», «121», «Лицей 8»).

    Возвращает {'scid','cid','sid','pid','cn','sft'} строками + name, short_name, city, source, inferred
    (параметры, взятые из значений формы по умолчанию, а не из строки школы). Пример (Волгоград, МОУ СШ №121):
    {'scid': '2410', 'cid': '2', 'sid': '34', 'pid': '0', 'cn': '89', 'sft': '2', ...}.
    Исключения: SchoolNotFound, SchoolAmbiguous(candidates), SgoUnsupported/ProviderUnavailable (узел)."""
    query=str(school_query or '').strip()[:120]
    if not query:raise ValueError('Нужно название или номер школы')
    h=SgoHTTP(_host_for(base_url),client=client);found=_Found()
    form=await h.request('GET','/prepareloginform',optional=True);found.calls+=1
    form=form if isinstance(form,dict) else {}
    defaults={k:form[k] for k in PARAMS[:-1] if type(form.get(k)) is int}
    cities={x['id']:str(x.get('name') or '') for x in form.get('cities') or [] if isinstance(x,dict) and type(x.get('id')) is int}
    for row in (form.get('schools') or [])[:RESOLVE_MAX_ROWS]:
        if isinstance(row,dict) and type(row.get('id')) is int:found.rows[row['id']]=(row,defaults,'prepareloginform')
    flat=None
    for params in ({'name':query},{'name':query,'withAddress':'true'}):
        flat=await h.request('GET','/schools/search',params=params,optional=True);found.calls+=1
        if flat is not None:break
    rows=flat.get('items',flat.get('schools')) if isinstance(flat,dict) else flat
    if isinstance(rows,list):
        # Строка плоского поиска может быть из другого города: наследуем только страну/регион.
        base={k:v for k,v in defaults.items() if k in {'cid','sid'}}
        for row in rows[:RESOLVE_MAX_ROWS]:
            if isinstance(row,dict) and type(row.get('id')) is int:found.rows[row['id']]=(row,base,'schools/search')
    if walk_tree and not isinstance(rows,list) and form:
        await _collect_tree(h,form,defaults,found)
    if not form and flat is None:raise SgoUnsupported('Портал не предоставляет поддерживаемый API школ')
    scored=sorted(((school_match_score(query,row),scid,row,ctx,src) for scid,(row,ctx,src) in found.rows.items()),
                  key=lambda x:(-x[0],x[1]))
    scored=[x for x in scored if x[0]>0]
    if not scored:raise SchoolNotFound('Школа не найдена на этом портале; уточни номер или название')
    best=scored[0][0];top=[x for x in scored if x[0]==best]
    def view(item):
        score,scid,row,ctx,src=item;loc=_location(row,ctx)
        inferred=[]
        for k in PARAMS[:-1]:
            if k not in loc and k in defaults and (k in {'cid','sid','sft'} or loc.get('cn') in (None,defaults.get('cn'))):
                loc[k]=defaults[k];inferred.append(k)
        city=str(row.get('city') or row.get('cityName') or cities.get(loc.get('cn')) or '')[:200] or None
        out={'scid':str(scid),**{k:str(loc[k]) for k in PARAMS[:-1] if k in loc},
             'name':str(row.get('name') or row.get('fullName') or '')[:300],
             'short_name':str(row.get('shortName') or row.get('name') or '')[:200],'city':city,'source':src,
             'inferred':inferred,'missing':[k for k in PARAMS[:-1] if k not in loc]}
        return out
    if len(top)>1:
        raise SchoolAmbiguous('Под запрос подходит несколько школ; выбери нужную',[view(x) for x in scored[:10]])
    return view(top[0])
