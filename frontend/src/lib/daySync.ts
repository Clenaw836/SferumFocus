/** Share planning inputs, not in-flight mutations, awards or active device timers. */
import {launchCredential,launchHeaders,csrfHeaders,reportSyncConflict} from './platform';
import {cache} from './api';
import {schoolDay} from './day';
import {setSyncPending} from './syncState';
const fields=['extra','hidden','types','acts','bed','start','moved'];
export async function installDaySync():Promise<void>{
  window.addEventListener('sf-day-change',()=>setSyncPending('plan',true));
  const signed=launchCredential();let version=0,blocked=false,saving=false;let timer:ReturnType<typeof setTimeout>|undefined;
  const headers=()=>({'Content-Type':'application/json',...launchHeaders(signed),...csrfHeaders()});
  const snapshot=()=>Object.fromEntries(fields.map(f=>{
    const v=cache.get(`sf.${f}.${schoolDay()}`);
    return [f,v&&typeof v==='object'&&Object.keys(v).length===0?null:v];
  }));
  try{
    const r=await fetch('/api/v1/shared/plan',{headers:headers(),redirect:'error'});if(!r.ok)return;
    const d=await r.json();version=d.version;
    if(d.payload?.day===schoolDay()&&d.payload?.data&&typeof d.payload.data==='object'){
      const local=snapshot();
      if(fields.some(f=>local[f]!==null)&&JSON.stringify(local)!==JSON.stringify(d.payload.data)){
        reportSyncConflict();return; // never destroy unsynced local planning inputs
      }
      for(const f of fields)if(f in d.payload.data)cache.set(`sf.${f}.${schoolDay()}`,d.payload.data[f]);
    }
  }catch{return;}
  let previous=JSON.stringify(snapshot());
  async function save():Promise<void>{
    if(saving||blocked||launchCredential()!==signed)return;
    const data=snapshot(),encoded=JSON.stringify(data);if(encoded===previous){setSyncPending('plan',false);return;}saving=true;
    try{
      const r=await fetch('/api/v1/shared/plan',{method:'PUT',redirect:'error',headers:headers(),body:JSON.stringify({version,payload:{day:schoolDay(),data}})});
      if([401,403,409].includes(r.status)){blocked=true;if(r.status===409)reportSyncConflict();return;}
      if(r.ok){version=(await r.json()).version;previous=encoded;setSyncPending('plan',JSON.stringify(snapshot())!==previous);}
    }catch{/* Local inputs remain; never duplicate an execution mutation. */}
    finally{saving=false;if(!blocked&&JSON.stringify(snapshot())!==previous)timer=setTimeout(()=>void save(),5000);}
  }
  window.addEventListener('sf-day-change',()=>{clearTimeout(timer);timer=setTimeout(()=>void save(),700);});
  window.addEventListener('online',()=>void save());
}
