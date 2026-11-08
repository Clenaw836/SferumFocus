/** v17: порядок строк результатов класса. Совпадает с app/teacher_mode.sort_rows (тест — tests/unit/v17.test.mts).
 *  best: % верных ↓, ответов ↓, имя ↑; без данных — в конце (не «лучшие»). alpha: имя ↑. Сортировка стабильная. */
import type { TmRow } from "./teacherTypes";
import type { HeatRow } from "./types";

export type ResOrder = "best" | "alpha";
export const RES_ORDER_LABEL: Record<ResOrder, string> = { best: "сначала лучшие", alpha: "по алфавиту" };

export function sortResults(rows: TmRow[], order: ResOrder): TmRow[] {
  const name = (a: TmRow, b: TmRow) => a.student.localeCompare(b.student, "ru");
  const out = rows.slice();
  if (order === "alpha") return out.sort(name);
  return out.sort((a, b) =>
    (a.correct_pct == null ? 1 : 0) - (b.correct_pct == null ? 1 : 0)
    || (b.correct_pct ?? 0) - (a.correct_pct ?? 0)
    || b.answered - a.answered
    || name(a, b));
}

/** Тон строки — по доле ОШИБОК (та же шкала, что карта ДЗ): 100 − % верных. */
export const errorPct = (r: TmRow): number | null => (r.correct_pct == null ? null : 100 - r.correct_pct);

/** Сумма минут этапов плана и её соответствие длительности урока. */
export function planBalance(stages: { minutes: number }[], duration: number): { total: number; diff: number; ok: boolean } {
  const total = stages.reduce((s, x) => s + (Number.isFinite(x.minutes) ? x.minutes : 0), 0);
  return { total, diff: duration - total, ok: total === duration && stages.every((x) => x.minutes > 0) };
}

/** Следующий будний день (сб/вс пропускаем) — для «Уроков нет» в выходной. */
export function nextWorkday(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  do d.setDate(d.getDate() + 1); while (d.getDay() === 0 || d.getDay() === 6);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}


const FIELD: Record<string, string> = { start: "начало", end: "конец", room: "кабинет", subject: "предмет", class: "класс", teacher_id: "учитель" };
/** «Было» — только реально изменившиеся поля, по-русски. */
export function wasText(was: Record<string, string | null> | undefined, now: Record<string, unknown>): string {
  if (!was) return "";
  return Object.entries(was).filter(([k, v]) => (now[k] ?? null) !== v).map(([k, v]) => `${FIELD[k] ?? k} ${v ?? "—"}`).join(", ");
}

/** Карта ДЗ (прежняя тепловая карта). */
/** Порядок строк: стабильный, при равенстве — по имени. «best» — сначала лучшие (меньше ошибок). */
export type HwOrder = "best" | "alpha" | "attention";
export const HW_ORDER_LABEL: Record<HwOrder, string> = { best: "сначала лучшие", alpha: "по алфавиту", attention: "сначала требующие внимания" };
export function sortHeatRows<T extends { r: HeatRow; e: number | null }>(rows: T[], order: HwOrder): T[] {
  const name = (a: T, b: T) => a.r.display_name.localeCompare(b.r.display_name, "ru");
  const out = rows.slice();
  if (order === "alpha") return out.sort(name);
  if (order === "attention") return out.sort((a, b) => (b.e ?? -1) - (a.e ?? -1) || a.r.submitted_tasks - b.r.submitted_tasks || name(a, b));
  // без данных (e == null) — в конце, а не «лучшими»
  return out.sort((a, b) => (a.e == null ? 1 : 0) - (b.e == null ? 1 : 0) || (a.e ?? 0) - (b.e ?? 0) || b.r.submitted_tasks - a.r.submitted_tasks || name(a, b));
}

