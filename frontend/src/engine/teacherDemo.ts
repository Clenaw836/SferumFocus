/** Read-only explicit DEMO fixture generated from app.teacher_mode, never a live fallback. */
import fixture from "./teacherDemoData.json" with { type: "json" };
import type {TmDay,TmDirectory,TmMaterials,TmPrep,TmResults} from "../lib/teacherTypes";
import {LocalError} from "./local";
interface DemoTeacher {days:Record<string,TmDay>;results:Record<string,TmResults>;preps:Record<string,{lesson:TmPrep["lesson"];facts:TmPrep["facts"];fields:Record<string,number>}>;materials:TmMaterials}
const data = fixture as unknown as {directory:TmDirectory;teachers:Record<string,DemoTeacher>;prepShared:unknown[]};
const copy = <T>(x:T):T => JSON.parse(JSON.stringify(x));
const teacher = (id:string) => {const t=data.teachers[id];if(!t)throw new LocalError("DEMO: выберите учителя",409);return t;};
export const directory = () => copy(data.directory);
export function today(id:string,date:string,now:string|null,scenario:string):TmDay {
  const d = new Date(`${date}T12:00:00Z`);if(!Number.isFinite(+d))throw new LocalError("Некорректная дата",422);
  const weekday=(d.getUTCDay()+6)%7;
  const base=teacher(id).days[String(weekday)];
  const day:TmDay=JSON.parse(JSON.stringify(base).split(base.date).join(date));
  if(scenario==="not_loaded"||scenario==="unavailable"){day.lessons=[];day.state=scenario;}
  if(scenario==="stale"){day.state="stale";day.meta.stale=true;}
  day.next=day.lessons.find(l=>l.status==="active"&&(!now||l.end>now))??null;
  return day;
}
export function results(id:string,cls:string,subject:string,order:string):TmResults {
 const r=teacher(id).results[`${cls}|${subject}`];if(!r)throw new LocalError("Нет права просмотра этого класса и предмета",403);
 const out=copy(r);out.order=order;if(order==="alpha")out.rows.sort((a,b)=>a.student.localeCompare(b.student,"ru"));return out;
}
export function prep(id:string,lessonId:string):TmPrep {
 const t=teacher(id);const parts=lessonId.split(":");const date=parts[1];const d=new Date(`${date}T12:00:00Z`);const weekday=(d.getUTCDay()+6)%7;
 const base=t.days[String(weekday)];if(!base)throw new LocalError("Урок не найден",404);
 const key=lessonId.replace(date,base.date);const p=t.preps[key];if(!p)throw new LocalError("Урок не найден",404);
 const expanded={lesson:p.lesson,facts:p.facts,...Object.fromEntries(Object.entries(p.fields).map(([key,index])=>[key,data.prepShared[index]]))};
 return JSON.parse(JSON.stringify(expanded).split(base.date).join(date)) as TmPrep;
}
export const materials=(id:string)=>copy(teacher(id).materials);
