import {LoadingRows} from './LoadingRows';
import {useEffect,useRef,useState} from 'preact/hooks';
import {regionMatches,type RegionOption} from '../lib/regions';
import type {School} from '../lib/school';
type Host={host_id:string;base_url:string;region_name:string;last_status:string;name:string;auth_policy?:string;sources?:string[];public_probe?:{checked_at:string;status:string;authenticated:boolean}};
type Service={id:string;name:string;kind:string;official_url:string;integration:string;sources:string[]};
type Locations={context:Record<string,number>;levels:{key:string;items:{id:number;name:string}[]}[];items:School[];complete:boolean};
const locationLabels:Record<string,string>={cid:'Страна',sid:'Регион портала',pid:'Район',cn:'Город / населённый пункт',sft:'Тип учебного заведения'};
type Institution={institution_uid:string;name:string;short_name:string;city:string;region:string;address:string;source_url:string;license:string;portal_candidates:string[];diary_bindings?:{school:School;source_url:string;verified_at:string}[]};
type Call=(path:string,body?:unknown,signal?:AbortSignal)=>Promise<any>;
/** Guided discovery. Only the selected portal receives anonymous requests. */
export function SchoolDirectory({call,onChoose,disabled,onFindPortal}:{call:Call;onChoose:(school:School)=>void;disabled:boolean;onFindPortal?:(name:string,portals:string[])=>void}){
 const [regions,setRegions]=useState<RegionOption[]>([]),[region,setRegion]=useState(''),[regionQuery,setRegionQuery]=useState('');
 const [regionsLoading,setRegionsLoading]=useState(true),[regionalLoading,setRegionalLoading]=useState(false);
 const [providersLoading,setProvidersLoading]=useState(true);
 const [services,setServices]=useState<Service[]>([]),[providerError,setProviderError]=useState('');
 const [hosts,setHosts]=useState<Host[]>([]),[host,setHost]=useState<Host|null>(null),[cities,setCities]=useState<{city:string;schools:number}[]>([]),[city,setCity]=useState('');
 const [query,setQuery]=useState(''),[items,setItems]=useState<School[]>([]),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const [locations,setLocations]=useState<Locations|null>(null),[locationQuery,setLocationQuery]=useState('');
 const [regionalQuery,setRegionalQuery]=useState(''),[regionalItems,setRegionalItems]=useState<School[]>([]),[regionalMessage,setRegionalMessage]=useState('');
 const seq=useRef(0);const alive=useRef(true);
 // Epoch also distinguishes A → B → A: host equality alone is not enough.
 const portalEpoch=useRef(0),selectedHostId=useRef<string|null>(null);
 const isCurrentPortal=(h:Host,epoch:number)=>alive.current&&portalEpoch.current===epoch&&selectedHostId.current===h.host_id;
 const leavePortal=()=>{portalEpoch.current++;selectedHostId.current=null;setHost(null);setCities([]);setLocations(null);};
 useEffect(()=>{alive.current=true;void call('directory/regions').then(d=>{if(alive.current){setRegions(d.items);setRegionsLoading(false);}}).catch(()=>{if(alive.current){setRegionsLoading(false);setMessage('Не удалось загрузить регионы. Проверьте связь и откройте выбор ещё раз.');}});return()=>{alive.current=false;seq.current++;portalEpoch.current++;selectedHostId.current=null;};},[]);
 useEffect(()=>{if(!region)return;const c=new AbortController();setHosts([]);setServices([]);setProviderError('');setProvidersLoading(true);void call('directory/providers?region='+encodeURIComponent(region),undefined,c.signal).then(d=>{if(!c.signal.aborted){setHosts(d.items);setServices(d.services||[]);setProvidersLoading(false);}}).catch(()=>{if(!c.signal.aborted){setProvidersLoading(false);setProviderError('Не удалось загрузить дневники. Вернитесь к выбору региона и повторите.');}});return()=>c.abort();},[region]);
 const [institutions,setInstitutions]=useState<Institution[]>([]);
 const [regionalMore,setRegionalMore]=useState(false),[regionalOffset,setRegionalOffset]=useState(0);
 const queryKey=useRef('');queryKey.current=region+'|'+regionalQuery+'|'+(host?.host_id||'');
 useEffect(()=>{
  if(!region||host||providersLoading){setRegionalLoading(false);return;}
  setRegionalLoading(true);
  const c=new AbortController();let liveFinished=false;setRegionalItems([]);setInstitutions([]);setRegionalMore(false);setRegionalOffset(0);
  const onlyCached=regionalQuery.trim().length===1;
  const path='schools/search?q='+encodeURIComponent(regionalQuery)+'&region='+encodeURIComponent(region)+'&include_institutions=true';
  const apply=(d:any)=>{setRegionalLoading(false);setRegionalItems(d.items);setInstitutions(d.institutions||[]);setRegionalMore(!!d.has_more);setRegionalOffset(d.next_offset??d.items.length);};
  const cached=setTimeout(()=>{void call(path,undefined,c.signal).then(d=>{if(!c.signal.aborted&&!liveFinished){apply(d);setRegionalMessage(onlyCached?'Поиск по сохранённым школам. Для обновления с портала введите ещё один символ.':d.items.length||(d.institutions||[]).length?'Результаты каталога. Карточки дневников и открытых учреждений показаны отдельно.':hosts.length?'Проверяем региональный портал…':'В каталоге пока нет совпадений; можно указать адрес дневника ниже.');}}).catch(()=>{if(!c.signal.aborted){setRegionalLoading(false);setRegionalMessage('Не удалось загрузить каталог. Проверьте связь или уточните портал ниже.');}});},120);
  const live=onlyCached||!hosts.length?0:setTimeout(()=>{void call(path+'&live=true&flat=true',undefined,c.signal).then(d=>{if(!c.signal.aborted){liveFinished=true;apply(d);setRegionalMessage(d.items.length?'Выберите вашу школу.':'Совпадений нет или портал недоступен. Можно уточнить сервер ниже.');}}).catch(()=>{if(!c.signal.aborted){setRegionalLoading(false);setRegionalMessage('Портал не ответил. Сохранённые школы доступны; повторите позже.');}});},400);
  return()=>{clearTimeout(cached);clearTimeout(live);c.abort();};
 },[region,host,regionalQuery,providersLoading,hosts]);
 const moreRegional=async()=>{if(busy)return;const key=queryKey.current;setBusy(true);try{
  const d=await call('schools/search?q='+encodeURIComponent(regionalQuery)+'&region='+encodeURIComponent(region)+'&include_institutions=true&offset='+regionalOffset);
  if(alive.current&&queryKey.current===key){setRegionalItems(old=>[...old,...d.items.filter((x:School)=>!old.some(y=>y.school_uid===x.school_uid))]);setInstitutions(old=>[...old,...(d.institutions||[]).filter((x:Institution)=>!old.some(y=>y.institution_uid===x.institution_uid))]);setRegionalMore(!!d.has_more);setRegionalOffset(d.next_offset);}
 }catch{if(alive.current&&queryKey.current===key)setRegionalMessage('Не удалось загрузить следующую страницу. Повторите попытку.');}finally{if(alive.current)setBusy(false);}};

 const loadCities=async(h:Host,epoch:number)=>{
  try{
   const d=await call('directory/cities?host_id='+encodeURIComponent(h.host_id));
   if(isCurrentPortal(h,epoch))setCities(d.items);
  }catch{
   // Cities are optional. A failed enrichment must not hide cached schools.
   if(isCurrentPortal(h,epoch))setCities([]);
  }
 };
 useEffect(()=>{
  if(!host)return;
  const n=++seq.current,c=new AbortController(),epoch=portalEpoch.current;
  const timer=setTimeout(()=>{void call('schools/search?q='+encodeURIComponent(query)+'&host_id='+encodeURIComponent(host.host_id)+(city?'&city='+encodeURIComponent(city):''),undefined,c.signal).then(d=>{
   if(!c.signal.aborted&&n===seq.current&&isCurrentPortal(host,epoch))setItems(d.items);
  }).catch(()=>{});},200);
  return()=>{clearTimeout(timer);c.abort();};
 },[host,query,city]);
 const discover=async(h:Host,q='')=>{
  if(busy)return;
  const epoch=portalEpoch.current;
  setBusy(true);setMessage('Получаем список учебных заведений с выбранного сервера…');
  try{
   const d=await call('schools/resolve-host',{host_id:h.host_id,q});
   if(!isCurrentPortal(h,epoch))return;
   setItems(d.items);await loadCities(h,epoch);
   if(!isCurrentPortal(h,epoch))return;
   setMessage(d.host_status==='online'?(d.items.length?'Школы загружены с портала. Выберите город и свою школу.':'Сервер ответил, но список пуст. Уточните название школы и повторите поиск.'):'Портал сейчас недоступен или его API отличается. Авторизация не выполнялась. Можно повторить поиск или указать другой адрес СГО.');
  }catch(e){if(isCurrentPortal(h,epoch))setMessage(e instanceof Error?e.message:'Не удалось получить школы');}
  finally{if(isCurrentPortal(h,epoch))setBusy(false);}
 };
 const setNode=(h:Host)=>{
  const epoch=++portalEpoch.current;selectedHostId.current=h.host_id;
  setHost(h);setCity('');setQuery('');setItems([]);setCities([]);setLocations(null);setLocationQuery('');
  void loadCities(h,epoch);void discover(h);
 };
 const loadLocations=async(context:Record<string,number>={})=>{
  if(!host||busy)return;
  const epoch=portalEpoch.current;setBusy(true);setMessage('Получаем районы и города непосредственно с портала…');
  try{
   const d:Locations=await call('directory/locations',{host_id:host.host_id,context});
   if(!isCurrentPortal(host,epoch))return;
   setLocations(d);setLocationQuery('');
   if(d.items.length){setItems(d.items);await loadCities(host,epoch);}
   if(isCurrentPortal(host,epoch))setMessage(d.complete?'Выберите район, город или школу из ответа портала.':'Портал вернул большой список. Уточните выбор; каталог может быть неполным.');
  }catch(e){if(isCurrentPortal(host,epoch))setMessage(e instanceof Error?e.message:'Не удалось получить города');}
  finally{if(isCurrentPortal(host,epoch))setBusy(false);}
 };
 return <div class="school-directory">
  <p class="school-help f-b f-2 mt-3 mb-4">Регион → школа → вход. Выбор города необязателен. Уроки и время загрузятся из дневника, если портал их предоставляет.</p>
  <nav aria-label="Выбор дневника" class="school-path l-h l-wrap mt-4 mb-4">
   <button type="button" disabled={busy} onClick={()=>{seq.current++;setRegion('');leavePortal();setItems([]);setMessage('');}}>1. {region||'Регион'}</button>
   {region&&<button type="button" disabled={busy} onClick={()=>{seq.current++;leavePortal();setMessage('');}}>2. {host?'Дневник выбран':'Дневник'}</button>}
   {host&&<span>3. Город и школа</span>}
  </nav>
  {!region?<>
   <label class="field-label" htmlFor="region-search">Поиск региона</label><input id="region-search" class="input" type="search" value={regionQuery} onInput={e=>setRegionQuery(e.currentTarget.value)} placeholder="Например, Волгоградская область"/>
   {regionsLoading&&<LoadingRows label="Загружаем регионы"/>}
   <ul class="school-results l-v l-g3 mt-4 mb-4 school-region-list p-1" aria-label="Регионы">{regions.filter(x=>regionMatches(x,regionQuery)).map(x=><li key={x.name}><button onClick={()=>{setRegion(x.name);setRegionalQuery('');setRegionalItems([]);setRegionalMessage('');setProvidersLoading(true);setMessage('');}}><strong>{x.name}</strong><small>{x.portals?'СГО: '+x.portals+' · проверка при выборе':x.other_services?'Есть региональные сервисы':'Федеральные сервисы или свой адрес'}{x.cached_schools?' · школ в каталоге: '+x.cached_schools:''}</small></button></li>)}</ul>
   {regions.length>0&&!regions.some(x=>regionMatches(x,regionQuery))&&<p class="school-empty f-b b-card mt-4 mb-4">Регион не найден. Можно указать адрес портала ниже.</p>}
  </>:!host?<>
   {providersLoading&&<LoadingRows label="Загружаем способы подключения"/>}
   {!providersLoading&&<>
   <h4>Выберите учебное учреждение</h4>
   <label class="field-label" htmlFor="regional-school-search">Название или номер школы в регионе</label><input id="regional-school-search" class="input" type="search" value={regionalQuery} maxLength={120} placeholder="Например, 121" onInput={e=>setRegionalQuery(e.currentTarget.value)}/>
   <p class="school-help f-b f-2 mt-3 mb-4" role="status">{regionalMessage}</p>
   {regionalLoading&&!regionalItems.length&&!institutions.length&&<LoadingRows label="Ищем школы региона"/>}
   <ul class="school-results l-v l-g3 mt-4 mb-4" aria-label="Школы региона">{regionalItems.map(s=><li key={s.school_uid}><button disabled={busy||disabled} onClick={()=>onChoose(s)}><strong>{s.short_name}</strong><span>{[s.region,s.city].filter(Boolean).join(' · ')}</span><small>{new URL(s.base_url).hostname}</small></button></li>)}</ul>
   {institutions.length>0&&<><h4>Учреждения из открытых источников</h4><p class="school-help f-b f-2 mt-3 mb-4">Подтверждённые связи ведут к выбору школы в дневнике. Для остальных карточек нужно найти портал. Выбор не отправляет логин и пароль.</p><ul class="school-results l-v l-g3 mt-4 mb-4" aria-label="Учреждения региона">{institutions.map(s=><li key={s.institution_uid}><section class="school-service l-v b-card mt-4 mb-4"><strong>{s.short_name}</strong><span>{[s.region,s.city].filter(Boolean).join(' · ')}</span>{s.address&&<p class="school-help f-b f-2 mt-3 mb-4">{s.address}</p>}{s.diary_bindings?.length?s.diary_bindings.map(link=><div class="school-diary-binding l-v" key={link.school.school_uid}><button type="button" class="btn btn-secondary btn-block" disabled={busy||disabled} onClick={()=>onChoose(link.school)}>Выбрать школу · {new URL(link.school.base_url).hostname}</button><small>Связь с дневником подтверждена · вход ещё не выполнен</small><a class="f-a" href={link.source_url} target="_blank" rel="noopener noreferrer">Источник связи с дневником</a></div>):<button type="button" class="btn btn-secondary btn-block" disabled={busy||disabled} onClick={()=>onFindPortal?.(s.name,s.portal_candidates)}>Найти дневник этой школы</button>}<a class="f-a" href={s.source_url} target="_blank" rel="noopener noreferrer">Источник карточки</a><small>{s.license}</small></section></li>)}</ul></>}
   </>}
   {regionalMore&&<button type="button" class="btn btn-secondary btn-block" disabled={busy||disabled} onClick={()=>void moreRegional()}>Показать ещё школы</button>}
   <h4>{hosts.length?'Другой способ: выбрать электронный дневник':'Дневники и способы подключения'}</h4>
   {providerError&&<p role="alert">{providerError}</p>}
   <ul class="school-results l-v l-g3 mt-4 mb-4" aria-label="Электронные дневники">{hosts.map(h=><li key={h.host_id}><button disabled={busy||disabled} onClick={()=>setNode(h)}><strong>{h.name}</strong><span>{new URL(h.base_url).hostname}</span><small>{h.last_status==='online'?'Публичный API отвечал; это не проверка входа':'Адрес-кандидат · проверим API при выборе'}</small>{h.auth_policy==='esia_only'&&<small>Портал сообщает: вход только через ЕСИА</small>}</button></li>)}</ul>
   {!hosts.length&&!providerError&&!providersLoading&&<p class="school-empty f-b b-card mt-4 mb-4">Автоматическое подключение для этого региона пока не подтверждено. Сайты ниже можно открыть отдельно — это не синхронизация с СферумФокусом. Ручной режим доступен без подключения дневника.</p>}
   <ul class="school-results l-v l-g3 mt-4 mb-4 school-service-list" aria-label="Другие системы дневников">{services.map(s=><li key={s.id}><section class="school-service l-v b-card mt-4 mb-4"><strong>{s.name}</strong><span>{new URL(s.official_url).host}</span><p class="school-help f-b f-2 mt-3 mb-4">{s.integration==='agreement_required'?'Импорт требует соглашения и разрешённого канала обмена с оператором.':s.integration==='oauth_registration_required'?'Есть официальный OAuth API. Для импорта нужно зарегистрировать приложение у провайдера.':'Официальный сайт сервиса. Автоматический импорт этой системы в сборке не подключён.'}</p><a class="f-a" href={s.official_url} target="_blank" rel="noopener noreferrer">Открыть сайт — без подключения данных ↗</a><details><summary>Источники и статус</summary><p class="school-help f-b f-2 mt-3 mb-4">Это переход на внешний сайт, а не вход в СферумФокус. Пароль Госуслуг здесь не запрашивается. Наличие адреса не подтверждает обслуживание вашей школы.</p>{s.sources.map((url,i)=><p key={url}><a href={url} target="_blank" rel="noopener noreferrer">Источник {i+1} · {new URL(url).hostname}</a></p>)}</details></section></li>)}</ul>
  </>:<>
   <p class="school-kicker f-m f-w6">{new URL(host.base_url).hostname}</p>
   {host.sources&&host.sources.length>0&&<details class="school-external mt-4 mb-4"><summary>Откуда адрес и что проверено</summary><p class="school-help f-b f-2 mt-3 mb-4">{host.public_probe?.status==='public_api_compatible'?'При подготовке сборки публичный API ответил совместимым JSON. Вход ученика этим не подтверждён.':'Это адрес-кандидат из открытого каталога. Совместимость и доступность проверяются отдельно.'}</p>{host.public_probe&&<p class="school-help f-b f-2 mt-3 mb-4">Проверка: {host.public_probe.checked_at.slice(0,10)} · без логина и пароля.</p>}{host.sources.map((url,i)=><a class="f-a" key={url} href={url} target="_blank" rel="noopener noreferrer">Источник {i+1} · {new URL(url).hostname}</a>)}</details>}
   {host.auth_policy==='esia_only'&&<p class="school-help f-b f-2 mt-3 mb-4" role="note">Этот портал объявил вход только через ЕСИА. Поиск школ не обходит это ограничение. Авторизация требует настроенного официального шлюза.</p>}
   <label class="field-label" htmlFor="school-city">Город / населённый пункт</label><select id="school-city" class="input" value={city} onChange={e=>setCity(e.currentTarget.value)}><option value="">Все города выбранного портала</option>{cities.map(x=><option key={x.city} value={x.city}>{x.city} · {x.schools}</option>)}</select>
   <p class="school-help f-b f-2 mt-3 mb-4">Города берутся из списка школ портала. Если список ещё пуст, ищите школу по названию.</p>
   <details class="school-locations"><summary>Нет нужного города? Уточнить район и город на портале</summary>
    <p class="school-help f-b f-2 mt-3 mb-4">Для старых версий СГО можно пройти дерево населённых пунктов без ограничения первыми городами. Идентификаторы определяет портал.</p>
    <button type="button" class="btn btn-secondary btn-block" disabled={busy||disabled} onClick={()=>void loadLocations()}>Загрузить районы и города</button>
    {locations&&<>
     <label class="field-label" htmlFor="location-search">Найти в списке портала</label><input id="location-search" class="input" type="search" value={locationQuery} onInput={e=>setLocationQuery(e.currentTarget.value)}/>
     {locations.levels.map(level=><fieldset key={level.key} class="school-location-level b-tile mt-3 mb-3"><legend>{locationLabels[level.key]||level.key}</legend><ul class="school-results l-v l-g3 mt-4 mb-4">{level.items.filter(x=>x.name.toLocaleLowerCase().includes(locationQuery.toLocaleLowerCase())).map(option=><li key={option.id}><button type="button" disabled={busy||disabled} onClick={()=>{const keys=['cid','sid','pid','cn','sft'];const context=Object.fromEntries(Object.entries(locations.context).filter(([k])=>keys.indexOf(k)<keys.indexOf(level.key)));void loadLocations({...context,[level.key]:option.id});}}>{option.name}{locations.context[level.key]===option.id?' ✓':''}</button></li>)}</ul></fieldset>)}
    </>}
   </details>
   <label class="field-label" htmlFor="school-name-search">Название или номер школы</label><input id="school-name-search" class="input" type="search" placeholder="Например, 121" value={query} maxLength={120} onInput={e=>setQuery(e.currentTarget.value)}/>
   <button type="button" class="btn btn-secondary btn-block" disabled={busy||disabled} onClick={()=>void discover(host,query)}>Найти школы на выбранном сервере</button>
   {busy&&!items.length&&<LoadingRows label="Загружаем школы портала"/>}
   <ul class="school-results l-v l-g3 mt-4 mb-4" aria-label="Школы выбранного портала">{items.filter(s=>!city||s.city===city).map(s=><li key={s.school_uid}><button disabled={disabled||busy} onClick={()=>onChoose(s)}><strong>{s.short_name}</strong><span>{[s.city,s.region].filter(Boolean).join(' · ')}</span><small>{new URL(s.base_url).hostname}</small></button></li>)}</ul>
   {!items.length&&!busy&&<p class="school-empty f-b b-card mt-4 mb-4">Школ пока нет. Уточните название и выполните поиск на выбранном сервере.</p>}
  </>}
  <p class="school-feedback f-b f-2 mt-4" role="status" aria-live="polite">{message}</p>
 </div>;
}
