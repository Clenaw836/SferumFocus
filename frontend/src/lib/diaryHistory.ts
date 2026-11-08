/**
 * Master v2.0 · Feature 2 — история дневника: даты, учебный год, праздники, «просрочено», свайп.
 * Чистые функции (тестируются в Node). Никаких выдуманных оценок/заданий: только классификация дат
 * и правила показа того, что пришло из источника.
 */
export const pad = (n: number) => String(n).padStart(2, "0");
export const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const fromIso = (s: string) => new Date(`${s}T12:00:00`);
export const isIso = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && iso(fromIso(s)) === s;
export const shift = (s: string, days: number) => { const d = fromIso(s); d.setDate(d.getDate() + days); return iso(d); };
export const mondayOf = (s: string) => { const d = fromIso(s); const wd = (d.getDay() + 6) % 7; d.setDate(d.getDate() - wd); return iso(d); };
export const WD_SHORT = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
export const WD_LONG = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
export const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
export const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
export const humanDate = (s: string) => { const d = fromIso(s); return `${WD_LONG[d.getDay()]}, ${d.getDate()} ${MONTHS_GEN[d.getMonth()]}${d.getFullYear() !== new Date().getFullYear() ? " " + d.getFullYear() : ""}`; };

/** Учебный год: 1 сентября — 31 августа следующего года (метка «2026/27»). */
export function schoolYear(s: string): { start: string; end: string; label: string } {
  const d = fromIso(s), y = d.getMonth() >= 8 ? d.getFullYear() : d.getFullYear() - 1;
  return { start: `${y}-09-01`, end: `${y + 1}-08-31`, label: `${y}/${String((y + 1) % 100).padStart(2, "0")}` };
}
/** Пределы навигации: с 1 сентября прошлого учебного года до конца следующего (≈ 3 учебных года). */
export function navBounds(today: string): { min: string; max: string } {
  const sy = schoolYear(today);
  return { min: shift(sy.start, -365).slice(0, 4) + "-09-01", max: `${Number(sy.end.slice(0, 4)) + 1}-08-31` };
}
export const clampDate = (s: string, b: { min: string; max: string }) => (s < b.min ? b.min : s > b.max ? b.max : s);

/** Нерабочие праздничные дни с фиксированной датой — ТК РФ, ст. 112. Переносы выходных и школьные
 *  каникулы зависят от года/региона/школы и здесь НЕ угадываются. */
const HOLIDAYS: Record<string, string> = {
  "01-01": "Новогодние каникулы", "01-02": "Новогодние каникулы", "01-03": "Новогодние каникулы", "01-04": "Новогодние каникулы",
  "01-05": "Новогодние каникулы", "01-06": "Новогодние каникулы", "01-07": "Рождество Христово", "01-08": "Новогодние каникулы",
  "02-23": "День защитника Отечества", "03-08": "Международный женский день", "05-01": "Праздник Весны и Труда",
  "05-09": "День Победы", "06-12": "День России", "11-04": "День народного единства",
};
export type DayKind = { kind: "holiday"; label: string } | { kind: "weekend"; label: string } | { kind: "summer"; label: string } | { kind: "school"; label: string };
export function dayKind(s: string, schoolWeek: 5 | 6): DayKind {
  const h = HOLIDAYS[s.slice(5)];
  if (h) return { kind: "holiday", label: `${h} — праздничный день (ТК РФ, ст. 112)` };
  const wd = fromIso(s).getDay();
  if (wd === 0 || (wd === 6 && schoolWeek === 5)) return { kind: "weekend", label: wd === 0 ? "Воскресенье — выходной" : "Суббота — выходной при пятидневке" };
  const m = fromIso(s).getMonth();
  if (m >= 5 && m <= 7) return { kind: "summer", label: "Обычно летние каникулы — уроков в источнике может не быть" };
  return { kind: "school", label: "Учебный день" };
}

/** «Просрочено» — только при подтверждённом сроке И статусе из источника (выдача учителя на сервере). */
export const OPEN_STATUSES = new Set(["assigned", "in_progress", "paused"]);
export function isOverdue(item: { due: string | null | undefined; status: string | null | undefined }, today: string): boolean {
  return isIso(item.due) && typeof item.status === "string" && OPEN_STATUSES.has(item.status) && item.due < today;
}

/** Выбранная дата живёт в пределах сессии: тот же календарный день и не дольше 2 часов, иначе — сегодня. */
export const KEEP_MS = 2 * 3600 * 1000;
export function restoreDate(raw: string | null, today: string, now: number, b: { min: string; max: string }): string {
  try {
    const o = raw ? JSON.parse(raw) as { d?: unknown; at?: unknown; on?: unknown } : null;
    if (o && isIso(o.d) && o.on === today && typeof o.at === "number" && now - o.at >= 0 && now - o.at <= KEEP_MS) return clampDate(o.d, b);
  } catch { /* повреждённое значение → сегодня */ }
  return today;
}

/**
 * Свайп по дням: горизонтальный жест листает, вертикальный — никогда. Направление «замыкается» по первым
 * 10 px движения; лист — при |dx| ≥ 56 px и |dx| ≥ 2·|dy| (≈ 27°), либо быстрый рывок ≥ 36 px за ≤ 250 мс.
 */
export function createSwipe() {
  let x0 = 0, y0 = 0, t0 = 0, lock: "h" | "v" | null = null, on = false;
  return {
    start(x: number, y: number, t: number) { x0 = x; y0 = y; t0 = t; lock = null; on = true; },
    move(x: number, y: number): "h" | "v" | null {
      if (!on || lock) return lock;
      const dx = Math.abs(x - x0), dy = Math.abs(y - y0);
      if (dx < 10 && dy < 10) return null;
      lock = dx > dy * 1.2 ? "h" : "v";
      return lock;
    },
    /** -1 — к прошлому дню (палец вправо), +1 — к следующему (палец влево), 0 — не листать. */
    end(x: number, y: number, t: number): -1 | 0 | 1 {
      if (!on) return 0; on = false;
      if (lock === "v") return 0;
      const dx = x - x0, dy = Math.abs(y - y0), adx = Math.abs(dx), dt = t - t0;
      const ok = (adx >= 56 && adx >= dy * 2) || (adx >= 36 && dt <= 250 && adx >= dy * 2);
      return ok ? (dx > 0 ? -1 : 1) : 0;
    },
    cancel() { on = false; lock = null; },
  };
}
