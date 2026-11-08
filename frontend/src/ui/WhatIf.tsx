import { useState } from "preact/hooks";
import { Icon } from "./Icon";
import { changeAllowed, simulate, type Change, type Option, type WhatIf as W, type WhatIfIn } from "../lib/whatif";
import { dur } from "../lib/time";

const CHANGES: { c: Change; label: string }[] = [
  { c: { kind: "late", minutes: 20 }, label: "Задерживаюсь на 20 мин" },
  { c: { kind: "late", minutes: 45 }, label: "На 45 мин" },
  { c: { kind: "bed", minutes: -30 }, label: "Лягу на 30 мин раньше" },
];
const VERDICT = { fits: "Успеваешь", tight: "Впритык", over: "Не успеваешь" } as const;

/** Полоса «нужно / есть»: ширина — доля от большего из двух; цифры — рядом, точность до 5 мин. */
function Bar({ need, cap, tag }: { need: number; cap: number; tag: string }) {
  const max = Math.max(need, cap, 1);
  return (
    <div class="wi-bar f-m f-3" aria-hidden="true">
      <span class="wi-bar-k">{tag}</span>
      <span class="wi-track b-box b-nob l-rel o-h"><i class="wi-cap" style={{ width: `${(cap / max) * 100}%` }} /><i class={`wi-need u-acc-bg${need > cap ? " is-over" : ""}`} style={{ width: `${(need / max) * 100}%` }} /></span>
    </div>
  );
}

/**
 * «Успею ли?»: что будет, если… — БЕЗ применения. Видно: нужно/доступно до и после, что сдвинулось,
 * что под риском и почему; варианты выхода. Применяется только кнопкой «Применить».
 */
export function WhatIf({ base, onApply, onCustom, onAdd }: { base: WhatIfIn | null; onApply: (w: W, o: Option | null) => void; onCustom?: () => void; onAdd?: () => void }) {
  const [w, setW] = useState<W | null>(null);
  const [opt, setOpt] = useState<Option["id"] | null>(null);
  if (!base || !base.tasks.length) return (
    <section class="wi b-card mt-4 mb-4 wi-empty" aria-labelledby="wi-h">
      <div class="wi-head l-v l-g1">
        <h2 id="wi-h" class="wi-h l-h f-s">Успею ли?</h2>
        <p class="wi-parts f-b f-2">Добавь задание — скажу, во сколько освободишься.</p>
        {onAdd && <div class="wi-changes l-h l-wrap mt-3"><button type="button" class="chip" onClick={onAdd}>Добавить задание</button></div>}
      </div>
    </section>
  );
  const now = simulate(base, { kind: "late", minutes: 0 }).before;
  const study = base.tasks.reduce((s, t) => s + t.planned_minutes, 0);
  const pick = (c: Change) => { const r = simulate(base, c); setW(r); setOpt(r.options[0]?.id ?? null); };
  const chosen = w?.options.find((o) => o.id === opt) ?? null;
  // Hero-число прогноза: конец последней рабочей вставки «станет» (как Tonight.finish). При перегрузе — молчим, там дефицит.
  const wWorks = w ? w.after.plan.plan.filter((e) => e.kind === "work") : [];
  const freeAt = w && w.verdict !== "over" && wWorks.length ? wWorks[wWorks.length - 1].end : null;
  return (
    <section class={`wi b-card mt-4 mb-4${w ? " is-open" : ""}`} aria-labelledby="wi-h">
      <div class="wi-head l-v l-g1">
        <h2 id="wi-h" class="wi-h l-h f-s">Успею ли?</h2>
        {now.deficit > 0
          ? <p class="wi-parts f-b f-2">Уже сейчас не хватает <b class="wi-risk f-w6 f-bad num">{dur(now.deficit)}</b> — разбор в плане ниже. Проверь, что изменится, если…</p>
          : <>
            <dl class="wi-stats l-c3 mt-1 mb-1">
              <div><dt>Задания</dt><dd class="num f-w6">{dur(study)}</dd></div>
              <div><dt>До сна</dt><dd class="num f-w6">{dur(now.capacity)}</dd></div>
              <div class={`is-${now.free < 15 ? "tight" : "fits"}`}><dt>Запас</dt><dd class="num f-w6">{dur(now.free)}</dd></div>
            </dl>
            <p class="wi-parts f-b f-2">{now.start}–{now.bedtime} · нужно {dur(now.need)}: {now.parts.map((x) => `${x.label} ${dur(x.minutes)}`).join(" · ")}</p>
          </>}
        <p class="wi-note f-m f-3">Время — оценка по нормативам и твоим правкам, не обещание.</p>
      </div>
      <div class="wi-changes l-h l-wrap mt-3" role="group" aria-label="Что если">
        {CHANGES.filter(({ c }) => changeAllowed(base, c)).map(({ c, label }) => (   /* v18.1: заведомо недопустимые изменения не предлагаем */
          <button key={label} type="button" class="chip" aria-pressed={w?.label === simulate(base, c).label ? "true" : "false"} onClick={() => pick(c)}>{label}</button>
        ))}
        {onCustom && <button type="button" class="chip" onClick={onCustom}>Другое время…</button>}
      </div>
      {w && (
        <div class="wi-res l-v l-g3 mt-4" role="status" aria-live="polite">
          <p class={`wi-verdict f-s is-${w.verdict}`}><b>{VERDICT[w.verdict]}</b> · {w.label.toLowerCase()}</p>
          {freeAt && <p class={`wi-free f-h mt-1 is-${w.verdict}`}>Свободен в <b class="num">{freeAt}</b></p>}
          <div class="wi-bars l-v l-g1">
            <Bar need={w.before.need} cap={w.before.capacity} tag="сейчас" />
            <Bar need={w.after.need} cap={w.after.capacity} tag="станет" />
            <p class="wi-legend l-h l-wrap l-g1 f-m f-2"><span><i class="wi-sw-need u-acc-bg" />нужно {dur(w.before.need)} → {dur(w.after.need)}</span><span><i class="wi-sw-cap" />есть {dur(w.before.capacity)} → {dur(w.after.capacity)}</span></p>
          </div>
          <ul class="wi-diff l-v l-g0">
            {w.diffs.map((d) => (
              <li key={d.title} class={`is-${d.status}`}>
                <span class="wi-subj">{d.subject}<span class="faint"> · {dur(d.minutes)}</span></span>
                <span class="wi-when f-nw num">
                  {d.status === "at_risk" || d.status === "new_at_risk" ? <b class="wi-risk f-w6 f-bad">не помещается</b>
                    : d.status === "shifted" ? <>{d.before!.start}<span aria-hidden="true"> → </span><span class="sr"> теперь </span>{d.after!.start}</>
                    : d.after?.start}
                </span>
              </li>
            ))}
          </ul>
          <ul class="wi-why l-v l-g1 f-b f-2">{w.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
          {w.options.length > 0 && (
            <fieldset class="wi-opts l-v b-bare">
              <legend>Что делаем?</legend>
              {w.options.map((o) => (
                <label key={o.id} class={`wi-opt l-a1 b-tile b-tap${opt === o.id ? " is-on" : ""}`}>
                  <input type="radio" name="wi-opt" checked={opt === o.id} onChange={() => setOpt(o.id)} />
                  <span><b>{o.title}</b>{o.detail.map((x) => <span class="wi-step l-blk f-b f-2 mt-1" key={x}>{x}</span>)}{o.warn && <span class="wi-warn l-blk f-m f-a mt-1">{o.warn}</span>}</span>
                </label>
              ))}
            </fieldset>
          )}
          <div class="wi-act l-h">
            <button class="btn btn-primary" onClick={() => { onApply(w, chosen); setW(null); }}><Icon name="check" />Применить</button>
            <button class="btn btn-ghost" onClick={() => setW(null)}>Отмена</button>
          </div>
          <p class="wi-note f-m f-3">Пока не нажмёшь «Применить», план не меняется.</p>
        </div>
      )}
    </section>
  );
}
