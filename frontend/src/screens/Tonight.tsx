import { DateStrip, DayPreview, DayRoute, LifePresets, routeSlots, stepOne, verdict } from "./DayPlan";
import type { ActDraftX } from "../lib/assistant";
import { eveningLoad } from "../lib/sanpin";
import { EveningAgenda } from '../ui/EveningAgenda';
import { firstMission } from '../lib/mission';
import { DataProvenance } from '../ui/DataProvenance';
import { AiAnswer } from "../ui/AiAnswer";
import { nsKey } from "../lib/demo";
import { needOf } from "../lib/need";
import { hwInfo, isHwNew, useHw } from "../lib/hwSync";
import { useEffect, useMemo, useState } from "preact/hooks";
import { Icon } from "../ui/Icon";
import { Hud } from "../ui/Hud";
import { Odometer } from "../ui/Odometer";
import { appLink, share } from "../lib/host";
import { cache } from "../lib/api";
import { dayStore, schoolDay, type MorningCard } from "../lib/day";
import type { FocusSession } from "../lib/focus";
import { toast } from "../ui/Toast";
import { dur, plural, toHHMM, toMin, dayTitle } from "../lib/time";
import { splitTitle, subjectColor } from "../lib/subjects";
import type { PlanWindow } from "../lib/clock";
import { buildPlan } from "../engine/norms";
import { kindOf } from "../lib/activities";
import { SOURCE_LABEL, WD_NAME, type DayView, type Provider } from "../lib/schedule";
import { type MorningPlan, type Phase, type SchoolTimes } from "../lib/daycycle";
import type { DayOut } from "../lib/dayEngine";
import { topicFor } from "../lib/blitzBank";
import { MiniQuiz } from "../ui/MiniQuiz";
import { prepOffer, questionsWord } from "../lib/prep";
import { sleepSpan } from "../lib/sleep";
import type { ComponentChildren } from "preact";
import type { Rescue } from "../lib/survival";
import type { CalculateResponse, DayActivity, InitialState, PersonalActivity, RestSlot, Rewards, Task } from "../lib/types";
/**
 * ГЛАВНАЯ v14 — «Линия дня».
 * Не стопка карточек, а одна история: СЕЙЧАС (фокус-точка: одно состояние, одно число, одно действие)
 * → вертикальная линия дня: ШКОЛА → ДОРОГА → ВЕЧЕР (план/задания/дела) → СОН → ЗАВТРА.
 * Коробки только там, где есть слой (лист, док). Иерархию держат типографика, ритм и одна ось времени.
 */
interface Props {
    initial: InitialState;
    tasks: Task[];
    /** v3.2.1 · ДЗ со сроком позже ближайшего учебного дня (lib/planHorizon.ts) — не в плане, но видны. */
    ahead?: Task[];
    /** v3.2.1 · «хвосты»: срок наступил, «сделано» не отмечено — в план не встают сами, берутся кнопкой. */
    tails?: Task[];
    onPullAhead?: (t: Task) => void;
    eveningTasks?: Task[];
    compact?: boolean;
    order?: "default" | "short_first";
    done: string[];
    start: string;
    bedtime: string;
    survival: boolean;
    plan: CalculateResponse | null;
    planBusy: boolean;
    planError: string | null;
    offline: boolean;
    demo?: boolean;
    aiOnline: boolean | null;
    onBuild: () => void;
    onOpenTask: (t: Task) => void;
    onMission: (t: Task, minutes: number) => void;
    onAdd: () => void;
    onSettings: () => void;
    onSurvival: () => void;
    onProfile: () => void;
    onConnectDiary?: () => void;
    onProgress: () => void;
    onTutor?: () => void;
    onStudy?: () => void;
    rewards: Rewards | null;
    userName: string;
    standalone: boolean;
    session?: FocusSession | null;
    logV?: number;
    botName?: string | null;
    onTriage?: () => void;
    cards?: MorningCard[];
    onCardSeen?: (title: string) => void;
    onBlitz?: () => void;
    win: PlanWindow;
    nowMin: number;
    stale: boolean;
    acts: DayActivity[];
    personal: PersonalActivity[];
    onAddAct: () => void;
    onEditAct: (a: DayActivity) => void;
    onCarryAll: () => void;
    /** одна строка помощника под главным числом (изменение расписания, дрейф сна, подсказка) */
    head?: ComponentChildren;
    /** v2.2: пилюля «+N заданий от учителя → Приступить» (ui/HwPixel.tsx) — наверху «Вечера». */
    hwPill?: ComponentChildren;
    rescueNode?: ComponentChildren;
    /** v18: «Успею ли?» — симулятор «что если» без применения */
    whatIfNode?: ComponentChildren;
    /** режим спасения (если показан): заголовок и «Мои дела» согласованы с карточкой */
    rescue?: Rescue | null;
    assistantNode?: ComponentChildren;
    onBed?: () => void;
    // ---- петля дня ----
    phase: Phase;
    view: DayView;
    viewNext: DayView;
    times: SchoolTimes;
    travel: number;
    wake: string;
    /** v16.1: редактор времени подъёма (отдельно от отбоя) */
    onWake?: () => void;
    provider: Provider | null;
    onReport: () => void;
    mp: MorningPlan;
    morningStarted: boolean;
    onMorningStart: () => void;
    moved: Record<string, string>;
    rescueMode?: "normal" | "tight" | "survival" | "critical";
    // ---- v16: единый расчёт дня ----
    day: DayOut;
    schedStatus: string;
    syncedAt: {
        phone: number | null;
        source: string | null;
    };
    onImport: () => void;
    /** v17.1: «Собрать расписание» — ученик задаёт время начала уроков и дела, видит прогноз */
    onBuildSchedule?: () => void;
    onSync: () => void;
    onQuizDone: (ok: number, n: number) => void;
    /** v3.2 · пресет распорядка (Игры, Ужин, Гулянка, Тренировка) в 1 тап. */
    onPreset?: (d: ActDraftX) => void;
}
/** «(нужно 5 ч 25 с делами и отдыхом, до сна 3 ч 40)» — чтобы «2 ч 15 мин» заданий и дефицит не противоречили. */
function needTail(r: Parameters<typeof needOf>[0]) {
    const nd = needOf(r);
    if (!nd || nd.other <= 0)
        return null;
    return <> (нужно <b class="num">{dur(nd.need)}</b> с делами и отдыхом, до сна <span class="num">{dur(nd.cap)}</span>)</>;
}
/** Блок «Времени не хватает»: из чего сложился дефицит + реальные компромиссы.
 *  Паттерн 21st.dev «Spending Limit Card» (сегментная полоса бюджета) — на наших токенах. */
function DeficitCard({ r, survival, busy, onSurvival, onTriage }: {
    r: CalculateResponse;
    survival: boolean;
    busy: boolean;
    onSurvival: () => void;
    onTriage?: () => void;
}) {
    const pl = r.plan, s = pl.summary;
    const has = s.capacity_minutes !== undefined;
    const parts = has ? [
        { k: "work", label: "Задания с перерывами", v: s.need_work_minutes ?? 0 },
        { k: "fixed", label: "Обязательные дела", v: s.need_fixed_minutes ?? 0 },
        { k: "flex", label: "Гибкие дела", v: s.need_flexible_minutes ?? 0 },
        { k: "rest", label: "Отдых и еда", v: s.need_rest_minutes ?? 0 },
    ].filter((x) => x.v > 0) : [];
    const need = parts.reduce((a, x) => a + x.v, 0);
    const cap = s.capacity_minutes ?? 0;
    const unplaced = s.unplaced_personal ?? [];
    return (<section class="deficit mt-4" aria-labelledby="def-h">
      <div class="def-top l-v l-g1">
        <h2 id="def-h" class="eyebrow def-eyebrow f-bad">Времени не хватает</h2>
        <b class="num def-n f-xl f-bad">−{dur(pl.deficit_minutes)}</b>
        {has && <span class="def-lead f-b f-2">нужно {dur(need)} · до сна {dur(cap)}</span>}
      </div>
      {has && need > 0 && (<>
          <div class="def-bar l-h l-g1 mt-4 mb-3 l-rel r-xs" role="img" aria-label={`Нужно ${dur(need)}, до сна ${dur(cap)}`}>
            {parts.map((x) => <i key={x.k} class={`d-${x.k}`} style={{ flexGrow: x.v }}/>)}
            <span class="def-cap p-abs r-xs" style={{ left: `${Math.min(100, (cap / need) * 100)}%` }}/>
          </div>
          <dl class="def-dl l-v l-g0 f-b">
            {parts.map((x) => <div key={x.k}><dt><i class={`d-${x.k}`} aria-hidden="true"/>{x.label}</dt><dd class="num f-w6">{dur(x.v)}</dd></div>)}
            <div class="def-sum"><dt>До сна · {s.window_start}–{s.window_end}</dt><dd class="num f-w6">{dur(cap)}</dd></div>
            <div class="def-sum bad"><dt>Дефицит</dt><dd class="num f-w6">−{dur(pl.deficit_minutes)}</dd></div>
          </dl>
        </>)}
      {unplaced.length > 0 && <p class="def-miss l-h l-top f-b f-warn mt-3"><Icon name="alert"/>Не влезает: {unplaced.map((t) => `«${t}»`).join(", ")}</p>}
      {r.negotiator_message && !pl.tradeoff_suggestions.every((t) => r.negotiator_message!.includes(t)) && <blockquote class="def-quote l-a1 l-g3 mt-4"><Icon name="bot"/><p>{r.negotiator_message}</p></blockquote>}
      {pl.tradeoff_suggestions.length > 0 && (<>
          <h3 class="def-h3 f-s mt-4">Что можно сделать</h3>
          <ul class="tips f-b f-2 mt-1">{pl.tradeoff_suggestions.map((t) => <li key={t}>{t}</li>)}</ul>
          <p class="hint-text">Обязательные дела не двигаем — меняется только гибкое и учёба.</p>
        </>)}
      <div class="stack" style="margin-top:12px">
        {!survival && <button class="btn btn-primary btn-block" onClick={onSurvival} disabled={busy}><Icon name="flame"/>Режим выживания</button>}
        {onTriage && <button class={`btn ${survival ? "btn-secondary" : "btn-ghost"} btn-block`} onClick={onTriage} disabled={busy}><Icon name="calendar"/>Распределить на 2 дня</button>}
      </div>
    </section>);
}
const sub = (t: string) => splitTitle(t).subject;
const nTasks = (n: number) => `${n} ${plural(n, "задание", "задания", "заданий")}`;
/** V23 · эталон «Сейчас по плану»: длительность сессии (предложение плана и +5/+10 мин), крупный таймер,
 *  старт и разбор с тьютором. Длительность — радиогруппа, а не вкладки: выбор значения, не смена панели. */
function MissionStart({ minutes, onStart, onTutor }: { minutes: number; onStart: (m: number) => void; onTutor?: () => void }) {
  const opts = [minutes, minutes + 5, minutes + 10].filter((m, i) => i === 0 || m <= 60);
  const [len, setLen] = useState(minutes);
  useEffect(() => setLen(minutes), [minutes]);
  const key = (e: KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const n = opts[(opts.indexOf(len) + (e.key === "ArrowRight" ? 1 : opts.length - 1)) % opts.length];
    setLen(n); (e.currentTarget as HTMLElement).querySelector<HTMLButtonElement>(`[data-min="${n}"]`)?.focus();
  };
  return <div class="mission-start l-v">
    <div class="seg-duration" role="radiogroup" aria-label="Длительность сессии" onKeyDown={key}>
      {opts.map((m) => <button key={m} type="button" role="radio" aria-checked={m === len} tabIndex={m === len ? 0 : -1} data-min={m} onClick={() => setLen(m)}>{m} мин</button>)}
    </div>
    {/* v2.4 «Сегодня»: длительность уже видна на выбранном чипе — второй крупный таймер «10:00» (40 px) убран; одно главное и одно второстепенное действие в строку */}
    <div class="mission-actions">
      <button type="button" data-action="start-study" class="btn btn-primary" onClick={() => onStart(len)}><Icon name="play"/>Запустить таймер {len} мин</button>
      {onTutor && <button type="button" class="btn btn-secondary mission-tutor" onClick={onTutor}><Icon name="flask"/>Практикум / Тьютор</button>}
    </div>
  </div>;
}

/** v3.2.1 · «Задано наперёд»: ДЗ на следующие дни. Не раздувает вечер, но видно и берётся одной кнопкой. */
function AheadList({ tasks, tails, onPull }: { tasks: Task[]; tails: Task[]; onPull?: (t: Task) => void }) {
  const mins = tasks.reduce((a, t) => a + (t.planned_minutes || 0), 0);
  const head = tasks.length ? <><b>Задано наперёд · <span class="num">{tasks.length}</span></b><small>Не входит в план сегодня · ~{dur(mins)}. Можно начать заранее{tails.length ? ` · хвостов: ${tails.length}` : ""}</small></>
    : <><b>Хвосты · <span class="num">{tails.length}</span></b><small>Срок уже наступил, «сделано» не отмечено</small></>;
  return <details class="day-workbench ahead-workbench b-box mt-4 mb-4">
    <summary class="f-2"><Icon name="calendar"/><span>{head}</span><Icon name="chevron"/></summary>
    {tails.length > 0 && <p class="ahead-sub f-3">Хвосты — срок наступил, а «сделано» не отмечено. Если уже сделал — не трогай, в план они сами не встают.</p>}
    <ul class="ahead-list" aria-label="Задано наперёд и хвосты">
      {[...tails, ...tasks].map((t) => { const cut = t.title.indexOf(": "); const { subject, detail } = cut > 0 ? { subject: t.title.slice(0, cut), detail: t.title.slice(cut + 2) } : splitTitle(t.title); return <li key={t.title} class="ahead-row">
        <span class="ahead-txt"><b class="f-2">{subject || "Задание"}</b><small class="f-3">{detail || t.title}</small><small class="ahead-due f-3">{dueLabel(t.deadline)}{t.planned_minutes ? ` · ~${t.planned_minutes} мин` : ""}</small></span>
        {onPull && <button type="button" class="quiet-control ahead-pull f-b b-tap" onClick={() => onPull(t)} aria-label={`Сделать сегодня: ${t.title}`}>Сделать сегодня</button>}
      </li>; })}
    </ul>
  </details>;
}

export function Tonight(p: Props) {
    const [sel, setSel] = useState(p.day.date);
    useEffect(() => setSel(p.day.date), [p.day.date]);
    const mission = firstMission(p.tasks, p.done, p.day.date);
    const left = p.tasks.filter((t) => !p.done.includes(t.title));
    const totalMin = left.reduce((s, t) => s + t.planned_minutes, 0);
    const plan = p.plan?.plan;
    const works = plan?.plan.filter((e) => e.kind === "work") ?? [];
    const finish = works.length ? toMin(works[works.length - 1].end) : null;
    const bed = toMin(plan?.summary.window_end ?? p.bedtime);
    const deficit = plan?.deficit_minutes ?? 0;
    const effStart = p.win.state === "ok" ? p.win.start : p.start;
    const afterBed = p.win.state === "afterBed";
    const activeTask = p.session ? p.tasks.find(t => t.title === p.session!.title && !p.done.includes(t.title)) : null;
    const fresh = !!plan && !p.stale;
    const evening = p.eveningTasks ?? left;
    const preview = useMemo(() => (p.win.state === "ok" && evening.length
        ? buildPlan({ tasks: evening, start_time: effStart, bedtime: p.bedtime, rest_slots: p.initial.settings.rest_slots, personal_activities: p.personal, survival: p.survival, compact_breaks: p.compact, order: p.order })
        : null), [evening, effStart, p.bedtime, p.personal, p.survival, p.compact, p.order]);
    const pWorks = preview?.plan.filter((e) => e.kind === "work") ?? [];
    const estimate = pWorks.length ? toMin(pWorks[pWorks.length - 1].end) : toMin(effStart);
    const drift = fresh && p.win.state === "ok" && toMin(p.win.start) - toMin(plan!.summary.window_start) >= 30;
    const allDone = p.tasks.length > 0 && left.length === 0;
    const log = useMemo(() => dayStore.log(), [p.logV, p.done.length]);
    const actualMin = p.tasks.reduce((s, t) => s + (p.done.includes(t.title) ? (log[t.title]?.actualMin ?? t.planned_minutes) : 0), 0);
    const blitzToday = Object.keys(cache.get<Record<string, number>>(`sf.blitz.day.${schoolDay()}`) ?? {}).length;
    const now = p.nowMin;
    const ph = p.phase;
    const tight = !!p.rescueNode && !fresh; // режим спасения ещё не применён
    const nextWork = fresh ? works.find((w) => w.task && !p.done.includes(w.task) && toMin(w.end) > now)?.task ?? left[0]?.title : left[0]?.title;
    const nextTask = nextWork ? p.tasks.find((t) => t.title === nextWork) ?? null : null;
    const schoolSide = ph === "morning" || ph === "school" || ph === "travel";
    const progress = p.tasks.length ? (p.tasks.length - left.length) / p.tasks.length : 0;
    // v16: «сейчас/дальше» — из движка дня (lib/dayEngine.ts ≡ app/day_engine.py), не локальный пересчёт
    const D = p.day, ds = D.day_state;
    const cl = D.current_lesson, nl = D.next_lesson;
    const current = cl ? p.view.lessons.find((l) => l.status === "active" && l.lesson_number === cl.n) ?? null : null;
    const next = nl ? p.view.lessons.find((l) => l.status === "active" && l.lesson_number === nl.n) ?? null : null;
    const lessonPct = cl ? cl.progress_pct / 100 : 0;
    const prep = D.lesson_prep;
    const prepToday = !!prep && prep.date === D.date && (ds === "BEFORE_SCHOOL" || (ds === "BETWEEN_LESSONS" && (prep.starts_in ?? 0) >= 5));
    // ---------- ФОКУС-ТОЧКА: состояние → одно число → одно действие ----------
    let state = "", hero: ComponentChildren = null, lead: ComponentChildren = null, action: ComponentChildren = null, tone = "";
    if (allDone) {
        state = "Всё сделано";
        tone = "ok";
        hero = <h1 id="tonight-h" class="now-title f-xl mt-2">Свобода</h1>;
        lead = <>{nTasks(p.tasks.length)} закрыто · <span class="num">{actualMin}</span> мин по факту{blitzToday ? <> · блицев <span class="num">{blitzToday}</span></> : null}. Вечер твой.</>;
        action = (<div class="now-acts l-v l-g1 mt-6">
        <button class="btn btn-primary btn-block btn-share mt-4" onClick={async () => {
                const r = await share(`Уроки сделаны${finish !== null ? ` к ${toHHMM(finish)}` : ""} — вечер свободен\n${nTasks(p.tasks.length)}, ${actualMin} мин. Собери свой вечер:`, appLink("plan", p.botName));
                if (r === "copied")
                    toast("Скопировано — вставь в чат класса", "ok");
            }}><Icon name="share"/>Отправить в чат класса</button>
        {p.onBlitz && blitzToday === 0 && <button class="btn btn-quiet btn-block" onClick={p.onBlitz}><Icon name="bolt"/>Закрепить блицем · 60 секунд</button>}
      </div>);
    }
    else if (afterBed || ph === "night") {
        state = `Ночь · ${toHHMM(now)}`;
        tone = "night";
        hero = <h1 id="tonight-h" class="now-title f-xl mt-2">Пора спать</h1>;
        lead = left.length ? <>Сон в <b class="num">{p.bedtime}</b>. Осталось {nTasks(left.length)} — утром до выхода я покажу, что успеешь.</> : <>Сон в <b class="num">{p.bedtime}</b>. Всё сделано.</>;
        action = (<div class="now-acts l-v l-g1 mt-6">
        {left.length > 0 && activeTask && <button class="btn btn-primary btn-block" onClick={p.onCarryAll}><Icon name="sun"/>Перенести на утро</button>}
        <button class="btn btn-quiet btn-block" onClick={p.onBed ?? p.onSettings}><Icon name="moon"/>Изменить время сна</button>
      </div>);
    }
    else if (ph === "morning") {
        const ul = Math.max(0, p.mp.untilLeave ?? 0);
        state = `Утро · ${toHHMM(now)}`;
        tone = "morning";
        hero = <h1 id="tonight-h" class="now-num f-xl mt-1 num"><span class="sr">До выхода </span>{dur(ul)}</h1>;
        lead = <>до выхода{p.view.first_lesson ? <> · первый урок <b>{sub(p.view.lessons.find((l) => l.status === "active")?.subject ?? "")}</b> в <b class="num">{p.view.first_lesson}</b></> : null}</>;
        if (p.mp.fit.length) {
            const first = p.mp.fit.find((t) => !p.done.includes(t.title));
            action = (<div class="morning mt-4 now-acts l-v l-g1 mt-6">
          <p class="mo-sum f-s f-2">{p.mp.ok ? "Успеешь" : `Успеешь ${p.mp.fit.length} из ${p.mp.fit.length + p.mp.overflow.length}`}: {p.mp.fit.map((t) => <span key={t.title} class="mo-item f-w6">{sub(t.title)} <span class="num faint">{t.planned_minutes} мин</span></span>)}</p>
          {p.mp.overflow.length > 0 && <p class="mo-over f-b f-3 mt-1">Не помещается до выхода — оставил на вечер: {p.mp.overflow.map((t) => sub(t.title)).join(", ")}</p>}
          {first && Object.keys(p.moved).includes(first.title) && <p class="mo-why f-b f-3 mt-1">{p.moved[first.title]}</p>}
          {!p.morningStarted
                    ? <button class="btn btn-primary btn-block" onClick={p.onMorningStart}><Icon name="sun"/>Начать утро</button>
                    : first && <button class="btn btn-primary btn-block" onClick={() => p.onOpenTask(first)}><Icon name="play"/>Продолжить · {sub(first.title)}</button>}
        </div>);
        }
    }
    else if (ph === "school" && ds === "BEFORE_SCHOOL") {
        state = `До уроков · ${toHHMM(now)}`;
        hero = <h1 id="tonight-h" class="now-title f-xl mt-2">{next ? next.subject : "Уроки"}</h1>;
        lead = nl ? <>первый урок через <b class="num">{dur(Math.max(0, nl.starts_in))}</b>, в <span class="num">{nl.start}</span>{nl.room ? <> · {nl.room}</> : null}</> : null;
    }
    else if (ph === "school" && ds === "SCHOOL_ENDING") {
        state = `Последние минуты · ${current?.lesson_number ?? ""}-й урок`;
        tone = "ok";
        hero = <h1 id="tonight-h" class="now-title f-xl mt-2">{current?.subject ?? "Последний урок"}</h1>;
        lead = <>уроки закончатся через <b class="num">{dur(Math.max(0, cl?.ends_in ?? 0))}</b>, в <span class="num">{D.school.last}</span> · дома около <span class="num">{D.school.home}</span></>;
    }
    else if (ph === "school") {
        state = current ? `Сейчас · ${current.lesson_number}-й урок` : "Перемена";
        hero = current
            ? <h1 id="tonight-h" class="now-title f-xl mt-2">{current.subject}</h1>
            : <h1 id="tonight-h" class="now-title f-xl mt-2">{next ? next.subject : "Уроки"}</h1>;
        lead = current
            ? <>ещё <b class="num">{dur(Math.max(0, toMin(current.end_time!) - now))}</b>{next ? <> · дальше {next.subject} в <span class="num">{next.start_time}</span></> : <> · последний урок</>}</>
            : next ? <>через <b class="num">{dur(Math.max(0, toMin(next.start_time!) - now))}</b>, в <span class="num">{next.start_time}</span></> : null;
    }
    else if (ph === "travel") {
        state = "Дорога домой";
        hero = <h1 id="tonight-h" class="now-num f-xl mt-1 num"><span class="sr">Дома в </span>{D.school.home ?? toHHMM(p.times.homeAt!)}</h1>;
        lead = <>будешь дома · через <b class="num">{dur(Math.max(0, p.times.homeAt! - now))}</b>{left.length ? <> · вечером {nTasks(left.length)}</> : null}</>;
    }
    else if (fresh && deficit > 0) {
        state = "Не помещается в вечер";
        tone = "warn";
        hero = <h1 id="tonight-h" class="now-num f-xl mt-1 num">−{dur(deficit)}</h1>;
        const nd = needOf(plan);
        lead = nd
            ? <>нужно <b class="num">{dur(nd.need)}</b> · до сна в <span class="num">{toHHMM(bed)}</span> — <b class="num">{dur(nd.cap)}</b>. Ниже — что можно сделать.</>
            : <>не хватает до сна в <b class="num">{toHHMM(bed)}</b>. Ниже — что можно сделать.</>;
    }
    else if (fresh && finish !== null) {
        state = "Закончишь домашку в";
        hero = <h1 id="tonight-h" class="now-num f-xl mt-1 num" key={finish}><Odometer value={toHHMM(finish)} from={p.start} label={`Закончишь домашку в ${toHHMM(finish)}`}/></h1>;
        const cleanFree = plan?.summary.clean_gamepass_minutes;
        lead = cleanFree !== undefined
            ? <>После домашки — отдых и твои дела. Чистого свободного времени: <b class="num">{dur(cleanFree)}</b>. Сон в <span class="num">{toHHMM(bed)}</span>.</>
            : <>Это конец домашки, не всех дел. Сон в <b class="num">{toHHMM(bed)}</b>; отдых и личные дела учтены в плане ниже.</>;
    }
    else if (tight) {
        state = `Вечер · ${toHHMM(now)}`;
        tone = "warn";
        hero = <h1 id="tonight-h" class="now-title f-xl mt-2">{nTasks(left.length)} <span class="now-dim l-blk f-w6 f-3 num">{dur(totalMin)}</span></h1>;
        const trim = p.rescue?.mode === "tight" ? p.rescue.trims[0] : undefined;
        lead = trim
            ? <>все задания успеешь, если сократить «{trim.title}» до <b class="num">{dur(trim.to)}</b> — сон не трогаем.</>
            : <>до сна не хватает <b class="num">{dur(preview?.deficit_minutes ?? 0)}</b>{needTail(preview)} — план спасения ниже, сон не трогаем.</>;
    }
    else {
        state = ds === "NO_SCHOOL" ? `Выходной · ${toHHMM(now)}` : ds === "UNKNOWN" ? (p.provider?.kind === "real" ? "Дневник не передал время уроков" : "Расписание неизвестно") : ds === "AFTER_SCHOOL" ? `После школы · ${toHHMM(now)}` : left.length ? `Вечер · ${toHHMM(now)}` : "Вечер";
        hero = <h1 id="tonight-h" class="now-title f-xl mt-2">{left.length ? <>{nTasks(left.length)} <span class="now-dim l-blk f-w6 f-3 num">{dur(totalMin)}</span></> : "Заданий нет"}</h1>;
        lead = !left.length ? <>Подключи школьный дневник — домашние задания загрузятся автоматически. Можно также добавить своё задание.</>
            : preview && preview.deficit_minutes > 0 ? <>до сна не хватает <b class="num">{dur(preview.deficit_minutes)}</b>{needTail(preview)} — построй план, покажу варианты.</>
                : <>начнёшь в <b class="num">{effStart}</b> — домашка примерно до <b class="num">{toHHMM(estimate)}</b></>;
    }
    if (!action && ds === "UNKNOWN" && !allDone)
        action = (<div class="now-acts l-v l-g1 mt-6">
      {p.onConnectDiary && <button class="btn btn-primary btn-block" onClick={p.onConnectDiary}><Icon name="book"/>{p.provider?.kind === "real" ? "Проверить подключение дневника" : "Подключить школьный дневник"}</button>}
      {p.onBuildSchedule && <button class="btn btn-ghost btn-block" onClick={p.onBuildSchedule}>Нет подключения — ввести вручную</button>}
      <button class="btn btn-secondary btn-block" onClick={p.onImport}><Icon name="calendar"/>Добавить расписание</button>
    </div>);
    if (!action && schoolSide && ph !== "morning" && left.length && (!plan || p.stale))
        action = (<div class="now-acts l-v l-g1 mt-6">
      <button class={`btn btn-secondary btn-block${p.planBusy ? " is-loading" : ""}`} onClick={p.onBuild} disabled={p.planBusy} aria-busy={p.planBusy}>
        <Icon name="route"/>Построить план дня
      </button>
    </div>);
    if (!action && !allDone && !afterBed && ph !== "night" && !schoolSide) {
        if (left.length === 0)
            action = (<div class="now-acts l-v l-g1 mt-6">
        <button class="btn btn-primary btn-block btn-hero" onClick={p.onAdd}>
          <Icon name="plus"/>Добавить задание
        </button>
      </div>);
        else if ((!plan || p.stale) && !tight)
            action = (<div class="now-acts l-v l-g1 mt-6">
        <button class={`btn btn-primary btn-block btn-hero${p.planBusy ? " is-loading" : ""}`} onClick={p.onBuild} disabled={p.planBusy || left.length === 0} aria-busy={p.planBusy}>
          <Icon name="route"/>Построить план дня
        </button>
        <p class="now-sub f-b f-2 f-tc mt-2">Покажу, когда закончишь домашку</p>
      </div>);
        else if ((!plan || p.stale) && tight)
            action = (<div class="now-acts l-v l-g1 mt-6">
        <button class={`btn btn-quiet btn-block${p.planBusy ? " is-loading" : ""}`} onClick={p.onBuild} disabled={p.planBusy || left.length === 0} aria-busy={p.planBusy}>
          <Icon name="route"/>Построить план как есть
        </button>
      </div>);
        else if (fresh && nextTask)
            action = (<div class="now-acts l-v l-g1 mt-6">
        <button class="btn btn-primary btn-block btn-next" onClick={() => p.onOpenTask(nextTask)}>
          <Icon name={p.session?.title === nextTask.title ? "timer" : "play"}/>
          <span>{p.session?.title === nextTask.title ? "Продолжить" : "Начать"} · {sub(nextTask.title)}</span>
          <span class="btn-meta num">{nextTask.planned_minutes} мин</span>
        </button>
        {drift && !p.planBusy && <button class="btn btn-quiet btn-block" onClick={p.onBuild}><Icon name="clock"/>Перестроить от {p.win.state === "ok" ? p.win.start : ""}</button>}
      </div>);
    }
    // ---------- лента дня: где я в сутках ----------
    const dayFrom = p.times.first ?? toMin(effStart);
    const bedS = bed <= dayFrom ? bed + 1440 : bed;
    const segs: {
        k: string;
        a: number;
        b: number;
    }[] = [];
    if (p.times.first !== null) {
        segs.push({ k: "school", a: p.times.first, b: p.times.last! });
        segs.push({ k: "travel", a: p.times.last!, b: p.times.homeAt! });
    }
    const eveA = Math.max(p.times.homeAt ?? dayFrom, fresh ? toMin(plan!.summary.window_start) : toMin(effStart));
    const eveB = fresh && finish !== null ? Math.min(finish, bedS) : !afterBed && left.length ? Math.min(estimate, bedS) : eveA;
    if (eveB > eveA)
        segs.push({ k: "work", a: eveA, b: eveB });
    if (bedS > Math.max(eveB, eveA))
        segs.push({ k: deficit > 0 || tight ? "short" : "free", a: Math.max(eveB, eveA), b: bedS });
    const report = <button class="dl-add l-h l-inl f-s f-2 b-bare b-tap" onClick={p.onReport}><Icon name="plus"/>Сообщить об изменении</button>;
    // v16: «Первым — X: причина» (приоритет движка: урок завтра → срок → письменное → длиннее)
    const ra = D.recommended_action;
    const firstLine = !allDone && !afterBed && ph !== "night" && !schoolSide && ra.kind === "start_task" && left.length > 1 && !(fresh && nextTask)
        ? <p class="now-first f-b f-2 mt-2"><b>{ra.label}</b>: {D.homework[0] && ra.reason.endsWith(` ${D.homework[0].subject}`) ? ra.reason.slice(0, -D.homework[0].subject.length - 1) : ra.reason}</p> : null;
    // v16: одно предупреждение — самое важное (часы → нет данных → устарело → конфликт → частично)
    const WARN_ORDER = ["clock_mismatch", "tz_invalid", "schedule_missing", "schedule_stale", "schedule_conflict", "schedule_partial"];
    const warn = WARN_ORDER.map((c) => D.warnings.find((w) => w.code === c)).find(Boolean) ?? null;
    const srcMeta = p.provider ? (p.provider.is_demo ? "демо-расписание" : p.provider.name) : "расписание не подключено";
    const eveTitle = fresh ? "План дня" : "Вечер";
    const showPlan = fresh && !afterBed;
    const currentTask = activeTask ?? (fresh ? nextTask : mission?.task ?? nextTask) ?? null;
    // v2: a teacher blitz quiz is answered in its sheet, not with a focus timer
    const quizNext = !activeTask && currentTask?.source === "teacher" && hwInfo(currentTask.title)?.kind === "quiz";
    const load = eveningLoad(left, p.initial.grade);
    const slots = routeSlots(fresh ? plan : preview, p.acts, p.bedtime);
    const stepSlot = currentTask ? slots.find((x) => x.kind === "study" && x.task === currentTask.title) ?? null : null;
    const step = currentTask && !activeTask ? stepOne(currentTask, stepSlot, left) : null;
    if (sel !== p.day.date) return (<section class="screen home plan-other" aria-labelledby="dp-h">
      <DateStrip today={p.day.date} value={sel} onChange={setSel}/>
      <DayPreview date={sel} today={p.day.date} initial={p.initial} acts={p.acts} onToday={() => setSel(p.day.date)}/>
    </section>);
    return (<section class="screen home" aria-labelledby="dashboard-h">
      <Hud tasks={p.tasks} grade={p.initial.grade} name={p.userName} onProfile={p.onProfile} onProgress={p.onProgress} meta={`${dayTitle(p.initial.school_day?.date)} · ${p.initial.grade ?? ""}`} status={p.demo ? "демо" : p.offline ? "офлайн" : p.standalone ? "автономно" : p.aiOnline === false ? "без ИИ" : null}/>
      <DateStrip today={p.day.date} value={sel} onChange={setSel}/>
      {p.hwPill}
      <header class="plan-head"><h2 class="plan-title">План дня{totalMin > 0 ? <> · ~<span class="num">{dur(totalMin)}</span></> : null}</h2>
        <p class="plan-hint">{load.limit === null ? "Время на домашку посчитано по нормативам." : load.limit === 0 ? "В 1 классе домашних заданий нет (СанПиН)." : `Норма СанПиН для ${load.grade} класса — до ${dur(load.limit)} домашки в день${load.level === "over" ? " · сейчас больше нормы" : ""}.`}</p></header>
      {(afterBed || ph === 'night') && !activeTask ? null : currentTask ? <section class={`first-mission focus-teaser${!activeTask && !quizNext && !fresh && mission ? " is-mission" : ""}`} aria-labelledby="mission-title">
        {!activeTask && !quizNext && !fresh && !!mission ? <>
        <div class="teaser-copy"><span class="eyebrow">{activeTask ? 'Сессия в работе' : quizNext ? 'Блиц-опрос от учителя' : 'Шаг 1 — начни с этого'}</span><h2 id="mission-title">{splitTitle(currentTask.title).subject}</h2><p class="f-2">{splitTitle(currentTask.title).detail || 'Один шаг к свободному вечеру'}</p></div>
        <MissionStart minutes={mission!.minutes} onStart={(m) => p.onMission(currentTask, m)} onTutor={p.onTutor}/>
        </> : <>
        {/* V23-N18: при идущей сессии здесь было статичное «10:00», а живой остаток (09:55) — в панели снизу: выглядело как стоящий таймер. Теперь — длина сессии «10 мин»; живое время — в панели и на экране таймера. */}
        <div class="teaser-clock" aria-hidden="true">{activeTask ? <span class="is-plan f-w6">{Math.ceil(p.session!.plannedSec/60)}<small>мин</small></span> : <span class="f-w6">{String(mission?.minutes ?? currentTask.planned_minutes).padStart(2,'0')}:00</span>}</div>
        <div class="teaser-copy"><span class="eyebrow">{activeTask ? 'Сессия в работе' : quizNext ? 'Блиц-опрос от учителя' : 'Шаг 1 — начни с этого'}</span><h2 id="mission-title">{splitTitle(currentTask.title).subject}</h2><p class="f-2">{splitTitle(currentTask.title).detail || 'Один шаг к свободному вечеру'}</p><button type="button" data-action="start-study" class="btn btn-primary" onClick={() => activeTask || quizNext || fresh || !mission ? p.onOpenTask(currentTask) : p.onMission(currentTask, mission?.minutes ?? currentTask.planned_minutes)}><Icon name={activeTask ? 'timer' : quizNext ? 'bolt' : 'play'}/>{activeTask ? 'Вернуться к занятию' : quizNext ? `Пройти опрос · ${currentTask.planned_minutes} мин` : fresh || !mission ? `К заданию · ${currentTask.planned_minutes} мин` : `Начать · ${mission.minutes} мин`}</button></div>
        </>}
        {!activeTask && !quizNext && step && <div class="step-one">{step.range && <p class="step-range num">{step.range}</p>}<p class="step-why">{step.why}</p><ol class="step-list">{step.steps.map((x) => <li key={x}>{x}</li>)}</ol></div>}
        {!activeTask && mission?.partial && !fresh && <p class="mission-note">Начнём с {mission.minutes} минут. Полное задание ≈ {currentTask.planned_minutes} мин.</p>}
      </section> : <section class="dashboard-empty b-card mb-6"><h2>{allDone ? 'Все задания завершены.' : 'Пока нет заданий'}</h2><p class="f-2">{allDone ? 'Ниже можно открыть выполненные задания.' : 'Добавь домашку вручную или подключи дневник.'}</p>{!p.tasks.length && <button class="btn btn-primary" onClick={p.onAdd}>Добавить задание</button>}</section>}
      {!(afterBed || ph === 'night') && <DayRoute slots={slots} done={p.done} now={now} verdictText={verdict(slots, left, p.initial.grade, p.bedtime)} onStart={(t) => { const task = p.tasks.find((x) => x.title === t); if (task) p.onMission(task, Math.min(25, task.planned_minutes)); }}/>}
      {p.onPreset && <LifePresets date={p.day.date} acts={p.acts} bedtime={p.bedtime} onPreset={p.onPreset} onEdit={p.onEditAct} onAdd={p.onAddAct} onBed={p.onBed}/>}
      {(afterBed || ph === 'night') && !activeTask && <section class="night-action b-card mb-6"><h2>Оставим время на сон</h2><p class="f-2">Отбой в {p.bedtime}. {left.length ? `Осталось ${nTasks(left.length)}.` : 'На сегодня заданий нет.'}</p>{left.length > 0 && <button class="btn btn-primary" onClick={p.onCarryAll}>Перенести на утро</button>}</section>}
      <div class="today-overview l-c2 mb-4"><button class="today-count l-v l-g1 l-as b-tile l-rel" onClick={() => left.length ? document.getElementById('agenda-h')?.scrollIntoView({behavior: 'auto', block: 'start'}) : p.onAdd()}><span>{left.length && left.length < p.tasks.length ? 'Осталось сегодня' : 'Сегодня'}</span><strong>{!p.tasks.length ? 'Заданий нет' : left.length ? nTasks(left.length) : 'Всё сделано'}</strong>{!p.tasks.length && <small>Добавить задание</small>}<Icon name="chevron"/></button><button class="today-note l-v l-g1 l-as b-tile l-rel" onClick={p.onSettings}><span>В твоём темпе</span><b>{totalMin > 0 ? `≈ ${dur(totalMin)} работы` : 'Вечер для себя'}</b><small>Сон в {p.bedtime} · изменить</small><Icon name="moon"/></button></div>
      {/* F9 · «шкала победы»: сколько вечера уже пройдено (задания и минуты) и когда свободен */}
      {p.tasks.length > 0 && <VictoryScale done={p.tasks.length - left.length} total={p.tasks.length} doneMin={p.tasks.reduce((s, t) => s + (p.done.includes(t.title) ? t.planned_minutes : 0), 0)}
        leftMin={totalMin} freeAt={allDone || afterBed ? null : fresh && finish !== null && deficit === 0 ? toHHMM(finish) : left.length && !(fresh && deficit > 0) ? toHHMM(estimate) : null}/>}
      {p.offline && <p class="note warn" role="status"><Icon name="info"/><span>Офлайн · показан сохранённый снимок. Подтверждение синхронизации — отдельно.</span></p>}
      {p.tasks.length > 0 && <section class="agenda-workspace mb-6" aria-labelledby="agenda-h"><div class="agenda-heading l-h l-top l-btw mb-3"><div><h2 id="agenda-h">{showPlan ? 'Порядок дня' : 'Ближайшие задачи'}</h2><p class="f-3">{fresh && finish !== null && deficit === 0 ? `По плану — до ${toHHMM(finish)}. Это оценка, не обещание.` : fresh ? 'Времени не хватает: ниже доступны варианты переноса.' : 'Время начала ещё не рассчитано.'}</p></div><button class="quiet-control p-1 l-h l-inl f-b f-a f-nw b-tap l-fix" onClick={p.onAdd} aria-label="Добавить задание"><Icon name="plus"/>Добавить</button></div>
      <EveningAgenda tasks={p.tasks} done={p.done} current={p.session?.title} plan={showPlan ? p.plan : null} onOpen={p.onOpenTask}/>
      <button class="plan-command l-h l-g3 f-2 l-w100" onClick={p.onBuild} disabled={p.planBusy || !left.length} aria-busy={p.planBusy}><Icon name="route"/><span><b>{p.planBusy ? 'Собираю план…' : fresh ? 'Пересчитать порядок и перерывы' : 'Рассчитать вечер с перерывами'}</b><small>С учётом дел и времени сна</small></span><Icon name="chevron"/></button></section>}
      {((p.ahead?.length ?? 0) + (p.tails?.length ?? 0)) > 0 && <AheadList tasks={p.ahead ?? []} tails={p.tails ?? []} onPull={p.onPullAhead}/>}
      {/* V23 BUG-005: «Быстрый доступ» убран — дублировал нижние вкладки и профиль в шапке */}
      <details class="source-workbench b-box mt-4 mb-4"><summary class="f-2"><Icon name="refresh"/><span>Источник данных и синхронизация</span><Icon name="chevron"/></summary>      <SchedChip status={p.schedStatus} at={p.syncedAt} provider={p.provider} onSync={p.onSync} onImport={p.onImport} standalone={p.standalone}/>

      <DataProvenance initial={p.initial}/>
    </details>
      {p.planError && <p class="note bad" role="alert"><Icon name="alert"/><span>{p.planError}</span></p>}
      {p.stale && <p class="note warn" role="status"><Icon name="refresh"/><span>План устарел — собери его заново после изменений.</span></p>}
      {warn && <p class="note warn" role="status"><Icon name={warn.code === "clock_mismatch" ? "clock" : "alert"}/><span>{warn.text}</span></p>}
      {!allDone && !afterBed && p.rescueNode}
      <details class="day-workbench b-box mt-4 mb-4"><summary class="f-2"><Icon name="calendar"/><span><b>План дня подробно</b><small>Расписание, дела, сон и перенос на утро</small></span><Icon name="chevron"/></summary>
      {/* ============ СЕЙЧАС ============ */}
      <header class={`focal${tone ? ` t-${tone}` : ""}`}>
        <p class="now-state l-h f-b f-w6 f-2"><i aria-hidden="true"/>{state}</p>
        {hero}
        {ph === "school" && current && <div class="now-bar mt-4 o-h r-xs u-soft" role="progressbar" aria-label="Урок идёт" aria-valuenow={Math.round(lessonPct * 100)} aria-valuemin={0} aria-valuemax={100}><i style={{ transform: `scaleX(${lessonPct})` }}/></div>}
        {lead && <p class="now-lead f-s f-2 mt-3">{lead}</p>}
        {firstLine}
        {warn && <p class={`now-warn p-2 l-h l-top f-b mt-3 u-warn r-sm w-${warn.code}`} role="status"><Icon name={warn.code === "clock_mismatch" ? "clock" : "alert"}/>{warn.text}</p>}
        {p.head && <div class="now-hint mt-4">{p.head}</div>}
        {prepToday && prep && <LessonPrep prep={prep} date={D.date} onQuizDone={p.onQuizDone} cards={p.cards}/>}
        {p.stale && <p class="stale-note l-h f-b f-warn" role="status"><Icon name="refresh"/>Задания, дела или время изменились — план устарел</p>}
        {action}
        <Ribbon segs={segs} from={dayFrom} to={bedS} now={now} bed={toHHMM(bedS)}/>
      </header>
      {p.onConnectDiary && <button type="button" class="btn btn-secondary btn-block" style="margin:0 0 16px" onClick={p.onConnectDiary}><Icon name="book"/>Подключить реальный дневник СГО</button>}


      {/* ============ ЛИНИЯ ДНЯ ============ */}
      <ol class="dl mt-8 l-rel" aria-label="Линия дня">
        {schoolSide && p.view.lessons.length > 0 && (<li class="sn l-rel sn-school today">
            <div class="sn-h b-tap">
              <span class="sn-t f-b f-w6 f-3"/><span class="sn-node l-center l-g0 f-3 b-round" aria-hidden="true"><Icon name="cap"/></span>
              <div class="sn-hd l-v l-g0 today-h"><h2>Школа</h2><span class="sn-meta l-blk f-b f-3 f-num f-trunc">{activeCount(p.view)} {plural(activeCount(p.view), "урок", "урока", "уроков")} · {srcMeta}</span></div>
            </div>
            <LessonList view={p.view} now={now} live day={D}/>
            <div class="dl-foot">{report}{p.onBuildSchedule && <button class="dl-add l-h l-inl f-s f-2 b-bare b-tap" onClick={p.onBuildSchedule}><Icon name="clock"/>Ввести расписание вручную</button>}<button class="dl-add l-h l-inl f-s f-2 b-bare b-tap" onClick={p.onImport}><Icon name="calendar"/>Импорт расписания</button></div>
          </li>)}
        {schoolSide && p.times.last !== null && (<li class={`sn l-rel sn-travel${ph === "travel" ? " is-now" : now >= p.times.homeAt! ? " is-past" : ""}`}>
            <div class="sn-h b-tap">
              <span class="sn-t f-b f-w6 f-3 num">{toHHMM(p.times.last)}</span><span class="sn-node l-center l-g0 f-3 b-round" aria-hidden="true"><Icon name="bus"/></span>
              <div class="sn-hd l-v l-g0"><h2>Дорога домой</h2><span class="sn-meta l-blk f-b f-3 f-num f-trunc num">{p.travel} мин · дома ~{toHHMM(p.times.homeAt!)}</span></div>
            </div>
          </li>)}
        {!schoolSide && p.view.lessons.length > 0 && p.times.last !== null && (<li class="sn l-rel sn-past">
            <details class="dl-past">
              <summary class="sn-h b-tap">
                <span class="sn-t f-b f-w6 f-3 num">{toHHMM(p.times.homeAt!)}</span><span class="sn-node l-center l-g0 f-3 b-round" aria-hidden="true"><Icon name="home"/></span>
                <span class="sn-hd l-v l-g0"><b>Дома</b><span class="sn-meta l-blk f-b f-3 f-num f-trunc num">школа {p.view.first_lesson}–{toHHMM(p.times.last)} · дорога {p.travel} мин</span></span>
                <Icon name="chevron"/>
              </summary>
              <LessonList view={p.view} now={now} live day={D}/>
            </details>
          </li>)}

        {/* ---------- ВЕЧЕР ---------- */}
        <li class={`sn l-rel sn-evening${!schoolSide ? " is-now" : ""}`}>
          <div class="sn-h b-tap">
            <button class="sn-t f-b f-w6 f-3 num sn-tap b-bare b-tap ctl-time p-1 l-v l-g1 l-as" onClick={p.onSettings} aria-label={`Старт плана ${effStart}, изменить`}>{effStart}</button>
            <span class="sn-node l-center l-g0 f-3 b-round" aria-hidden="true"><Icon name="moon"/></span>
            <div class="sn-hd l-v l-g0"><h2>{eveTitle}</h2>
              <span class="sn-meta l-blk f-b f-3 f-num f-trunc num">{p.tasks.length ? `${p.tasks.length - left.length}/${p.tasks.length} · ${fresh ? `${dur(plan!.summary.total_work_minutes)} работы` : dur(totalMin)}` : "заданий нет"}</span>
            </div>
            {fresh && !afterBed && (<button class={`icon-btn sn-refresh s-44${p.planBusy ? " is-loading" : ""}`} onClick={p.onBuild} disabled={p.planBusy || left.length === 0} aria-label="Пересобрать план" aria-busy={p.planBusy}><Icon name="refresh"/></button>)}
          </div>
          {p.tasks.length > 0 && <div class="sn-prog o-h r-xs u-line" aria-hidden="true"><i style={{ transform: `scaleX(${progress})` }}/></div>}

          {p.planError && <div class="note bad" role="alert"><Icon name="alert"/><div><b>План не собрался.</b> {p.planError}</div></div>}
          {showPlan && !allDone && p.plan?.plan.survival_dropped && <p class="dl-note l-h f-b f-2 warn"><Icon name="alert"/>{p.plan.plan.survival_dropped.message}</p>}
          {showPlan && !allDone && deficit > 0 && (p.rescueNode
            ? <details class="def-more mt-2 mb-4"><summary>Почему не хватает?</summary><DeficitCard r={p.plan!} survival={p.survival} busy={p.planBusy} onSurvival={p.onSurvival} onTriage={p.onTriage}/></details>
            : <DeficitCard r={p.plan!} survival={p.survival} busy={p.planBusy} onSurvival={p.onSurvival} onTriage={p.onTriage}/>)}

          {showPlan
            ? <Timeline log={log} key={`${plan!.summary.window_start}-${finish}-${works.length}`} plan={p.plan!} tasks={p.tasks} done={p.done} onOpen={p.onOpenTask} now={now} session={p.session?.title ?? null} freeAt={finish !== null && deficit === 0 ? toHHMM(finish) : null} fixed={new Set(p.acts.filter((a) => a.fixed && a.startTime).map((a) => a.title))}/>
            : <TaskRows tasks={p.tasks} done={p.done} log={log} session={p.session?.title ?? null} onOpen={p.onOpenTask} mock={p.initial.diary_mode === "mock"}/>}
          {showPlan && p.plan?.ai_reasoning && <p class="why f-b f-3 mt-6"><b class="f-2">Почему так.</b> {p.plan.ai_reasoning}</p>}
          <div class="dl-foot"><button class="dl-add l-h l-inl f-s f-2 b-bare b-tap" onClick={p.onAdd}><Icon name="plus"/>Добавить задание</button></div>

          <Acts acts={p.acts} rests={p.initial.settings.rest_slots} now={now} onAdd={p.onAddAct} onEdit={p.onEditAct} hidePlanned={showPlan} unplaced={fresh ? plan!.summary.unplaced_personal ?? [] : tight && p.rescue ? p.rescue.after.summary.unplaced_personal ?? [] : preview?.summary.unplaced_personal ?? []} trims={!fresh && tight && p.rescue ? p.rescue.trims : []}/>

          {/* v18: «Если начну позже» (R-PLN-09) заменён карточкой «Успею ли?» над линией дня — одна точка для «что если» */}
          {!allDone && <TimeBudget b={D.time_budget} avail={D.available_time}/>}

          {p.cards && p.cards.length > 0 && (<details class="mcards b-card mt-4">
              <summary><Icon name="sun"/>Повтори утром · {p.cards.length} {plural(p.cards.length, "шпаргалка", "шпаргалки", "шпаргалок")}</summary>
              {p.cards.map((c) => (<div class="mcard py-3 l-v" key={c.title}>
                  <b>{sub(c.title)}</b>
                  <ol class="flash">{c.card.points.map((x, i) => <li key={i}><AiAnswer text={x}/></li>)}</ol>
                  <p class="mcard-trap l-h f-b f-warn"><Icon name="alert"/><AiAnswer text={c.card.trap_question} inline/></p>
                  {p.onCardSeen && <button class="btn btn-secondary btn-sm" onClick={() => p.onCardSeen!(c.title)}><Icon name="check"/>Повторил · +5</button>}
                </div>))}
            </details>)}
        </li>

        {/* ---------- СОН ---------- */}
        <li class="sn l-rel sn-sleep">
          <div class="sn-h b-tap">
            <button class="sn-t f-b f-w6 f-3 num sn-tap b-bare b-tap" onClick={p.onBed ?? p.onSettings} aria-label={`Отбой в ${p.bedtime}, изменить время сна`}>{p.bedtime}</button>
            <span class="sn-node l-center l-g0 f-3 b-round" aria-hidden="true"><Icon name="moon"/></span>
            <div class="sn-hd l-v l-g0"><h2>Сон</h2><span class="sn-meta l-blk f-b f-3 f-num f-trunc num">{p.survival ? "режим выживания · " : ""}{dur(sleepSpan(p.bedtime, p.wake))} сна</span></div>
          </div>
          {/* v16.1: у отбоя и подъёма — свои действия (раньше одно «Изменить» рядом с подъёмом открывало отбой) */}
          <div class="sn-times l-c2" role="group" aria-label="Время сна и подъёма">
            <button class="sn-time l-1a l-g1 l-mid b-tile b-tap" onClick={p.onBed ?? p.onSettings}>
              <span class="sn-time-l l-h l-inl l-g1 f-m f-3"><Icon name="moon"/>Отбой </span><b class="num">{p.bedtime} </b><span class="sn-time-a f-m f-a">Изменить<span class="sr"> время отхода ко сну</span></span>
            </button>
            <button class="sn-time l-1a l-g1 l-mid b-tile b-tap" onClick={p.onWake ?? p.onSettings}>
              <span class="sn-time-l l-h l-inl l-g1 f-m f-3"><Icon name="sun"/>Подъём </span><b class="num">{p.wake} </b><span class="sn-time-a f-m f-a">Изменить<span class="sr"> время подъёма</span></span>
            </button>
          </div>
        </li>

        {/* ---------- ЗАВТРА ---------- */}
        {!schoolSide && (<li class="sn l-rel sn-tomorrow today">
            <div class="sn-h b-tap">
              <span class="sn-t f-b f-w6 f-3"/><span class="sn-node l-center l-g0 f-3 b-round" aria-hidden="true"><Icon name="sun"/></span>
              <div class="sn-hd l-v l-g0 today-h"><h2>Завтра · {WD_NAME[p.viewNext.weekday].toLowerCase()}</h2>
                <span class="sn-meta l-blk f-b f-3 f-num f-trunc">{p.viewNext.lessons.length ? `${activeCount(p.viewNext)} ${plural(activeCount(p.viewNext), "урок", "урока", "уроков")} · ${srcMeta}` : srcMeta}</span></div>
            </div>
            {!p.viewNext.available && p.viewNext.lessons.length === 0
                ? <p class="dl-empty f-s f-3">Расписания на завтра нет. Сфотографируй его или продиктуй — я покажу, что понял, прежде чем сохранить.</p>
                : p.viewNext.lessons.length === 0 ? <p class="dl-empty f-s f-3">Уроков нет — выходной.</p>
                    : <LessonList view={p.viewNext} now={now} live={false}/>}
            {prep && prep.date === D.tomorrow.date && <LessonPrep prep={prep} date={D.date} onQuizDone={p.onQuizDone} compact cards={p.cards}/>}
            <div class="dl-foot">{report}{p.onBuildSchedule && <button class="dl-add l-h l-inl f-s f-2 b-bare b-tap" onClick={p.onBuildSchedule}><Icon name="clock"/>Ввести расписание вручную</button>}<button class="dl-add l-h l-inl f-s f-2 b-bare b-tap" onClick={p.onImport}><Icon name="calendar"/>{p.viewNext.available ? "Импорт расписания" : "Добавить расписание"}</button></div>
          </li>)}
      </ol>

      </details>
      <details class="planning-help b-box mt-4 mb-4"><summary class="f-2"><Icon name="bulb"/><span>Помощь с планом</span><Icon name="chevron"/></summary>{p.whatIfNode}<section class="assistant-workspace"><div class="dashboard-section-head l-h l-btw l-g3 mt-6"><h2>Помощник рядом</h2><Icon name="bot"/></div>{p.assistantNode}</section></details>
      <p class="foot-note f-c f-3 mt-4">Время заданий — по нормативной таблице: класс × предмет × объём. Сейчас <span class="num">{toHHMM(now)}</span>.</p>
    </section>);
}
const activeCount = (v: DayView) => v.lessons.filter((l) => l.status === "active").length;
/** Лента суток: школа · дорога · работа · свободно/дефицит до сна + «сейчас». Только transform/width, без анимации по кругу. */
function Ribbon({ segs, from, to, now, bed }: {
    segs: {
        k: string;
        a: number;
        b: number;
    }[];
    from: number;
    to: number;
    now: number;
    bed: string;
}) {
    if (to <= from || !segs.length)
        return null;
    const pct = (m: number) => Math.max(0, Math.min(100, ((m - from) / (to - from)) * 100));
    const label: Record<string, string> = { school: "школа", travel: "дорога", work: "задания", free: "свободно", short: "не хватает" };
    return (<div class="ribbon mt-6" role="img" aria-label={`День: ${segs.map((s) => `${label[s.k]} ${toHHMM(s.a)}–${toHHMM(s.b)}`).join(", ")}; сон в ${bed}`}>
      <div class="rb-track l-rel r-xs u-soft">
        {segs.map((s) => <i key={s.k + s.a} class={`rb-${s.k}`} style={{ left: `${pct(s.a)}%`, width: `${Math.max(0.8, pct(s.b) - pct(s.a))}%` }}/>)}
        {now >= from && now <= to && <b class="rb-now p-abs r-xs" style={{ left: `${pct(now)}%` }}/>}
      </div>
      <div class="rb-scale l-h l-btw l-g0 f-m f-3 mt-2 num" aria-hidden="true"><span>{toHHMM(from)}</span><span>сон {bed}</span></div>
      {/* v16.1: подпись цветов — без неё полоса читалась как «непонятные отрезки» */}
      <ul class="rb-legend l-h l-wrap l-g1 f-m f-3 mt-2" aria-hidden="true">{[...new Set(segs.map((s) => s.k))].map((k) => <li key={k}><i class={`rb-${k}`}/>{label[k]}</li>)}</ul>
    </div>);
}
/** Уроки как часть дня: ГОТОВО (тихо) · СЕЙЧАС (акцент) · ДАЛЬШЕ · ПОЗЖЕ. Изменения — с источником. */
function LessonList({ view, now, live, day }: {
    view: DayView;
    now: number;
    live: boolean;
    day?: DayOut;
}) {
    const cn = live ? day?.current_lesson?.n ?? null : null, nn = live ? day?.next_lesson?.n ?? null : null;
    const current = cn !== null ? { lesson_number: cn } : null, next = nn !== null ? { lesson_number: nn } : null;
    return (<ol class="ls-strip" aria-label="Уроки">
      {view.lessons.map((l) => {
            const off = l.status !== "active";
            const chg = l.source !== "real" && l.source !== "demo";
            const on = !off && current?.lesson_number === l.lesson_number;
            const nx = !off && !current && next?.lesson_number === l.lesson_number;
            const past = live && !off && !!l.end_time && toMin(l.end_time) <= now;
            return (<li key={`${l.lesson_number}-${l.subject}`} class={`ls dl-row b-tap${off ? " off" : ""}${chg ? " chg" : ""}${on ? " now" : ""}${nx ? " next" : ""}${past ? " past" : ""}`} aria-current={on ? "true" : undefined}>
            <span class="dl-t l-h l-je l-g0 f-b f-w6 f-3 num">{l.start_time ?? "—"}</span>
            <span class="dl-dot b-round" aria-hidden="true"/>
            <span class="dl-body py-2 l-v l-g0">
              <b>{off ? <s>{l.subject}</s> : l.subject}{on && <em class="ls-tag f-m f-w6 f-a">сейчас</em>}{nx && <em class="ls-tag f-m f-w6 f-a soft">дальше</em>}</b>
              {(l.room || l.was || l.note || chg || off) && (<span class="dl-sub f-b f-3 f-trunc">
                  {[off ? "отменён" : null, l.was && !off ? `вместо ${l.was}` : null, l.room].filter(Boolean).join(" · ")}
                  {chg && <span class="ls-src f-warn"> · изменено: {SOURCE_LABEL[l.source].toLowerCase()}</span>}
                  {l.note && <span class="ls-note"> · {l.note}</span>}
                </span>)}
              {past && <span class="sr">, прошёл</span>}
              {on && <span class="sr">, идёт сейчас</span>}
            </span>
          </li>);
        })}
    </ol>);
}
const WD_DUE = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
/** v3.2 · к какому дню задание: в общем плане дня собраны ДЗ со всех дней — срок виден в строке. */
function dueLabel(d?: string | null): string | null {
  if (!d) return null;
  const today = schoolDay();
  if (d < today) return "срок прошёл";
  if (d === today) return "на сегодня";
  if (d === schoolDay(undefined, 1)) return "к завтра";
  return `к ${WD_DUE[new Date(d + "T12:00:00").getDay()]}, ${d.slice(8, 10)}.${d.slice(5, 7)}`;
}
/** Задания до сборки плана: строка = кнопка, цвет предмета — только точка на оси. */
function TaskRows({ tasks, done, log, session, onOpen, mock }: {
    tasks: Task[];
    done: string[];
    log: Record<string, {
        actualMin?: number | null;
    }>;
    session: string | null;
    onOpen: (t: Task) => void;
    mock: boolean;
}) {
    useHw();   // v2: «Новое» на заданиях учителя гаснет, когда ученик их открыл
    if (!tasks.length)
        return <p class="dl-empty f-s f-3">Заданий нет — {mock ? "демо-дневник пуст" : "дневник пуст"}. Перешли домашку боту или добавь вручную.</p>;
    return (<ul class="task-list" aria-label="Задания">
      {tasks.map((t, i) => {
            const { subject, detail } = splitTitle(t.title);
            const isDone = done.includes(t.title);
            const live = !isDone && session === t.title;
            const fact = isDone ? log[t.title]?.actualMin ?? null : null;
            const hwi = t.source === "teacher" ? hwInfo(t.title) : null, fresh = !!hwi && isHwNew(hwi);
            return (<li key={t.title} class={`dl-row b-tap tk${isDone ? " done" : ""}${live ? " live" : ""}`} style={{ "--c": subjectColor(t.title), "--i": i }}>
            <span class="dl-t l-h l-je l-g0 f-b f-w6 f-3 num">{isDone ? <Icon name="check"/> : <>{t.planned_minutes}<small class="dl-unit"> мин</small></>}</span>
            <span class="dl-dot b-round" aria-hidden="true"/>
            <button class="dl-body py-2 l-v l-g0 dl-tap l-jc b-tap" onClick={() => onOpen(t)}>
              <b>{subject}{t.source === "bot" && <span class="src-bot f-c f-w6"> · из чата</span>}{t.source === "morning" && <span class="src-bot f-c f-w6"> · с утра</span>}{t.source === "teacher" && <span class="src-bot f-c f-w6 src-teacher f-a"> · {hwi?.kind === "quiz" ? "блиц-опрос от учителя" : "от учителя"}</span>}{fresh && <span class="hw-fresh f-c f-w6 b-pill u-acc">Новое</span>}</b>
              <span class="dl-sub f-b f-3 f-trunc">{dueLabel(t.deadline) && <span class="dl-due">{dueLabel(t.deadline)} · </span>}{detail || (t.type === "oral" ? "устное" : "письменное")}{fact != null ? ` · факт ${fact} мин` : ""}</span>
              <span class="sr">{t.planned_minutes} минут{isDone ? ", выполнено" : ""}</span>
            </button>
            <span class="dl-side l-h l-g1 f-b f-3 num" aria-hidden="true">{live ? <span class="tag live"><Icon name="timer"/>в работе</span> : isDone ? <span class="reward l-h l-inl l-g1 f-m f-w6 f-warn got">+{t.type === "oral" ? 15 : 10} очков</span> : <span class="reward l-h l-inl l-g1 f-m f-w6 f-warn" title="Очки за выполнение">+{t.type === "oral" ? 15 : 10} очков</span>}</span>
          </li>);
        })}
    </ul>);
}
/** Мои дела — тихие строки на той же оси. После сборки плана дела уже стоят в маршруте — здесь только управление. */
function Acts({ acts, rests, unplaced, trims = [], now, onAdd, onEdit, hidePlanned }: {
    acts: DayActivity[];
    rests: RestSlot[];
    unplaced: string[];
    trims?: Rescue["trims"];
    now: number;
    onAdd: () => void;
    onEdit: (a: DayActivity) => void;
    hidePlanned: boolean;
}) {
    const sorted = [...acts].sort((a, b) => (a.startTime ? toMin(a.startTime) : 9999) - (b.startTime ? toMin(b.startTime) : 9999));
    return (<div class="acts mt-1">
    <details class="acts-d" open={!hidePlanned || unplaced.length > 0}>
      <summary class="acts-sum f-s f-2 b-tap"><span>Мои дела</span><span class="faint num">{sorted.length + rests.length}{unplaced.length ? ` · не влезло ${unplaced.length}` : ""}</span><Icon name="chevron"/></summary>
      <ul class="acts-list">
        {sorted.map((a) => {
            const end = a.startTime ? toHHMM(toMin(a.startTime) + a.durationMinutes) : null;
            const past = a.fixed && !!end && toMin(end) <= now;
            const miss = unplaced.includes(a.title);
            const cut = trims.find((x) => x.title === a.title);
            return (<li key={a.id} class={`dl-row b-tap act${past ? " past" : ""}${miss ? " miss" : ""}`}>
              <span class="dl-t l-h l-je l-g0 f-b f-w6 f-3 num">{a.fixed && a.startTime ? a.startTime : ""}</span>
              <span class="dl-dot b-round sq" aria-hidden="true"><Icon name={kindOf(a.type).icon}/></span>
              <button class="dl-body py-2 l-v l-g0 dl-tap l-jc b-tap" onClick={() => onEdit(a)}>
                <b>{a.title}</b>
                <span class="dl-sub f-b f-3 f-trunc num">{a.fixed && a.startTime ? `${a.startTime}–${end}` : "когда удобно"} · {dur(a.durationMinutes)}{past ? " · прошло" : ""}</span>
                <span class="sr">. Изменить</span>
              </button>
              <span class="dl-side l-h l-g1 f-b f-3">{miss ? <span class="tag bad">не влезло</span> : cut ? <span class="tag warn">{dur(cut.to)} вместо {dur(cut.from)}</span> : <span class="faint">{a.fixed ? "ко времени" : "гибко"}</span>}</span>
            </li>);
        })}
        {rests.map((r) => (<li key={`r-${r.label}`} class="dl-row b-tap act fixed">
            <span class="dl-t l-h l-je l-g0 f-b f-w6 f-3 num">{r.start}</span><span class="dl-dot b-round sq" aria-hidden="true"><Icon name="clock"/></span>
            <span class="dl-body py-2 l-v l-g0"><b>{r.label || "Отдых"}</b><span class="dl-sub f-b f-3 f-trunc num">{r.start}–{r.end} · из настроек</span></span>
            <span class="dl-side l-h l-g1 f-b f-3 faint"><Icon name="lock"/></span>
          </li>))}
      </ul>
    </details>
    <div class="dl-foot"><button class="dl-add l-h l-inl f-s f-2 b-bare b-tap" onClick={onAdd}><Icon name="plus"/>Добавить дело</button></div>
    </div>);
}
/** Маршрут вечера: сегменты одного задания (1/3, 2/3 + перерывы) — ОДНА остановка с «пипсами» блоков.
 *  Паттерн 21st.dev «Timeline» (kuratlielia: тихая ось, вставка с анимацией) — на нашей оси дня. */
type Stop = {
    kind: "work";
    label: string;
    start: string;
    end: string;
    parts: number;
    work: number;
} | {
    kind: "other";
    k: string;
    label: string;
    start: string;
    end: string;
    seg?: string | null;
};
function toStops(plan: CalculateResponse): Stop[] {
    const out: Stop[] = [];
    for (const x of plan.plan.plan) {
        const last = out[out.length - 1];
        if (x.kind === "break")
            continue;
        if (x.kind === "work") {
            if (last && last.kind === "work" && last.label === x.label) {
                last.end = x.end;
                last.parts += 1;
                last.work += toMin(x.end) - toMin(x.start);
                continue;
            }
            out.push({ kind: "work", label: x.label, start: x.start, end: x.end, parts: 1, work: toMin(x.end) - toMin(x.start) });
        }
        else
            out.push({ kind: "other", k: x.kind, label: x.label, start: x.start, end: x.end, seg: x.segment });
    }
    return out;
}
/** F9 · Шкала победы над вечером: доля выполненной нагрузки (по плановым минутам), шаги и «свободен в». Без градиентов. */
export function VictoryScale({ done, total, doneMin, leftMin, freeAt }: { done: number; total: number; doneMin: number; leftMin: number; freeAt: string | null }) {
    const all = doneMin + leftMin;
    const pct = all > 0 ? Math.round((100 * doneMin) / all) : done >= total ? 100 : 0;
    const win = total > 0 && done >= total;
    return <section class={`win-scale l-v b-card mb-4${win ? " is-win" : ""}`} aria-label="Шкала победы над вечером">
      <div class="win-scale-head l-h l-base l-btw l-wrap"><b>{win ? "Победа: всё сделано" : `Сделано ${done} из ${total}`}</b><span class="num f-2">{doneMin} из {all} мин</span></div>
      <div class="win-scale-bar b-box b-nob o-h" role="progressbar" aria-label={`Вечер пройден на ${pct}%`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><i style={{ transform: `scaleX(${pct / 100})`, ...(win ? { background: "var(--ok)" } : {}) }}/></div>
      {!win && freeAt && <p class="win-scale-free f-b">Свободен в <b class="num">{freeAt}</b></p>}
    </section>;
}

function Timeline({ plan, tasks, done, onOpen, fixed, now, session, freeAt, log }: {
    log: Record<string, {
        actualMin?: number | null;
    }>;
    plan: CalculateResponse;
    tasks: Task[];
    done: string[];
    onOpen: (t: Task) => void;
    fixed: Set<string>;
    now: number;
    session: string | null;
    freeAt: string | null;
}) {
    const stops = toStops(plan);
    let lastW = -1;
    stops.forEach((x, k) => {
        if (x.kind === "work")
            lastW = k;
    });
    const free = freeAt && <li key="free" class="dl-row b-tap dl-free"><span class="dl-t l-h l-je l-g0 f-b f-w6 f-3 num">{freeAt}</span><span class="dl-dot b-round" aria-hidden="true"/><span class="dl-body py-2 l-v l-g0"><b>Свободен</b><span class="dl-sub f-b f-3 f-trunc">дальше вечер твой</span></span></li>;
    const nextI = stops.findIndex((x) => x.kind === "work" && !done.includes(x.label) && toMin(x.end) > now);
    return (<ol class="route" aria-label="План дня">
      {stops.flatMap((x, i) => {
            const tail = i === lastW && free ? [free] : [];
            if (x.kind === "other")
                return [(<li key={i} class={`dl-row b-tap rt-other k-${x.k}${x.k === "personal" && fixed.has(x.label) ? " is-fixed" : ""}`} style={{ "--i": i }}>
            <span class="dl-t l-h l-je l-g0 f-b f-w6 f-3 num">{x.start}</span><span class="dl-dot b-round" aria-hidden="true"/>
            <span class="dl-body py-2 l-v l-g0"><b>{x.label}{x.seg ? <span class="faint num"> · часть {x.seg}</span> : null}</b><span class="dl-sub f-b f-3 f-trunc num">до {x.end}{x.k === "personal" && fixed.has(x.label) ? " · ко времени" : ""}</span></span>
          </li>), ...tail];
            const task = tasks.find((t) => t.title === x.label);
            const isDone = done.includes(x.label);
            const { subject, detail } = splitTitle(x.label);
            const live = session === x.label && !isDone;
            return [(<li key={i} class={`dl-row b-tap rt-stop${isDone ? " done" : ""}${i === nextI ? " next" : ""}${live ? " live" : ""}`} style={{ "--i": i, "--c": subjectColor(x.label) }}>
            <span class="dl-t l-h l-je l-g0 f-b f-w6 f-3 num">{isDone ? <Icon name="check"/> : x.start}</span>
            <span class="dl-dot b-round" aria-hidden="true"/>
            <button class="dl-body py-2 l-v l-g0 dl-tap l-jc b-tap rt-body" onClick={() => task && onOpen(task)} disabled={!task}>
              <span class="sr">{x.start}–{x.end}: </span>
              <b class="rt-title">{subject}{i === nextI && !live && <em class="ls-tag f-m f-w6 f-a">дальше</em>}{live && <em class="ls-tag f-m f-w6 f-a">в работе</em>}</b>
              <span class="dl-sub f-b f-3 f-trunc num">
                {x.parts > 1 && <span class="pips" aria-hidden="true">{Array.from({ length: x.parts }, (_, k) => <i key={k}/>)}</span>}
                {isDone && log[x.label]?.actualMin != null ? `факт ${log[x.label]!.actualMin} мин` : <>{dur(x.work)}{x.parts > 1 ? ` · ${x.parts} ${plural(x.parts, "блок", "блока", "блоков")}` : ""} · до {x.end}</>}{detail ? ` · ${detail}` : ""}
              </span>
              {isDone && <span class="sr">, выполнено</span>}
            </button>
          </li>), ...tail];
        })}
    </ol>);
}
// ============================ v16 ============================
/**
 * Подготовка к уроку (v16.1): одно реалистичное действие под время до звонка (lib/prep.prepOffer):
 * мини-квиз 3–5 вопросов, который успевает закончиться до урока, или шпаргалка / домашнее / тетрадь.
 * Тему не выдумываем; вопросы банка честно помечены как практика по предмету. В фокус-точке
 * предмет и время уже в герое — здесь их не повторяем. «Позже» — скрыть до смены урока.
 */
function LessonPrep({ prep, date, onQuizDone, compact, cards }: {
    prep: NonNullable<DayOut["lesson_prep"]>;
    date: string;
    onQuizDone: (ok: number, n: number) => void;
    compact?: boolean;
    cards?: MorningCard[];
}) {
    const key = nsKey(`sf.prep.skip.${prep.date}.${prep.n}`);
    const [skip, setSkip] = useState(() => {
        try {
            return sessionStorage.getItem(key) === "1";
        }
        catch {
            return false;
        }
    });
    const [quiz, setQuiz] = useState<number | null>(null);
    const [showCard, setShowCard] = useState(false);
    if (skip || !prep.subject)
        return null;
    const topic = topicFor(prep.subject);
    const card = (cards ?? []).find((c) => (!!topic && topicFor(c.title)?.key === topic.key) || splitTitle(c.title).subject.toLowerCase() === prep.subject!.toLowerCase()) ?? null;
    const isToday = prep.date === date;
    const offer = prepOffer({ subject: prep.subject, topic: prep.topic, topicSource: prep.topic_source, startsIn: isToday ? prep.starts_in : null,
        hasBank: !!topic, card: card?.title ?? null, relatedTasks: prep.related_tasks });
    const when = isToday ? (prep.starts_in !== null ? `через ${dur(Math.max(0, prep.starts_in))}, в ${prep.start}` : `в ${prep.start}`) : `завтра ${prep.n ?? 1}-м уроком в ${prep.start}`;
    const later = () => {
        setSkip(true);
        try {
            sessionStorage.setItem(key, "1");
        }
        catch { /* приватный режим */ }
    };
    return (<section class={`prep b-card mt-4${compact ? " compact" : ""}`} aria-label={`Подготовка к уроку: ${prep.subject}`}>
      <div class="prep-top l-h l-btw">
        <p class="prep-eye f-m f-3">{offer.kind === "quiz" ? `Подготовка · ≈ ${offer.minutes} мин` : "Подготовка · 1 минута"}</p>
        {quiz === null && <button class="link prep-later f-b f-2 b-tap mw-44" onClick={later}>Позже</button>}
      </div>
      {compact && <p class="prep-h f-s mt-1"><b>{prep.subject}</b> <span class="num faint">{when}</span></p>}
      <p class="prep-why f-s mt-1">{offer.why}</p>
      <p class={`prep-topic f-b f-2 mt-1 src-${prep.topic_source}`}>{offer.topicLine}{offer.kind === "quiz" && offer.practiceNote ? <> <span class="prep-note f-3">{offer.practiceNote}</span></> : null}</p>
      {quiz !== null && topic
            ? <MiniQuiz topic={topic} date={date} count={quiz} onDone={onQuizDone} onClose={() => setQuiz(null)}/>
            : <>
            {offer.kind !== "quiz" && <p class="prep-advice f-b mt-2">{offer.advice}</p>}
            {showCard && card && (<div class="prep-card f-b b-tile b-nob mt-3" role="region" aria-label={`Шпаргалка: ${card.title}`}>
                <ul>{card.card.points.slice(0, 5).map((x, k) => <li key={k}><AiAnswer text={x}/></li>)}</ul>
                {card.card.trap_question && <p class="faint">Проверь себя: <AiAnswer text={card.card.trap_question} inline/></p>}
              </div>)}
            {(offer.kind === "quiz" || card) && (<div class="prep-acts l-h l-wrap mt-3">
                {offer.kind === "quiz" && <button class="btn btn-secondary btn-sm" onClick={() => setQuiz(offer.questions)}><Icon name="bolt"/>Мини-квиз · {offer.questions} {questionsWord(offer.questions)}</button>}
                {card && (offer.kind === "card" || offer.alsoCard) && <button class="btn btn-secondary btn-sm" aria-expanded={showCard} onClick={() => setShowCard((v) => !v)}><Icon name="sun"/>{showCard ? "Скрыть шпаргалку" : "Шпаргалка"}</button>}
              </div>)}
          </>}
    </section>);
}
const ST_TEXT: Record<string, string> = {
    fresh: "Синхронизировано", stale: "Устарело", partial: "Частично", conflict: "Конфликт в расписании", imported: "Импорт",
    demo: "Демо-расписание", unavailable: "Источник недоступен", none: "Нет данных о расписании", updating: "Обновляю расписание…",
};
const hm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
/** Статус расписания одной строкой: «Синхронизировано 07:12» / «Устарело · 2 дн.» / «Демо» / «Нет данных». */
function SchedChip({ status, at, provider, onSync, onImport }: {
    status: string;
    at: {
        phone: number | null;
        source: string | null;
    };
    provider: Provider | null;
    onSync: () => void;
    onImport: () => void;
    standalone: boolean;
}) {
    const ts = at.source ? new Date(at.source) : at.phone ? new Date(at.phone) : null;
    const ok = ts && !isNaN(ts.getTime());
    const sameDay = ok && ts!.toDateString() === new Date().toDateString();
    const when = ok ? (sameDay ? hm(ts!) : `${String(ts!.getDate()).padStart(2, "0")}.${String(ts!.getMonth() + 1).padStart(2, "0")} ${hm(ts!)}`) : "";
    const tone = status === "fresh" || status === "imported" ? "ok" : status === "demo" || status === "updating" ? "info" : "warn";
    const txt = ST_TEXT[status] ?? status;
    const showWhen = ["fresh", "stale", "imported", "partial", "conflict", "unavailable"].includes(status) && when;
    return (<div class={`sched-st l-h l-wrap f-m f-2 mt-1 mb-3 s-${tone}`} role="status" aria-live="polite">
      <i aria-hidden="true" style={{ background: `var(--${tone === "info" ? "ember" : tone})` }}/><span>{txt}{showWhen ? <span class="num"> {status === "fresh" || status === "imported" ? "" : "· "}{when}</span> : null}</span>
      {provider?.feed_configured && status !== "updating" && <button class="link" onClick={onSync}>Обновить</button>}
      {(status === "none" || status === "unavailable") && <button class="link" onClick={onImport}>Добавить</button>}
    </div>);
}
/** R-PLN-10 «Куда уходит время»: школа · дорога · уроки дома · свободно — из day.time_budget. */
function TimeBudget({ b, avail }: {
    b: DayOut["time_budget"];
    avail: DayOut["available_time"];
}) {
    const parts = [{ k: "school", l: "Школа", v: b.school }, { k: "travel", l: "Дорога", v: b.travel }, { k: "work", l: "Уроки дома", v: b.homework }, { k: "free", l: "Свободно", v: b.free }].filter((x) => x.v > 0);
    if (!parts.length)
        return null;
    return (<details class="tbud mt-3">
      <summary class="f-2"><Icon name="chart"/>Куда уходит время<Icon name="chevron"/></summary>
      <div class="tb-bar l-h l-g1 mt-1 mb-3 o-h r-sm" role="img" aria-label={parts.map((x) => `${x.l} ${dur(x.v)}`).join(", ")}>{parts.map((x) => <i key={x.k} class={`tb-${x.k}`} style={{ flexGrow: x.v }}/>)}</div>
      <dl class="tb-dl l-v l-g1 f-b">{parts.map((x) => <div key={x.k}><dt><i class={`tb-${x.k}`} aria-hidden="true"/>{x.l}</dt><dd class="num">{dur(x.v)}</dd></div>)}
        <div><dt>До сна · {avail.from}–{avail.to}</dt><dd class="num">{dur(avail.minutes)}</dd></div></dl>
    </details>);
}
