/**
 * Карточка режима спасения: не «вы не успеваете», а готовый план выхода.
 * NORMAL — не показываем; TIGHT — «впритык», урезаем гибкое; SURVIVAL — часть на утро; CRITICAL — честно: не помещается.
 * Сон — ограничение: «Сон сохранён». Каждое решение — с короткой причиной.
 */
import { Icon } from "../ui/Icon";
import { dur } from "../lib/time";
import { splitTitle } from "../lib/subjects";
import type { Rescue } from "../lib/survival";

const TITLE = { normal: "", tight: "Впритык", survival: "Режим спасения", critical: "Не помещается даже с переносом" } as const;
const LVL = { normal: 1, tight: 2, survival: 3, critical: 4 } as const;
const s = (t: string) => splitTitle(t).subject;

export function RescueCard({ r, busy, onApply, onMoreMorning, onKeepSleep, onPriorities }: {
  r: Rescue; busy: boolean; onApply: () => void; onMoreMorning: () => void; onKeepSleep: () => void; onPriorities?: () => void;
}) {
  if (r.mode === "normal") return null;
  const crit = r.mode === "critical";
  return (
    <section class={`rescue p-4 mt-2 mb-4 r-md u-warn-s bd-0 m-${r.mode}`} aria-labelledby="rs-h">
      <div class="rs-top l-h l-btw l-g3">
        <h2 id="rs-h" class="eyebrow rs-eyebrow l-h f-s"><Icon name={crit ? "alert" : "flame"} />{TITLE[r.mode]}</h2>
        <span class="rs-meter l-h l-inl l-g1" role="img" aria-label={`Нагрузка: ${LVL[r.mode]} из 4`}>{[1, 2, 3, 4].map((k) => <i key={k} class={k <= LVL[r.mode] ? "on" : ""} />)}</span>
      </div>
      <dl class="rs-stats l-h l-wrap l-g1 mt-3">
        <div><dt>Нужно</dt><dd class="num f-w6">{dur(r.need)}</dd></div>
        <div><dt>До сна</dt><dd class="num f-w6">{dur(r.capacity)}</dd></div>
        <div class="bad"><dt>Дефицит</dt><dd class="num f-w6">−{dur(r.deficit)}</dd></div>
      </dl>
      {r.parts.length > 0 && <p class="rs-parts f-m f-2 mt-1 num">Нужно: {r.parts.map((x) => `${x.label} ${dur(x.minutes)}`).join(" + ")}</p>}
      <ul class="rs-list l-v l-g1 f-s mt-3">
        {r.keep.map((t) => <li key={t} class="rs-keep"><span aria-hidden="true">✓</span> {s(t)}<span class="faint"> · сегодня</span></li>)}
        {r.moves.map((m) => <li key={m.title} class="rs-move"><span aria-hidden="true">→</span> {s(m.title)}<span class="faint"> · утром, {m.minutes} мин</span></li>)}
        {r.trims.map((t) => <li key={t.title} class="rs-trim"><span aria-hidden="true">↓</span> {t.title}<span class="faint"> · {dur(t.to)} вместо {dur(t.from)}</span></li>)}
        {r.overflow.map((m) => <li key={m.title} class="rs-over"><span aria-hidden="true">⇢</span> {s(m.title)}<span class="faint"> · завтра — не помещается</span></li>)}
      </ul>
      <p class="rs-sleep l-h l-g1 f-b f-w6 f-2 mt-3"><Icon name="moon" />Сон сохранён · {r.bedtime}</p>
      {crit && <p class="rs-crit">Даже после переноса не хватает {dur(r.leftover)}. Выбери, что важнее:</p>}
      <details class="rs-why"><summary class="f-2 b-tap l-h">Почему так</summary><ul>{r.reasons.map((x) => <li key={x}>{x}</li>)}</ul></details>
      {crit ? (
        <div class="stack">
          <button class="btn btn-primary btn-block" onClick={onMoreMorning} disabled={busy}><Icon name="sun" />Перенести больше на утро</button>
          <button class="btn btn-secondary btn-block" onClick={onKeepSleep} disabled={busy}><Icon name="moon" />Сохранить сон</button>
          {onPriorities && <button class="btn btn-ghost btn-block" onClick={onPriorities} disabled={busy}><Icon name="calendar" />Пересмотреть приоритеты</button>}
        </div>
      ) : <button class="btn btn-primary btn-block" onClick={onApply} disabled={busy}><Icon name="check" />Применить план</button>}
    </section>
  );
}
