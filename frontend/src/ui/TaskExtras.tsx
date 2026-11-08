import { useEffect, useLayoutEffect, useState } from "preact/hooks";
import { Icon } from "./Icon";
import { api, ApiError } from "../lib/api";
import { makeRound, topicFor } from "../lib/blitzBank";
import type { TaskDetails } from "../lib/studentTypes";
import { closeQuizSession, closeQuizRequired } from "../lib/closeQuizSession";
import { QuizClock, questionMs } from "../lib/quizClock";
import { QuizTimer, useQuizClock } from "./QuizTimer";
import { schoolDay } from "../lib/day";
import { TaskCompletionStatus } from "./TaskCompletionStatus";
import type { Task } from "../lib/types";

const fmtDate = (s: string | null) => {
  if (!s) return null;
  const d = new Date(s + "T12:00:00");
  return isNaN(+d) ? s : d.toLocaleDateString("ru-RU", { weekday: "short", day: "numeric", month: "long" });
};

/** «Подробности»: что именно задано, откуда, к какому уроку и как посчитано время. */
export function TaskInfo({ task }: { task: Task }) {
  const [d, setD] = useState<TaskDetails | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () => { setErr(null); setD(null); api.st.details(task.title).then(setD).catch((e) => setErr(e instanceof ApiError ? e.message : "Не удалось загрузить")); };
  useEffect(load, [task.title]);
  if (err) return <div class="note bad" role="alert"><Icon name="alert" /><div>{err} <button class="btn btn-ghost btn-sm" onClick={load}>Повторить</button></div></div>;
  if (!d) return <div class="stack" aria-busy="true">{[0, 1, 2].map((i) => <div key={i} class="sk" style="height:40px" />)}</div>;
  const rows: [string, string | null, string | null][] = [
    ["Задание", d.text, null],
    ["Откуда", d.source, null],
    ["Учитель", d.teacher, null],
    ["Выдано", fmtDate(d.issued_on), null],
    ["Сдать", fmtDate(d.due), d.due_source],
    ["Тема урока", d.topic, d.topic ? d.topic_source : null],
    ["Время", `${d.planned_minutes} мин`, d.estimate_source],
  ];
  return (
    <div class="ti" tabIndex={0} role="region" aria-label="Подробности задания">
      <dl class="ti-list l-v l-g0">
        {rows.filter((r) => r[1]).map(([k, v, s]) => (
          <div class="ti-row py-2 b-sep" key={k}><dt>{k}</dt><dd>{v}{s && <span class="ti-src l-blk f-m f-3 mt-1">{s}</span>}</dd></div>
        ))}
      </dl>
      {d.refs.length > 0 && <p class="ti-refs l-h l-wrap l-g1 mt-3 mb-3" aria-label="Что открыть в учебнике">{d.refs.map((r) => <span class="chip chip-sm" key={r}>{r}</span>)}</p>}
      {d.notice && <p class="meta"><Icon name="info" /> {d.notice}</p>}
    </div>
  );
}

type Q = { question: string; options: string[] };

/** Rounded-share quiz pass authorizes the explicit task-completion action. */
export function CloseByQuiz({ task, done = false, onPassed }: { task: Task; done?: boolean; onPassed: () => void }) {
  const key = `${schoolDay()}|${task.title}`;
  const state = closeQuizSession.get(key);
  const [, redraw] = useState(0);
  useLayoutEffect(() => closeQuizSession.subscribe(() => redraw(n => n + 1)), [key]);
  const { quiz, local, err, i, res, busy } = state;
  const update = (patch: Partial<typeof state>) => closeQuizSession.update(key, state, patch);
  const start = () => {
    state.clock?.cancel();
    const token = state.token + 1;
    if (!update({started:true,token,err:null,quiz:null,local:null,i:0,ans:[],res:null,busy:false,clock:null})) return;
    api.st.quiz(task.title).then(q => { if (closeQuizSession.current(key,state,token)) update({quiz:q,clock:q.ok?new QuizClock(q.questions.length,{durationMs:questionMs()}):null}); }).catch(e => {
      if (!closeQuizSession.current(key,state,token)) return;
      // Authentication/access failures must not create a successful local attempt.
      if (e instanceof ApiError && [401,403,-2].includes(e.status)) { update({err:e.message}); return; }
      const t=topicFor(task.title);
      if(t){const r=makeRound(t,4);update({clock:new QuizClock(r.length,{durationMs:questionMs()}),local:{qs:r.map(x=>({question:x.q,options:x.options})),right:r.map(x=>x.answer),why:r.map(x=>x.why)}})}
      else update({err:e instanceof ApiError?e.message:"Не удалось начать"});
    });
  };
  useEffect(() => { if (!state.started && !done) start(); }, [key]);
  const qs: Q[] = local?.qs ?? quiz?.questions ?? [];
  const finish = async (all:number[]) => {
    const token=state.token;
    update({busy:true});
    try {
      if(local){const marks=local.right.map((r,k)=>all[k]===r),correct=marks.filter(Boolean).length;
        update({res:{ok:true,title:task.title,correct,total:marks.length,passed:correct>=closeQuizRequired(marks.length),marks,right:local.right,why:local.why}});
      }else{
        const result=await api.st.check(quiz!.quiz_id!,all);
        if(closeQuizSession.current(key,state,token)) update(result.ok?{res:result}:{err:"Опрос устарел — начни заново"});
      }
    }catch(e){if(closeQuizSession.current(key,state,token))update({err:e instanceof ApiError?e.message:"Не удалось проверить"})}
    finally{if(closeQuizSession.current(key,state,token))update({busy:false})}
  };
  const choose = (k:number,index:number) => {
    if(state.busy||state.res||state.i!==index||done||!state.clock)return;
    if(k>=0){if(!state.clock.answer(k,{check:true}))return;state.clock.resolve(false);}
    else if(state.clock.snapshot().current?.outcome!=="timeout")return;
    state.clock.next();
    const all=[...state.ans,k];
    update({ans:all,i:all.length>=qs.length?index:index+1});
    if(all.length>=qs.length)void finish(all);
  };
  if(done)return <div class="cq"><TaskCompletionStatus task={task} done={done}/></div>;
  if (err) return <div class="note bad" role="alert"><Icon name="alert" /><div>{err} <button class="btn btn-ghost btn-sm" onClick={start}>Ещё раз</button></div></div>;
  if (quiz && !quiz.ok) return <div class="note"><Icon name="info" /><div>{quiz.message}</div></div>;
  if (!qs.length) return <div class="stack" aria-busy="true">{[0, 1, 2, 3].map((k) => <div key={k} class="sk" style="height:48px" />)}</div>;
  if (res) {
    return (
      <div class="cq" role="status">
        <p class={`cq-score f-s mb-3 ${res.passed ? "ok" : "bad"}`}><b class="num">{res.correct} из {res.total}</b> {res.passed ? "— проверка пройдена" : "— пока не закрыто"}</p>
        <ol class="cq-review l-v mb-4">
          {qs.map((q, k) => (
            <li key={k} class={res.marks[k] ? "ok" : "bad"}>
              <span>{q.question}</span>
              <span class="cq-a f-b f-2">{res.marks[k] ? "✓" : "✗"} {q.options[res.right[k]]}</span>
              {!res.marks[k] && <span class="cq-why f-b f-3">{res.why[k]}</span>}
            </li>
          ))}
        </ol>
        {res.passed
          ? <button class="btn btn-ok btn-block" onClick={onPassed} data-autofocus><Icon name="check" />Закрыть задание</button>
          : <button class="btn btn-primary btn-block" onClick={start}><Icon name="refresh" />Попробовать ещё раз</button>}
      </div>
    );
  }
  const q = qs[i];
  const conf = local ? "без связи · общие вопросы по предмету" : quiz?.confidence_label ? `${quiz.confidence_label}${quiz.topic ? ` · ${quiz.topic}` : ""}` : null;
  return (
    <div class="cq">
      <p class="eyebrow">Вопрос {i + 1} из {qs.length}{conf ? ` · ${conf}` : ""}</p>
      <div class="cq-bar mt-1 mb-4 o-h r-xs u-line" aria-hidden="true"><i style={{ width: `${(i / qs.length) * 100}%` }} /></div>
      {state.clock && <TimedCloseQuestion clock={state.clock} q={q} index={i} busy={busy} choose={choose} />}
      <p class="hint-text">Верно {closeQuizRequired(qs.length, quiz?.pass_share)} из {qs.length} — проверка пройдена. Затем нажми «Закрыть задание», чтобы отметить выполнение.</p>
    </div>
  );
}

/** Same per-question clock/readout/config as full Blitz; attempt owns deadline across mounts. */
function TimedCloseQuestion({clock,q,index,busy,choose}:{clock:QuizClock;q:Q;index:number;busy:boolean;choose:(pick:number,index:number)=>void}) {
  const {now}=useQuizClock(clock,{cancelOnUnmount:false});
  const snap=clock.snapshot();
  useEffect(()=>{
    if(snap.phase!=="idle"&&snap.phase!=="loading"){clock.expire();return;}
    clock.load();const id=requestAnimationFrame(()=>clock.start());return()=>cancelAnimationFrame(id);
  },[clock,snap.index,snap.phase]);
  const expired=snap.current?.outcome==="timeout";
  return <><QuizTimer clock={clock} now={now} compact/><h3 class="cq-q f-s mb-4" id="cq-q">{q.question}</h3>
    <div class="cq-opts l-v" role="group" aria-labelledby="cq-q">{q.options.map((o,k)=><button key={`${index}-${k}`} type="button" class="btn btn-secondary btn-block cq-opt b-tap" onClick={()=>choose(k,index)} disabled={busy||snap.phase!=="asking"}>{o}</button>)}</div>
    {expired&&<button class="btn btn-secondary btn-block" onClick={()=>choose(-1,index)}>Дальше · пропуск по времени</button>}</>;
}
