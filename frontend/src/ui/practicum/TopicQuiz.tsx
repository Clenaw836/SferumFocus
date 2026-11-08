/** v3.0 · квиз-опрос по теме: 6 типов вопросов, проверка на сервере, итог → пробелы по навыкам → практикум. */
import { useEffect, useState } from "preact/hooks";
import { practicumApi } from "../../lib/api";
import type { QuizQuestion, QuizResult, QuizStart } from "../../lib/practicumTypes";
import { LoadingRows } from "../LoadingRows";
import { Lab } from "./Lab";
import { practicumError } from "./PracticumRunner";
import { SkillMasteryMap } from "./SkillMasteryMap";

type Ans = number | number[] | string | (number | null)[];
const KIND_RU: Record<QuizQuestion["kind"], string> = {
  single_choice: "Один ответ", multi_choice: "Несколько ответов", short_answer: "Короткий ответ",
  matching: "Сопоставление", ordering: "Порядок", diagram_question: "Вопрос по схеме",
};
const answered = (q: QuizQuestion, a: Ans | undefined) => {
  if (a === undefined) return false;
  if (q.kind === "short_answer") return String(a).trim() !== "";
  if (q.kind === "multi_choice") return Array.isArray(a) && a.length > 0;
  if (q.kind === "matching") return Array.isArray(a) && a.every((x) => x !== null && x !== undefined);
  return true;
};

function Question({ q, a, set }: { q: QuizQuestion; a: Ans | undefined; set: (v: Ans) => void }) {
  const qid = `tq-${q.id}`;
  if (q.kind === "single_choice" || q.kind === "diagram_question") return <div class="pr-options l-v" role="radiogroup" aria-labelledby={qid}>
    {q.kind === "diagram_question" && q.diagram && <Lab cfg={{ model: q.diagram.model, initial: q.diagram.state }} state={q.diagram.state} readouts={{}} readonly idp={`${qid}-d`} />}
    {(q.options ?? []).map((o, i) => <button key={i} type="button" role="radio" aria-checked={a === i} class="pr-option l-h f-b b-card b-tap l-w100" onClick={() => set(i)}>{o}</button>)}
  </div>;
  if (q.kind === "multi_choice") {
    const cur = Array.isArray(a) ? (a as number[]) : [];
    return <div class="pr-options l-v" role="group" aria-labelledby={qid}>
      {(q.options ?? []).map((o, i) => <button key={i} type="button" role="checkbox" aria-checked={cur.includes(i)} class="pr-option l-h f-b b-card b-tap l-w100 pr-option--multi"
        onClick={() => set(cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i].sort())}>{o}</button>)}
    </div>;
  }
  if (q.kind === "short_answer") return <label class="pr-answer l-v l-g1 f-m f-w6 f-2 l-w100"><span>Ответ</span>
    <input class="input" type="text" autoComplete="off" value={typeof a === "string" ? a : ""} onInput={(e) => set((e.currentTarget as HTMLInputElement).value)} aria-describedby={qid} /></label>;
  if (q.kind === "matching") {
    const cur = Array.isArray(a) ? (a as (number | null)[]) : (q.left ?? []).map(() => null);
    return <div class="pr-match l-v l-g3">{(q.left ?? []).map((l, i) => <label key={i} class="pr-answer l-v l-g1 f-m f-w6 f-2 l-w100"><span>{l}</span>
      <select class="input" value={cur[i] === null || cur[i] === undefined ? "" : String(cur[i])}
        onChange={(e) => { const v = (e.currentTarget as HTMLSelectElement).value; const next = [...cur]; next[i] = v === "" ? null : Number(v); set(next); }}>
        <option value="">Выбери пару</option>
        {(q.right ?? []).map((r, j) => <option key={j} value={String(j)}>{r}</option>)}
      </select></label>)}</div>;
  }
  const order = Array.isArray(a) ? (a as number[]) : (q.items ?? []).map((_, i) => i);
  const move = (i: number, d: number) => { const j = i + d; if (j < 0 || j >= order.length) return; const n = [...order]; [n[i], n[j]] = [n[j], n[i]]; set(n); };
  return <ol class="pl-order l-v l-g1" aria-labelledby={qid}>{order.map((ix, i) => <li key={ix} class="pl-order-card l-a1a l-mid b-tile">
    <span class="pl-order-n f-b f-w6 f-a f-tc sf-tabular" aria-hidden="true">{i + 1}</span><span class="pl-order-text f-b">{q.items?.[ix]}</span>
    <span class="pl-order-move l-h l-inl l-g1">
      <button type="button" class="pl-step-btn l-h l-inl l-jc l-g0 f-s b-tile l-fix s-40 mw-44" aria-label={`Поднять: ${q.items?.[ix]}`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
      <button type="button" class="pl-step-btn l-h l-inl l-jc l-g0 f-s b-tile l-fix s-40 mw-44" aria-label={`Опустить: ${q.items?.[ix]}`} disabled={i === order.length - 1} onClick={() => move(i, 1)}>↓</button>
    </span></li>)}</ol>;
}

export function TopicQuiz({ topicId, onExit, onPracticum }: { topicId: string; onExit: () => void; onPracticum?: (id: string) => void }) {
  const [quiz, setQuiz] = useState<QuizStart | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [i, setI] = useState(0);
  const [answers, setAnswers] = useState<Record<string, Ans>>({});
  const [res, setRes] = useState<QuizResult | null>(null);
  const [busy, setBusy] = useState(false);
  const start = () => { setErr(null); setRes(null); setAnswers({}); setI(0); setQuiz(null); practicumApi.quiz(topicId).then(setQuiz).catch((e) => setErr(practicumError(e))); };
  useEffect(start, [topicId]);
  const submit = async () => {
    if (!quiz) return;
    setBusy(true); setErr(null);
    try {
      const body = Object.fromEntries(quiz.questions.map((q) => {
        const a = answers[q.id];
        return [q.id, q.kind === "ordering" && a === undefined ? (q.items ?? []).map((_, k) => k) : a ?? null];
      }));
      setRes(await practicumApi.submitQuiz(quiz.attempt_id, body));
    } catch (e) { setErr(practicumError(e)); } finally { setBusy(false); }
  };
  if (!quiz) return <div class="pr-run l-v l-g4">{err ? <div class="pr-error l-v l-g3 b-card" role="alert"><p>{err}</p><div class="pr-actions l-h l-wrap b-box b-nob">
    <button type="button" class="btn btn-primary" onClick={start}>Повторить</button><button type="button" class="btn btn-ghost" onClick={onExit}>Назад</button></div></div>
    : <LoadingRows label="Собираем квиз-опрос" rows={3} />}</div>;

  if (res) return <div class="pr-run l-v l-g4" data-stage="quiz-result">
    <header class="pr-head l-v l-g1"><p class="pr-eyebrow f-m f-w6 f-3">{quiz.badge} · {quiz.topic.title}</p><h2 class="pr-title f-h">Результат: {res.score_label}</h2></header>
    <section class="pr-stage l-v l-g3" aria-label="Разбор ответов">
      <ol class="tq-review l-v">{quiz.questions.map((q, k) => { const r = res.questions.find((x) => x.id === q.id); return <li key={q.id} class={r?.correct ? "is-ok" : "is-wrong"}>
        <p class="tq-review-q l-h f-b f-w6"><span class="tq-mark f-w6 l-fix" aria-hidden="true">{r?.correct ? "✓" : "✗"}</span><span class="sr">{r?.correct ? "Верно" : "Неверно"}: </span>{k + 1}. {q.text}</p>
        {!r?.correct && r?.answer && <p class="tq-review-a f-b f-2 mt-1">Правильно: {r.answer}</p>}
        {r?.explain && <p class="tq-review-e f-b f-2 mt-1">{r.explain}</p>}</li>; })}</ol>
      {res.gaps.length > 0 && <div class="tq-gaps p-34 u-warn r-md"><h4 class="f-2">Что стоит закрепить</h4><ul>{res.gaps.map((g) => <li key={g.skill_key}>{g.title} · ошибок {g.wrong} из {g.total}</li>)}</ul></div>}
      <SkillMasteryMap map={res.skill_map} compact />
      {res.message && <p class="pr-next f-b f-2">{res.message}</p>}
    </section>
    <div class="pr-actions l-h l-wrap b-box b-nob">
      {res.cta && onPracticum && <button type="button" class="btn btn-primary" onClick={() => onPracticum(res.cta!.practicum_id)}>{res.cta.label}</button>}
      <button type="button" class="btn btn-secondary" onClick={start}>Ещё раз</button>
      <button type="button" class="btn btn-ghost" onClick={onExit}>Готово</button>
    </div>
  </div>;

  const q = quiz.questions[i];
  const last = i === quiz.questions.length - 1;
  return <div class="pr-run l-v l-g4" data-stage="quiz">
    <header class="pr-head l-v l-g1"><p class="pr-eyebrow f-m f-w6 f-3">{quiz.badge} · {quiz.topic.title}</p><h2 class="pr-title f-h">{quiz.title}</h2>
      <ol class="pr-steps mt-1" aria-label={`Вопрос ${i + 1} из ${quiz.total}`}>{quiz.questions.map((x, k) =>
        <li key={x.id} class={answered(x, answers[x.id]) ? "is-done" : k === i ? "is-current" : ""} aria-current={k === i ? "step" : undefined}><span class="pr-step-bar l-blk b-box b-nob" aria-hidden="true" /></li>)}</ol>
    </header>
    <section class="pr-stage l-v l-g3" aria-labelledby={`tq-${q.id}`}>
      <p class="pr-kind f-c f-w6 f-a">Вопрос {i + 1} из {quiz.total} · {KIND_RU[q.kind]}</p>
      <h3 id={`tq-${q.id}`} class="pr-q f-s">{q.text}</h3>
      <Question q={q} a={answers[q.id]} set={(v) => setAnswers({ ...answers, [q.id]: v })} />
      {err && <p class="pr-error-line f-b f-bad" role="alert">{err}</p>}
    </section>
    <div class="pr-actions l-h l-wrap b-box b-nob">
      {last ? <button type="button" class="btn btn-primary" disabled={busy} onClick={submit}>{busy ? "Проверяем…" : "Проверить ответы"}</button>
        : <button type="button" class="btn btn-primary" onClick={() => setI(i + 1)}>Дальше</button>}
      {i > 0 && <button type="button" class="btn btn-secondary" onClick={() => setI(i - 1)}>Назад</button>}
      <button type="button" class="btn btn-ghost" onClick={onExit}>Выйти</button>
    </div>
  </div>;
}
