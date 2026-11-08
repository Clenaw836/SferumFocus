import type {Task,InitialState} from './types';
import {toMin} from './time';
export function firstMission(tasks:Task[],done:string[],today:string):{task:Task;minutes:number;partial:boolean}|null{
 const choices=tasks.filter(t=>!done.includes(t.title)&&(!t.deadline||t.deadline<=today)&&Number.isFinite(t.planned_minutes)&&t.planned_minutes>0);
 choices.sort((a,b)=>a.planned_minutes-b.planned_minutes||(a.title<b.title?-1:a.title>b.title?1:0));
 const task=choices[0];if(!task)return null;
 // A long assignment is NOT relabelled as ten minutes: start an honest short segment.
 const minutes=Math.min(15,task.planned_minutes);return{task,minutes,partial:minutes<task.planned_minutes};
}
/** V23-N17 · одно «что дальше» для главного экрана («Сейчас по плану») и экрана «Задание завершено» («Следующее: …»).
 * Раньше лист брал первое невыполненное по порядку списка, а главный экран — короткое задание (firstMission) или план:
 * после «Русского» лист звал к «Алгебре», а главный экран — к «Литературе». Правило то же, что в Tonight:
 * свежий план → первая работа плана, которая ещё не прошла; иначе firstMission; иначе первое невыполненное. */
export function nextUp(tasks:Task[],done:string[],today:string,works:{task?:string|null;end:string}[]|null,nowMin:number):Task|null{
 const left=tasks.filter(t=>!done.includes(t.title));
 const title=works?(works.find(w=>w.task&&!done.includes(w.task)&&toMin(w.end)>nowMin)?.task??left[0]?.title):(firstMission(tasks,done,today)?.task.title??left[0]?.title);
 return title?tasks.find(t=>t.title===title)??null:null;
}
export function provenance(initial:InitialState,pending:boolean):string[]{
 const out:string[]=[];
 if(initial.diary_mode==='mock')out.push('Демо-стенд жюри (локальные данные)');
 else if(initial.diary_provider==='netschool'){
  let domain='';try{domain=new URL(initial.diary_portal||'').hostname;}catch{}
  out.push(initial.diary_status==='connected'?'Дневник СГО подключён'+(domain?' · '+domain:''):initial.diary_status==='temporarily_unavailable'?'СГО временно недоступен · сохранённые данные':'Дневник СГО требует подключения');
  out.push(initial.bell_schedule_present===true?'Звонки: по данным портала':'Звонки не переданы порталом');
 }else out.push('Расписание: ручные данные');
 if(pending)out.push('Сохранено только на устройстве (ожидает сети)');return out;
}
