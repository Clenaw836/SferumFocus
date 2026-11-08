import type {TmResults} from "./teacherTypes";
import {getPerformanceSeverity} from "./performance";
import {routeOf} from "./max";
/** One quiz is evidence, not mastery or a pedagogical diagnosis. No invented denominator. */
export function analyticsRows(r:TmResults) {
 return !r.available ? [] : r.questions.map(q=>({...q,tone:getPerformanceSeverity(q.correct_pct==null||q.answered<=0?null:100-q.correct_pct).tone}));
}
export function lessonSuggestions(r:TmResults) {
 if(!r.available||r.insufficient)return [];
 return analyticsRows(r).filter(q=>q.answered>0&&q.correct_pct!=null&&q.correct_pct<100&&q.topic&&q.topic_link_confirmed)
 .sort((a,b)=>a.correct_pct!-b.correct_pct!||a.id.localeCompare(b.id)).slice(0,2);
}
export type TeacherTab="today"|"classes"|"materials";
export function teacherTab(raw:string):TeacherTab {const hash="#"+routeOf(raw);return hash==="#teacher-classes"||hash==="#teacher-assignments"?"classes":hash==="#teacher-materials"?"materials":"today";}
/** Recovery 2: «Классы» has two sections; #teacher-assignments deep-links to the assignments one. */
export type ClassesSection="results"|"assignments";
export function classesSection(raw:string):ClassesSection {return "#"+routeOf(raw)==="#teacher-assignments"?"assignments":"results";}
export const teacherHash=(tab:TeacherTab,section:ClassesSection)=>tab==="classes"&&section==="assignments"?"#teacher-assignments":`#teacher-${tab}`;
