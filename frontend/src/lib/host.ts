/** UI host adapter. Auth never uses this convenience wrapper. */
import * as max from './max';
import {telegram,telegramData} from './platform';
export * from './max';
const tg=()=>telegramData()?telegram():undefined;
export const ready=()=>{if(tg()){try{tg()?.ready?.();}catch{/* host unavailable */}}else max.ready();};
export const maxUser=():ReturnType<typeof max.maxUser>=>tg()?.initDataUnsafe?.user as ReturnType<typeof max.maxUser>||max.maxUser();
export const startParam=()=>tg()?.initDataUnsafe?.start_param||max.startParam();
const stack:{cb:()=>void}[]=[];let bound=false;
const onBack=()=>stack[stack.length-1]?.cb();
function syncBack(){const b=tg()?.BackButton;if(!b)return;try{if(!bound){b.onClick(onBack);bound=true;}if(stack.length)b.show();else b.hide();}catch{/* unsupported bridge */}}
export function bindBack(cb:()=>void):()=>void{if(!tg())return max.bindBack(cb);const entry={cb};stack.push(entry);syncBack();return()=>{const i=stack.indexOf(entry);if(i>=0)stack.splice(i,1);syncBack();};}
export const backDepth=()=>tg()?stack.length:max.backDepth();
const guards=new Set<string>();
export function closingGuard(on:boolean,reason='game'):void{if(!tg()){max.closingGuard(on,reason);return;}if(on)guards.add(reason);else guards.delete(reason);try{if(guards.size)tg()?.enableClosingConfirmation?.();else tg()?.disableClosingConfirmation?.();}catch{/* unsupported bridge */}}
export const haptic:typeof max.haptic={
 tap(style='light'){if(!tg())return max.haptic.tap(style);try{tg()?.HapticFeedback?.impactOccurred(style);}catch{/* no-op */}},
 select(){if(!tg())return max.haptic.select();try{tg()?.HapticFeedback?.selectionChanged();}catch{/* no-op */}},
 notify(kind){if(!tg())return max.haptic.notify(kind);try{tg()?.HapticFeedback?.notificationOccurred(kind);}catch{/* no-op */}},
};
export function setupViewport():void{max.setupViewport();if(tg()){document.documentElement.dataset.platform=tg()?.platform||'telegram';document.documentElement.dataset.host='telegram';}}
export function launchInfo():ReturnType<typeof max.launchInfo>{return tg()?{inMax:false,platform:tg()?.platform||'telegram',version:tg()?.version||null,device:null,chat:null}:max.launchInfo();}
export function openUrl(url:string):void{if(!/^https:\/\//.test(url))return;if(tg()?.openLink){try{tg()!.openLink!(url);return;}catch{/* system fallback */}}max.openUrl(url);}
export function appLink(payload:string,botName?:string|null):string{if(tg())return `${location.origin}${location.pathname}?startapp=${encodeURIComponent(payload.slice(0,512))}`;return max.appLink(payload,botName);}
