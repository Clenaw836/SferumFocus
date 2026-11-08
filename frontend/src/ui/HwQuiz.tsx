/**
 * v2 · Блиц-опрос от учителя — экран ученика.
 * Сервер — источник правды: вопросы приходят без ключей, балл считает сервер, разбор (верные ответы
 * и пояснения) — только после сдачи и только если учитель его разрешил. «Начать» и «Отправить»
 * идемпотентны: повтор после обрыва связи не создаёт вторую попытку. Черновик ответов живёт на
 * устройстве до отправки — перезагрузка или закрытие мини-приложения его не теряют.
 */
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, ApiError } from "../lib/api";
import { createOnce } from "../lib/assignmentSync";
import { schoolDay } from "../lib/day";
import { nsKey } from "../lib/demo";
import { dueText, when } from "../lib/hwFormat";
import { refreshHw } from "../lib/hwSync";
import type { QuizAnswer, StudentQuiz, StudentQuizQuestion } from "../lib/hwTypes";
import { plural } from "../lib/time";
import { Icon } from "./Icon";

const once = createOnce();
const LETTERS = "АБВГДЕ";
export type Draft = Record<string, { choice?: number[]; text?: string }>;
const errText = (e: unknown) => (e instanceof ApiError || e instanceof Error) && e.message ? e.message : "Не получилось связаться с сервером";
const draftKey = (issue: string) => nsKey(`sf.hw-quiz-draft.v1.${issue}`);
function readDraft(issue: string): Draft {
  try { const v = JSON.parse(localStorage.getItem(draftKey(issue)) || "{}"); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; }
}
function writeDraft(issue: string, d: Draft | null) {
  try { if (d) localStorage.setItem(draftKey(issue), JSON.stringify(d)); else localStorage.removeItem(draftKey(issue)); } catch { /* квота: черновик живёт только в памяти */ }
}
export const answered = (q: StudentQuizQuestion, d: Draft) => (q.kind === "short" ? !!d[q.id]?.text?.trim() : !!d[q.id]?.choice?.length);
const points = (n: number) => `${n} ${plural(n, "балл", "балла", "баллов")}`;
const clock = (sec: number) => `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;

/** Seconds left by the server clock (offset measured on every server answer); null — no limit. */
function useLeft(deadline: string | null, serverNow: string | null): number | null {
  const offset = useMemo(() => (serverNow ? Date.parse(serverNow) - Date.now() : 0), [serverNow]);
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    if (!deadline) { setLeft(null); return; }
    const end = Date.parse(deadline);
    const tick = () => setLeft(Math.max(0, Math.round((end - (Date.now() + offset)) / 1000)));
    tick();
    const t = window.setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [deadline, offset]);
  return left;
}

export function Question({ q, n, value, onChange, disabled }: {
  q: StudentQuizQuestion; n: number; value: Draft[string] | undefined; disabled: boolean; onChange: (v: Draft[string]) => void;
}) {
  const id = `hq-${q.id}`;
  const picked = value?.choice ?? [];
  const pick = (i: number) => onChange({ choice: q.kind === "single" ? [i] : picked.includes(i) ? picked.filter((c) => c !== i) : [...picked, i].sort((a, b) => a - b) });
  return <fieldset class="qz-play-q l-v b-card" aria-labelledby={`${id}-l`}>
    <legend id={`${id}-l`}><span class="qz-num l-center l-g0 f-b f-w6 l-fix r-sm u-sel num" aria-hidden="true">{n}</span><span class="qz-play-text f-s"><span class="sr">Вопрос {n}. </span>{q.text}</span>
      <small class="qz-play-pts f-m f-3">{points(q.points)}{q.kind === "multi" ? " · несколько ответов" : ""}</small></legend>
    {q.kind === "short"
      ? <label class="field qz-play-short"><span class="field-label">Ответ</span>
          <input class="input" maxLength={200} autoComplete="off" spellcheck={false} disabled={disabled} value={value?.text ?? ""}
            onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }}   // Enter не отправляет опрос целиком
            onInput={(e) => onChange({ text: (e.currentTarget as HTMLInputElement).value })} /></label>
      : <div class="qz-play-opts l-v">
          {q.options.map((o, i) => <label key={i} class={`qz-play-opt l-h l-g3 b-tile b-tap l-rel${picked.includes(i) ? " is-on" : ""}`}>
            <input type={q.kind === "single" ? "radio" : "checkbox"} name={id} checked={picked.includes(i)} disabled={disabled} onChange={() => pick(i)} />
            <span class="qz-letter l-center l-g0 f-b f-w6 f-2 b-round l-fix" aria-hidden="true">{picked.includes(i) ? "✓" : LETTERS[i]}</span><span class="qz-play-opt-text f-s">{o}</span>
          </label>)}
        </div>}
  </fieldset>;
}

export function Review({ q, n }: { q: StudentQuizQuestion; n: number }) {
  const r = q.result, ok = !!r?.correct, done = !!r?.answered;
  const tone = !done ? "is-skip" : ok ? "is-ok" : "is-bad";
  const word = !done ? "без ответа" : ok ? "верно" : "неверно";
  return <li class={`qz-rev l-v b-card ${tone}`}>
    <div class="qz-rev-head l-a1a f-b"><span class="qz-rev-mark l-center l-g0 f-b f-w6 f-2 b-round u-line" aria-hidden="true">{!done ? "–" : ok ? "✓" : "✗"}</span>
      <b>{n}. {q.text}</b><span class="qz-rev-word f-m f-w6 f-2 f-nw">{word}</span></div>
    {q.kind === "short"
      ? <p class="qz-rev-line f-b f-2">Твой ответ: <b>{r?.text || "—"}</b>{q.answers?.length ? <> · верный: <b>{q.answers.join(" / ")}</b></> : null}</p>
      : <ul class="qz-rev-opts">{q.options.map((o, i) => {
          const mine = !!r?.choice?.includes(i), right = !!q.correct?.includes(i);
          return <li key={i} class={`${mine ? "is-mine" : ""}${right ? " is-right" : ""}`}>
            <span class="qz-letter l-center l-g0 f-b f-w6 f-2 b-round l-fix" aria-hidden="true">{LETTERS[i]}</span><span>{o}</span>
            {(mine || right) && <em>{[mine && "твой выбор", right && "верный ответ"].filter(Boolean).join(" · ")}</em>}
          </li>;
        })}</ul>}
    {q.explain && <p class="hint-text qz-rev-explain">{q.explain}</p>}
  </li>;
}

export function HwQuiz({ issueId, onSubmitted }: { issueId: string; onSubmitted?: (q: StudentQuiz) => void }) {
  const [q, setQ] = useState<StudentQuiz | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<"" | "start" | "submit">("");
  const [draft, setDraft] = useState<Draft>(() => readDraft(issueId));
  const [confirm, setConfirm] = useState(false);
  const autoSent = useRef(false);
  const left = useLeft(q?.state === "started" ? q.deadline_at : null, q?.server_now ?? null);

  const load = () => {
    setErr("");
    api.hw.quiz(issueId).then((r) => { setQ(r); if (r.state === "submitted" || r.state === "closed") writeDraft(issueId, null); })
      .catch((e) => setErr(errText(e)));
  };
  useEffect(() => { setQ(null); setConfirm(false); autoSent.current = false; setDraft(readDraft(issueId)); load(); }, [issueId]);

  const start = async () => {
    setBusy("start"); setErr("");
    try { setQ(await once.run(`start:${issueId}`, (op) => api.hw.quizStart(issueId, op))); refreshHw(); }
    catch (e) { setErr(errText(e)); }
    finally { setBusy(""); }
  };
  const questions = q?.questions ?? [];
  const missing = questions.filter((x) => !answered(x, draft)).length;
  const submit = async (force = false) => {
    if (!q || busy) return;
    if (!force && missing > 0 && !confirm) { setConfirm(true); return; }
    setConfirm(false); setBusy("submit"); setErr("");
    const answers: QuizAnswer[] = questions.map((x) => (x.kind === "short" ? { id: x.id, text: (draft[x.id]?.text ?? "").trim() } : { id: x.id, choice: draft[x.id]?.choice ?? [] }));
    try {
      const r = await once.run(`submit:${issueId}:${JSON.stringify(answers)}`, (op) => api.hw.quizSubmit(issueId, answers, schoolDay(), op));
      writeDraft(issueId, null); setQ(r); refreshHw(); onSubmitted?.(r);
    } catch (e) { setErr(`${errText(e)} Ответы сохранены на устройстве — нажми «Отправить» ещё раз.`); }
    finally { setBusy(""); }
  };
  // Время вышло: отправляем то, что есть (один раз; при ошибке — кнопка «Отправить» остаётся)
  useEffect(() => { if (left === 0 && q?.state === "started" && !autoSent.current) { autoSent.current = true; void submit(true); } }, [left, q?.state]);
  const setAnswer = (id: string, v: Draft[string]) => setDraft((d) => { const next = { ...d, [id]: v }; writeDraft(issueId, next); return next; });

  if (err && !q) return <div class="note bad" role="alert"><Icon name="alert" /><div>{err} <button type="button" class="btn btn-ghost btn-sm" onClick={load}>Повторить</button></div></div>;
  if (!q) return <div class="stack" aria-busy="true">{[0, 1, 2].map((i) => <div key={i} class="sk" style="height:52px" />)}</div>;

  const facts = <dl class="hw-facts l-fit qz-play-facts">
    <div><dt>Вопросов</dt><dd class="num f-w6">{q.count}</dd></div>
    <div><dt>Максимум</dt><dd class="num f-w6">{points(q.max_score)}</dd></div>
    <div><dt>Время</dt><dd class="num f-w6">{q.time_limit_min ? `${q.time_limit_min} мин` : "без лимита"}</dd></div>
    <div><dt>Срок</dt><dd class="f-w6">{dueText(q.due_date)}</dd></div>
  </dl>;

  if (q.state === "closed") return <section class="qz-play l-v l-g3" aria-label="Блиц-опрос">
    {q.manual
      ? <div class="note ok"><Icon name="check" /><div><b>Результат внёс учитель: {q.manual.score} из {q.manual.max_score}.</b>{q.manual.note ? ` ${q.manual.note}` : ""}</div></div>
      : <div class="note"><Icon name="info" /><div><b>Опрос закрыт.</b> Учитель завершил или отозвал его — пройти уже нельзя.</div></div>}
  </section>;

  if (q.state === "not_started") return <section class="qz-play l-v l-g3" aria-label="Блиц-опрос">
    {q.instructions && <p class="hw-task-text f-b f-2 u-acc-s p-3">{q.instructions}</p>}
    {facts}
    <ul class="qz-rules l-v b-card">
      <li class="f-2"><Icon name="check" />Ответы проверяет сервер, балл увидишь сразу после отправки.</li>
      <li class="f-2"><Icon name="timer" />{q.time_limit_min ? `Таймер на ${q.time_limit_min} мин пойдёт после «Начать». Когда время выйдет, ответы отправятся сами.` : "Лимита времени нет — отвечай спокойно."}</li>
      <li class="f-2"><Icon name="lock" />Отправить можно один раз. Учитель видит, что ты открыл опрос, и результат.</li>
    </ul>
    {err && <p class="field-err" role="alert">{err}</p>}
    <button type="button" class={`btn btn-primary btn-block${busy === "start" ? " is-loading" : ""}`} disabled={!!busy} onClick={() => void start()}><Icon name="play" />Начать опрос</button>
  </section>;

  if (q.state === "started") {
    const low = left !== null && left <= 60;
    return <section class="qz-play l-v l-g3" aria-label="Блиц-опрос">
      <div class={`qz-play-bar l-h l-btw b-pill b-tap${low ? " is-low" : ""}`}>
        <span class="qz-play-progress f-b f-w6 f-2 num">Отвечено {questions.length - missing} из {questions.length}</span>
        {left !== null && <span class="qz-play-left l-h l-inl l-g1 f-s b-pill u-sel"><Icon name="timer" /><span role="timer" aria-label={`Осталось ${clock(left)}`} class="num">{clock(left)}</span></span>}
      </div>
      <p class="sr" role="status">{left === 60 ? "Осталась одна минута" : left === 0 ? "Время вышло, отправляем ответы" : ""}</p>
      <form class="qz-play-form l-v l-g3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        {questions.map((x, i) => <Question key={x.id} q={x} n={i + 1} value={draft[x.id]} disabled={busy === "submit"} onChange={(v) => { setConfirm(false); setAnswer(x.id, v); }} />)}
        {confirm && <div class="note warn qz-confirm" role="alert"><Icon name="alert" /><div>
          <b>Без ответа: {missing} {plural(missing, "вопрос", "вопроса", "вопросов")}.</b> Отправить как есть? Изменить ответы после отправки нельзя.
          <div class="qz-confirm-actions l-h l-wrap mt-2"><button type="submit" class="btn btn-primary btn-sm">Отправить как есть</button><button type="button" class="btn btn-ghost btn-sm" onClick={() => setConfirm(false)}>Вернуться к вопросам</button></div>
        </div></div>}
        {err && <p class="field-err" role="alert">{err}</p>}
        {!confirm && <button type="submit" class={`btn btn-primary btn-block${busy === "submit" ? " is-loading" : ""}`} disabled={!!busy}><Icon name="check" />Отправить ответы</button>}
      </form>
    </section>;
  }

  // submitted
  const pct = q.max_score ? Math.round((100 * (q.score ?? 0)) / q.max_score) : 0;
  const reveal = questions.some((x) => x.correct !== undefined || x.answers !== undefined);
  return <section class="qz-play l-v l-g3" aria-label="Результат блиц-опроса">
    <div class="qz-result l-v l-g1 l-ac f-tc" role="status">
      <span class="qz-result-score f-h f-2 num"><b class="f-a">{q.score ?? 0}</b> из {q.max_score}</span>
      <span class="qz-result-meta f-b f-2">{pct}% · отправлено {when(q.submitted_at)}</span>
      {(q.late || q.overtime) && <span class="qz-result-flags f-m f-warn">{[q.late && "после срока", q.overtime && "после окончания времени"].filter(Boolean).join(" · ")} — учитель это видит</span>}
    </div>
    {questions.length > 0 && <ol class="qz-rev-list l-v" aria-label="Разбор ответов">{questions.map((x, i) => <Review key={x.id} q={x} n={i + 1} />)}</ol>}
    {!reveal && <p class="hint-text">Учитель решил показать верные ответы позже — разберёте вместе на уроке.</p>}
  </section>;
}
