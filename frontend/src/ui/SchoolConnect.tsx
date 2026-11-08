import {EsiaConnect} from './EsiaConnect';
import {SchoolDirectory} from './SchoolDirectory';
import {useEffect,useRef,useState} from 'preact/hooks';
import {connectionRequest} from '../lib/api';
import {roleContext} from '../lib/roleContext';
import {JuryEntry} from './JuryEntry';
import {School,hostLabel,allowedMethod,hasDiarySession} from '../lib/school';
import {Segmented} from './Segmented';
import {Icon} from './Icon';
import {DiaryConsent} from './DiaryConsent';
type Method='sgo_credentials'|'gosuslugi_esia'|'moya_shkola';
type AuthOptions={school_uid:string;school_password_login:boolean|null;status:string};
/** v2.3.2 (D3): способы Госуслуг/«Моей школы» показываются, только если сервер включил их (ENABLE_ESIA_AUTH). */
const ESIA_ON=new Set(['awaiting_official_credentials','ready']);
const ESIA_OFF_TEXT='Вход через Госуслуги в этом приложении сейчас недоступен: официальный шлюз подготовлен и отключён. Войдите логином и паролем, которые выдала школа.';
export function SchoolConnect({onConnected,initialOpen=false,juryEntry=true}:{onConnected:()=>void;initialOpen?:boolean;juryEntry?:boolean}){
 const [open,setOpen]=useState(initialOpen),[school,setSchool]=useState<School|null>(null),[items,setItems]=useState<School[]>([]);
 const [quickOpen,setQuickOpen]=useState(false);
 const [query,setQuery]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const [esiaOn,setEsiaOn]=useState(false);
 const [login,setLogin]=useState(''),[password,setPassword]=useState(''),[show,setShow]=useState(false),[method,setMethod]=useState<Method>('sgo_credentials');
 const [authOptions,setAuthOptions]=useState<AuthOptions|null>(null);
 const [consent,setConsent]=useState(false); // V23: согласие на обработку данных дневника — до любого способа входа
 const [loginRole,setLoginRole]=useState<'student'|'teacher'>(roleContext().role);
 const [connected,setConnected]=useState(false),[choosing,setChoosing]=useState(false);const generation=useRef(0);const active=useRef(true);
 const call=(path:string,body?:unknown,signal?:AbortSignal)=>connectionRequest('/api/platform/'+path,body,signal);
 const refresh=async()=>{const d=await call('bootstrap');if(!active.current)return;setSchool(d.school);setConnected(hasDiarySession(d.diary_connection));};
 useEffect(()=>{active.current=true;void refresh().catch(()=>{});const visible=()=>{if(document.visibilityState==='visible')void refresh().catch(()=>{});};document.addEventListener('visibilitychange',visible);document.addEventListener('sf-diary-change',visible);return()=>{active.current=false;document.removeEventListener('visibilitychange',visible);document.removeEventListener('sf-diary-change',visible);};},[]);
 useEffect(()=>{if(!open||!quickOpen||query.trim().length<2||school&&!choosing)return;const controller=new AbortController();const n=++generation.current;const timer=setTimeout(()=>{void call('schools/search?q='+encodeURIComponent(query),undefined,controller.signal).then(d=>{if(n===generation.current)setItems(d.items);}).catch(e=>{if(!controller.signal.aborted)setMessage(e instanceof Error?e.message:'Поиск недоступен');});},200);return()=>{clearTimeout(timer);controller.abort();};},[open,quickOpen,query,school,choosing]);
 useEffect(()=>{if(!open)return;const controller=new AbortController();void connectionRequest('/api/v1/diary/auth/capabilities',undefined,controller.signal).then((d:{esia_state?:string})=>{if(!controller.signal.aborted)setEsiaOn(ESIA_ON.has(String(d?.esia_state)));}).catch(()=>{if(!controller.signal.aborted)setEsiaOn(false);});return()=>controller.abort();},[open]);
 useEffect(()=>{setAuthOptions(null);if(!open||!school||connected||choosing)return;const controller=new AbortController();const key=school.school_uid;void call('school/auth-options',undefined,controller.signal).then((d:AuthOptions)=>{if(!controller.signal.aborted&&d.school_uid===key)setAuthOptions(d);}).catch(()=>{});return()=>controller.abort();},[open,school?.school_uid,connected,choosing]);
 const action=async(fn:()=>Promise<void>)=>{if(busy)return;setBusy(true);setMessage('');try{await fn();}catch(e){setMessage(e instanceof Error?e.message:'Не удалось подключиться');}finally{setBusy(false);}};
 const close=()=>{setOpen(false);setPassword('');setShow(false);setMessage('');};
 const choose=async(s:School)=>{const d=await call('schools/select',{school_uid:s.school_uid});setSchool(d.school);setChoosing(false);setMethod(allowedMethod(d.school,'sgo_credentials')?'sgo_credentials':allowedMethod(d.school,'gosuslugi_esia')?'gosuslugi_esia':'moya_shkola');setPassword('');setShow(false);};
 return <section class="school-connect b-card mt-4 mb-4" aria-labelledby="school-connect-title">
  {juryEntry&&!connected&&<JuryEntry/>}
  <div class="school-connect-heading l-h l-g3 mb-4"><Icon name="book"/><div><h4 id="school-connect-title">Мой школьный дневник</h4><p class="f-2">{school?.short_name||'Школа → вход → ваш дневник'}</p></div></div>
  {!open?<button class="btn btn-secondary btn-block" onClick={()=>{setOpen(true);setChoosing(false);void refresh().catch(()=>{});}}>{connected?'Управлять подключением':school?'Войти в дневник':'Подключить реальный дневник СГО'}</button>:<>
   <div class="school-connect-toolbar l-h l-btw mt-4 mb-4"><strong>{school&&!choosing?'Подключение дневника':'Выбор дневника'}</strong><button class="btn btn-ghost" onClick={close} disabled={busy}>Свернуть</button></div>
   {(!school||choosing)?<>
    <SchoolDirectory call={call} onChoose={s=>void action(()=>choose(s))} disabled={busy} onFindPortal={(name)=>{setQuery(name.slice(0,120));setQuickOpen(true);setMessage('Ищем школу в проверенном каталоге серверов. Адрес сервера вручную не вводится — так пароль не уйдёт на чужой сайт.');}}/><details class="school-quick mt-4 mb-4" open={quickOpen} onToggle={e=>setQuickOpen(e.currentTarget.open)}><summary>Быстрый поиск в сохранённом каталоге</summary><label class="field-label" htmlFor="school-search">Название школы, город или регион</label><input id="school-search" class="input" type="search" value={query} maxLength={120} autoComplete="off" placeholder="Например, лицей 101, Тестоград" onInput={e=>setQuery(e.currentTarget.value)}/>
    <p class="school-help f-b f-2 mt-3 mb-4">Это сохранённые результаты прошлых запросов. Для актуального поиска выберите регион и портал выше.</p>
    <ul class="school-results l-v l-g3 mt-4 mb-4" aria-label="Найденные школы">{items.map(s=><li key={s.school_uid}><button disabled={busy} onClick={()=>void action(()=>choose(s))}><strong>{s.short_name}</strong><span>{[s.city,s.region].filter(Boolean).join(' · ')}</span><small>{new URL(s.base_url).hostname} · Сетевой Город</small><small>{hostLabel(s.host_status)}</small><span class="school-select-label f-w6 f-a mt-1">Выбрать школу →</span></button></li>)}</ul>
    {items.length===0&&<p class="school-empty f-b b-card mt-4 mb-4">Пока нет совпадений. Уточните название или проверьте региональные серверы. Каталог не охватывает все школы.</p>}
    <button class="btn btn-secondary btn-block" disabled={busy||query.trim().length<2} onClick={()=>void action(async()=>{const d=await call('schools/search?q='+encodeURIComponent(query)+'&live=true');setItems(d.items);setMessage(d.items.length?'Выберите вашу школу.':'Не удалось найти школу на доступных узлах. Попробуйте адрес своего портала или ручной режим.');})}>Найти на серверах СГО</button>
    </details>
    <p class="school-help f-b f-2 mt-3 mb-4 school-untrusted-note">Школы нет в списке — значит, её сервер ещё не проверен. Адрес сервера вручную не вводится: так логин и пароль не уйдут на чужой сайт. Попросите школу проверить адрес портала СГО или войдите через Госуслуги.</p>
    {school&&<button class="btn btn-ghost" onClick={()=>setChoosing(false)}>Назад к моей школе</button>}
   </>:<>
    <div class="school-host l-v b-card mb-4"><span class="school-kicker f-m f-w6 f-2">Школа и сервер определены</span>{!connected&&<button type="button" class="btn btn-ghost" disabled={busy} onClick={()=>{setChoosing(true);setPassword('');}}>Изменить</button>}<strong>{school.name}</strong><span class="f-2">{[school.city,school.region].filter(Boolean).join(' · ')}</span><code class="f-a">{new URL(school.base_url).hostname}</code><span class="f-2">{hostLabel(school.host_status)}</span></div>
    {connected?<><p class="school-success f-s f-ok" role="status">✓ Дневник подключён{school.student_display_name?' · '+school.student_display_name:''}{school.class_name?' · '+school.class_name:''}</p><p class="school-help f-b f-2 mt-3 mb-4">Уроки, время начала и окончания, домашние задания берутся из дневника. Перемены определяются по промежуткам между уроками. Если портал не передал время, приложение не подставляет выдуманные звонки.</p><button class="btn btn-secondary btn-block" onClick={()=>location.reload()}>Открыть обновлённый дневник</button><p class="school-help f-b f-2 mt-3 mb-4">Для смены школы сначала отключите дневник кнопкой ниже.</p></>:<>
    <DiaryConsent checked={consent} disabled={busy} onChange={setConsent}/>
    {esiaOn&&<div class="school-methods mt-4 mb-4"><Segmented<Method> value={method} options={[{value:'sgo_credentials',label:'СГО'},{value:'gosuslugi_esia',label:'Госуслуги'},{value:'moya_shkola',label:'Моя школа'}]} onChange={v=>{setMethod(v);setPassword('');setShow(false);setMessage('');}} label="Способ входа"/></div>}
    {!connected&&<label class="field"><span class="field-label">Роль входа в СГО</span><select class="input" value={loginRole} disabled={busy} onChange={e=>{const r=e.currentTarget.value==='teacher'?'teacher':'student';setLoginRole(r);try{localStorage.setItem('sf_role',r);}catch{}}}><option value="student">Ученик</option><option value="teacher">Учитель</option></select></label>}
    {method==='sgo_credentials'?allowedMethod(school,method)&&authOptions?.school_password_login!==false?<form onSubmit={e=>{e.preventDefault();void action(async()=>{try{const result=await call('diary/connect',{login,password,role:loginRole});await refresh();if(result.role!==roleContext().role){location.reload();return;}onConnected();setMessage('Дневник подключён. Расписание и домашние задания загружены автоматически. Старые оценки не будут отправлены в чат.');}finally{setPassword('');setShow(false);}});}}>
     <p class="school-help f-b f-2 mt-3 mb-4">Для входа сервер приложения передаст данные на <strong>{new URL(school.base_url).hostname}</strong>. Вводите пароль СГО, не пароль Госуслуг.</p>
     <label class="field-label" htmlFor="sgo-login">Логин в Сетевом Городе</label><input id="sgo-login" class="input" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellcheck={false} value={login} maxLength={200} required disabled={busy} onInput={e=>setLogin(e.currentTarget.value)}/>
     <label class="field-label" htmlFor="sgo-password">Пароль СГО</label><div class="school-password l-h l-wrap l-g1"><input id="sgo-password" class="input" type={show?'text':'password'} autoComplete="current-password" value={password} maxLength={300} required disabled={busy} onInput={e=>setPassword(e.currentTarget.value)}/><button class="btn btn-ghost" type="button" aria-pressed={show} onClick={()=>setShow(!show)}>{show?'Скрыть':'Показать'}</button></div>
     <p class="school-help f-b f-2 mt-3 mb-4">Введите логин и пароль, которые вам выдали в школе.</p><a href={school.base_url} target="_blank" rel="noopener noreferrer">Забыли пароль? Восстановить на портале</a><p class="school-security l-h l-top f-b f-2 mt-4 mb-4"><Icon name="lock"/> Сессия шифруется на сервере. Пароль не сохраняется.</p>
     <button type="submit" class="btn btn-primary btn-block" disabled={busy||!login||!password||!consent}>{busy?'Проверяем вход…':'Войти в Сетевой Город'}</button>
    {esiaOn&&<button type="button" class="btn btn-ghost btn-block" onClick={()=>{setMethod('gosuslugi_esia');setPassword('');}}>Войти через Госуслуги</button>}</form>:<p class="school-empty f-b b-card mt-4 mb-4">{esiaOn?'Портал отключил вход по школьному логину и паролю. Выберите доступный официальный способ входа.':'Эта школа принимает вход только через Госуслуги. '+ESIA_OFF_TEXT}</p>:!esiaOn?<p class="school-empty f-b b-card mt-4 mb-4" role="status">{ESIA_OFF_TEXT}</p>:!consent?<p class="school-help f-b f-2 mt-3 mb-4">Чтобы войти через {method==='gosuslugi_esia'?'Госуслуги':'«Мою школу»'}, отметьте согласие выше.</p>:method==='gosuslugi_esia'?<><EsiaConnect school={school} onConnected={()=>{void refresh();onConnected();}}/><button type="button" class="btn btn-ghost btn-block" onClick={()=>setMethod('sgo_credentials')}>Войти, используя логин и пароль</button></>:<EsiaConnect key={school.school_uid+':myschool'} school={school} method="moya_shkola" onConnected={()=>{void refresh();onConnected();}}/>}
    <button class="btn btn-ghost btn-block" disabled={busy} onClick={()=>{setChoosing(true);setPassword('');}}>Выбрать другую школу</button>
    </>}
    <button class="btn btn-secondary btn-block" disabled={busy} onClick={()=>void action(async()=>{if(connected)await call('diary/sync',{});await refresh();onConnected();setMessage('Статус подключения обновлён.');})}>Проверить подключение</button>
   </>}
   <p class="school-feedback f-b f-2 mt-4" role="status" aria-live="polite">{busy?'Запрос к серверу… Это может занять до 45 секунд.':message}</p>
  </>}
 </section>;
}
