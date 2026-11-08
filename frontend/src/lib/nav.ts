/** v18: навигация приложения (вкладки, роль → набор вкладок, hash-маршрут). Вынесено из main.tsx. */
import type { Role } from "./types";
import type { StudySeg } from "../screens/Study";
import { routeOf } from "./max";
import type { PracticeSeg } from "./practiceSeg";

export type Tab = "tonight" | "tutor" | "blitz" | "study";
export const TAB_META: Record<Tab, { icon: string; label: string; aria?: string }> = {
  // v3.2 · «Вечер» → «План дня»: id «tonight», #tonight и #tab-tonight сохранены для диплинков и E2E.
  tonight: { icon: "route", label: "План дня", aria: "План дня: дела, домашка и сон по времени" },
  tutor: { icon: "chat", label: "Тьютор" },
  // v3.0 · вкладка «Практика» (бывш. «Блиц»): id «blitz» и #tab-blitz сохранены для обратной совместимости E2E/диплинков.
  blitz: { icon: "target", label: "Практика", aria: "Практика: практикумы, блиц и квиз-опросы" },
  study: { icon: "cap", label: "Учёба" },
};
/** Teacher workspace owns Today/Classes/Materials; no student screens are allowed. */
/** v3.2 · порядок ученика: Учёба (открывается первой) | План дня | Тьютор | Практика. */
export const tabsFor = (r: Role): Tab[] => (r === "teacher" ? ["study"] : ["study", "tonight", "tutor", "blitz"]);
export const HOME_TAB: Tab = "study";
export function readHash(): { tab: Tab; seg?: StudySeg; sim?: boolean; practice?: PracticeSeg } {
  const h = routeOf(location.hash);   // P0-01: параметры запуска MAX после «&» не мешают маршруту
  if (h === "diary") return { tab: "study", seg: "diary" };
  // v2.2: «#grades» — Учёба → Дневник с раскрытым «Симулятором оценок» (кейс жюри «Ученик: оценка» после смены роли)
  if (h === "grades") return { tab: "study", seg: "grades", sim: true };
  if (h === "progress") return { tab: "study", seg: "progress" };
  // v2.2: «Учёба» открывается дневником, поэтому «#study» = дневник, а «Прогресс» — свой адрес «#progress»
  // (раньше прогресс писался как «#study» и после перезагрузки терялся: открывался дневник).
  if (h === "study") return { tab: "study", seg: "diary" };
  // v3.0: «#practice» — новый адрес вкладки «Практика» (= blitz), «#blitz» работает как раньше.
  // «#blitz» (диплинки, «Тренировка» вечера, вызовы) ведёт прямо в блиц, «#practice» — в практикумы.
  if (h === "practice") return { tab: "blitz", practice: "practicum" };
  if (h === "blitz") return { tab: "blitz", practice: "blitz" };
  // v3.2: без адреса открывается «Учёба»; «#tonight» — «План дня».
  return { tab: (["tonight", "tutor", "blitz", "study"] as Tab[]).includes(h as Tab) ? (h as Tab) : HOME_TAB };
}
