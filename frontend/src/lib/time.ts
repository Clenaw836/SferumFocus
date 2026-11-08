/** Допустимый отбой 15:00–23:55: как в настройках вечера (план клиента — до полуночи, см. clock.planWindow). */
export const BED_MIN = 15 * 60, BED_MAX = 23 * 60 + 55;

export const toMin = (hhmm: string): number => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
};
export const toHHMM = (min: number): string => {
  const v = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(v / 60)).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`;
};
/** «135» → «2 ч 15 мин», «40» → «40 мин». */
export const dur = (min: number): string => {
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60), r = m % 60;
  if (!h) return `${r} мин`;
  return r ? `${h} ч ${r} мин` : `${h} ч`;
};
export const plural = (n: number, one: string, few: string, many: string): string => {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
};
const WD = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
export const dayTitle = (iso: string | undefined): string => {
  const d = iso ? new Date(iso + "T12:00:00") : new Date();
  return `${WD[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`;
};
export const weekdayShort = (iso: string): string => WD[new Date(iso + "T12:00:00").getDay()];
export const nowHHMM = (): string => toHHMM(new Date().getHours() * 60 + new Date().getMinutes());
