import {connectionRequest} from '../lib/api';
import {ConnectionHealth} from './ConnectionHealth';
import {SchoolConnect} from './SchoolConnect';
import {useEffect,useState} from 'preact/hooks';
import {telegram,syncIssue} from '../lib/platform';
type Status={status:string;provider:string;portal?:string;is_stale?:boolean;snapshot_available?:boolean;last_synced_at?:string|null};
type Sync={execution:'server';worker_online:boolean;sync:null|{last_success:number|null;last_result:string;next_due:number}};
const names:Record<string,string>={connected:'Подключено',reauth_required:'Нужно повторно войти',temporarily_unavailable:'Временно нет связи',revoked:'Отключено',unsupported_manual:'Ручной режим',demo:'Демонстрация'};
export function AccountConnections(){
  const [connectVersion,setConnectVersion]=useState(0);
  const [sync,setSync]=useState<Sync|null>(null);
  const [status,setStatus]=useState<Status|null>(null);const [message,setMessage]=useState(syncIssue());const [busy,setBusy]=useState(false);
  const [code,setCode]=useState('');const [entry,setEntry]=useState('');const [json,setJson]=useState('');
  // Excellence v3: no window.confirm — MAX/Telegram WebViews may not show JS dialogs (confirm() then returns false and the action can never run).
  const [askDisconnect,setAskDisconnect]=useState(false);
  const [requests,setRequests]=useState<{request_id:string;target:string}[]>([]);
  const [prefs,setPrefs]=useState({enabled:false,private:true,quiet_start:'22:00',quiet_end:'07:00',timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||'Europe/Moscow',homework:false,homework_per_day:2});
  const [delivery,setDelivery]=useState<{state:string;total:number}[]>([]);
  const call=(path:string,method='GET',body?:unknown)=>connectionRequest('/api/v1/'+path,body,undefined,method as 'GET'|'POST');
  const refresh=async()=>{setStatus(await call('diary/status'));setSync(await call('diary/sync'));setRequests((await call('auth/link-requests')).requests);const n=await call('diary/notifications');setPrefs({homework:false,homework_per_day:2,...n.preferences});setDelivery(n.delivery||[]);};
  const action=async(fn:()=>Promise<void>)=>{if(busy)return;setBusy(true);setMessage('');try{await fn();}catch(e){setMessage(e instanceof Error?e.message:'Не удалось выполнить запрос');}finally{setBusy(false);}};
  useEffect(()=>{void action(refresh);const conflict=()=>setMessage('История изменилась на другом устройстве. Обнови страницу: автоматическая перезапись остановлена.');addEventListener('sf-sync-conflict',conflict);return()=>removeEventListener('sf-sync-conflict',conflict);},[]);
  useEffect(()=>{
    if(!connectVersion)return;
    const frame=requestAnimationFrame(()=>{
      const school=document.querySelector<HTMLElement>('.account-connections .school-connect');
      school?.scrollIntoView({behavior:'auto',block:'start'});
      school?.querySelector<HTMLElement>('input,button')?.focus({preventScroll:true});
    });
    return()=>cancelAnimationFrame(frame);
  },[connectVersion]);
  return <section class="account-connections b-card mt-6 mb-6" aria-labelledby="connections-title" aria-busy={busy}>
    <h3 id="connections-title">Аккаунт и дневник</h3>
    <p role="status" aria-live="polite">{status?names[status.status]||status.status:'Проверяем подключение…'}{message?' · '+message:''}</p>
    {status?.is_stale&&<p class="hint-text" role="status">Показана сохранённая копия дневника{status.last_synced_at?' от '+new Date(status.last_synced_at).toLocaleString('ru-RU'):' без подтверждённой даты обновления'}. Для новых данных нужно обновить подключение.</p>}
    {status?.status==='temporarily_unavailable'&&!status.snapshot_available&&<p class="hint-text">Сохранённых данных пока нет. Добавь задание вручную или повтори обновление позже.</p>}
    <p class="hint-text">Вход в Telegram/MAX не подключает школьный дневник автоматически. Для подключения выбери школу ниже. Не вводи пароли и cookies в импорт JSON.</p>
    <ConnectionHealth onConnect={()=>setConnectVersion(v=>v+1)}/>
    <SchoolConnect key={connectVersion} initialOpen={connectVersion>0} onConnected={()=>{void refresh();document.dispatchEvent(new Event('sf-diary-change'));}}/>
    {status?.provider==='netschool'&&<div class="panel p-4 mt-3 mb-3" aria-label="Серверная синхронизация">
      <h4>Дневник синхронизирует сервер</h4>
      <p class="hint-text">Телефон и мини-приложение можно закрыть. Сессия дневника хранится зашифрованной на сервере.</p>
      <p role="status">{sync?.worker_online?'Коннектор работает':'Нет подтверждения работы коннектора'}{sync?.sync?.last_success?' · Обновлено '+new Date(sync.sync.last_success*1000).toLocaleString('ru-RU'):''}</p>
      <button class="btn btn-secondary btn-block" disabled={busy||status.status==='reauth_required'} onClick={()=>void action(async()=>{await call('diary/sync','POST');setSync(await call('diary/sync'));setMessage('Обновление поставлено в серверную очередь.');})}>Обновить дневник на сервере</button>
      <button class="btn btn-ghost" disabled={busy} onClick={()=>void action(refresh)}>Проверить синхронизацию</button>
    </div>}
    <details><summary>Нет доступного подключения — ручной режим</summary>
    <button class="btn btn-secondary btn-block" disabled={busy} onClick={()=>void action(async()=>{const r=await call('diary/connect','POST',{provider:'manual'});setStatus(r);setMessage('Ручной режим включён.');})}>Использовать ручной режим</button>
    </details>
    <details><summary>Импорт собственных данных JSON</summary>
      <p class="hint-text">Формат: tasks, lessons, grades, school_date, school_name, grade. Только ваши данные, без токенов. Импорт заменяет текущий ручной снимок.</p>
      <label class="field-label">Данные дневника<textarea class="textarea" rows={5} maxLength={60000} value={json} onInput={e=>setJson(e.currentTarget.value)} /></label>
      <button class="btn btn-secondary" disabled={busy||!json} onClick={()=>void action(async()=>{await call('diary/manual-import','POST',JSON.parse(json));setMessage('Импорт сохранён. Обнови страницу для нового плана.');await refresh();})}>Сохранить импорт</button>
    </details>
    {askDisconnect
      ? <div class="hw-confirm l-v l-w100 u-warn r-lg p-3" role="group" aria-label="Отключить дневник"><p class="f-2">Удалить подключение, сохранённую сессию дневника, оценки и очередь уведомлений?</p><div class="hw-row-actions l-h l-wrap">
          <button type="button" class="btn btn-secondary btn-sm" disabled={busy} onClick={()=>void action(async()=>{setStatus(await call('diary/disconnect','POST'));setAskDisconnect(false);document.dispatchEvent(new Event('sf-diary-change'));setMessage('Сессия и данные подключения удалены.');})}>Отключить и удалить</button>
          <button type="button" class="btn btn-ghost btn-sm" disabled={busy} onClick={()=>setAskDisconnect(false)}>Отмена</button></div></div>
      : <button class="btn btn-ghost btn-block" disabled={busy} onClick={()=>setAskDisconnect(true)}>Отключить дневник и удалить данные сессии</button>}
    <h4>Связать мои устройства</h4>
    <p class="hint-text">Создай код в основном аккаунте. Введи его только на своём втором устройстве, затем подтверди здесь. Код действует 5 минут. Аккаунты с данными автоматически не сливаются.</p>
    <button class="btn btn-secondary" disabled={busy} onClick={()=>void action(async()=>{setCode((await call('auth/link-code','POST')).code);})}>Получить код</button>
    {code&&<p role="status">Код: <strong class="num">{code}</strong> · действует 5 минут</p>}
    <label class="field-label">Код со своего основного устройства<input class="input" inputMode="numeric" autoComplete="off" maxLength={6} value={entry} onInput={e=>setEntry(e.currentTarget.value.replace(/\D/g,''))} /></label>
    <button class="btn btn-secondary" disabled={busy||entry.length!==6} onClick={()=>void action(async()=>{await call('auth/link-request','POST',{code:entry});setEntry('');setMessage('Подтверди запрос на основном устройстве, затем обнови страницу здесь.');})}>Запросить привязку</button>
    <button class="btn btn-ghost" disabled={busy} onClick={()=>void action(refresh)}>Проверить запросы</button>
    {requests.map(r=><div key={r.request_id}><p>Привязать ваш профиль {r.target}?</p><button class="btn btn-secondary" disabled={busy} onClick={()=>void action(async()=>{await call('auth/link-confirm','POST',{request_id:r.request_id});setMessage('Привязано. Обновите страницу на обоих устройствах.');await refresh();})}>Подтвердить своё устройство</button></div>)}
    <h4>Уведомления Telegram</h4>
    <label><input type="checkbox" checked={prefs.enabled} onChange={e=>setPrefs({...prefs,enabled:e.currentTarget.checked})} /> Сообщать о новых и изменённых оценках</label>
    <p class="hint-text">В сообщении — урок, отметка, тип работы и тема, если они есть в дневнике.</p>
    <label><input type="checkbox" checked={prefs.homework} onChange={e=>setPrefs({...prefs,homework:e.currentTarget.checked})} /> Сообщать о новых домашних заданиях</label>
    {prefs.homework&&<label class="field-label">Не больше сообщений о ДЗ в день
      <select class="input" value={String(prefs.homework_per_day)} onChange={e=>setPrefs({...prefs,homework_per_day:Number(e.currentTarget.value)})}><option value="1">1 — общей сводкой</option><option value="2">2</option></select></label>}
    <label><input type="checkbox" checked={prefs.private} onChange={e=>setPrefs({...prefs,private:e.currentTarget.checked})} /> Не показывать оценку и текст ДЗ в сообщении</label>
    {delivery.length>0&&<p class="hint-text" role="status">Уведомления: {delivery.map(d=>`${({sent:'отправлено',pending:'ждут отправки',failed:'не доставлено',uncertain:'неясно',sending:'отправляются'} as Record<string,string>)[d.state]??d.state} — ${d.total}`).join(' · ')}</p>}
    <div class="focus-quick mt-4 mb-6"><label>Тишина с<input type="time" value={prefs.quiet_start} onInput={e=>setPrefs({...prefs,quiet_start:e.currentTarget.value})} /></label><label>До<input type="time" value={prefs.quiet_end} onInput={e=>setPrefs({...prefs,quiet_end:e.currentTarget.value})} /></label></div>
    <label class="field-label">Часовой пояс<input class="input" value={prefs.timezone} onInput={e=>setPrefs({...prefs,timezone:e.currentTarget.value})} /></label>
    <button class="btn btn-secondary btn-block" disabled={busy} onClick={()=>void action(async()=>{
      const tg=telegram();if((prefs.enabled||prefs.homework)&&tg?.requestWriteAccess){const allowed=await new Promise<boolean>(resolve=>tg.requestWriteAccess!(resolve));if(!allowed)throw new Error('Разреши боту отправлять сообщения или отключи уведомления');}
      await call('diary/notifications','POST',prefs);setMessage('Настройки уведомлений сохранены. Бот должен быть запущен; дневник должен быть реально подключён.');
    })}>Сохранить уведомления</button>
    <p class="hint-text">При неопределённом результате отправки автоматический повтор остановлен, чтобы не прислать дубль. Чат бота — не секретное хранилище.</p>
  </section>;
}
