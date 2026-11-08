/** v2.1 · B2: «Что, если…» по предмету → «Начать 15-минутную Фокус-миссию» → сократический тьютор по теме.
 *  Расчёт — lib/gradeTarget.ts (паритет с сервером), только по загруженным оценкам: это не прогноз четвертной. */
import { useId, useMemo, useState } from "preact/hooks";
import { averageOf, fmtAvg, markBase, marksNeeded, withMarks, type MarkLike } from "../lib/gradeTarget";
import { plural } from "../lib/time";
import { Icon } from "./Icon";

export const MISSION_MINUTES = 15;
const MAX_EXTRA = 6;

interface Props {
  subject: string;
  topic: string;
  marks: readonly MarkLike[];
  /** Синтетические оценки демо-режима (честная пометка «демо-оценки»). */
  demo?: boolean;
  onMission: (subject: string, topic: string) => void;
}

export function GradeWhatIf({ subject, topic, marks, demo = false, onMission }: Props) {
  const id = useId();
  const [extra, setExtra] = useState<number[]>([]);
  const base = useMemo(() => markBase(marks), [marks]);
  const now = averageOf(base);
  if (now === null) return null;
  // Цель — как у сервера: 4.00, если средний ниже 4, иначе 4.50. Она не «уезжает», пока ученик пробует варианты.
  const [tn, td] = now < 4 ? [4, 1] : [9, 2];
  const target = tn / td;
  const next = withMarks(base, extra);
  const after = averageOf(next) ?? now;
  const delta = after - now;
  const left = marksNeeded(next, tn, td, 5);
  const add = (v: number) => setExtra((xs) => (xs.length >= MAX_EXTRA ? xs : [...xs, v]));
  return <article class="gw p-4 l-v mt-3 mb-3 panel" aria-labelledby={`${id}-t`}>
    <header class="gw-head l-h l-btw">
      <h3 id={`${id}-t`}>{subject}</h3>
      {demo && <span class="src-badge demo">демо-оценки</span>}
    </header>
    <p class="gw-now">Сейчас средний <b class="num">{fmtAvg(now)}</b> · {base.count} {plural(base.count, "оценка", "оценки", "оценок")}{demo ? " (пример, не из дневника)" : " из дневника"}</p>
    <div class="gw-what l-h l-wrap" role="group" aria-label="Что, если получить">
      <span class="gw-label f-b f-2">Что, если получить:</span>
      {[5, 4, 3].map((v) => <button key={v} type="button" class="gw-chip f-w6 f-num b-pill b-tap" disabled={extra.length >= MAX_EXTRA}
        aria-label={`Добавить оценку ${v}`} onClick={() => add(v)}>+{v}</button>)}
      {extra.length > 0 && <button type="button" class="gw-reset f-2 f-num b-pill b-tap" onClick={() => setExtra([])}>Сбросить</button>}
    </div>
    <p class="gw-result" role="status" aria-live="polite">
      {extra.length
        ? <>С оценками <b class="num">{extra.join(", ")}</b> средний станет <b class="num">{fmtAvg(after)}</b>{" "}
            <span class={delta >= 0 ? "gw-up f-ok" : "gw-down f-bad"}>({delta >= 0 ? "+" : "−"}{fmtAvg(Math.abs(delta))})</span></>
        : "Нажми «+5», «+4» или «+3», чтобы увидеть, как изменится средний."}
    </p>
    <p class="gw-target">{left === 0
      ? <>Цель <b class="num">{fmtAvg(target)}</b> достигнута в этом сценарии.</>
      : <>До <b class="num">{fmtAvg(target)}</b> нужно ещё <b class="num">{left}</b> {plural(left ?? 0, "оценка", "оценки", "оценок")} «5» весом 1.</>}</p>
    <button type="button" class="btn btn-primary btn-block gw-go" onClick={() => onMission(subject, topic)}>
      <Icon name="timer" />Начать {MISSION_MINUTES}-минутную Фокус-миссию
    </button>
    <p class="gw-note f-b f-3">{MISSION_MINUTES} минут на тему «{topic}»: тьютор задаёт наводящие вопросы, готовых ответов не даёт.</p>
  </article>;
}
