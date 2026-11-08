/**
 * Режим спасения. Не «вы не успеваете», а план выхода:
 *  NORMAL — всё помещается; TIGHT — помещается, если урезать гибкое время/реже перерывы;
 *  SURVIVAL — нужен перенос допустимых заданий на утро; CRITICAL — даже перенос не спасает.
 * Сон — ограничение, а не ресурс: отбой здесь не двигается никогда. Обязательные дела не трогаем.
 * Утро получает только то, что физически помещается до выхода. Каждое решение — с короткой причиной.
 */
import { buildPlan, SURVIVAL_CAP } from "../engine/norms";
import { splitTitle } from "./subjects";
import { dur } from "./time";
import type { PersonalActivity, PlanOut, RestSlot, Task } from "./types";

export type Mode = "normal" | "tight" | "survival" | "critical";
export interface Move { title: string; minutes: number; to: "morning" | "tomorrow"; reason: string }
export interface Trim { title: string; from: number; to: number; reason: string }
/** Слагаемое потребности вечера: сумма parts = need, need − capacity = deficit. */
export interface Part { key: "study" | "breaks" | "rest" | "fixed" | "flexible"; label: string; minutes: number }
export interface Rescue {
  mode: Mode; deficit: number; capacity: number; need: number; work: number; bedtime: string;
  keep: string[]; moves: Move[]; trims: Trim[]; compact: boolean; after: PlanOut; leftover: number;
  reasons: string[]; morningBudget: number; overflow: Move[];
  /** из чего сложилась потребность (до спасения) — чтобы цифры на карточке сходились */
  parts: Part[];
}
export interface RescueIn { tasks: Task[]; start: string; bedtime: string; rest_slots: RestSlot[]; personal: PersonalActivity[]; morningBudget: number; survival?: boolean; compact?: boolean; order?: "default" | "short_first" }

const MIN_FLEX = 30; // свободное время не обнуляем: минимум полчаса гибкого дела остаётся
const subj = (t: string) => splitTitle(t).subject;
const need = (p: PlanOut) => p.summary.need_work_minutes! + p.summary.need_fixed_minutes! + p.summary.need_flexible_minutes! + p.summary.need_rest_minutes!;

export function rescue(r: RescueIn): Rescue {
  const plan = (tasks: Task[], personal: PersonalActivity[], compact = !!r.compact) =>
    buildPlan({ tasks, start_time: r.start, bedtime: r.bedtime, rest_slots: r.rest_slots, personal_activities: personal, survival: !!r.survival, compact_breaks: compact, order: r.order ?? "default" });
  const p0 = plan(r.tasks, r.personal);
  const study = r.tasks.reduce((s, t) => s + Math.max(1, r.survival ? Math.min(t.planned_minutes, SURVIVAL_CAP) : t.planned_minutes), 0);
  const sm = p0.summary;
  const parts: Part[] = ([
    { key: "study", label: "задания", minutes: study },
    { key: "breaks", label: "перерывы", minutes: Math.max(0, (sm.need_work_minutes ?? 0) - study) },
    { key: "rest", label: "отдых", minutes: sm.need_rest_minutes ?? 0 },
    { key: "fixed", label: "обязательные дела", minutes: sm.need_fixed_minutes ?? 0 },
    { key: "flexible", label: "свои дела", minutes: sm.need_flexible_minutes ?? 0 },
  ] as Part[]).filter((x) => x.minutes > 0);
  const base = { deficit: p0.deficit_minutes, capacity: sm.capacity_minutes ?? 0, need: need(p0), work: sm.need_work_minutes ?? 0, bedtime: r.bedtime, morningBudget: r.morningBudget, parts };
  const fixedTitles = r.personal.filter((a) => a.is_fixed && a.start_time).map((a) => a.title);
  const reasons: string[] = [];
  const biggest = [...r.tasks].filter((t) => t.type === "written").sort((a, b) => b.planned_minutes - a.planned_minutes)[0];
  if (biggest && r.tasks.length > 1) reasons.push(`${subj(biggest.title)} — первой: занимает больше всего времени.`);
  fixedTitles.slice(0, 1).forEach((t) => reasons.push(`«${t}» не переношу — это обязательное дело.`));
  if (p0.deficit_minutes === 0) return { ...base, mode: "normal", keep: r.tasks.map((t) => t.title), moves: [], trims: [], compact: !!r.compact, after: p0, leftover: 0, reasons, overflow: [] };

  // 1) урезать гибкое свободное время (не обязательные дела)
  let left = p0.deficit_minutes;
  const trims: Trim[] = [];
  const personal = r.personal.map((a) => {
    if (a.is_fixed || left <= 0) return a;
    const can = Math.max(0, a.duration_minutes - MIN_FLEX);
    const cut = Math.min(can, left);
    if (cut <= 0) return a;
    left -= cut;
    trims.push({ title: a.title, from: a.duration_minutes, to: a.duration_minutes - cut, reason: `«${a.title}» — ${dur(a.duration_minutes - cut)} вместо ${dur(a.duration_minutes)}: это гибкое время.` });
    return { ...a, duration_minutes: a.duration_minutes - cut };
  });
  let cur = plan(r.tasks, personal);
  const done = (mode: Mode, keep: Task[], moves: Move[], compact: boolean, after: PlanOut, overflow: Move[] = []): Rescue => {
    const rs = [...reasons, ...trims.map((t) => t.reason), ...moves.map((m) => m.reason)];
    if (compact) rs.push("Перерывы — раз в 50 минут внутри задания, между заданиями — как обычно.");
    rs.push(mode === "critical" ? `Сон оставил на ${r.bedtime}: ночь не резиновая.` : `Сон сохранён: ${r.bedtime}.`);
    return { ...base, mode, keep: keep.map((t) => t.title), moves, trims, compact, after, leftover: after.deficit_minutes, reasons: rs, overflow };
  };
  if (cur.deficit_minutes === 0) return done("tight", r.tasks, [], !!r.compact, cur);

  // 2) устные — на утро (если помещаются до выхода), затем 3) реже перерывы, 4) другие допустимые
  let keep = [...r.tasks];
  const moves: Move[] = [];
  let morningLeft = r.morningBudget;
  let compact = !!r.compact;
  const tryMove = (cands: Task[]) => {
    for (const t of cands) {
      if (cur.deficit_minutes === 0) return;
      if (t.planned_minutes > morningLeft) continue;
      keep = keep.filter((x) => x.title !== t.title);
      morningLeft -= t.planned_minutes;
      moves.push({ title: t.title, minutes: t.planned_minutes, to: "morning",
        reason: t.type === "oral" ? `${subj(t.title)} — на утро: это устное задание, а утром есть ${r.morningBudget} мин.` : `${subj(t.title)} — на утро: ${t.planned_minutes} мин помещаются до выхода.` });
      cur = plan(keep, personal, compact);
    }
  };
  tryMove(keep.filter((t) => t.type === "oral").sort((a, b) => a.planned_minutes - b.planned_minutes));
  if (cur.deficit_minutes > 0) {
    const c = plan(keep, personal, true);
    if (c.deficit_minutes < cur.deficit_minutes) { compact = true; cur = c; }
  }
  if (cur.deficit_minutes > 0) tryMove(keep.filter((t) => t.type !== "oral").sort((a, b) => a.planned_minutes - b.planned_minutes));
  if (cur.deficit_minutes === 0) return done("survival", keep, moves, compact, cur);
  // CRITICAL: что придётся отложить на завтра (не на утро — туда физически не влезает)
  let rest = [...keep].sort((a, b) => (a.type === "oral" ? 0 : 1) - (b.type === "oral" ? 0 : 1) || a.planned_minutes - b.planned_minutes);
  const overflow: Move[] = [];
  let probe = cur;
  while (probe.deficit_minutes > 0 && rest.length > 1) {
    const t = rest.shift()!;
    overflow.push({ title: t.title, minutes: t.planned_minutes, to: "tomorrow", reason: `${subj(t.title)} — на завтра: сегодня до сна не помещается, а утром не хватит времени.` });
    probe = plan(rest, personal, compact);
  }
  return done("critical", keep, moves, compact, cur, overflow);
}
