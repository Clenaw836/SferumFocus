/**
 * Master v2.0 · Feature 3 — расчёты для экрана «Статистика» (чистые функции, тестируются в Node).
 * Правила честности: нет данных ≠ ноль; среднее — только при ≥ 3 активных днях и с округлением до 5 мин;
 * средний балл блица — только при ≥ 3 дуэлях; сравнение периодов — только когда в обоих ≥ 3 активных дня.
 */
import type { MyWeek } from "./types";

export type Period = 7 | 14 | 30;
export type Metric = "minutes" | "tasks";
export type Day = MyWeek["days"][number];
export interface Scale { max: number; step: number; ticks: number[] }

export function niceScale(maxVal: number, metric: Metric): Scale {
  const v = Math.max(0, Number.isFinite(maxVal) ? maxVal : 0);
  const steps = metric === "tasks" ? [1, 2, 5, 10, 20] : [15, 30, 60, 90, 120, 180, 240];
  const floor = metric === "tasks" ? 4 : 60;                 // пустая шкала не «раздувает» маленькие значения
  const top = Math.max(v, floor);
  const step = steps.find((s) => Math.ceil(top / s) <= 4) ?? steps[steps.length - 1];
  const max = Math.max(step * Math.ceil(top / step), step);
  const ticks: number[] = []; for (let t = 0; t <= max + 1e-9; t += step) ticks.push(t);
  return { max, step, ticks };
}

export function fmtMin(n: number): string {
  const m = Math.max(0, Math.round(n));
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} ч ${r} мин` : `${h} ч`;
}
export function tickLabel(v: number, metric: Metric): string {
  if (metric === "tasks") return String(v);
  if (v === 0) return "0";
  if (v < 60) return `${v} мин`;
  const h = v / 60;
  return `${Number.isInteger(h) ? h : h.toFixed(1).replace(".", ",")} ч`;
}

export interface Summary {
  days: number; total: number; activeDays: number; avgActive: number | null; counted: number;
  duels: number; blitzAvg: number | null; tasks: number | null; tasksPartial: boolean;
  actual: number; estimate: number; unsplitMinutes: number; best: { date: string; minutes: number } | null;
}
export function summarize(days: Day[]): Summary {
  const active = days.filter((d) => d.study_minutes > 0);
  const total = days.reduce((a, d) => a + d.study_minutes, 0);
  const duels = days.reduce((a, d) => a + d.duels, 0);
  let wsum = 0, wn = 0;
  for (const d of days) if (d.blitz_avg !== null && d.blitz_avg !== undefined && d.duels > 0) { wsum += d.blitz_avg * d.duels; wn += d.duels; }
  const known = days.filter((d) => d.tasks_done !== null && d.tasks_done !== undefined);
  let actual = 0, estimate = 0, unsplit = 0;
  for (const d of days) {
    if (d.actual_minutes === null || d.actual_minutes === undefined || d.estimate_minutes === null || d.estimate_minutes === undefined) unsplit += d.study_minutes;
    else { actual += d.actual_minutes; estimate += d.estimate_minutes; }
  }
  const best = active.reduce<{ date: string; minutes: number } | null>((b, d) => (!b || d.study_minutes > b.minutes ? { date: d.date, minutes: d.study_minutes } : b), null);
  return {
    days: days.length, total, activeDays: active.length,
    avgActive: active.length >= 3 ? Math.round(total / active.length / 5) * 5 : null,
    counted: days.filter((d) => d.counted).length, duels,
    blitzAvg: wn >= 3 ? Math.round((wsum / wn) * 10) / 10 : null,
    tasks: known.length ? known.reduce((a, d) => a + (d.tasks_done ?? 0), 0) : null, tasksPartial: known.length < days.length,
    actual, estimate, unsplitMinutes: unsplit, best,
  };
}

/** Сравнение с предыдущим периодом такой же длины: только при ≥ 3 активных днях в обоих. */
export function compare(cur: Day[], prev: Day[]): { delta: number; prevTotal: number } | null {
  if (cur.length !== prev.length || cur.length === 0) return null;
  const a = summarize(cur), b = summarize(prev);
  if (a.activeDays < 3 || b.activeDays < 3) return null;
  return { delta: a.total - b.total, prevTotal: b.total };
}

const WD = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
const MON = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const dt = (iso: string) => new Date(`${iso}T12:00:00`);
/** Подпись оси X: неделя — дни недели; 14 дней — числа через одно; 30 дней — каждое 5-е число. */
export function xLabel(iso: string, i: number, n: number): string {
  const d = dt(iso);
  if (n <= 7) return WD[d.getDay()];
  if (n <= 14) return i % 2 === (n - 1) % 2 ? String(d.getDate()) : "";
  return (n - 1 - i) % 5 === 0 ? String(d.getDate()) : "";
}
export const longDate = (iso: string): string => { const d = dt(iso); return `${WD[d.getDay()]}, ${d.getDate()} ${MON[d.getMonth()]}`; };
export const valueOf = (d: Day, m: Metric): number | null => (m === "minutes" ? d.study_minutes : d.tasks_done ?? null);
