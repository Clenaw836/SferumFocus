/** Encrypted server history + text drafts; revision conflicts never overwrite another device. */
import {tutorSession} from './tutorSession';
import {schoolDay} from './schoolDay';
import {setSyncPending} from './syncState';
import {launchCredential,launchHeaders,csrfHeaders,reportSyncConflict} from './platform';
let checkpoint: (() => Promise<boolean>) | null = null;
/** Await a durable text checkpoint BEFORE a permission dialog can reload a MAX WebView. */
export async function checkpointTutor(): Promise<void> {
  if (!Object.keys(tutorSession.draftSnapshot()).length) return;
  if (!checkpoint || !await checkpoint()) throw new Error('Черновик пока не сохранён на сервере. Проверь сеть; фото из галереи и текст остаются доступны.');
}
export async function installTutorSync(): Promise<void> {
  const signed=launchCredential(), epoch=tutorSession.epoch;
  let version=0, blocked=false, timer:ReturnType<typeof setTimeout>|undefined;
  const active=()=>launchCredential()===signed && tutorSession.epoch===epoch;
  const headers=()=>({'Content-Type':'application/json',...launchHeaders(signed),...csrfHeaders()});
  const snapshot=()=>({history:tutorSession.historySnapshot(schoolDay()),drafts:tutorSession.draftSnapshot()});
  checkpoint=null;
  try {
    const r=await fetch('/api/v1/shared/tutor',{credentials:'include',headers:headers(),redirect:'error'});
    if(!r.ok || !active()){if(active())tutorSession.subscribe(()=>setSyncPending('tutor',true));return;}
    const d=await r.json();if(!active())return;version=d.version;
    if(d.payload?.history)tutorSession.hydrateHistory(d.payload.history,schoolDay());
    tutorSession.hydrateDrafts(d.payload?.drafts);
  }catch{if(active())tutorSession.subscribe(()=>setSyncPending('tutor',true));return;}
  let previous=JSON.stringify(snapshot());
  let flight:Promise<boolean>|null=null;
  async function save():Promise<boolean>{
    if(blocked || !active())return false;
    if(flight) { const ok=await flight; return ok && active() && !blocked && (JSON.stringify(snapshot())===previous || await save()); }
    const payload=snapshot(), encoded=JSON.stringify(payload);
    if(encoded===previous)return true;
    flight=(async()=>{
      try{
        const r=await fetch('/api/v1/shared/tutor',{method:'PUT',credentials:'include',redirect:'error',headers:headers(),body:JSON.stringify({version,payload})});
        if(!active())return false;
        if(r.status===409){blocked=true;reportSyncConflict();return false;}
        if(r.status===401||r.status===403){blocked=true;return false;}
        if(!r.ok)return false;
        const d=await r.json();if(!active())return false;version=d.version;previous=encoded;
        setSyncPending('tutor',JSON.stringify(snapshot())!==previous);return true;
      }catch{return false;}
      finally{flight=null;}
    })();
    const ok=await flight;
    if(active()&&!blocked&&JSON.stringify(snapshot())!==previous)timer=setTimeout(()=>void save(),5000);
    return ok;
  }
  checkpoint=async()=>{clearTimeout(timer);const ok=await save();return ok && active() && JSON.stringify(snapshot())===previous;};
  tutorSession.subscribe(()=>{
    if(blocked||!active())return;
    if(JSON.stringify(snapshot())===previous)return;
    setSyncPending('tutor',true);clearTimeout(timer);timer=setTimeout(()=>void save(),700);
  });
  window.addEventListener('online',()=>{if(active())void save();});
}
