/**
 * Гибкий сон. Не одна настройка навсегда:
 *  recommended — рекомендация (по классу/школе), usual — «обычно» (выбирает ученик),
 *  today — только на сегодня. Отбой на сегодня = today ?? usual ?? recommended.
 * Минимальный сон — ограничение: позже (подъём − 8 ч) помощник не советует сам, но и не запрещает.
 * Если 4 дня подряд сон позже рекомендованного — один мягкий вопрос, без морали, не чаще раза в день.
 */
import { cache } from "./api";
import { dayStore, schoolDay } from "./day";
import { nowDate } from "./clock";
import { toHHMM, toMin } from "./time";

export const MIN_SLEEP = 8 * 60;
export interface Prefs { usualBed?: string | null; wake?: string | null; travel?: number | null; prep?: number | null }
const P = "sf.prefs", LOG = "sf.bedlog", SNOOZE = "sf.beddrift.snooze";
export const prefs = {
  get(): Prefs { return cache.get<Prefs>(P) ?? {}; },
  set(p: Prefs) { cache.set(P, { ...prefs.get(), ...p }); },
};
/** «23:30» → минуты на шкале вечера: 00:30 = 24:30, чтобы «позже» сравнивалось честно. */
export const bedScale = (hhmm: string) => { const m = toMin(hhmm); return m < 12 * 60 ? m + 1440 : m; };
export const latestHealthyBed = (wake: string) => toHHMM(toMin(wake) - MIN_SLEEP + 1440);

export function bedFor(recommended: string): { today: string | null; usual: string; recommended: string; effective: string } {
  const usual = prefs.get().usualBed ?? recommended;
  const today = dayStore.bedToday();
  return { today, usual, recommended, effective: today ?? usual };
}
export function logBed(bed: string) {
  const log = cache.get<Record<string, string>>(LOG) ?? {};
  log[schoolDay()] = bed;
  const keys = Object.keys(log).sort().slice(-14);
  cache.set(LOG, Object.fromEntries(keys.map((k) => [k, log[k]])));
}
/** v18.1 (D-11): запись журнала за сегодня — чтобы «Отменить» вернул её точно (null — записи не было). */
export const bedLogToday = (): string | null => (cache.get<Record<string, string>>(LOG) ?? {})[schoolDay()] ?? null;
export function setBedLogToday(v: string | null) {
  const log = { ...(cache.get<Record<string, string>>(LOG) ?? {}) };
  if (v === null) delete log[schoolDay()]; else log[schoolDay()] = v;
  cache.set(LOG, log);
}
/** Мягкий сигнал о сдвиге режима: последние 4 учебных дня сон позже рекомендованного хотя бы на 30 мин. */
export function driftNotice(recommended: string, log = cache.get<Record<string, string>>(LOG) ?? {}, today = schoolDay(nowDate())): { days: number; recommended: string } | null {
  if (cache.get<string>(SNOOZE) === today) return null;
  const days = Object.keys(log).sort().filter((d) => d < today).slice(-4);   // прошедшие вечера; сегодняшний ещё не случился
  if (days.length < 4) return null;
  const late = days.every((d) => bedScale(log[d]) >= bedScale(recommended) + 30);
  return late ? { days: 4, recommended } : null;
}
export const snoozeDrift = () => cache.set(SNOOZE, schoolDay(nowDate()));
