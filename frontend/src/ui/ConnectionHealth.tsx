/** Honest server health. A failed refresh never becomes a fabricated success. */
import {useEffect, useRef, useState} from 'preact/hooks';
import {connectionRequest, ApiError} from '../lib/api';
import {haptic} from '../lib/host';
import {reward} from '../lib/motion';
import {Sheet} from './Sheet';
import {Icon} from './Icon';

type State = 'connected'|'delayed'|'reauth_required'|'demo'|'not_connected';
export type ConnectionSnapshot = {state:State; portal_host:string|null; last_success:number|null; worker_online:boolean; snapshot_available:boolean; is_stale?:boolean; last_synced_at?:string|null; checked_at:number};
type Call = (path:string, body?:unknown, signal?:AbortSignal)=>Promise<any>;
const copy:Record<State,{title:string;description:string;tone:string}> = {
  connected:{title:'Дневник на связи',description:'Сервер обновляет дневник. Мини-приложение можно закрыть — синхронизация продолжится.',tone:'good'},
  delayed:{title:'Обновление задерживается',description:'Дневник временно не обновляется. Сохранённые задания остаются доступны. Можно проверить ещё раз чуть позже.',tone:'waiting'},
  reauth_required:{title:'Нужно обновить вход',description:'Школьный портал завершил сессию. Подключи дневник повторно — личный план останется на месте.',tone:'waiting'},
  demo:{title:'Ты в демо-режиме',description:'Это учебный пример, а не данные из школы. Реальный дневник можно подключить отдельно.',tone:'neutral'},
  not_connected:{title:'Дневник ещё не подключён',description:'Планом можно пользоваться уже сейчас. Подключи школу, чтобы получать расписание и оценки.',tone:'neutral'},
};
export function ConnectionHealth({onConnect,call=connectionRequest}: {onConnect:()=>void;call?:Call}) {
  const [open,setOpen]=useState(false);
  const [snapshot,setSnapshot]=useState<ConnectionSnapshot|null>(null);
  const [busy,setBusy]=useState(false);
  const [issue,setIssue]=useState<'offline'|'session'|'unavailable'|null>(null);
  const [notice,setNotice]=useState('');
  const symbol=useRef<HTMLDivElement>(null);
  const request=useRef<AbortController|null>(null);
  const alive=useRef(true);
  const refresh=async(queue=false)=>{
    if(request.current)return;
    const controller=new AbortController();request.current=controller;
    setBusy(true);setNotice('');
    try {
      if(queue)await call('/api/v1/diary/sync',{},controller.signal);
      const result=await call('/api/v1/diary/health',undefined,controller.signal);
      if(!alive.current||request.current!==controller)return;
      setSnapshot(result);setIssue(null);
      if(queue)setNotice('Запрос принят сервером. Новые данные появятся после обновления.');
    } catch(error) {
      if(!alive.current||controller.signal.aborted)return;
      if(error instanceof ApiError && [-2,401,403].includes(error.status)){
        setSnapshot(null);setIssue('session');
      } else setIssue(navigator.onLine?'unavailable':'offline');
    } finally {
      if(request.current===controller){request.current=null;if(alive.current)setBusy(false);}
    }
  };
  useEffect(()=>{
    alive.current=true;void refresh();
    const online=()=>void refresh();
    const offline=()=>setIssue('offline');
    addEventListener('online',online);addEventListener('offline',offline);
    const changed=()=>{request.current?.abort();request.current=null;setSnapshot(null);void refresh();};
    document.addEventListener('sf-diary-change',changed);
    return()=>{alive.current=false;request.current?.abort();removeEventListener('online',online);removeEventListener('offline',offline);document.removeEventListener('sf-diary-change',changed);};
  },[]);
  useEffect(()=>{
    if(!open||snapshot?.state!=='connected'||issue)return;
    const timer=setTimeout(()=>{if(symbol.current)void reward(symbol.current);},40);
    return()=>clearTimeout(timer);
  },[open,snapshot?.state,issue]);
  const current=snapshot?copy[snapshot.state]||copy.not_connected:null;
  const title=issue==='session'?'Подтверди вход в приложение':issue?'Сейчас нет связи с сервером':current?.title||'Проверяем связь с дневником';
  const cacheDescription=snapshot?.state==='delayed'&&!snapshot.snapshot_available?'Сервер дневника временно недоступен. Сохранённых данных пока нет. Можно добавить домашнее задание вручную или повторить обновление позже.':current?.description;
  const description=issue==='session'?'Сессия приложения завершилась. Закрой и снова открой мини-приложение.':issue?'Не удалось проверить связь. Последний успешный результат показан ниже. Подключение школы не удалено.':cacheDescription||'Проверим школьный портал и работу серверной синхронизации.';
  const connect=()=>{setOpen(false);onConnect();};
  return <>
    <button class="connection-health-trigger py-4 l-h l-g3 mt-4 mb-4 l-w100" onClick={()=>{haptic.tap('light');setOpen(true);void refresh();}} aria-haspopup="dialog">
      <span class={`connection-dot b-round l-fix ${issue?'waiting':current?.tone||'neutral'}`} aria-hidden="true"/>
      <span><strong>Здоровье подключения</strong><span>{title}</span></span><Icon name="chevron"/>
    </button>
    <Sheet open={open} onClose={()=>setOpen(false)} title="Здоровье подключения" eyebrow="Аккаунт и дневник">
      <section class="connection-health pt-3" aria-label="Состояние подключения" aria-busy={busy}>
        <div class={`connection-health-summary ${issue?'waiting':current?.tone||'neutral'}`}>
          <div ref={symbol} class="connection-health-symbol l-center l-g0 f-2 b-box mb-4 s-44" aria-hidden="true"><Icon name={issue?'wifiOff':snapshot?.state==='connected'?'check':'book'}/></div>
          <h3 role="status" aria-live="polite">{title}</h3><p class="f-2">{description}</p>
        </div>
        <dl class="connection-health-facts mb-4">
          <div><dt>Школьный портал</dt><dd>{snapshot?.portal_host||'Не выбран'}</dd></div>
          <div><dt>Последнее обновление</dt><dd class="num">{snapshot?.last_success?new Date(snapshot.last_success*1000).toLocaleString('ru-RU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}):'Пока нет подтверждения'}</dd></div>
          <div><dt>Синхронизация</dt><dd>{snapshot?.worker_online?(issue?'На связи при прошлой проверке':'Сервер на связи'):snapshot?'Ожидаем подтверждения':'Ещё не проверена'}</dd></div>
        </dl>
        {issue&&snapshot&&<p class="connection-health-note f-b f-2">Это сохранённый результат проверки, не текущий статус.</p>}
        {snapshot?.is_stale&&snapshot.snapshot_available&&<p class="connection-health-note f-b f-2">Показана сохранённая копия дневника, не актуальные данные портала.</p>}
        {notice&&<p role="status" class="connection-health-note f-b f-2">{notice}</p>}
        <div class="connection-health-actions l-v">
          <button class="btn btn-secondary btn-block" disabled={busy} onClick={()=>void refresh()}><Icon name="refresh"/>{busy?'Проверяем…':'Проверить ещё раз'}</button>
          {!issue&&snapshot&&['connected','delayed'].includes(snapshot.state)&&<button class="btn btn-ghost btn-block" disabled={busy} onClick={()=>void refresh(true)}>Запросить обновление дневника</button>}
          {snapshot&&['not_connected','demo','reauth_required'].includes(snapshot.state)&&<button class="btn btn-primary btn-block" onClick={connect}>{snapshot.state==='reauth_required'?'Обновить подключение':'Подключить школьный дневник'}</button>}
        </div>
        <p class="hint-text connection-health-privacy l-h mt-6"><Icon name="lock"/>Пароль Госуслуг сюда вводить не нужно. Подключение хранится зашифрованным на сервере.</p>
      </section>
    </Sheet>
  </>;
}
