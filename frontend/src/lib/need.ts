/** v17: одна арифметика вечера для героя и карточки дефицита (правило №6 «цифры на экране сходятся»).
 *  Раньше герой показывал «2 задания 2 ч 15 мин» и «не хватает 1 ч 45», а карточка — «до сна 3 ч 40»:
 *  2:15 < 3:40, и дефицит выглядел ошибкой. Теперь рядом всегда «нужно N · до сна M». */
import type { PlanOut } from "./types";

export interface Need { need: number; cap: number; deficit: number; work: number; other: number }

export function needOf(r: Pick<PlanOut, "summary" | "deficit_minutes"> | null | undefined): Need | null {
  const s = r?.summary;
  if (!s || s.capacity_minutes === undefined) return null;
  const work = s.need_work_minutes ?? 0;
  const other = (s.need_fixed_minutes ?? 0) + (s.need_flexible_minutes ?? 0) + (s.need_rest_minutes ?? 0);
  return { need: work + other, cap: s.capacity_minutes, deficit: r!.deficit_minutes, work, other };
}
