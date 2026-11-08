import { QuizClock } from "./quizClock";
import type { CloseQuiz, CloseQuizResult } from './studentTypes';
type Q = { question: string; options: string[] };
export type CloseAttempt = { clock: QuizClock | null; started: boolean; token: number; quiz: CloseQuiz | null; local: {qs: Q[]; right: number[]; why: string[]} | null; err: string | null; i: number; ans: number[]; res: CloseQuizResult | null; busy: boolean };
/** Only quiz attempt state; timing/completion remain in focus/dayStore. Memory-only per identity. */
class CloseQuizSession {
 private records = new Map<string, CloseAttempt>(); private listeners = new Set<() => void>();
 get(key: string): CloseAttempt { let s=this.records.get(key);if(!s){s={clock:null,started:false,token:0,quiz:null,local:null,err:null,i:0,ans:[],res:null,busy:false};this.records.set(key,s)}return s; }
 subscribe(fn:()=>void):()=>void {this.listeners.add(fn);return ()=>{this.listeners.delete(fn)}}
 update(key:string, s:CloseAttempt, patch:Partial<CloseAttempt>):boolean {if(this.records.get(key)!==s)return false;Object.assign(s,patch);this.listeners.forEach(f=>f());return true;}
 current(key:string,s:CloseAttempt,token:number):boolean{return this.records.get(key)===s&&s.token===token}
 forget(key:string):void{const s=this.records.get(key);s?.clock?.cancel();this.records.delete(key);this.listeners.forEach(f=>f())}
 reset():void{this.records.forEach(s=>s.clock?.cancel());this.records.clear();this.listeners.forEach(f=>f())}
}
export const closeQuizSession = new CloseQuizSession();
/** Preserve the established rounded-share contract (4 questions → 2), not mathematical ceiling60%. */
export const closeQuizRequired = (total:number, share=0.6):number => Math.max(1,Math.round(total*share));
