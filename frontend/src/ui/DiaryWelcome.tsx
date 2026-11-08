import {useEffect,useRef,useState} from 'preact/hooks';
import {Sheet} from './Sheet';
import {connectionRequest,onboarding,type ConnectResult,type RoleName} from '../lib/api';
import {enterJury} from '../lib/jury';
import {JuryEntry} from './JuryEntry';
import {SchoolConnect} from './SchoolConnect';
import {OnboardingWizard} from './onboarding/OnboardingWizard';
import {adoptProfileAppearance} from '../lib/profileSync';
import {toast} from './Toast';
import {hasDiarySession} from '../lib/school';
import {roleContext} from '../lib/roleContext';
import {TeacherBody} from './DiaryOverviewCard';
import {OPEN_ONBOARDING_EVENT} from '../lib/onboardingEvent';
export {OPEN_ONBOARDING_EVENT, openOnboarding} from '../lib/onboardingEvent';
/** The host login identifies the account; this separate step connects its diary.
 *  v2.1: шаги «Кто вы? → Найдите свою школу → Подключить дневник»; прежние способы (Госуслуги, файл, ручной ввод)
 *  остаются в «Другие способы подключения».
 *  v3.2 · Экран обязательный: ученик без сессии дневника не попадает в приложение. Нет «Продолжить без
 *  подключения», крестика, Escape и свайпа; единственный обход — капсула «Демо жюри» в шапке (вымышленные данные). */
export function DiaryWelcome({enabled,role='student'}:{enabled:boolean;role?:RoleName}){
 const [open,setOpen]=useState(false),[error,setError]=useState(''),[retry,setRetry]=useState(0),[wizardKey,setWizardKey]=useState(0);
 const [teacherDone,setTeacherDone]=useState<ConnectResult|null>(null),[forced,setForced]=useState(false);
 useEffect(()=>{
  if(!enabled)return;let stopped=false;const c=new AbortController();
  void (async()=>{
   const profile=await onboarding.profile().catch(()=>null);
   if(stopped)return;
   if(profile){adoptProfileAppearance(profile);if(profile.onboarding_completed)return;}
   // Учитель: права и классы уже выданы справочником школы, рабочее место открывается сразу (в том числе по
   // deep link #teacher-assignments). Мастер не перекрывает его сам — журнал подключают из карточки «Подключите
   // журнал» (DiaryOverviewCard → openOnboarding) или из профиля.
   if(role==='teacher')return;
   const d=await connectionRequest('/api/platform/bootstrap',undefined,c.signal);
   if(!stopped&&d.diary_connection?.provider!=='demo'&&!hasDiarySession(d.diary_connection)){setForced(true);setOpen(true);}
  })().catch(()=>{if(!stopped&&role==='student'){setError('Не удалось проверить подключение дневника. Проверьте интернет и повторите.');setForced(true);setOpen(true);}});
  return()=>{stopped=true;c.abort();};
 },[enabled,retry,role]);
 useEffect(()=>{
  if(!enabled)return;
  const show=()=>{setError('');setTeacherDone(null);setWizardKey(k=>k+1);setOpen(o=>{if(!o)setForced(false);return true;});};
  document.addEventListener(OPEN_ONBOARDING_EVENT,show);
  return()=>document.removeEventListener(OPEN_ONBOARDING_EVENT,show);
 },[enabled]);
 const focusPlan=useRef(false);
 const continueToPlan=()=>{focusPlan.current=true;setOpen(false);};
 const afterClose=()=>{
  if(!focusPlan.current)return;
  focusPlan.current=false;
  const mission=document.getElementById('mission-title');
  if(mission){mission.setAttribute('tabindex','-1');mission.focus({preventScroll:true});mission.scrollIntoView({block:'center',behavior:'auto'});}
  toast('Дневник можно подключить позже в профиле.', 'info');
 };
 const connected=(r:ConnectResult)=>{
  document.dispatchEvent(new Event('sf-diary-change'));
  // Аккаунт учителя в СГО, а приложение открыто как ученик. Права учителя выдаёт школа (справочник /
  // TEACHER_MAX_IDS), а не мастер — показываем честную панель, а не «готово».
  if(r.role!==roleContext().role){location.reload();return;}
  setForced(false);setOpen(false);
  toast(r.school_name?`Дневник подключён · ${r.school_name}`:'Дневник подключён','ok');
 };
 const closePending=()=>{setTeacherDone(null);setOpen(false);};
 const locked=forced&&!teacherDone;
 const jury=<button type="button" class="jury-capsule" onClick={enterJury} aria-label="Демо жюри: вымышленные данные без входа">Демо жюри</button>;
 return <Sheet full open={open&&enabled} locked={locked} headAction={locked?jury:undefined} onClose={teacherDone?closePending:continueToPlan} onAfterClose={afterClose} title="Подключить дневник" eyebrow="СферумФокус">
  {teacherDone?<div class="diary-welcome"><TeacherPending r={teacherDone} onClose={closePending}/></div>:<div class="diary-welcome">
   {error?<><p role="alert">{error}</p><button class="btn btn-secondary btn-block" onClick={()=>{setError('');setRetry(v=>v+1);}}>Повторить проверку</button></>:<OnboardingWizard key={wizardKey} initialRole={role} onDone={connected}/>}
   <details class="dw-more pt-3 mt-4 mb-2"><summary>Другие способы входа: каталог порталов СГО, «Моя школа»</summary>
    <JuryEntry/>
    <SchoolConnect initialOpen={false} juryEntry={false} onConnected={()=>{document.dispatchEvent(new Event('sf-diary-change'));setForced(false);setOpen(false);}}/>
   </details>
  </div>}
 </Sheet>;
}
/** Учитель подключил журнал из оболочки ученика: вход в СГО принят, но рабочее место учителя откроется только после
 *  того, как школа добавит его в справочник (права выдаёт школа, а не приложение — иначе это повышение прав). */
function TeacherPending({r,onClose}:{r:ConnectResult;onClose:()=>void}){
 const ov=r.overview;
 return <section class="dw-teacher l-v l-g3 b-card" aria-labelledby="dw-teacher-title">
  <h2 id="dw-teacher-title">Журнал учителя подключён</h2>
  <p class="f-2">Дневник принял вход учителя. Рабочее место учителя откроется, когда школа добавит вас в справочник учителей СферумФОКУСа: права выдаёт школа, а не приложение.</p>
  {ov?.teacher_data&&<TeacherBody data={ov.teacher_data} school={ov.school?.name??r.school_name??null} stale={ov.is_stale} cachedAt={ov.cached_at}/>}
  <button type="button" class="btn btn-primary btn-block" onClick={onClose}>Понятно</button>
 </section>;
}
