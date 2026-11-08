/**
 * v16.1 Модель сна: ОТБОЙ (bedtime) и ПОДЪЁМ (wakeTime) — два разных поля с разной семантикой.
 *
 *  отбой  — вечер учебного дня D:  «только сегодня» → day-ключ `bed` (lib/day, граница 04:00),
 *                                   «обычно»        → sf.prefs.usualBed;  иначе рекомендация сервера.
 *  подъём — утро дня D+1:           «обычно»        → sf.prefs.wake;      иначе settings.wake_time сервера.
 *  Хранится на устройстве (localStorage + зеркало MAX DeviceStorage), сервер о сне не знает:
 *  план строится запросом /calculate, куда отбой передаётся явно. Логические ключи прежние, физические ключи изолированы server-verified account namespace (Phase1).
 *
 * Сохранение — с проверкой: пишем, перечитываем, при расхождении откатываем и возвращаем ошибку.
 * Успех показывается только после подтверждённой записи; при ошибке введённое значение остаётся в форме.
 * Продолжительность сна считается через полночь: 22:00 → 06:45 = 8 ч 45 мин (а не «−15 ч 15 мин»).
 */
import { cache } from "./api";
import { dayStore } from "./day";
import { prefs } from "./bedtime";
import { BED_MAX, BED_MIN, toHHMM, toMin } from "./time";

export const WAKE_MIN = 4 * 60 + 30, WAKE_MAX = 11 * 60;      // 04:30–11:00
export { BED_MAX, BED_MIN } from "./time";                      // v18.1: границы отбоя — в чистом модуле (их использует и whatif)
export const MIN_SLEEP = 8 * 60;

/** Минуты сна от отбоя до подъёма с переходом через полночь. 0 — одинаковое время (некорректно). */
export function sleepSpan(bed: string, wake: string): number {
  const b = toMin(bed), w = toMin(wake);
  if (!Number.isFinite(b) || !Number.isFinite(w)) return 0;
  return (((w - b) % 1440) + 1440) % 1440;
}
export const clampT = (m: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, m));
export const stepTime = (t: string, d: number, lo: number, hi: number) => toHHMM(clampT(toMin(t) + d, lo, hi));

/** Подъём из настроек: выбор ученика → сервер → 06:45. */
export const wakeFor = (serverWake: string | null | undefined) => prefs.get().wake ?? serverWake ?? "06:45";

export interface WakeCheck { errors: string[]; warnings: string[]; sleep: number }
/**
 * Проверка подъёма: в допустимом окне, не позже «выход − сборы» (иначе противоречивый интервал),
 * сон не меньше 8 ч — предупреждение (решать ученику), не запрет.
 */
export function checkWake(wake: string, bed: string, leaveTomorrow: number | null, prepMin: number): WakeCheck {
  const errors: string[] = [], warnings: string[] = [];
  const w = toMin(wake);
  if (!/^\d{2}:\d{2}$/.test(wake) || !Number.isFinite(w)) errors.push("Время подъёма в формате ЧЧ:ММ.");
  else if (w < WAKE_MIN || w > WAKE_MAX) errors.push(`Подъём — между ${toHHMM(WAKE_MIN)} и ${toHHMM(WAKE_MAX)}.`);
  if (leaveTomorrow !== null && Number.isFinite(w) && w + prepMin > leaveTomorrow)
    errors.push(`Завтра выход в ${toHHMM(leaveTomorrow)}, на сборы ${prepMin} мин — подъём не позже ${toHHMM(leaveTomorrow - prepMin)}.`);
  const sleep = sleepSpan(bed, wake);
  if (sleep > 0 && sleep < MIN_SLEEP) warnings.push(`Сна будет ${Math.floor(sleep / 60)} ч${sleep % 60 ? ` ${sleep % 60} мин` : ""} — меньше 8 часов.`);
  return { errors, warnings, sleep };
}

/** Утро перед выходом: сколько минут на дела после подъёма (как lib/daycycle.morningBudget). */
export const morningMinutes = (wake: string, leave: number | null, prepMin: number) => (leave === null ? null : Math.max(0, leave - prepMin - toMin(wake)));

export interface WakeImpact { before: number | null; after: number | null; load: number; overflow: string[]; changesPlan: boolean }
/**
 * Что изменит новый подъём для УЖЕ созданного плана утра (задания, перенесённые на завтра утром).
 * changesPlan — утро не вмещает перенесённое (нужно явное подтверждение, расписание молча не меняем).
 */
export function wakeImpact(from: string, to: string, leave: number | null, prepMin: number, morning: { title: string; minutes: number }[]): WakeImpact {
  const before = morningMinutes(from, leave, prepMin), after = morningMinutes(to, leave, prepMin);
  const load = morning.reduce((a, x) => a + x.minutes, 0);
  const overflow: string[] = [];
  if (after !== null) { let used = 0; for (const x of morning) { used += x.minutes; if (used > after) overflow.push(x.title); } }
  const fitBefore = before === null || load <= before;
  return { before, after, load, overflow, changesPlan: overflow.length > 0 && (fitBefore || (before !== null && after !== null && after < before)) };
}

export type SaveResult = { ok: true } | { ok: false; error: string };
const BED_RANGE = `Сон — между ${toHHMM(BED_MIN)} и ${toHHMM(BED_MAX)}. Время не изменено.`;
const FAIL = "Не удалось сохранить: память телефона недоступна (приватный режим или нет места). Время не изменено.";

/** Подъём: сохраняем ТОЛЬКО wake (отбой и прочие настройки не трогаем), с проверкой и откатом. */
export function saveWake(wake: string): SaveResult {
  const prev = prefs.get();
  try {
    prefs.set({ wake });
    if (prefs.get().wake !== wake) throw new Error("verify");
    return { ok: true };
  } catch {
    try { cache.set("sf.prefs", prev); } catch { /* уже плохо */ }
    return { ok: false, error: FAIL };
  }
}

/** Отбой: «только сегодня» или «обычно». Подъём не трогаем. Проверка перечитыванием + откат. */
export function saveBed(bed: string, scope: "today" | "usual"): SaveResult {
  // v18.1 (D-03): отбой только в допустимом окне (клиентский план — до полуночи); «00:10» не сохраняем
  const m = /^\d{2}:\d{2}$/.test(bed) ? toMin(bed) : NaN;
  if (!(m >= BED_MIN && m <= BED_MAX)) return { ok: false, error: BED_RANGE };
  const prevPrefs = prefs.get(), prevToday = dayStore.bedToday();
  try {
    if (scope === "usual") { prefs.set({ usualBed: bed }); dayStore.setBedToday(null); }
    else dayStore.setBedToday(bed);
    const ok = scope === "usual" ? prefs.get().usualBed === bed && dayStore.bedToday() === null : dayStore.bedToday() === bed;
    if (!ok) throw new Error("verify");
    if (prefs.get().wake !== prevPrefs.wake) throw new Error("wake touched");
    return { ok: true };
  } catch {
    try { cache.set("sf.prefs", prevPrefs); dayStore.setBedToday(prevToday); } catch { /* */ }
    return { ok: false, error: FAIL };
  }
}
