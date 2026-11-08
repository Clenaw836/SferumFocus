/**
 * Школьный помощник — НЕ чат, а слой действий поверх плана. Знает состояние дня (время, уроки,
 * дорогу, дела, задания, сон, перенесённое, изменения расписания, режим) и:
 *  • отвечает на событие ученика одним коротким ответом + одной причиной («почему»);
 *  • спрашивает только недостающий параметр (быстрые варианты, а не форма);
 *  • важное (расписание, дела) — только ПОНЯЛ → ПРЕДПРОСМОТР → ПОДТВЕРДИ → ПРИМЕНИ;
 *  • сам показывает не больше одной полезной подсказки (hint).
 * Модуль чистый: решения считаются из Ctx, действия выполняет main.tsx.
 */
import type { DayOut } from "./dayEngine";
import { parseIntent, parseTime, sameSubject, subjectOf, type ActType, type ParsedActivity } from "./nlu";
import { describe, WD_ACC, weekdayOf, type Lesson, type ScheduleChange } from "./schedule";
import { lessonNow, type Phase, type SchoolTimes } from "./daycycle";
import type { Mode, Rescue } from "./survival";
import type { SfEvent } from "./events";
import { accusative, splitTitle } from "./subjects";
import { dur, plural, toHHMM, toMin } from "./time";
import type { DayActivity, PlanOut, Task } from "./types";

export interface Ctx {
  now: number; today: string; tomorrow: string; phase: Phase; times: SchoolTimes; timesTomorrow: SchoolTimes;
  travel: number; wake: string; prep: number;
  lessonsToday: Lesson[]; lessonsTomorrow: Lesson[];
  tasks: Task[]; done: string[]; left: Task[]; morning: Task[]; tomorrowTasks: Task[];
  acts: DayActivity[]; actsTomorrow: DayActivity[];
  bed: { today: string | null; usual: string; recommended: string; effective: string };
  start: string; plan: PlanOut | null; rescue: Rescue | null; mode: Mode;
  movedToday: Record<string, string>; movedTomorrow: Record<string, string>;
  doneYesterday: string[]; events: SfEvent[]; unseen: ScheduleChange[]; changes: ScheduleChange[];
  scheduleConf: number;
  /** v16: единый расчёт дня (lib/dayEngine) — ассистент говорит то же, что экран */
  day?: DayOut;
}
export interface ActDraftX { type: ActType; title: string; date: string; startTime: string | null; duration: number; fixed: boolean }
export type Act =
  | { do: "start"; title: string } | { do: "openPlan" } | { do: "rescue" } | { do: "tired" }
  | { do: "lateBy"; minutes: number } | { do: "homeAt"; time: string } | { do: "pickTime"; for: "home" | "act"; draft?: ActDraftX }
  | { do: "markDone"; title: string } | { do: "keepMorning"; title: string } | { do: "doNow"; title: string }
  | { do: "addAct"; draft: ActDraftX } | { do: "actTime"; draft: ActDraftX; time: string } | { do: "editAct"; draft: ActDraftX }
  | { do: "removeAct"; id: string } | { do: "bed"; time: string; scope: "today" | "usual" } | { do: "openBed" }
  | { do: "evidence"; text: string } | { do: "homework"; text: string } | { do: "say"; text: string } | { do: "voice" }
  | { do: "ack"; ids: string[] } | { do: "carryAll" } | { do: "dismiss" } | { do: "tutor" } | { do: "bedDrift"; yes: boolean };
export interface Chip { label: string; act: Act; primary?: boolean }
export interface Reply { id: string; lines: string[]; strong?: string; why?: string; chips?: Chip[]; tone?: "ok" | "warn" | "info"; icon?: string; heard?: string }

let seq = 0;
const R = (r: Omit<Reply, "id">): Reply => ({ id: `r${++seq}`, ...r });
const subj = (t: string) => splitTitle(t).subject;
const hh = toHHMM;
const KIND_GEN: Record<string, string> = { "Тренировка": "тренировки", "Футбол": "футбола", "Репетитор": "репетитора", "Кружок": "кружка", "Встреча": "встречи", "Бассейн": "бассейна", "Танцы": "танцев", "Хоккей": "хоккея" };
const gen = (t: string) => KIND_GEN[t] ?? `«${t}»`;
const KIND_Q: Record<string, string> = { sport: "тренировка", tutor: "репетитор", club: "кружок", meet: "встреча", misc: "это", road: "выезжаешь", games: "играешь", other: "это" };
const ICON: Record<string, string> = { sport: "dumbbell", tutor: "user", club: "palette", games: "gamepad", meet: "users", road: "bus", misc: "pin", other: "dots" };
const DEF_DUR: Record<string, number> = { sport: 90, tutor: 60, club: 60, games: 60, meet: 60, road: 30, misc: 30, other: 30 };
const dayWord = (c: Ctx, date: string) => (date === c.today ? "Сегодня" : date === c.tomorrow ? "Завтра" : `В ${WD_ACC[weekdayOf(date)]}`);
const roundUp30 = (m: number) => Math.ceil(m / 30) * 30;

/** Ближайшее обязательное дело сегодня после «сейчас». */
function nextFixed(c: Ctx): DayActivity | null {
  return c.acts.filter((a) => a.fixed && a.startTime && toMin(a.startTime) > c.now).sort((a, b) => toMin(a.startTime!) - toMin(b.startTime!))[0] ?? null;
}
/** Что делать следующим вечером: задание, которое успеешь до ближайшего обязательного дела. */
export function pickTask(c: Ctx): { task: Task | null; why: string | null; gap: number | null; act: DayActivity | null } {
  const pool = c.left.filter((t) => !c.morning.some((m) => m.title === t.title));
  if (!pool.length) return { task: null, why: null, gap: null, act: null };
  const act = nextFixed(c);
  const gap = act ? toMin(act.startTime!) - c.now : null;
  if (gap !== null && gap > 10) {
    const fits = pool.filter((t) => t.planned_minutes <= gap - 5).sort((a, b) => b.planned_minutes - a.planned_minutes);
    if (fits[0]) return { task: fits[0], why: `успеешь до ${gen(act!.title)}: ${fits[0].planned_minutes} мин из ${gap}`, gap, act };
  }
  const work = c.plan?.plan.find((e) => e.kind === "work" && e.task && !c.done.includes(e.task) && toMin(e.end) > c.now);
  const t = (work && pool.find((x) => x.title === work.task)) ?? [...pool].sort((a, b) => (a.type === "written" ? 0 : 1) - (b.type === "written" ? 0 : 1) || b.planned_minutes - a.planned_minutes)[0];
  return { task: t, why: t.type === "written" ? "письменное — пока свежая голова" : null, gap, act };
}

export function whatNow(c: Ctx): Reply {
  const lines: string[] = [`Сейчас ${hh(c.now)}.`];
  if (c.day?.day_state === "UNKNOWN") lines.push("Расписания на сегодня нет — поэтому не угадываю, в школе ты или дома.");
  if (c.phase === "school") {
    if (c.day) {
      const cl = c.day.current_lesson, nl = c.day.next_lesson;
      if (c.day.day_state === "BEFORE_SCHOOL" && nl) lines.push(`Первый урок — ${nl.subject} в ${nl.start}.`);
      else if (cl) lines.push(`${c.day.day_state === "SCHOOL_ENDING" ? "Последние минуты: " : "Идёт "}${cl.n}-й урок — ${cl.subject}, до ${cl.end}.`);
      else if (nl) lines.push(`Перемена. Дальше: ${nl.subject} в ${nl.start}.`);
      if (cl && nl) lines.push(`Дальше: ${nl.subject} в ${nl.start}.`);
    } else {
      const { current, next } = lessonNow(c.lessonsToday, c.now);
      if (current) lines.push(`Идёт ${current.lesson_number}-й урок — ${current.subject}, до ${current.end_time}.`);
      if (next) lines.push(`Дальше: ${next.subject} в ${next.start_time}.`);
    }
    lines.push(`Уроки до ${hh(c.times.last!)}, дома около ${hh(c.times.homeAt!)}.`);
    return R({ icon: "cap", lines, chips: [{ label: "Что задали на вечер", act: { do: "openPlan" } }] });
  }
  if (c.phase === "morning") {
    if (c.morning.length) {
      const t = c.morning[0];
      lines.push(`До выхода ${dur(c.times.leave! - c.now)}. Сначала ${subj(t.title)} — ${t.planned_minutes} мин.`);
      return R({ icon: "sun", lines, why: c.movedToday[t.title] ?? "перенесено с вечера", chips: [{ label: "Начать", act: { do: "start", title: t.title }, primary: true }] });
    }
    lines.push(`До выхода ${dur(Math.max(0, c.times.leave! - c.now))}. Заданий на утро нет — спокойно собирайся.`);
    return R({ icon: "sun", lines });
  }
  if (c.phase === "night") {
    lines.push(c.left.length ? `Пора спать — сон в ${c.bed.effective}. Осталось ${c.left.length} ${plural(c.left.length, "задание", "задания", "заданий")}.` : "Пора спать. Всё сделано.");
    return R({ icon: "moon", lines, chips: c.left.length ? [{ label: "Перенести на утро", act: { do: "carryAll" }, primary: true }] : [] });
  }
  if (c.phase === "travel") lines.push(`Ты в дороге — дома около ${hh(c.times.homeAt!)}.`);
  const p = pickTask(c);
  if (!p.task) { lines.push(c.left.length ? "Остались только утренние задания — вечер свободен." : "Всё сделано — вечер твой."); return R({ icon: "check", lines, tone: "ok" }); }
  if (p.act && p.gap !== null) lines.push(`До ${gen(p.act.title)} ${dur(p.gap)}.`);
  lines.push(`Лучше сделать ${accusative(subj(p.task.title).toLowerCase())} — ${p.task.planned_minutes} мин.`);
  return R({ icon: "play", lines, why: p.why ?? undefined, chips: [{ label: "Начать", act: { do: "start", title: p.task.title }, primary: true }] });
}

export function whatTomorrow(c: Ctx): Reply {
  const a = c.lessonsTomorrow.filter((l) => l.status === "active");
  if (!a.length) return R({ icon: "calendar", lines: ["Завтра уроков нет."], chips: [{ label: "Открыть полный план", act: { do: "openPlan" } }] });
  const lines = ["Завтра:", ...a.slice(0, 7).map((l) => `${l.start_time} ${l.subject.toLowerCase()}${l.was ? ` (вместо ${l.was.toLowerCase()})` : ""}`)];
  const after = [`${c.travel} минут домой`, ...c.actsTomorrow.filter((x) => x.startTime).map((x) => `${x.startTime} ${x.title.toLowerCase()}`)];
  lines.push("", "После школы:", ...after);
  const tt = c.tomorrowTasks;
  if (tt.length) lines.push("", "На утро/вечер:", `${tt.length} ${plural(tt.length, "задание", "задания", "заданий")} · ~${dur(tt.reduce((s, t) => s + t.planned_minutes, 0))}`);
  return R({ icon: "calendar", lines, chips: [{ label: "Открыть полный план", act: { do: "openPlan" } }] });
}

export function whatChanged(c: Ctx): Reply {
  const lines: string[] = [];
  const seen = new Set<string>();
  const push = (s: string) => { if (!seen.has(s)) { seen.add(s); lines.push(s); } };
  for (const ch of c.changes.filter((x) => x.status === "applied" && (x.date === c.today || x.date === c.tomorrow))) { const d = describe(ch); push(`• ${dayWord(c, ch.date)}: ${d.text}`); }
  for (const e of c.events) {
    if (e.type === "ACTIVITY_ADDED") push(`+ ${e.data.title} добавлено${e.data.time ? ` (${e.data.time})` : ""}`);
    if (e.type === "ACTIVITY_MOVED") push(`↔ ${e.data.title} перенесено на ${e.data.time}`);
    if (e.type === "ACTIVITY_CANCELLED") push(`− ${e.data.title} отменено`);
    if (e.type === "TASK_MOVED_TO_MORNING") push(`↗ ${subj(String(e.data.title))} перенесено на утро`);
    if (e.type === "BEDTIME_CHANGED") push(`☾ Сон: ${e.data.from} → ${e.data.to}${e.data.scope === "today" ? " (только сегодня)" : ""}`);
    if (e.type === "USER_LATE") push(`→ Старт плана сдвинут на ${e.data.start}`);
  }
  for (const t of Object.keys(c.movedToday)) push(`+ ${subj(t)} перенесено на утро`);
  for (const t of c.doneYesterday.slice(0, 4)) push(`✓ ${subj(t)} выполнено вчера`);
  for (const t of c.done) push(`✓ ${subj(t)} выполнено`);
  if (!lines.length) return R({ icon: "refresh", lines: ["Пока ничего не менялось: расписание и план как были."] });
  return R({ icon: "refresh", strong: "Что изменилось", lines: lines.slice(0, 8) });
}

function overloaded(c: Ctx): Reply {
  const r = c.rescue;
  if (!r || r.mode === "normal") {
    const fin = c.plan?.plan.filter((e) => e.kind === "work").pop()?.end;
    return R({ icon: "check", tone: "ok", lines: [fin ? `По плану всё помещается: финиш в ${fin}, сон в ${c.bed.effective}.` : `До сна в ${c.bed.effective} всё помещается.`], chips: [{ label: "Что сейчас делать?", act: { do: "say", text: "Что мне сейчас делать?" } }] });
  }
  const opts: string[] = [];
  r.moves.forEach((m) => opts.push(`перенести ${subj(m.title).toLowerCase()} на утро`));
  r.trims.forEach((t) => opts.push(`сократить «${t.title}» на ${t.from - t.to} мин`));
  if (r.compact) opts.push("реже перерывы внутри заданий");
  opts.push("оставить сон без изменений");
  const lines = [r.mode === "tight" ? `Впритык: не хватает ${dur(r.deficit)}, но все задания помещаются.` : `Да, сейчас дефицит ${dur(r.deficit)}.`, "Я могу:", ...opts.map((o, i) => `${i + 1}. ${o};`)];
  if (r.mode === "critical") lines.push("", "Даже так всё не помещается — часть придётся отложить на завтра.");
  else lines.push("", `Лучший вариант — №1${opts.length > 2 ? ` и №${opts.length}` : ""}.`);
  return R({ icon: "timer", tone: "warn", lines, why: r.moves[0]?.reason ?? r.trims[0]?.reason ?? (r.compact ? "Перерывы — раз в 50 минут внутри задания, между заданиями — как обычно." : r.reasons[r.reasons.length - 1]), chips: [{ label: "Применить", act: { do: "rescue" }, primary: true }] });
}

function late(c: Ctx, minutes: number | null, homeAt: string | null, stay: boolean): Reply {
  const atSchool = c.phase === "school" || c.phase === "morning" || stay;
  if (homeAt) return R({ icon: "home", lines: [`Понял: дома в ${homeAt}.`, "План дня начнётся оттуда."], chips: [{ label: "Да", act: { do: "homeAt", time: homeAt }, primary: true }, { label: "Изменить", act: { do: "pickTime", for: "home" } }] });
  if (minutes) {
    if (atSchool && c.times.homeAt !== null) return late(c, null, hh(c.times.homeAt + minutes), false);
    return R({ icon: "timer", lines: [`Понял: начнёшь на ${dur(minutes)} позже — в ${hh(Math.max(c.now, toMin(c.start)) + minutes)}.`], chips: [{ label: "Перестроить вечер", act: { do: "lateBy", minutes }, primary: true }] });
  }
  if (atSchool && c.times.homeAt !== null) {
    const base = c.times.homeAt;
    const opts = [roundUp30(base + 15), roundUp30(base + 45), roundUp30(base + 75)];
    return R({ icon: "cap", lines: ["Понял.", "Во сколько примерно ты будешь дома?"], why: `последний урок до ${hh(c.times.last!)}, дорога ${c.travel} мин`,
      chips: [...opts.map((m) => ({ label: hh(m), act: { do: "homeAt", time: hh(m) } as Act })), { label: "Указать", act: { do: "pickTime", for: "home" } }] });
  }
  return R({ icon: "timer", lines: ["На сколько?"], chips: [15, 30, 60].map((m) => ({ label: m === 60 ? "1 час" : `${m} мин`, act: { do: "lateBy", minutes: m } as Act })).concat([{ label: "Сказать голосом", act: { do: "voice" } }]) });
}

export function activityDraft(c: Ctx, a: ParsedActivity): ActDraftX {
  const date = a.dayDate ?? (c.phase === "night" ? c.tomorrow : c.today);
  return { type: a.type, title: a.title, date, startTime: a.startTime, duration: a.duration ?? DEF_DUR[a.type] ?? 60, fixed: a.type !== "games" && a.type !== "other" };
}
// `_guessed` is kept for callers; it never changed the reply (both branches of the old ternary were "").
export function activityReply(c: Ctx, d: ActDraftX, _guessed = false): Reply {
  if (!d.startTime && d.fixed) {
    const home = d.date === c.today ? c.times.homeAt : c.timesTomorrow.homeAt;
    const opts = [...new Set([home !== null ? roundUp30(home + 30) : null, 18 * 60, 19 * 60].filter((x): x is number => x !== null && x > (d.date === c.today ? c.now : 0)))].slice(0, 3);
    return R({ icon: ICON[d.type], lines: [`Во сколько ${KIND_Q[d.type] ?? "это"}?`], why: home !== null ? `после школы ты дома около ${hh(home)}` : undefined,
      chips: [...opts.map((m) => ({ label: hh(m), act: { do: "actTime", draft: d, time: hh(m) } as Act })), { label: "Указать", act: { do: "pickTime", for: "act", draft: d } }] });
  }
  const span = d.startTime ? `${d.startTime}–${hh(toMin(d.startTime) + d.duration)}` : `${dur(d.duration)}, когда удобно`;
  return R({ icon: ICON[d.type], strong: "Я понял:", lines: [d.title, dayWord(c, d.date), span, "Добавить в план?"].filter(Boolean),
    chips: [{ label: "Добавить", act: { do: "addAct", draft: d }, primary: true }, { label: "Изменить", act: { do: "editAct", draft: d } }] });
}

/** Ученик сказал/написал фразу → ответ помощника. */
export function answer(text: string, c: Ctx): Reply {
  const it = parseIntent(text, { today: c.today, nowMin: c.now, lastBellToday: c.times.last, schoolWeek: 5 });
  const heard = text.trim();
  const out = ((): Reply => {
    switch (it.kind) {
      case "whatNow": return whatNow(c);
      case "whatTomorrow": return whatTomorrow(c);
      case "whatChanged": return whatChanged(c);
      case "overloaded": return overloaded(c);
      case "late": return late(c, it.minutes, it.homeAt, it.stayAtSchool);
      case "tired": {
        const short = [...c.left].filter((t) => !c.morning.includes(t)).sort((a, b) => a.planned_minutes - b.planned_minutes)[0];
        return R({ icon: "pause", lines: [short ? `Тогда сегодня лучше начать с короткого задания — ${subj(short.title).toLowerCase()}, ${short.planned_minutes} мин.` : "Тогда сделай перерыв — заданий не осталось."], why: short ? "короткое → перерыв → потом сложнее: так легче втянуться" : undefined,
          chips: short ? [{ label: "Перестроить вечер", act: { do: "tired" }, primary: true }] : [] });
      }
      case "done": {
        const t = c.left.find((x) => it.subject && sameSubject(subj(x.title), it.subject)) ?? c.left.find((x) => it.subject && subjectOf(x.title) && sameSubject(subjectOf(x.title)!, it.subject));
        if (!t) return R({ icon: "?", lines: [it.subject ? `Не нашёл «${it.subject}» среди несделанных заданий.` : "Что именно ты сделал?"], chips: c.left.slice(0, 4).map((x) => ({ label: subj(x.title), act: { do: "markDone", title: x.title } as Act })) });
        return R({ icon: "check", lines: [`Отметить «${subj(t.title)}» выполненным?`], chips: [{ label: "Да, сделал", act: { do: "markDone", title: t.title }, primary: true }, { label: "Нет", act: { do: "dismiss" } }] });
      }
      case "bedtime": {
        if (!it.time) return R({ icon: "moon", lines: [`Сон сегодня в ${c.bed.effective}${c.bed.today ? "" : " (обычное время)"}.`], chips: [{ label: "Изменить", act: { do: "openBed" }, primary: true }] });
        return R({ icon: "moon", lines: [`Сон в ${it.time}?`, `Рекомендуемое — ${c.bed.recommended}.`], chips: [{ label: "Только сегодня", act: { do: "bed", time: it.time, scope: "today" }, primary: true }, { label: "Обычно", act: { do: "bed", time: it.time, scope: "usual" } }] });
      }
      case "activity": {
        if (it.act.cancel) {
          const a = (it.act.dayDate === c.tomorrow ? c.actsTomorrow : c.acts).find((x) => x.type === it.act.type || x.title === it.act.title);
          if (a) return R({ icon: "−", lines: [`Убрать «${a.title}»${a.startTime ? ` в ${a.startTime}` : ""} из плана?`], chips: [{ label: "Убрать", act: { do: "removeAct", id: a.id }, primary: true }, { label: "Оставить", act: { do: "dismiss" } }] });
        }
        return activityReply(c, activityDraft(c, it.act));
      }
      case "schedule": return R({ icon: "calendar", lines: ["Похоже на изменение расписания — покажу, что понял, прежде чем менять."], chips: [{ label: "Разобрать изменение", act: { do: "evidence", text }, primary: true }] });
      case "homework": return R({ icon: "book", lines: ["Добавлю как задание и оценю время."], chips: [{ label: "Добавить задание", act: { do: "homework", text }, primary: true }, { label: "Это не задание", act: { do: "dismiss" } }] });
      default: return R({ icon: "chat", lines: ["Я понимаю события дня. Например:"], chips: ["Что мне сейчас делать?", "Я опоздаю", "Что завтра?", "Я не успеваю"].map((x) => ({ label: x, act: { do: "say", text: x } as Act })).concat([{ label: "Вопрос по предмету — к репетитору", act: { do: "tutor" } }]) });
    }
  })();
  return { ...out, heard };
}

/** После «сделал»: освободилось время — предложить взять утреннее сейчас, но не навязывать. */
export function afterDone(c: Ctx, title: string, freedMin: number): Reply {
  const m = c.left.find((t) => t.title !== title && (c.movedTomorrow[t.title] !== undefined));
  const movedTomorrowTitle = Object.keys(c.movedTomorrow)[0];
  if (movedTomorrowTitle && freedMin >= 10) {
    return R({ icon: "check", tone: "ok", strong: "Готово ✓", lines: [`Теперь у тебя освободилось ${dur(freedMin)}.`, `Хочешь закончить ${subj(movedTomorrowTitle).toLowerCase()} сейчас или оставить на утро?`],
      chips: [{ label: "Сейчас", act: { do: "doNow", title: movedTomorrowTitle }, primary: true }, { label: "Утром", act: { do: "keepMorning", title: movedTomorrowTitle } }] });
  }
  void m;
  return R({ icon: "check", tone: "ok", strong: "Готово ✓", lines: [freedMin > 0 ? `Вечер теперь свободнее на ${dur(freedMin)}.` : "Отмечено."] });
}

/** Максимум ОДНА проактивная подсказка: самая полезная прямо сейчас. */
export function hint(c: Ctx): Reply | null {
  const ch = c.unseen.find((x) => x.date === c.today);
  if (ch) {
    const d = describe(ch);
    const txt = ch.change_type === "REPLACE" ? `Сегодня вместо ${String(ch.before ?? "").toLowerCase()} — ${String(ch.subject ?? "").toLowerCase()}.` : `Сегодня: ${d.text}.`;
    return R({ icon: "alert", strong: "Расписание изменилось", lines: [txt], tone: "warn", chips: [{ label: "Понятно", act: { do: "ack", ids: c.unseen.filter((x) => x.date === c.today).map((x) => x.id) }, primary: true }] });
  }
  if (c.phase === "morning" && c.morning.length) {
    const t = c.morning[0];
    return R({ icon: "sun", lines: [`До выхода ${dur(c.times.leave! - c.now)}. Есть ${plural(c.morning.length, "одно задание", "задания", "заданий").replace(/^задания$/, `${c.morning.length} задания`)} на ${c.morning.reduce((s, x) => s + x.planned_minutes, 0)} мин.`], chips: [{ label: "Начать", act: { do: "start", title: t.title }, primary: true }] });
  }
  if (c.phase === "travel") return R({ icon: "home", lines: [`До дома примерно ${dur(c.times.homeAt! - c.now)}.`] });
  if ((c.phase === "evening" || c.phase === "free") && c.left.length) {
    const bed = toMin(c.bed.effective);
    if (bed - c.now <= 20 && bed > c.now) return R({ icon: "moon", lines: [`Осталось ${bed - c.now} минут до сна.`, "Одно задание можно перенести на утро."], chips: [{ label: "Перенести на утро", act: { do: "carryAll" }, primary: true }] });
    if (c.mode !== "normal" && c.rescue) return R({ icon: "timer", tone: "warn", lines: [`Сегодня не помещается ${dur(c.rescue.deficit)}.`], chips: [{ label: "План спасения", act: { do: "rescue" }, primary: true }] });
    const p = pickTask(c);
    if (p.act && p.task && p.gap !== null) return R({ icon: "clock", lines: [`Сегодня ${p.act.title.toLowerCase()} в ${p.act.startTime}.`, `Лучше начать ${subj(p.task.title).toLowerCase()} сейчас.`], why: p.why ?? undefined, chips: [{ label: "Начать", act: { do: "start", title: p.task.title }, primary: true }] });
  }
  return null;
}
export { parseTime };
