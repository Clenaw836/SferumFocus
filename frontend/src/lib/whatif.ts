/**
 * v18 «Успею ли?» — симулятор изменения вечера БЕЗ применения.
 * Тот же детерминированный планировщик (engine/norms.buildPlan) и тот же режим спасения (survival.rescue),
 * что и в основном плане: прогноз не расходится с планом, который ученик увидит после «Применить».
 * Длительности — оценка по нормативам (или исправленная учеником), не обещание: UI так и пишет.
 */
import { buildPlan } from "../engine/norms";
import { rescue, type Rescue, type RescueIn } from "./survival";
import { splitTitle } from "./subjects";
import { BED_MAX, BED_MIN, dur, toHHMM, toMin } from "./time";
import type { PlanOut, Task } from "./types";

export type Change =
  | { kind: "late"; minutes: number }               // задерживаюсь: старт вечера позже
  | { kind: "task"; title: string; minutes: number } // новое задание
  | { kind: "bed"; minutes: number };               // сон раньше (<0) / позже (>0)

export interface Slot { start: string; end: string }
export interface TaskDiff { title: string; subject: string; minutes: number; before: Slot | null; after: Slot | null; status: "same" | "shifted" | "at_risk" | "new" | "new_at_risk" }
export interface Snapshot { start: string; bedtime: string; need: number; capacity: number; deficit: number; free: number; plan: PlanOut;
  /** v18.1 (D-01): окна нет — старт не раньше отбоя (модель клиента: отбой в те же сутки, см. planWindow/BED_MAX) */
  closed: boolean;
  /** из чего складывается «нужно» — чтобы цифры сходились с тем, что видит ученик */
  parts: { label: string; minutes: number }[] }
/** v18.1 (D-02): параметры планировщика, с которыми построен реальный план (режим спасения, сжатые перерывы, порядок). */
export interface WhatIfIn extends RescueIn { survival?: boolean; compact?: boolean; order?: "default" | "short_first" }
const flags = (r: WhatIfIn) => ({ survival: !!r.survival, compact_breaks: !!r.compact, order: r.order ?? "default" });
export interface Option { id: "rescue" | "bed" | "keep"; title: string; detail: string[]; bedtime?: string; rescue?: Rescue; warn?: string }
export interface WhatIf {
  change: Change; label: string; before: Snapshot; after: Snapshot;
  verdict: "fits" | "tight" | "over"; diffs: TaskDiff[]; reasons: string[]; options: Option[];
  tasksAfter: Task[];
}

const TIGHT = 15;          // запас меньше 15 мин — «впритык»: оценка по нормам ±, честно предупреждаем
const LATE_BED_MAX = 30;   // предлагаем лечь позже не больше чем на 30 мин и только с предупреждением

function snap(r: WhatIfIn): Snapshot {
  // v18.1 (D-01): buildPlan трактует «отбой ≤ старта» как отбой завтра (+24 ч) — для вечера клиента это неверно:
  // planWindow и build() такое окно не строят. Закрытое окно = 0 минут, всё нужное — дефицит.
  if (toMin(r.start) >= toMin(r.bedtime)) return closedSnap(r);
  const plan = buildPlan({ tasks: r.tasks, start_time: r.start, bedtime: r.bedtime, rest_slots: r.rest_slots, personal_activities: r.personal, ...flags(r) });
  const s = plan.summary;
  const need = (s.need_work_minutes ?? 0) + (s.need_fixed_minutes ?? 0) + (s.need_flexible_minutes ?? 0) + (s.need_rest_minutes ?? 0);
  const capacity = s.capacity_minutes ?? Math.max(0, toMin(r.bedtime) - toMin(r.start));
  const parts = [
    { label: "задания с перерывами", minutes: s.need_work_minutes ?? 0 },
    { label: "отдых и ужин", minutes: s.need_rest_minutes ?? 0 },
    { label: "обязательные дела", minutes: s.need_fixed_minutes ?? 0 },
    { label: "свои дела", minutes: s.need_flexible_minutes ?? 0 },
  ].filter((x) => x.minutes > 0);
  return { start: r.start, bedtime: r.bedtime, need, capacity, deficit: plan.deficit_minutes, free: Math.max(0, capacity - need), plan, parts, closed: false };
}

/** Окна нет: размещать нечего. «Нужно» — задания с перерывами и свои дела (стены по времени в закрытое окно не попадают). */
function closedSnap(r: WhatIfIn): Snapshot {
  const probe = buildPlan({ tasks: r.tasks, start_time: "00:00", bedtime: "23:59", rest_slots: [], personal_activities: r.personal.filter((a) => !(a.is_fixed && a.start_time)), ...flags(r) });
  const s = probe.summary;
  const parts = [
    { label: "задания с перерывами", minutes: s.need_work_minutes ?? 0 },
    { label: "свои дела", minutes: s.need_flexible_minutes ?? 0 },
  ].filter((x) => x.minutes > 0);
  const need = parts.reduce((a, x) => a + x.minutes, 0);
  const plan: PlanOut = { ...probe, plan: [], deficit_minutes: need, summary: { ...s, window_start: r.start, window_end: r.bedtime, capacity_minutes: 0, free_minutes_left: 0, utilization_percent: 0 } };
  return { start: r.start, bedtime: r.bedtime, need, capacity: 0, deficit: need, free: 0, plan, parts, closed: true };
}

/** v18.1 (D-01/D-03): изменение, которое заведомо нарушает ограничения, не предлагаем.
 *  «Лягу раньше» — только если новый отбой позже старта и не раньше BED_MIN; «позже» — не позже BED_MAX.
 *  Задержка — факт, а не выбор: на неё всегда честный ответ (в т.ч. «окна нет»). */
export function changeAllowed(base: WhatIfIn, c: Change): boolean {
  if (c.kind !== "bed") return true;
  const b = toMin(base.bedtime) + c.minutes;
  return b > toMin(base.start) && b >= BED_MIN && b <= BED_MAX;
}

export function slots(p: PlanOut): Map<string, Slot> {
  const m = new Map<string, Slot>();
  for (const e of p.plan) {
    if (e.kind !== "work" || !e.task) continue;
    const cur = m.get(e.task);
    m.set(e.task, cur ? { start: cur.start, end: e.end } : { start: e.start, end: e.end });
  }
  return m;
}

export const changeLabel = (c: Change) =>
  c.kind === "late" ? `Задерживаюсь на ${dur(c.minutes)}` : c.kind === "task" ? `Новое задание: ${splitTitle(c.title).subject}, ${dur(c.minutes)}` : c.minutes < 0 ? `Лягу на ${dur(-c.minutes)} раньше` : `Лягу на ${dur(c.minutes)} позже`;

export function simulate(base: WhatIfIn, c: Change): WhatIf {
  const before = snap(base);
  const next: WhatIfIn = { ...base };
  if (c.kind === "late") next.start = toHHMM(Math.min(toMin(base.start) + c.minutes, toMin(base.bedtime)));
  if (c.kind === "bed") next.bedtime = toHHMM(toMin(base.bedtime) + c.minutes);
  if (c.kind === "task") next.tasks = [...base.tasks, { title: c.title, type: "written", deadline: null, planned_minutes: c.minutes, blitz_eligible: false, source: "manual" }];
  const after = snap(next);
  const s0 = slots(before.plan), s1 = slots(after.plan);
  const diffs: TaskDiff[] = next.tasks.map((t) => {
    const b = s0.get(t.title) ?? null, a = s1.get(t.title) ?? null;
    const isNew = !base.tasks.some((x) => x.title === t.title);
    const status: TaskDiff["status"] = isNew ? (a ? "new" : "new_at_risk") : !a ? "at_risk" : b && (b.start !== a.start || b.end !== a.end) ? "shifted" : "same";
    return { title: t.title, subject: splitTitle(t.title).subject, minutes: t.planned_minutes, before: b, after: a, status };
  });
  const reasons: string[] = [];
  if (c.kind === "late") reasons.push(`Старт плана ${before.start} → ${after.start}: на ${dur(toMin(after.start) - toMin(before.start))} меньше времени до сна.`);
  if (after.closed) reasons.push(`До сна времени не остаётся: старт ${after.start}, отбой ${after.bedtime}.`);
  if (c.kind === "bed") reasons.push(`Сон ${before.bedtime} → ${after.bedtime}: окно ${c.minutes < 0 ? "короче" : "длиннее"} на ${dur(Math.abs(c.minutes))}.`);
  if (c.kind === "task") reasons.push(`+${dur(c.minutes)} работы и перерывы к ней.`);
  if (after.need < before.need) {
    const lost = before.parts.map((p) => ({ label: p.label, d: p.minutes - (after.parts.find((q) => q.label === p.label)?.minutes ?? 0) })).filter((x) => x.d > 0);
    if (lost.length) reasons.push(`Нужно меньше (${dur(before.need)} → ${dur(after.need)}): ${lost.map((x) => `${x.label} −${dur(x.d)}`).join(", ")} — уже не в окне вечера.`);
  }
  const risk = diffs.filter((d) => d.status === "at_risk" || d.status === "new_at_risk");
  for (const d of risk) reasons.push(`${d.subject} (${dur(d.minutes)}) не помещается до сна — не хватает ${dur(after.deficit)}.`);
  if (!risk.length && after.deficit === 0) reasons.push(after.free < TIGHT ? `Запас всего ${dur(after.free)} — любая задержка съест его.` : `Запас ${dur(after.free)} до сна.`);
  const verdict: WhatIf["verdict"] = after.deficit > 0 ? "over" : after.free < TIGHT ? "tight" : "fits";

  const options: Option[] = [];
  if (after.deficit > 0) {
    // закрытое окно: спасать нечего (rescue считал бы +24 ч); режим спасения уже включён — rescue считает без него (D-02)
    const r = after.closed || next.survival ? null : rescue({ tasks: next.tasks, start: next.start, bedtime: next.bedtime, rest_slots: next.rest_slots, personal: next.personal, morningBudget: next.morningBudget });
    if (r) {
    const steps = [
      ...r.trims.map((t) => `«${t.title}»: ${dur(t.from)} → ${dur(t.to)}`),
      ...(r.compact ? ["Перерывы реже: раз в 50 мин внутри задания"] : []),
      ...r.moves.map((m) => `${splitTitle(m.title).subject} → утро (${dur(m.minutes)}, до выхода есть ${dur(r.morningBudget)})`),
      ...r.overflow.map((m) => `${splitTitle(m.title).subject} → завтра: сегодня не помещается`),
    ];
    if (steps.length) options.push({ id: "rescue", title: r.mode === "critical" ? "Сохранить сон, часть — на завтра" : "Сохранить сон", detail: [...steps, `Сон остаётся в ${next.bedtime}.`], rescue: r });
    }
    if (after.deficit <= LATE_BED_MAX && !after.closed) {
      const btm = toMin(next.bedtime) + after.deficit + (5 - (after.deficit % 5)) % 5, bt = toHHMM(btm);
      // v18.1 (D-03): позже BED_MAX не предлагаем — toHHMM дал бы «00:10», а такой отбой не сохранится
      if (btm <= BED_MAX) options.push({ id: "bed", title: `Лечь в ${bt}`, detail: [`Всё остаётся сегодня; сон на ${dur(toMin(bt) - toMin(next.bedtime))} короче.`], bedtime: bt, warn: "Только сегодня. Недосып бьёт по завтрашним урокам сильнее, чем незаконченное задание." });
    }
    options.push({ id: "keep", title: "Оставить как есть", detail: [risk.length ? `${risk.map((d) => d.subject).join(", ")} — под риском, решишь по ходу.` : "Ничего не переношу."] });
  }
  return { change: c, label: changeLabel(c), before, after, verdict, diffs, reasons, options, tasksAfter: next.tasks };
}
