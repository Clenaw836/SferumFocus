import { useMemo, useRef, useState } from "preact/hooks";
import { Icon } from "./Icon";
import { buildMaterials, KIND_LABEL, MIN_QUERY, normalize, searchMaterials } from "../lib/materials";
import { dayStore } from "../lib/day";
import { plural } from "../lib/time";

/** F9 · «Умный поиск учебных материалов»: шпаргалки, формулы и памятки — офлайн, без ИИ, мгновенно.
 *  Свёрнут по умолчанию (паттерн disclosure, как «Изменить задание»): на 320–390 px поле ввода тьютора
 *  обязано помещаться в первый экран (phase3b_tutor «composer entirely inside viewport»). */
export function MaterialsSearch() {
  const [shown, setShown] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  // шпаргалки читаем один раз при открытии вкладки: они меняются только из «Плана на вечер»
  const [cards] = useState(() => dayStore.cards());
  const all = useMemo(() => buildMaterials(cards), [cards]);
  const found = useMemo(() => searchMaterials(q, all), [q, all]);
  const typed = normalize(q).length >= MIN_QUERY;
  const toggle = () => {
    const next = !shown;
    setShown(next);
    if (next) requestAnimationFrame(() => input.current?.focus());
  };
  return <section class={`tu-materials l-v mt-2${shown ? " is-open" : ""}`} aria-labelledby="tu-mat-h">
    <h2 id="tu-mat-h" class="tu-mat-h">
      <button type="button" class="btn btn-secondary btn-sm tu-mat-toggle l-h b-tap l-w100" aria-expanded={shown} aria-controls="tu-mat-panel" onClick={toggle}>
        <Icon name="book" /><span>Умный поиск учебных материалов</span><span class="tu-mat-chev l-h l-inl l-g0 l-fix" aria-hidden="true"><Icon name="chevron" /></span>
      </button>
    </h2>
    <div id="tu-mat-panel" class="tu-mat-panel l-v" hidden={!shown}>
    <label class="field-label" htmlFor="tu-mat-q">Памятки, формулы и шпаргалки</label>
    <input id="tu-mat-q" ref={input} class="input" type="search" value={q} maxLength={80} autoComplete="off" enterKeyHint="search"
      placeholder="Например, дискриминант" aria-describedby="tu-mat-status" onInput={(e) => { setQ(e.currentTarget.value); setOpen(null); }} />
    <p id="tu-mat-status" class="tu-mat-status f-2" role="status" aria-live="polite">
      {!typed ? (cards.length ? `Сохранено ${cards.length} ${plural(cards.length, "шпаргалка", "шпаргалки", "шпаргалок")} · ищем и в формулах, и в памятках` : "Ищем в формулах, памятках и сохранённых шпаргалках")
        : found.length ? `Найдено: ${found.length}` : "Ничего не нашлось. Попробуйте предмет или слово из темы."}
    </p>
    {typed && found.length > 0 && <ul class="tu-mat-list l-v" role="list">
      {found.map((m) => <li key={m.id} class={`tu-mat-item b-box k-${m.kind}`}>
        <button type="button" class="tu-mat-row p-23 l-h l-wrap l-g1 b-tap l-w100" aria-expanded={open === m.id} aria-controls={`tu-mat-${m.id}`} onClick={() => setOpen(open === m.id ? null : m.id)}>
          <span class="tu-mat-kind f-w6 b-pill">{KIND_LABEL[m.kind]}</span>
          <span class="tu-mat-title">{m.title}{m.subject && <span class="tu-mat-subj f-3"> · {m.subject}</span>}</span>
          {m.kind === "formula" && <span class="tu-mat-formula f-w6 num">{m.lines[0]}</span>}
        </button>
        <div id={`tu-mat-${m.id}`} class="tu-mat-body" hidden={open !== m.id}>
          {m.kind === "formula" ? <p class="tu-mat-formula-big f-w6 num">{m.lines[0]}</p>
            : <ol>{m.lines.map((l, i) => <li key={i}>{l}</li>)}</ol>}
        </div>
      </li>)}
    </ul>}
    </div>
  </section>;
}
