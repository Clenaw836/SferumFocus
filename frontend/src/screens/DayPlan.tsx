/** v3.2 · «План дня» (бывш. «Вечер»): рабочий календарь Пн..Вс, конструктор распорядка в 1 тап,
 *  поминутный маршрут дня (учёба + отдых + еда + игры + прогулка + сон) и вердикт по норме СанПиН. */
import { useMemo, useRef, useState } from "preact/hooks";
import { createSwipe } from "../lib/diaryHistory";
import { Icon } from "../ui/Icon";
import { addDays, weekdayOf } from "../lib/schedule";
import { sched } from "../lib/schedStore";
import { plural, toHHMM, toMin } from "../lib/time";
import { splitTitle } from "../lib/subjects";
import { SANPIN_REF } from "../lib/sanpin";
import type { DayActivity, PlanOut, Task, InitialState } from "../lib/types";
import type { ActDraftX } from "../lib/assistant";

const WD = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const mondayOf = (d: string) => addDays(d, -((new Date(d + "T12:00:00Z").getUTCDay() + 6) % 7));

/** 5.1 · Навигатор дат: каждая ячейка и стрелки недель реально меняют selectedDate. */
export function DateStrip({ today, value, onChange }: { today: string; value: string; onChange: (d: string) => void }) {
  const monday = mondayOf(value);
  // v3.2 · свайп по полоске — соседняя неделя (горизонтальный жест; вертикальную прокрутку не перехватываем).
  const sw = useRef(createSwipe());
  const swallow = useRef(false);
  const touch = (e: PointerEvent) => e.pointerType !== "mouse";
  return <div class="date-strip" role="group" aria-label="Выбор дня для плана. Свайп влево-вправо — соседняя неделя"
    onPointerDown={(e) => { if (touch(e)) { swallow.current = false; sw.current.start(e.clientX, e.clientY, e.timeStamp); } }}
    onPointerMove={(e) => { if (touch(e)) sw.current.move(e.clientX, e.clientY); }}
    onPointerUp={(e) => { if (!touch(e)) return; const s = sw.current.end(e.clientX, e.clientY, e.timeStamp); if (s) { swallow.current = true; onChange(addDays(value, 7 * s)); } }}
    onPointerCancel={() => sw.current.cancel()}
    onClickCapture={(e) => { if (swallow.current) { swallow.current = false; e.preventDefault(); e.stopPropagation(); } }}>
    <button type="button" class="icon-btn ds-nav" aria-label="Предыдущая неделя" onClick={() => onChange(addDays(value, -7))}><Icon name="chevron" /></button>
    <ol class="week-strip">{WD.map((label, i) => {
      const date = addDays(monday, i);
      return <li key={date} aria-current={date === today ? "date" : undefined}>
        <button type="button" class={`ds-day${date === value ? " is-on" : ""}`} aria-pressed={date === value} onClick={() => onChange(date)}>
          <span>{label}</span><b class="num">{Number(date.slice(8, 10))}</b><span class="sr">{date === today ? ", сегодня" : ""}</span></button><i aria-hidden="true" /></li>;
    })}</ol>
    <button type="button" class="icon-btn ds-nav ds-next" aria-label="Следующая неделя" onClick={() => onChange(addDays(value, 7))}><Icon name="chevron" /></button>
  </div>;
}

/** 5.2 · Пресеты реальной жизни: включаются в 1 тап, время редактируется в карточке дела. */
export const PRESETS: { key: string; icon: string; title: string; type: ActDraftX["type"]; start: string; minutes: number; road?: number }[] = [
  { key: "games", icon: "gamepad", title: "Игры в ПК / приставка", type: "games", start: "17:00", minutes: 90 },
  { key: "food", icon: "utensils", title: "Ужин", type: "misc", start: "19:00", minutes: 30 },
  { key: "walk", icon: "walk", title: "Гулянка с друзьями", type: "meet", start: "19:30", minutes: 90 },
  { key: "sport", icon: "dumbbell", title: "Тренировка / репетитор", type: "sport", start: "16:00", minutes: 90, road: 30 },
];
export function LifePresets({ date, acts, bedtime, onPreset, onEdit, onAdd, onBed }: { date: string; acts: DayActivity[]; bedtime: string; onPreset: (d: ActDraftX) => void; onEdit: (a: DayActivity) => void; onAdd: () => void; onBed?: () => void }) {
  return <section class="life" aria-labelledby="life-h">
    <h2 id="life-h" class="h-sec">Мой распорядок и отдых</h2>
    <p class="life-p">Включи в 1 тап — эти слоты станут личным временем, домашка встанет вокруг них.</p>
    <div class="life-chips">
      {PRESETS.map((x) => {
        const on = acts.find((a) => a.title === x.title);
        const st = on?.startTime ?? x.start, mins = on?.durationMinutes ?? x.minutes;
        return <button key={x.key} type="button" class={`chip life-chip${on ? " is-on" : ""}`} aria-pressed={!!on}
          onClick={() => on ? onEdit(on) : onPreset({ type: x.type, title: x.title, date, startTime: x.start, duration: x.minutes + (x.road ?? 0), fixed: true })}>
          <Icon name={x.icon} /><span>{x.title}</span><small class="num">{st}–{toHHMM(toMin(st) + mins)}</small></button>;
      })}
      {onBed && <button type="button" class="chip life-chip" onClick={onBed}><Icon name="moon" /><span>Во сколько спать</span><small class="num">{bedtime}</small></button>}
      <button type="button" class="chip life-chip life-add" onClick={onAdd}><Icon name="plus" /><span>Своё дело</span></button>
    </div>
  </section>;
}

type SlotKind = "study" | "break" | "rest" | "games" | "food" | "walk" | "sport" | "other" | "sleep";
export interface Slot { start: string; end: string; kind: SlotKind; title: string; task: string | null }
const KIND_LABEL: Record<SlotKind, string> = { study: "Учёба", break: "Перерыв", rest: "Отдых", games: "Игры", food: "Еда", walk: "Прогулка", sport: "Спорт", other: "Дело", sleep: "Сон" };
function kindOfAct(label: string, acts: DayActivity[]): SlotKind {
  const a = acts.find((x) => x.title === label), t = a?.type;
  if (t === "games") return "games";
  if (t === "meet") return "walk";
  if (t === "sport" || t === "tutor" || t === "club") return "sport";
  return /ужин|обед|перекус|еда/i.test(label) ? "food" : /гуля|прогул/i.test(label) ? "walk" : /игр|пк|приставк/i.test(label) ? "games" : "other";
}
/** Слоты маршрута из расчёта плана (сервер или локальный buildPlan) + сон. */
export function routeSlots(plan: PlanOut | null | undefined, acts: DayActivity[], bedtime: string): Slot[] {
  if (!plan) return [];
  const out: Slot[] = plan.plan.map((e) => ({ start: e.start, end: e.end, title: e.label, task: e.task,
    kind: e.kind === "work" ? "study" : e.kind === "break" ? "break" : e.kind === "rest" ? "rest" : kindOfAct(e.label, acts) }));
  out.push({ start: bedtime, end: bedtime, kind: "sleep", title: "Сон", task: null });
  return out;
}
export { verdict } from "../lib/routeVerdict";
export function DayRoute({ slots, done, now, verdictText, onStart }: { slots: Slot[]; done: string[]; now: number; verdictText: string | null; onStart: (task: string) => void }) {
  if (!slots.length) return null;
  const nextI = slots.findIndex((s) => s.kind === "study" && s.task && !done.includes(s.task) && toMin(s.end) > now);
  return <section class="day-route" aria-labelledby="route-h">
    <h2 id="route-h" class="h-sec">Маршрут по времени</h2>
    <ol class="dr-list">{slots.map((s, i) => {
      const isDone = !!s.task && done.includes(s.task), live = toMin(s.start) <= now && now < toMin(s.end);
      const { subject } = splitTitle(s.title);
      return <li key={i} class={`dr-row k-${s.kind}${isDone ? " is-done" : ""}${i === nextI ? " is-next" : ""}${live ? " is-live" : ""}`}>
        <span class="dr-t num">{s.kind === "sleep" ? s.start : `${s.start}–${s.end}`}</span>
        <span class="dr-dot" aria-hidden="true" />
        <span class="dr-b"><b>{s.kind === "study" ? subject : s.title}</b><small>{KIND_LABEL[s.kind]}{s.kind !== "sleep" ? ` · ${toMin(s.end) - toMin(s.start)} мин` : ""}{isDone ? " · готово" : i === nextI ? " · дальше" : ""}</small></span>
        {s.kind === "study" && s.task && !isDone && i === nextI && <button type="button" class="btn btn-ghost btn-sm dr-go" onClick={() => onStart(s.task!)} aria-label={`Старт: ${subject}`}><Icon name="play" /></button>}
      </li>;
    })}</ol>
    {verdictText && <p class="dr-verdict" role="status"><Icon name="check" />{verdictText}</p>}
  </section>;
}

/** Шаг 1: точное время, почему именно с этого и микро-чек-лист «как делать по шагам». */
export function stepOne(task: Task, slot: Slot | null, allLeft: Task[]): { range: string | null; why: string; steps: string[] } {
  const m = task.planned_minutes, written = task.type !== "oral";
  const range = slot ? `${slot.start} – ${slot.end} (${toMin(slot.end) - toMin(slot.start)} мин)` : null;
  const harder = allLeft.length > 1 && m >= Math.max(...allLeft.map((t) => t.planned_minutes));
  const why = written && harder ? "Самое объёмное письменное — первым, пока голова свежая: дальше пойдёт легче."
    : written ? "Письменное — раньше устного: устное легче повторить перед сном."
    : "Устное займёт немного времени — разгонимся с него и перейдём к остальному.";
  const core = Math.max(5, m - 10);
  const steps = written
    ? [`Шаг 1 (5 мин): повтори правило или формулу в Практикуме`, `Шаг 2 (${core} мин): реши задание в тетради по таймеру`, `Шаг 3 (5 мин): сфотографируй черновик Тьютору для проверки`]
    : [`Шаг 1 (5 мин): прочитай параграф и выдели главное`, `Шаг 2 (${core} мин): перескажи вслух по плану`, `Шаг 3 (5 мин): проверь себя в быстром квизе`];
  return { range, why, steps };
}

/** 5.1 · Выбран другой день: уроки, ДЗ со сроком, дела — именно на эту дату. */
export function DayPreview({ date, today, initial, acts, onToday }: { date: string; today: string; initial: InitialState; acts: DayActivity[]; onToday: () => void }) {
  const v = useMemo(() => sched.day(date), [date]);
  const lessons = v.lessons.filter((l) => l.status === "active");
  const hw = (initial.diary_tasks ?? []).filter((t) => t.deadline === date);
  const mins = hw.reduce((s, t) => s + (t.planned_minutes || 0), 0);
  const wd = weekdayOf(date);
  const [open] = useState(true);
  return <section class="day-preview" aria-labelledby="dp-h">
    <h2 id="dp-h" class="h-sec">{date < today ? "Прошедший день" : "План на"} {WD[(new Date(date + "T12:00:00Z").getUTCDay() + 6) % 7]}, {date.slice(8, 10)}.{date.slice(5, 7)}</h2>
    {open && <>
      <p class="dp-sum">{lessons.length ? <><span class="num">{lessons.length}</span> {plural(lessons.length, "урок", "урока", "уроков")}{lessons[lessons.length - 1]?.end_time ? <>, до <span class="num">{lessons[lessons.length - 1].end_time}</span></> : null}</> : wd === "sunday" || wd === "saturday" ? "Выходной — уроков нет" : "Уроков нет или расписание не пришло"}
        {hw.length ? <> · ДЗ: <span class="num">{hw.length}</span>{mins ? <> · ~<span class="num">{mins}</span> мин</> : null}</> : null}</p>
      {lessons.length > 0 && <ol class="dp-lessons">{lessons.map((l) => <li key={l.lesson_number}><span class="num">{l.start_time ?? l.lesson_number}</span><b>{l.subject}</b></li>)}</ol>}
      {hw.length > 0 && <ul class="dp-hw">{hw.map((t, i) => <li key={i}>{t.title}</li>)}</ul>}
      {date === today && acts.length > 0 && <ul class="dp-acts">{acts.map((a) => <li key={a.id}><span class="num">{a.startTime ?? "—"}</span>{a.title}</li>)}</ul>}
    </>}
    <button type="button" class="btn btn-secondary btn-sm" onClick={onToday}><Icon name="calendar" />К плану на сегодня</button>
    <p class="hint-text">{SANPIN_REF}: время на домашку считается по классу.</p>
  </section>;
}
