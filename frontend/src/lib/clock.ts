/**
 * Часы планировщика. Единственный источник «сейчас» для вечера:
 *  - реальное локальное время по умолчанию;
 *  - детерминированное время для демо/тестов: `?now=HH:MM` в адресе (запоминается
 *    в sessionStorage на вкладку) или `localStorage["sf.now"] = "HH:MM"`; `?now=off` — сброс.
 * План строится от max(выбранный старт, сейчас ↑ до 5 мин) — расписание никогда не
 * начинается в прошлом. Позже отбоя план не строим (бэкенд трактует end<=start как
 * «отбой завтра» — это дало бы бессмысленный план на всю ночь).
 */
import { toHHMM, toMin } from "./time";
import { resolveClock, type Clock } from "./dayEngine";

/**
 * v16: пояс школы (SCHOOL_TZ с сервера). Не задан → часы телефона, пояс НЕ угадываем.
 * Задан и расходится с телефоном → всё приложение считает по школе + предупреждение «+N ч».
 */
let schoolTz: string | null = null;
export function setSchoolTz(tz: string | null | undefined): boolean {
  const v = tz || null;
  if (v === schoolTz) return false;
  schoolTz = v; return true;
}
export const getSchoolTz = () => schoolTz;
/** Разрешённые часы «сейчас»: устройство vs школа. Детерминированное ?now/?today — как есть (для демо и тестов). */
export function clockNow(): Clock {
  const o = override(), d = dateOverride();
  if (o || d) {
    const base = d ?? isoLocal(new Date());
    const m = o ? toMin(o) : new Date().getHours() * 60 + new Date().getMinutes();
    return { now_local: `${base}T${toHHMM(m)}`, offset_min: -new Date().getTimezoneOffset(), source: "device", school_tz: schoolTz, device_offset_min: -new Date().getTimezoneOffset(), warning: null };
  }
  const now = new Date();
  return resolveClock(now, -now.getTimezoneOffset(), schoolTz);
}
const isoLocal = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const KEY = "sf.now";
const DKEY = "sf.today";
const DRE = /^\d{4}-\d{2}-\d{2}$/;
/** Граница учебного дня (как в day.ts): 00:00–03:59 — ещё «сегодняшняя» ночь. */
const DAY_EDGE = 4 * 60;

function override(): string | null {
  try {
    const q = new URLSearchParams(location.search).get("now");
    if (q === "off") { sessionStorage.removeItem(KEY); localStorage.removeItem(KEY); return null; }
    if (q && RE.test(q)) { sessionStorage.setItem(KEY, q); return q; }
    const s = sessionStorage.getItem(KEY) ?? localStorage.getItem(KEY);
    return s && RE.test(s) ? s : null;
  } catch { return null; }
}

/** Минуты от полуночи «сейчас» (с учётом детерминированного времени). */
export function nowMin(): number {
  const o = override();
  if (o) return toMin(o);
  if (schoolTz && !dateOverride()) { const c = clockNow(); return toMin(c.now_local.slice(11, 16)); }
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}
export const isClockFixed = (): boolean => override() !== null;
export const roundUp5 = (m: number): number => Math.ceil(m / 5) * 5;

export type PlanWindow =
  | { state: "ok"; start: string; fromNow: boolean; now: string }
  | { state: "afterBed"; now: string };

/**
 * Окно, от которого реально строится план.
 * fromNow — старт сдвинут на текущее время (выбранный старт уже прошёл).
 * afterBed — сейчас позже отбоя (или до 04:00 ночи): план не строим, предлагаем перенос.
 */
export function planWindow(userStart: string, bedtime: string, now = nowMin()): PlanWindow {
  const bed = toMin(bedtime);
  const nowS = toHHMM(now);
  if (now < DAY_EDGE || now >= bed) return { state: "afterBed", now: nowS };
  const up = roundUp5(now);
  const s = Math.max(toMin(userStart), up);
  if (s >= bed) return { state: "afterBed", now: nowS };
  return { state: "ok", start: toHHMM(s), fromNow: up > toMin(userStart), now: nowS };
}

/** Детерминированная ДАТА для демо/тестов: `?today=YYYY-MM-DD` (sessionStorage) или localStorage["sf.today"]. */
function dateOverride(): string | null {
  try {
    const q = new URLSearchParams(location.search).get("today");
    if (q === "off") { sessionStorage.removeItem(DKEY); localStorage.removeItem(DKEY); return null; }
    if (q && DRE.test(q)) { sessionStorage.setItem(DKEY, q); return q; }
    const s = sessionStorage.getItem(DKEY) ?? localStorage.getItem(DKEY);
    return s && DRE.test(s) ? s : null;
  } catch { return null; }
}
/** «Сейчас» как Date с учётом ?today и ?now — единственный источник для учебного дня и утра/вечера. */
export function nowDate(): Date {
  if (schoolTz && !override() && !dateOverride()) return new Date(`${clockNow().now_local}:00`);
  const d = dateOverride();
  const base = d ? new Date(`${d}T12:00:00`) : new Date();
  const m = nowMin();
  base.setHours(Math.floor(m / 60), m % 60, 0, 0);
  return base;
}
