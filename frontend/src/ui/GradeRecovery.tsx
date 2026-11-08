import {useEffect,useRef,useState} from 'preact/hooks';
import {connectionRequest} from '../lib/api';
import {isLowMark} from '../lib/gradeTarget';
import {plural} from '../lib/time';
import {GradeWhatIf} from './GradeWhatIf';
import {DEMO_RECOVERY} from '../lib/demoGrades';
export type Recovery={average:number;target:number;fives_needed:number;projected_average:number;scope:string};
type Mark={subject:string;value:string;weight?:number|string|null;topic:string;date:string;grade_id?:string;recovery_plan:Recovery|null};
type Plan={subject:string;topic:string;value:string;key:string;plan:Recovery;marks:Mark[]};
/** Одна карточка на предмет: точный план сервера + «Что, если…» по всем оценкам предмета (B2). */
function plans(grades:readonly Mark[]):Plan[]{
 // v2.2: «3-», «5/3», «2+» — тоже низкие (паритет с app/grade_marks.py::is_low); «Н», «Зач» — нет.
 const low=grades.filter(g=>g.recovery_plan&&isLowMark(g.value));
 const seen=new Map<string,Plan>();
 for(const g of [...low].sort((a,b)=>(b.date||'').localeCompare(a.date||''))){
  if(!seen.has(g.subject))seen.set(g.subject,{subject:g.subject,topic:g.topic,value:g.value,key:g.grade_id||g.subject,plan:g.recovery_plan!,marks:grades.filter(x=>x.subject===g.subject)});
 }
 return [...seen.values()];
}
/** v2.2: прокрутка к предмету, выбранному чипом «Исправить» в списке средних (подсветка 1,6 с, без анимации при reduce). */
function useFocusSubject(root:{current:HTMLElement|null},focus:string|null|undefined,ready:unknown){
 useEffect(()=>{
  if(!focus||!root.current)return;
  const el=[...root.current.querySelectorAll<HTMLElement>('[data-subject]')].find(x=>x.dataset.subject===focus);
  if(!el)return;
  let reduce=true;try{reduce=matchMedia('(prefers-reduced-motion: reduce)').matches||document.documentElement.dataset.a11y==='1';}catch{/* */}
  el.scrollIntoView({block:'start',behavior:reduce?'auto':'smooth'});
  el.classList.add('is-focus');
  const t=setTimeout(()=>el.classList.remove('is-focus'),1600);
  return()=>clearTimeout(t);
 },[focus,ready]);
}
export function GradeRecovery({onTutor,onMission,focus}:{onTutor:(subject:string,topic:string)=>void;onMission?:(subject:string,topic:string)=>void;focus?:string|null}){
 const [items,setItems]=useState<Plan[]>([]),[message,setMessage]=useState('Загружаем оценки…');
 const root=useRef<HTMLElement>(null);
 useFocusSubject(root,focus,items);
 useEffect(()=>{let c:AbortController|null=null;const load=()=>{c?.abort();const current=new AbortController();c=current;void connectionRequest<{grades:Mark[];hide_grades?:boolean;grades_state?:string}>('/api/v1/diary/grades',undefined,current.signal).then(d=>{if(current.signal.aborted)return;/* v2.1: скрытие — только по hide_grades (экран), а не по push-флагу private */const hidden=d.hide_grades===true||d.grades_state==='privacy_hidden';setItems(hidden?[]:plans(d.grades));setMessage(hidden?'Подсказки скрыты: в профиле включено «Скрывать оценки на экране».':d.grades_state==='sgo_unlinked'?'Подключите дневник, чтобы увидеть план исправления оценок.':'Нет оценок, для которых нужен расчёт исправления.');}).catch(()=>{if(!current.signal.aborted)setMessage('Не удалось загрузить оценки. Выдуманные оценки не подставляются.');});};const visible=()=>{if(document.visibilityState==='visible')load();};load();document.addEventListener('sf-diary-change',load);document.addEventListener('visibilitychange',visible);return()=>{c?.abort();document.removeEventListener('sf-diary-change',load);document.removeEventListener('visibilitychange',visible);};},[]);
 return <section ref={root} class="grade-recovery" aria-label="Траектория исправления"><p class="gr-lead f-b f-2 mb-2"><b>Спокойно исправим.</b> Расчёт только по загруженным оценкам предмета, не прогноз четвертной оценки.</p>{!items.length&&<p class="gr-empty py-3 f-b f-2" role="status">{message}</p>}{items.map(g=><div key={g.key} class="gr-item" data-subject={g.subject}><article class="panel p-4 mt-3 mb-3"><h3>{g.subject} · {g.value}</h3><p>{g.topic}</p><p class="recovery-line f-num">Всё поправимо. Средний балл <b class="num">{g.plan.average.toFixed(2)}</b>. Для <b class="num">{g.plan.target.toFixed(2)}</b> нужно ещё <b class="num">{g.plan.fives_needed}</b> {plural(g.plan.fives_needed,"оценка","оценки","оценок")} «5» весом 1.</p><button class="btn btn-secondary btn-block" onClick={()=>onTutor(g.subject,g.topic)}>Разобрать тему с тьютором</button></article>{onMission&&<GradeWhatIf subject={g.subject} topic={g.topic||'Разобрать тему'} marks={g.marks} onMission={onMission}/>}</div>)}</section>;
}
/** Демо-режим: те же экраны на синтетических оценках с честной пометкой (в автономной копии дневника нет). */
export function GradeRecoveryDemo({onMission,focus}:{onMission:(subject:string,topic:string)=>void;focus?:string|null}){
 const root=useRef<HTMLElement>(null);
 useFocusSubject(root,focus,DEMO_RECOVERY);
 return <section ref={root} class="grade-recovery" aria-label="Траектория исправления (демо)"><p class="gr-lead f-b f-2 mb-2"><b>Спокойно исправим.</b> Демо-режим: оценки — пример, не из дневника. С подключённым дневником расчёт идёт по вашим оценкам.</p>{DEMO_RECOVERY.map(s=><div key={s.subject} class="gr-item" data-subject={s.subject}><GradeWhatIf demo subject={s.subject} topic={s.topic} marks={s.marks} onMission={onMission}/></div>)}</section>;
}
