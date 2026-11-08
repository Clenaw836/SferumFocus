/** Host identity is only a transport hint until verified by the backend. */
import {initData as maxInitData} from './max';
import {createTelegramReader} from './telegramLaunch';
import {inSandbox} from './sandbox';
import {BOOT_TIMEOUT_MS,BootNetError,dropSession,fetchWithTimeout,readSession,withBootRetries,writeSession} from './bootNet';
export {sameCredential} from './telegramLaunch';
export interface TelegramApp {
  initData?:string;initDataUnsafe?:{start_param?:string;user?:{id:number;first_name?:string;last_name?:string}};
  ready?:()=>void;expand?:()=>void;platform?:string;version?:string;
  BackButton?:{show():void;hide():void;onClick(cb:()=>void):void;offClick(cb:()=>void):void};
  requestWriteAccess?:(cb:(allowed:boolean)=>void)=>void;
  openLink?:(url:string)=>void;
  enableClosingConfirmation?:()=>void;disableClosingConfirmation?:()=>void;
  HapticFeedback?:{impactOccurred(style:string):void;selectionChanged():void;notificationOccurred(kind:string):void};
}
declare global {interface Window {Telegram?:{WebApp?:TelegramApp}}}
export const telegram = ():TelegramApp|undefined => typeof window!=='undefined'?window.Telegram?.WebApp:undefined;
const readTelegramLaunch=createTelegramReader(
  ()=>telegram()?.initData||'',
  ()=>{try{return typeof location!=='undefined'?new URLSearchParams(location.hash.replace(/^#/, '')).get('tgWebAppData')||'':'';}catch{return '';}}
);
export const telegramData=():string=>readTelegramLaunch();
export function credentialFor(tg:string,max:string):string {
  if(tg&&max)throw new Error('Неоднозначная среда запуска');
  return tg?'telegram:'+tg:max;
}
/** In a demo sandbox the only credential is the server-signed X-Demo-Session token: host launch data is never mixed in.
 *  v2.1: последнее непустое значение «липкое». Мост MAX при пересоздании WebView/смене шрифта на мгновение
 *  отдаёт пустой initData — это не смена пользователя, а пропуск чтения; новая подпись по-прежнему видна сразу. */
let lastCredential='';
export const launchCredential=():string=>{
  if(inSandbox())return '';
  const current=credentialFor(telegramData(),maxInitData());
  if(current)lastCredential=current;
  return current||lastCredential;
};
/** P0 MAX: значение HTTP-заголовка обязано быть ISO-8859-1. Если клиент передал initData с не-ASCII символами
 *  (например, имя кириллицей без URL-кодирования), fetch() бросал TypeError ДО отправки запроса — сервер не видел
 *  ни одного API-вызова, а пользователь — заглушку MAX. Кодируем только символы вне 0x21–0x7E и одиночный «%»:
 *  сервер URL-декодирует значения перед проверкой HMAC, поэтому подписанные значения восстанавливаются байт в байт;
 *  уже корректная (документированная, ASCII) строка не меняется. */
export function headerSafe(value:string):string{
  return value.replace(/%(?![0-9A-Fa-f]{2})|[^\x21-\x7e]/gu,ch=>{try{return encodeURIComponent(ch);}catch{return '';}});
}
export function launchHeaders(signed:string):Record<string,string>{
  return !signed?{}:signed.startsWith('telegram:')?{'X-Telegram-Init-Data':headerSafe(signed.slice(9))}:{'X-Max-Init-Data':headerSafe(signed)};
}
let csrfToken='';
export const setCsrf=(token:string)=>{csrfToken=token;};
export const csrfHeaders=():Record<string,string>=>csrfToken?{'X-CSRF-Token':csrfToken}:{};
/** v2.1: веб-сессия — 10 с на попытку, два повтора при сетевом сбое/таймауте (600/1500 мс) и кэш
 *  CSRF-токена в sessionStorage (sf_web_session_v1) на время вкладки: перезагрузка не ждёт сервер.
 *  Кэш привязан к виду запуска; cookie сессии остаётся HttpOnly и в JS не попадает. */
export const WEB_SESSION_KEY='sf_web_session_v1';
const WEB_SESSION_TTL_MS=6*3600*1000;
interface CachedWebSession{csrf:string;scope:string;saved_at:number}
const isCachedWebSession=(v:unknown):v is CachedWebSession=>!!v&&typeof v==='object'
  &&typeof (v as CachedWebSession).csrf==='string'&&typeof (v as CachedWebSession).scope==='string'
  &&typeof (v as CachedWebSession).saved_at==='number';
const sessionScope=(signed:string)=>signed.startsWith('telegram:')?'telegram:'+(new URLSearchParams(signed.slice(9)).get('hash')||''):'web';
export function forgetWebSession():void{dropSession(WEB_SESSION_KEY);}
async function requestWebSession(signed:string,timeoutMs:number):Promise<string|null>{
  let r:Response;
  try{r=await fetchWithTimeout('/api/v1/auth/web-session',{method:'POST',credentials:'same-origin',redirect:'error',headers:{'X-Web-Bootstrap':'1','Content-Type':'application/json',...launchHeaders(signed)},body:'{}'},timeoutMs);}
  catch(e){throw e instanceof BootNetError?e:new BootNetError('network');}
  if(r.status===503)return null; // legacy explicit DEMO deployment; whoami still decides
  if(!r.ok)throw new Error('Не удалось создать сессию браузера');
  const data:unknown=await r.json().catch(()=>null);
  const token=data&&typeof data==='object'?(data as {csrf_token?:unknown}).csrf_token:undefined;
  if(typeof token!=='string')throw new Error('Неверный ответ сессии');
  return token;
}
export async function ensureWebSession(signed=''):Promise<void>{
  const scope=sessionScope(signed);
  const cached=readSession(WEB_SESSION_KEY,isCachedWebSession);
  if(cached&&cached.scope===scope&&Date.now()-cached.saved_at<WEB_SESSION_TTL_MS){
    setCsrf(cached.csrf);
    // Освежаем в фоне: тот же cookie → тот же токен; сбой сети тут ничего не ломает.
    void requestWebSession(signed,BOOT_TIMEOUT_MS).then(t=>{if(t){setCsrf(t);writeSession(WEB_SESSION_KEY,{csrf:t,scope,saved_at:Date.now()});}}).catch(()=>undefined);
    return;
  }
  const token=await withBootRetries(ms=>requestWebSession(signed,ms),e=>e instanceof BootNetError);
  if(token===null)return;
  setCsrf(token);writeSession(WEB_SESSION_KEY,{csrf:token,scope,saved_at:Date.now()});
}

let issue='';
export const syncIssue=()=>issue;
export function reportSyncConflict():void{issue='Данные изменились на другом устройстве. Автоматическая перезапись остановлена; локальная версия сохранена.';if(typeof window!=='undefined')window.dispatchEvent(new CustomEvent('sf-sync-conflict'));}
