/**
 * Recovery 2: what the student sees on a teacher assignment — who gave it, what to do, the due date,
 * the server status and timer minutes, and the shared history. Nothing here is simulated: without a
 * server snapshot the card says so.
 */
import { useEffect, useState } from "preact/hooks";
import { api } from "../lib/api";
import { hwInfo, hwStatusLabel, useHw } from "../lib/hwSync";
import { dueText, fmtDur, shownStatus } from "../lib/hwFormat";
import type { HwEvent } from "../lib/hwTypes";
import type { Task } from "../lib/types";
import { HwTimeline } from "./HwTimeline";
import { Icon } from "./Icon";

/** Timer seconds against the teacher's plan.  It measures time on the timer, not quality or attention. */
function Meter({ sec, planMin, done }: { sec: number; planMin: number; done: boolean }) {
  const plan = Math.max(60, planMin * 60), pct = Math.min(100, Math.round((100 * sec) / plan));
  return <div class={`hw-meter l-v b-tile b-nob${done ? " is-done" : ""}${sec > plan ? " is-over" : ""}`}>
    <div class="hw-meter-row l-h l-base l-btw f-m f-3"><span>По таймеру</span><b class="num">{fmtDur(sec)} из {planMin} мин</b></div>
    <div class="hw-meter-track b-box b-nob o-h" role="progressbar" aria-label="Время по таймеру относительно плана учителя" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-valuetext={`${fmtDur(sec)} из ${planMin} мин`}><i style={{ width: `${pct}%` }} /></div>
  </div>;
}

export function TeacherTaskCard({ task }: { task: Task }) {
  const hw = useHw();
  const info = hwInfo(task.title);
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<HwEvent[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => { setOpen(false); setEvents(null); setErr(""); }, [info?.issue_id]);
  useEffect(() => {
    if (!open || !info) return;
    let live = true;
    api.hw.mineOne(info.issue_id).then((r) => { if (live) { setEvents(r.events); setErr(""); } })
      .catch((e) => { if (live) setErr(e instanceof Error ? e.message : "История не загрузилась"); });
    return () => { live = false; };
  }, [open, info?.issue_id, info?.revision]);
  if (!info) return <div class="note hw-task-missing mb-3"><Icon name="info" /><div><b>Задание от учителя.</b> Статус появится, когда приложение свяжется с сервером.</div></div>;
  const pending = hw.pending(info.issue_id);
  const quiz = info.kind === "quiz" ? info.quiz ?? null : null;
  return <section class={`hw-task l-v b-card mb-4 s-${info.status}${quiz ? " is-quiz" : ""}`} aria-label={quiz ? "Блиц-опрос от учителя" : "Задание от учителя"}>
    <header class="hw-task-head l-h l-wrap">
      <span class="hw-task-mark l-center l-g0 f-a l-fix r-md u-sel" aria-hidden="true"><Icon name="user" /></span>
      <span class="hw-task-who l-v l-g0"><b>{info.teacher_name ?? "Учитель"}</b><small>Класс {info.class} · {info.subject}</small></span>
      <span class={`hw-badge b-pill s-${shownStatus(info.status, pending, hw.next(info.issue_id))}${pending ? " is-pending" : ""}`}>{hwStatusLabel(info, pending, hw.next(info.issue_id))}</span>
    </header>
    {info.instructions && !quiz && <p class="hw-task-text f-b f-2 u-acc-s p-3">{info.instructions}</p>}
    {quiz ? <dl class="hw-facts l-fit">
      <div><dt>Блиц-опрос</dt><dd class="num f-w6">{quiz.count} вопр. · {quiz.time_limit_min ? `${quiz.time_limit_min} мин` : "без лимита"}</dd></div>
      <div><dt>Срок</dt><dd class="f-w6">{dueText(info.due_date)}</dd></div>
      <div><dt>Результат</dt><dd class="num f-w6">{quiz.state === "submitted" ? `${quiz.score ?? 0} из ${quiz.max_score}` : quiz.state === "started" ? "начат" : "не начат"}</dd></div>
    </dl> : <>
      <Meter sec={info.timer_sec} planMin={info.planned_minutes} done={info.status === "completed"} />
      <dl class="hw-facts l-fit">
        <div><dt>Срок</dt><dd class="f-w6">{dueText(info.due_date)}</dd></div>
        <div><dt>Подтверждено</dt><dd class="num f-w6">{fmtDur(info.confirmed_sec)}</dd></div>
      </dl>
    </>}
    {!quiz && info.status === "paused" && info.timer_sec >= 60 && <p class="hint-text">Таймер продолжит с {fmtDur(info.timer_sec)} — отработанное не потеряется.</p>}
    {pending > 0 && hw.error && <p class="hint-text" role="status">{hw.error}</p>}
    <p class="hint-text">{quiz ? "Учитель видит, открыт ли опрос, и результат после отправки." : "Учитель видит статус и минуты таймера этого задания."}</p>
    <button type="button" class="help-link l-h l-inl l-jc f-b f-w6 f-2 b-box b-nob b-tap l-grow hw-task-history px-3 l-fix l-self-s" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="clock" />{open ? "Скрыть историю" : "История задания"}</button>
    {open && (err ? <p class="field-err" role="alert">{err}</p> : !events ? <div class="sk" style="height:48px" /> : <HwTimeline events={events} viewer="student" />)}
  </section>;
}
