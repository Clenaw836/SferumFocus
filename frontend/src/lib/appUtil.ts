/** v18: чистые помощники корня приложения (без состояния). Вынесено из main.tsx. */
import type { DayActivity, Task } from "./types";

export const clampT = (m: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, m));
/** « от 10:31» / « от 08.10 21:05» — возраст сохранённых данных для офлайн-сообщения. */
export const savedAt = (ts?: number | null): string => {
  if (!ts) return "";
  const d = new Date(ts), now = new Date(), p2 = (n: number) => String(n).padStart(2, "0");
  const time = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  return d.toDateString() === now.toDateString() ? ` от ${time}` : ` от ${p2(d.getDate())}.${p2(d.getMonth() + 1)} ${time}`;
};
export const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** Небо над экраном следует реальному времени: день → закат → ночь. Цвет несёт смысл, не декор. */
export function skyFor(h: number): string {
  if (h < 15) return "rgba(120,160,255,.16)";
  if (h < 18) return "rgba(255,150,70,.22)";
  if (h < 21) return "rgba(255,95,90,.18)";
  return "rgba(120,100,255,.16)";
}

/** Подпись входных данных плана: изменилась — план устарел (кнопка «Построить план дня» снова главная). */
/** Утренний перенос исключается целиком, не только если он помещается в mp.fit.
 * После окончания утра незавершённое возвращается; дневной прогресс не меняем. */
export function eveningTasks(all: Task[], done: string[], morning: boolean, moved: Record<string, unknown>): Task[] {
  return all.filter((t) => !done.includes(t.title) && !(morning && (t.source === "morning" || moved[t.title])));
}

export function sigOf(all: Task[], start: string, bed: string, acts: DayActivity[], surv: boolean, compact = false, order: "default" | "short_first" = "default", morning = false): string {
  return JSON.stringify([all.map((t) => [t.title, t.planned_minutes, t.type]), start, bed, acts.map((a) => [a.title, a.startTime, a.durationMinutes, a.fixed]), surv, compact, order, morning]);
}

