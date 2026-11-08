/**
 * Петля учебного дня: УТРО → ШКОЛА → ДОРОГА → ВЕЧЕР → НОЧЬ → УТРО.
 * Всё считается от расписания (с изменениями ученика) и настроек: подъём, сборы, дорога, сон.
 * Выход из дома = первый урок − дорога; дома = последний звонок + дорога (по умолчанию 45 мин).
 */
import { toHHMM, toMin } from "./time";
import type { Lesson } from "./schedule";
import type { Task } from "./types";

export type Phase = "night" | "morning" | "school" | "travel" | "evening" | "free";
export interface SchoolTimes { first: number | null; last: number | null; leave: number | null; homeAt: number | null }

export const activeLessons = (ls: Lesson[]) => ls.filter((l) => l.status === "active" && l.start_time && l.end_time);
export function schoolTimes(ls: Lesson[], travel: number): SchoolTimes {
  const a = activeLessons(ls);
  if (!a.length) return { first: null, last: null, leave: null, homeAt: null };
  const first = toMin(a[0].start_time!), last = toMin(a[a.length - 1].end_time!);
  return { first, last, leave: first - travel, homeAt: last + travel };
}
export function phaseAt(now: number, t: SchoolTimes, bed: string): Phase {
  const b0 = toMin(bed), b = b0 < 12 * 60 ? b0 + 1440 : b0;   // сон после полуночи: 00:30 = 24:30
  if (now < 4 * 60 || now >= b) return "night";
  if (t.first === null) return "free";
  if (now < t.leave!) return "morning";
  if (now < t.last!) return "school";
  if (now < t.homeAt!) return "travel";
  return "evening";
}
export function lessonNow(ls: Lesson[], now: number): { current: Lesson | null; next: Lesson | null; last: Lesson | null } {
  const a = activeLessons(ls);
  const current = a.find((l) => toMin(l.start_time!) <= now && now < toMin(l.end_time!)) ?? null;
  const next = a.find((l) => toMin(l.start_time!) > now) ?? null;
  return { current, next, last: a[a.length - 1] ?? null };
}

/** Время на задания утром: от max(сейчас, подъём) до выхода минус сборы. */
export function morningBudget(now: number | null, wake: string, leave: number | null, prep: number): number {
  if (leave === null) return 0;
  const from = Math.max(now ?? 0, toMin(wake));
  return Math.max(0, leave - prep - from);
}

export interface MorningPlan { untilLeave: number | null; untilFirst: number | null; avail: number; fit: Task[]; overflow: Task[]; ok: boolean; total: number }
/** Утро НЕ предлагает задание, которое физически не помещается до выхода: оно уходит в вечер. */
export function morningPlan(tasks: Task[], now: number, wake: string, t: SchoolTimes, prep: number): MorningPlan {
  const avail = morningBudget(now, wake, t.leave, prep);
  const fit: Task[] = [], overflow: Task[] = [];
  let used = 0;
  for (const x of [...tasks].sort((a, b) => (a.type === "oral" ? 0 : 1) - (b.type === "oral" ? 0 : 1) || a.planned_minutes - b.planned_minutes)) {
    if (used + x.planned_minutes <= avail) { fit.push(x); used += x.planned_minutes; } else overflow.push(x);
  }
  return { untilLeave: t.leave !== null ? t.leave - now : null, untilFirst: t.first !== null ? t.first - now : null, avail, fit, overflow, ok: overflow.length === 0, total: used };
}

export interface Brief { lastEnd: string | null; lessons: { time: string; subject: string; note: string | null; was: string | null; cancelled: boolean }[]; after: { icon: string; text: string }[]; evening: { count: number; minutes: number } }
export function brief(ls: Lesson[], t: SchoolTimes, travel: number, acts: { title: string; startTime: string | null; type: string }[], evening: Task[]): Brief {
  const icon = (type: string) => ({ sport: "dumbbell", tutor: "user", club: "palette", games: "gamepad", meet: "users", road: "bus", misc: "pin" } as Record<string, string>)[type] ?? "•";
  return {
    lastEnd: t.last !== null ? toHHMM(t.last) : null,
    lessons: ls.filter((l) => l.start_time).map((l) => ({ time: l.start_time!, subject: l.subject, note: l.note, was: l.was, cancelled: l.status !== "active" })),
    after: [
      ...(t.homeAt !== null ? [{ icon: "home", text: `Домой — ${travel} мин, дома ~${toHHMM(t.homeAt)}` }] : []),
      ...acts.filter((a) => a.startTime).sort((a, b) => toMin(a.startTime!) - toMin(b.startTime!)).map((a) => ({ icon: icon(a.type), text: `${a.title} — ${a.startTime}` })),
    ],
    evening: { count: evening.length, minutes: evening.reduce((s, x) => s + x.planned_minutes, 0) },
  };
}
