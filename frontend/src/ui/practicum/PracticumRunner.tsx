/** v3.0 · прохождение практикума: 8 этапов (введение → разминка → исследование → проверка действием →
 *  подсказки → разбор ошибки → испытание → итог). Каждое «верно/неверно» решает сервер; клиент только рисует. */
import { useEffect, useRef, useState } from "preact/hooks";
import { ApiError, practicumApi } from "../../lib/api";
import type { ActionBody, ActionResult, Feedback, LabState, Session, StageKind, TutorHelp } from "../../lib/practicumTypes";
import { LoadingRows } from "../LoadingRows";
import { Lab } from "./Lab";
import { SkillMasteryMap } from "./SkillMasteryMap";

const KIND_RU: Record<StageKind, string> = {
  intro: "Введение", warmup: "Разминка", exploration: "Исследование", action_check: "Проверка действием",
  progressive_hints: "Подсказки по шагам", error_explanation: "Разбор ошибки", final_challenge: "Финальное испытание", summary_and_next: "Итог",
};
const LAB_KINDS = new Set<StageKind>(["exploration", "action_check", "progressive_hints", "final_challenge"]);
export const practicumError = (e: unknown): string => {
  if (e instanceof ApiError && e.offline) return "Практикумы проверяет сервер, а связи сейчас нет. Прогресс не потерян — попробуй, когда появится интернет.";
  if (e instanceof ApiError && e.status === 409) return e.message || "Этот шаг пока недоступен.";
  return e instanceof Error && e.message ? e.message : "Не удалось связаться с сервером практикумов.";
};

export function PracticumRunner({ id, onExit, onOpen }: { id: string; onExit: () => void; onOpen?: (id: string) => void }) {
  const [s, setS] = useState<Session | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lab, setLab] = useState<LabState>({});
  const [ro, setRo] = useState<Record<string, unknown>>({});
  const [ans, setAns] = useState<Record<string, string>>({});
  const [fb, setFb] = useState<{ ok: boolean; items: Feedback[] } | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [verdict, setVerdict] = useState<{ ok: boolean; explain?: string } | null>(null);
  const [hints, setHints] = useState<string[]>([]);
  const [tutor, setTutor] = useState<{ open: boolean; q: string; busy: boolean; reply: TutorHelp | null; err: string | null }>({ open: false, q: "", busy: false, reply: null, err: null });
  const saveSeq = useRef(0), saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const headRef = useRef<HTMLHeadingElement>(null);
  const stage = s?.stage;
  const stageKey = s ? `${s.session_id}:${s.stage.index}:${s.attempt_no}` : "";

  const load = () => { setErr(null); practicumApi.session(id).then(setS).catch((e) => setErr(practicumError(e))); };
  useEffect(load, [id]);
  useEffect(() => {
    if (!stage) return;
    setLab(stage.state ?? stage.lab?.initial ?? {}); setRo(stage.readouts ?? {});
    setAns(Object.fromEntries((stage.answers ?? []).map((a) => [a.field, a.value === undefined || a.value === null ? "" : String(a.value)])));
    setFb(null); setPicked(null); setVerdict(null); setHints(stage.hints?.shown ?? []);
    setTutor((t) => ({ ...t, open: false, reply: null, err: null }));
    requestAnimationFrame(() => headRef.current?.focus());
  }, [stageKey]);
  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);
  // Итог — последний этап: сервер засчитывает практикум только после «advance» на нём. Кнопки итога
  // («Следующий практикум», «К практикумам») уходят с экрана, поэтому завершение отправляется само, один раз.
  const finished = useRef("");
  useEffect(() => {
    if (!s || s.stage.kind !== "summary_and_next" || s.status === "completed" || finished.current === stageKey) return;
    finished.current = stageKey;
    practicumApi.action(id, { type: "advance", stage_index: s.stage.index }).then((r) => setS(r.session))
      .catch(() => { finished.current = ""; });
  }, [stageKey, s?.status]);

  const changeLab = (next: LabState) => {
    setLab(next); setFb(null);
    if (!stage) return;
    const seq = ++saveSeq.current, idx = stage.index;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      practicumApi.save(id, idx, next, ans).then((r) => { if (seq === saveSeq.current) setRo(r.readouts ?? {}); }).catch(() => undefined);
    }, 250);
  };
  const act = async (body: ActionBody): Promise<ActionResult | null> => {
    if (busy) return null;
    setBusy(true); setErr(null);
    try { const r = await practicumApi.action(id, { stage_index: stage?.index, ...body }); setS(r.session); return r; }
    catch (e) { setErr(practicumError(e)); return null; }
    finally { setBusy(false); }
  };
  const check = async () => {
    const r = await act({ type: "check", lab_state: lab, answers: ans });
    if (!r) return;
    if (r.result.readouts) setRo(r.result.readouts);
    setFb({ ok: r.result.ok, items: r.result.feedback ?? [] });
  };
  const hint = async () => { const r = await act({ type: "hint" }); if (r?.result.hint) setHints((h) => [...h, r.result.hint as string]); };
  const answer = async () => {
    if (picked === null) return;
    const r = await act({ type: "answer", selected_answer: picked });
    if (r) setVerdict({ ok: r.result.ok, explain: r.result.explain });
  };
  const askTutor = async () => {
    const q = tutor.q.trim(); if (!q) return;
    setTutor((t) => ({ ...t, busy: true, err: null }));
    try { const reply = await practicumApi.tutor(id, q, lab, ans); setTutor((t) => ({ ...t, busy: false, reply })); }
    catch (e) { setTutor((t) => ({ ...t, busy: false, err: practicumError(e) })); }
  };

  if (!s || !stage) return <div class="pr-run l-v l-g4">
    {err ? <div class="pr-error l-v l-g3 b-card" role="alert"><p>{err}</p><div class="pr-actions l-h l-wrap b-box b-nob"><button type="button" class="btn btn-primary" onClick={load}>Повторить</button><button type="button" class="btn btn-ghost" onClick={onExit}>Назад</button></div></div>
      : <LoadingRows label="Загружаем практикум" rows={4} />}
  </div>;

  const p = s.practicum, isLab = LAB_KINDS.has(stage.kind) && !!stage.lab;
  /** Этап закрыт: решён, пропущен или ответ раскрыт сервером после попыток — дальше можно идти. */
  const done = stage.passed || stage.can_advance;
  const revealed = stage.question?.correct;
  const nextId = typeof stage.next_step === "object" && stage.next_step ? stage.next_step.practicum_id : s.next?.practicum_id;
  return <div class="pr-run l-v l-g4" data-stage={stage.kind}>
    <header class="pr-head l-v l-g1">
      <p class="pr-eyebrow f-m f-w6 f-3">{p.subject.title} · {p.subject.grade} класс · {p.topic.title}</p>
      <h2 class="pr-title f-h">{p.title}</h2>
      <ol class="pr-steps mt-1" aria-label={`Шаг ${stage.step} из ${stage.steps_total}`}>
        {s.steps.map((st) => <li key={st.n} class={st.n < stage.step ? "is-done" : st.n === stage.step ? "is-current" : ""} aria-current={st.n === stage.step ? "step" : undefined}>
          <span class="pr-step-bar l-blk b-box b-nob" aria-hidden="true" /><span class="pr-step-name f-c f-w6 f-3 f-trunc">{st.title}</span></li>)}
      </ol>
    </header>

    <section class="pr-stage l-v l-g3" aria-labelledby="pr-stage-h">
      <p class="pr-kind f-c f-w6 f-a">{KIND_RU[stage.kind]}{stage.skill ? ` · ${stage.skill.title}` : ""}</p>
      <h3 id="pr-stage-h" ref={headRef} tabIndex={-1}>{stage.title}</h3>

      {stage.kind === "intro" && <div class="pr-intro l-v l-g3">
        {/* v3.2 · ясность: зачем практикум, что именно делать и чем помогает приложение — до первого шага */}
        <div class="pr-fact b-card" role="note">
          {p.learning_goal && <><h4 class="f-2 f-3">Цель</h4><p class="f-2">{p.learning_goal}</p></>}
          <h4 class="f-2 f-3">Что делаешь</h4><p class="f-2">{s.steps.length} {s.steps.length === 1 ? "шаг" : s.steps.length < 5 ? "шага" : "шагов"}: {s.steps.map((x) => x.title).join(" → ")}{p.duration_minutes ? ` · ~${p.duration_minutes} мин` : ""}.</p>
          <h4 class="f-2 f-3">Как помогаем</h4><p class="f-2">«Подсказка» даёт наводящий шаг, а не ответ. «Спросить тьютора» разбирает именно твой ход на этом этапе. Ответы проверяет сервер — их нет в приложении заранее.</p>
        </div>
        {stage.body && <p>{stage.body}</p>}
        {stage.real_life && <div class="pr-fact b-card"><h4 class="f-2 f-3">Где пригодится</h4><p class="f-2">{stage.real_life}</p></div>}
        {stage.exam && <div class="pr-fact b-card"><h4 class="f-2 f-3">На экзамене</h4><p class="f-2">{stage.exam}</p></div>}
      </div>}

      {stage.question && <div class="pr-quiz l-v l-g3">
        {stage.case && <blockquote class="pr-case p-34 f-b u-warn r-md">{stage.case}</blockquote>}
        {stage.kind !== "intro" && stage.body && !stage.case && <p class="pr-lead f-b">{stage.body}</p>}
        <p class="pr-q f-s" id="pr-q">{stage.question.text}</p>
        <div class="pr-options l-v" role="radiogroup" aria-labelledby="pr-q">
          {stage.question.options.map((o, i) => <button key={i} type="button" role="radio" aria-checked={picked === i}
            class={`pr-option l-h f-b b-card b-tap l-w100${revealed === i ? " is-ok" : verdict && picked === i ? (verdict.ok ? " is-ok" : " is-wrong") : ""}`} disabled={busy || done}
            onClick={() => { setPicked(i); setVerdict(null); }}>{o}{revealed === i && <span class="sr"> — верный ответ</span>}</button>)}
        </div>
        {verdict && <div class={`pr-verdict p-34 f-b ${verdict.ok ? "is-ok" : "is-wrong"}`} role="status"><strong>{verdict.ok ? "Верно." : done ? "Разберём." : "Пока нет."}</strong>{verdict.explain ? ` ${verdict.explain}` : " Подумай ещё и выбери другой вариант."}</div>}
        {!verdict && done && stage.question.explain && <div class="pr-verdict p-34 f-b is-ok" role="status">{stage.question.explain}</div>}
      </div>}

      {isLab && stage.lab && <div class="pr-labwrap l-v l-g3">
        {stage.task && <p class="pr-task f-b b-card b-nob">{stage.task}</p>}
        {stage.observe && <p class="pr-lead f-b">{stage.observe}</p>}
        <Lab cfg={stage.lab} state={lab} readouts={ro} onChange={done ? undefined : changeLab} idp={`pr${stage.index}`} />
        {(stage.answers ?? []).length > 0 && <div class="pr-answers l-fit">
          {(stage.answers ?? []).map((a) => <label key={a.field} class="pr-answer l-v l-g1 f-m f-w6 f-2 l-w100"><span>{a.label}</span>
            <input class="input" type="text" inputMode="decimal" autoComplete="off" value={ans[a.field] ?? ""} disabled={done}
              onInput={(e) => { setAns({ ...ans, [a.field]: (e.currentTarget as HTMLInputElement).value }); setFb(null); }} /></label>)}
        </div>}
        {fb && <div class={`pr-feedback p-34 f-b ${fb.ok ? "is-ok" : "is-wrong"}`} role="status">
          <strong>{fb.ok ? "Получилось." : "Есть расхождение."}</strong>
          {fb.items.length > 0 && <ul>{fb.items.map((f, i) => <li key={i}><b>{f.principle_title}.</b> {f.message}</li>)}</ul>}
        </div>}
        {hints.length > 0 && <ol class="pr-hints l-v l-g1 f-b f-2 b-card" aria-label="Подсказки">{hints.map((h, i) => <li key={i}>{h}</li>)}</ol>}
        {!done && <div class="pr-tutor l-v l-as">
          <button type="button" class="btn btn-ghost btn-sm" aria-expanded={tutor.open} onClick={() => setTutor((t) => ({ ...t, open: !t.open }))}>Спросить тьютора</button>
          {tutor.open && <div class="pr-tutor-box l-v l-as l-w100">
            <label class="pr-answer l-v l-g1 f-m f-w6 f-2 l-w100"><span>Что непонятно в этом шаге?</span>
              <textarea class="textarea" rows={2} maxLength={500} value={tutor.q} onInput={(e) => setTutor({ ...tutor, q: (e.currentTarget as HTMLTextAreaElement).value })} /></label>
            <button type="button" class="btn btn-secondary btn-sm" disabled={tutor.busy || !tutor.q.trim()} onClick={askTutor}>{tutor.busy ? "Тьютор думает…" : "Отправить"}</button>
            {tutor.err && <p class="pr-error-line f-b f-bad" role="alert">{tutor.err}</p>}
            {tutor.reply && <div class="pr-tutor-reply b-card l-w100" role="status"><p>{tutor.reply.reply}</p>{tutor.reply.notice && <small>{tutor.reply.notice}</small>}</div>}
          </div>}
        </div>}
      </div>}

      {stage.kind === "summary_and_next" && <div class="pr-summary l-v">
        {(stage.learned ?? []).length > 0 && <><h4 class="f-2">Что ты освоил</h4><ul class="pr-learned f-b">{(stage.learned ?? []).map((l, i) => <li key={i}>{l}</li>)}</ul></>}
        {(s.mastery_change ?? []).length > 0 && <><h4 class="f-2">Как изменилось освоение</h4><ul class="pr-mastery l-v l-g1">{(s.mastery_change ?? []).map((m) =>
          <li class="f-2" key={m.skill_key}><span>{m.title}</span><span class="sf-tabular">{m.before === null ? "—" : `${m.before}%`} → {m.after === null ? "—" : `${m.after}%`}</span></li>)}</ul></>}
        {s.skill_map && <SkillMasteryMap map={s.skill_map} compact />}
        {(s.next?.text || (typeof stage.next_step === "object" && stage.next_step?.text) || typeof stage.next_step === "string") &&
          <p class="pr-next f-b f-2">{typeof stage.next_step === "string" ? stage.next_step : stage.next_step?.text || s.next?.text}</p>}
      </div>}
      {err && <p class="pr-error-line f-b f-bad" role="alert">{err}</p>}
    </section>

    <div class="pr-actions l-h l-wrap b-box b-nob">
      {stage.kind === "intro" && <button type="button" class="btn btn-primary" disabled={busy} onClick={() => act({ type: "advance" })}>Начать</button>}
      {stage.question && !done && <button type="button" class="btn btn-primary" disabled={busy || picked === null} onClick={answer}>Ответить</button>}
      {isLab && !done && <>
        <button type="button" class="btn btn-primary" disabled={busy} onClick={check}>Проверить</button>
        {stage.hints?.allowed && hints.length < (stage.hints?.total ?? 0) && <button type="button" class="btn btn-secondary" disabled={busy} onClick={hint}>Подсказка {hints.length + 1} из {stage.hints.total}</button>}
        {stage.can_skip && <button type="button" class="btn btn-ghost" disabled={busy} onClick={() => act({ type: "skip" })}>Пропустить шаг</button>}
      </>}
      {stage.kind !== "intro" && stage.kind !== "summary_and_next" && done && <button type="button" class="btn btn-primary" disabled={busy} onClick={() => act({ type: "advance" })}>Дальше</button>}
      {stage.kind === "summary_and_next" && <>
        {nextId && onOpen && <button type="button" class="btn btn-primary" onClick={() => onOpen(nextId)}>Следующий практикум</button>}
        <button type="button" class="btn btn-secondary" disabled={busy} onClick={() => act({ type: "restart" })}>Пройти ещё раз</button>
        <button type="button" class="btn btn-ghost" onClick={onExit}>К практикумам</button>
      </>}
    </div>
  </div>;
}
