/**
 * «Мои дела сегодня» — что ещё планировщик обязан учесть: репетитор в 17:00, тренировка,
 * игры, дорога. Обязательное «ко времени» становится стеной в плане (учёба его обтекает),
 * «когда удобно» — ставится после учёбы и первым идёт под сокращение при дефиците.
 * Паттерны 21st.dev (поиск MCP, метаданные): «Time Off Request Calendar» — чипы типа +
 * живой пересчёт; «Duration Picker» — шаг длительности с клавиатуры. Собрано на наших
 * токенах (.row/.list/.sheet), нативные radio/time — семантика и автозаполнение браузера.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { Icon } from "../ui/Icon";
import { Sheet } from "../ui/Sheet";
import { haptic } from "../lib/host";
import { dur, toHHMM, toMin } from "../lib/time";
import { draftFor, KINDS, kindOf, MAX_DUR, MIN_DUR, validate, type ActDraft, type ActErrors } from "../lib/activities";
import type { ActivityType, DayActivity } from "../lib/types";


const ERR_ORDER: (keyof ActErrors)[] = ["title", "startTime", "durationMinutes"];

export function ActivitySheet({ open, editing, nowMin, onClose, onSave, onDelete }: {
  open: boolean; editing: DayActivity | null; nowMin: number;
  onClose: () => void; onSave: (d: ActDraft) => void; onDelete: (a: DayActivity) => void;
}) {
  const [d, setD] = useState<ActDraft>(draftFor("tutor"));
  const [errs, setErrs] = useState<ActErrors>({});
  const [tried, setTried] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => { if (open) { setD(editing ? draftFor(editing.type, editing) : draftFor("tutor")); setErrs({}); setTried(false); } }, [open, editing]);
  const k = kindOf(d.type);
  const set = (p: Partial<ActDraft>) => { const n = { ...d, ...p }; setD(n); if (tried) setErrs(validate(n)); };
  const pickType = (t: ActivityType) => {
    const nk = kindOf(t), prev = kindOf(d.type);
    // название по умолчанию меняем, только если пользователь его не трогал
    const title = !d.title.trim() || d.title === prev.defTitle ? nk.defTitle : d.title;
    set({ type: t, title, fixed: nk.needTime ? true : nk.defFixed, durationMinutes: d.durationMinutes === prev.defMinutes ? nk.defMinutes : d.durationMinutes });
    haptic.select();
  };
  const onTypeKey = (e: KeyboardEvent) => {
    const i = KINDS.findIndex((x) => x.type === d.type);
    const dir = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const n = KINDS[(i + dir + KINDS.length) % KINDS.length];
    pickType(n.type);
    requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>(`[data-type="${n.type}"]`)?.focus());
  };
  const step = (delta: number) => { set({ durationMinutes: Math.max(MIN_DUR, Math.min(MAX_DUR, (d.durationMinutes || 0) + delta)) }); haptic.select(); };
  const submit = (e?: Event) => {
    e?.preventDefault();
    const v = validate(d);
    setTried(true); setErrs(v);
    const first = ERR_ORDER.find((x) => v[x]);
    if (first) { haptic.notify("error"); formRef.current?.querySelector<HTMLElement>(`[name="${first}"]`)?.focus(); return; }
    onSave({ ...d, title: d.title.trim(), startTime: d.fixed ? d.startTime : "" });
  };
  const end = d.fixed && /^\d{2}:\d{2}$/.test(d.startTime) ? toMin(d.startTime) + d.durationMinutes : null;
  const past = end !== null && end <= nowMin;
  const running = end !== null && !past && toMin(d.startTime) < nowMin;

  return (
    <Sheet open={open} onClose={onClose} eyebrow="Мои дела сегодня" title={editing ? "Изменить дело" : "Новое дело"}
      footer={<div class="stack">
        <button class="btn btn-primary btn-block" type="submit" form="act-form">{editing ? "Сохранить" : "Добавить дело"}</button>
        {editing && <button class="btn btn-ghost btn-block danger" type="button" onClick={() => onDelete(editing)}><Icon name="trash" />Удалить дело</button>}
      </div>}>
      <form id="act-form" ref={formRef} onSubmit={submit} noValidate>
        <fieldset class="fs b-bare">
          <legend class="field-label">Что за дело</legend>
          <div class="act-types l-c4" role="radiogroup" aria-label="Тип дела" onKeyDown={onTypeKey}>
            {KINDS.map((x) => (
              <button key={x.type} type="button" role="radio" data-type={x.type} aria-checked={d.type === x.type} tabIndex={d.type === x.type ? 0 : -1}
                class="act-type l-v l-g1 f-m f-w6 f-2 b-tile" onClick={() => pickType(x.type)}>
                <Icon name={x.icon} /><span>{x.label}</span>
              </button>
            ))}
          </div>
        </fieldset>

        <label class="field" style="margin-top:16px">
          <span class="field-label">{k.titleLabel}{k.needTitle ? " · обязательно" : ""}</span>
          <input class="input" name="title" value={d.title} maxLength={60} autoComplete="off" placeholder={k.placeholder}
            onInput={(e) => set({ title: (e.target as HTMLInputElement).value })} aria-invalid={!!errs.title} aria-describedby={errs.title ? "e-title" : undefined} />
          {errs.title && <span id="e-title" class="field-err" role="alert">{errs.title}</span>}
        </label>

        {k.needTime ? (
          <p class="hint-text" style="margin-top:12px">Для «Прочего» нужны название, время начала и длительность — так дело точно встанет в план.</p>
        ) : (
          <fieldset class="fs b-bare" style="margin-top:16px">
            <legend class="field-label">Когда</legend>
            <div class="radio-seg l-c2 l-g1 b-box">
              <label class={d.fixed ? "on" : ""}><input type="radio" name="when" checked={d.fixed} onChange={() => { set({ fixed: true }); haptic.select(); }} />Ко времени</label>
              <label class={!d.fixed ? "on" : ""}><input type="radio" name="when" checked={!d.fixed} onChange={() => { set({ fixed: false }); haptic.select(); }} />Когда удобно</label>
            </div>
            <p class="hint-text">{d.fixed ? "Время неподвижно: учёба встанет до и после." : "Поставим после уроков; если вечера не хватит — предложим сократить или перенести."}</p>
          </fieldset>
        )}

        {d.fixed && (
          <label class="field" style="margin-top:12px">
            <span class="field-label">Начало</span>
            <div class="act-time l-1a l-g3 l-mid">
              <input class="input" type="time" name="startTime" step={300} value={d.startTime}
                onInput={(e) => set({ startTime: (e.target as HTMLInputElement).value })} aria-invalid={!!errs.startTime} aria-describedby={errs.startTime ? "e-start" : end !== null ? "act-end" : undefined} />
              {end !== null && <span id="act-end" class="act-end f-b f-2 f-nw num">до {toHHMM(end)}</span>}
            </div>
            {errs.startTime && <span id="e-start" class="field-err" role="alert">{errs.startTime}</span>}
            {past && <span class="hint-text" style="color:var(--warn)">Это время уже прошло — в сегодняшний план дело не попадёт.</span>}
            {running && <span class="hint-text">Идёт сейчас — в план встанет остаток до {toHHMM(end!)}.</span>}
          </label>
        )}

        <fieldset class="fs b-bare" style="margin-top:16px">
          <legend class="field-label">Длительность</legend>
          <div class="dur-row l-v">
            <div class="dur-chips l-h l-wrap" role="group" aria-label="Быстрый выбор">
              {k.durations.map((m) => <button key={m} type="button" class={`chip${d.durationMinutes === m ? " on" : ""}`} aria-pressed={d.durationMinutes === m} onClick={() => { set({ durationMinutes: m }); haptic.select(); }}>{dur(m)}</button>)}
            </div>
            <div class="stepper" role="group" aria-label="Точнее">
              <button type="button" class="icon-btn" onClick={() => step(-15)} aria-label="Меньше на 15 минут" disabled={d.durationMinutes <= MIN_DUR}>−</button>
              <output class="num" name="durationMinutes" tabIndex={-1} aria-live="polite" aria-describedby={errs.durationMinutes ? "e-dur" : undefined}>{d.durationMinutes ? dur(d.durationMinutes) : "—"}</output>
              <button type="button" class="icon-btn" onClick={() => step(15)} aria-label="Больше на 15 минут" disabled={d.durationMinutes >= MAX_DUR}>+</button>
            </div>
          </div>
          {errs.durationMinutes && <span id="e-dur" class="field-err" role="alert">{errs.durationMinutes}</span>}
        </fieldset>
      </form>
    </Sheet>
  );
}
