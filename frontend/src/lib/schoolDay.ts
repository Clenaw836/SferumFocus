/**
 * Учебный день по местному времени с границей в 04:00 (см. day.ts). Вынесен в модуль без побочных эффектов
 * (только clock.ts), чтобы синхронизация репетитора и офлайн-юнит-тесты не тянули api.ts/DOM при импорте.
 */
import { nowDate } from "./clock";

const pad = (n: number) => String(n).padStart(2, "0");
export function schoolDay(d = nowDate(), offsetDays = 0): string {
  const x = new Date(d.getTime() - 4 * 3600e3);
  x.setDate(x.getDate() + offsetDays);
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
}

/** v3.2.1 · Минуты учебного дня: 00:00–03:59 — это ещё «вчерашний» учебный день (граница 04:00), поэтому
 *  00:20 = 24:20, а не «утро до уроков». Без этого ночью вчерашние уроки считались предстоящими
 *  (вкладка «Учёба» показывала прошедший день как «сегодня», а ДЗ к прошедшим урокам вставали в план). */
export const ROLLOVER_MIN = 4 * 60;
export function schoolDayMin(clockMin: number): number {
  return clockMin < ROLLOVER_MIN ? clockMin + 24 * 60 : clockMin;
}
