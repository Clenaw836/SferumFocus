const pending=new Set<string>();
export const syncPending=()=>pending.size>0;
export function setSyncPending(source:string,value:boolean):void{if(value)pending.add(source);else pending.delete(source);if(typeof window!=='undefined')window.dispatchEvent(new Event('sf-pending-change'));}
