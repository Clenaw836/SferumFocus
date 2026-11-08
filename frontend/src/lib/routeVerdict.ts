/** v3.2.1 · вердикт под маршрутом дня (чистая функция, тестируется без DOM). */
import { dur, toMin } from "./time";
import { eveningLoad } from "./sanpin";

type RouteSlot = { start: string; end: string; kind: string };
/** Вердикт под маршрутом: «В 19:15 все уроки будут закрыты! С 19:15 до 22:30 — свободный вечер. Норма СанПиН соблюдена». */
export function verdict(slots: RouteSlot[], tasks: { planned_minutes: number }[], grade: string | number | null | undefined, bedtime: string): string | null {
  const study = slots.filter((s) => s.kind === "study");
  if (!study.length) return null;
  const end = study[study.length - 1].end, load = eveningLoad(tasks, grade);
  const free = toMin(bedtime) - toMin(end);
  const norm = load.limit === null ? "" : load.level === "over" ? ` Нагрузка выше нормы СанПиН на ${dur(load.minutes - load.limit)} — часть лучше перенести.` : " Норма СанПиН соблюдена.";
  // v3.2.1 · честный вердикт: если до сна в маршрут влезла только часть заданий, не обещаем «всё закрыто».
  const planned = study.reduce((a, x) => a + Math.max(0, toMin(x.end) - toMin(x.start)), 0);
  const need = tasks.reduce((a, t) => a + Math.max(0, t.planned_minutes || 0), 0);
  if (need - planned > 5) return `До сна в маршрут помещается ${dur(planned)} из ${dur(need)}. Остальное (${dur(need - planned)}) — перенос на утро или завтра, см. ниже.${norm}`;
  return `В ${end} все уроки будут закрыты!${free > 0 ? ` С ${end} до ${bedtime} — свободный вечер.` : ""}${norm}`;
}
