/** v3.0 · вечерняя нагрузка по санитарной норме вместо «кубка очков» в шапке.
 *  СанПиН 1.2.3685-21, табл. 6.6 «Продолжительность выполнения домашних заданий»: 1 кл. — без д/з;
 *  2–3 кл. — 1,5 ч; 4–5 кл. — 2 ч; 6–8 кл. — 2,5 ч; 9–11 кл. — 3,5 ч. (В директиве упомянут СП 2.4.3648-20 —
 *  он про организацию обучения; нормы времени на домашние задания с 2021 г. стоят именно в табл. 6.6.) */
export const SANPIN_REF = "СанПиН 1.2.3685-21, табл. 6.6";
export function homeworkLimit(grade: string | number | null | undefined): number | null {
  const n = parseInt(String(grade ?? ""), 10);
  if (!Number.isFinite(n) || n < 1 || n > 11) return null;
  if (n === 1) return 0;
  return n <= 3 ? 90 : n <= 5 ? 120 : n <= 8 ? 150 : 210;
}
export type Load = { minutes: number; limit: number | null; level: "none" | "ok" | "near" | "over"; grade: number | null };
/** Сумма плановых минут д/з на сегодня против нормы класса: «near» — от 80 % нормы, «over» — выше нормы. */
export function eveningLoad(tasks: { planned_minutes: number }[], grade: string | number | null | undefined): Load {
  const minutes = Math.max(0, Math.round(tasks.reduce((s, t) => s + (Number.isFinite(t.planned_minutes) ? Math.max(0, t.planned_minutes) : 0), 0)));
  const limit = homeworkLimit(grade);
  const g = parseInt(String(grade ?? ""), 10);
  const level = limit === null ? "none" : minutes > limit ? "over" : limit > 0 && minutes >= limit * 0.8 ? "near" : "ok";
  return { minutes, limit, level, grade: Number.isFinite(g) ? g : null };
}
