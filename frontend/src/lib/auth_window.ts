/** External authorization uses SDK feature detection, never initDataUnsafe. */
import {hasExternalLinkBridge,openUrl} from './max';
import {handoffExternalUrl} from './handoff';
export function hostAuthLinkAvailable(): boolean {
 return typeof window.Telegram?.WebApp?.openLink==='function'||hasExternalLinkBridge();
}
/** Call only from an explicit login/reopen action, not a polling effect. */
export function openAuthLink(url:string):void {
 const safe=new URL(handoffExternalUrl(url,location.origin));
 if(window.Telegram?.WebApp?.openLink)window.Telegram.WebApp.openLink(safe.href);
 else if(hasExternalLinkBridge()&&safe.protocol==='https:')openUrl(safe.href);
 else window.open(safe.href,'_blank','noopener,noreferrer');
}
