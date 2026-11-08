import { roleContext } from "./roleContext";
import { accountKey } from "./identity";
/**
 * Демо-режим для сцены: ?demo=1 (или диплинк startapp=demo из бота).
 * НЕ подделывает продукт — включает тот же автономный движок (норматив → план → прогресс),
 * но: 1) без сети — ничего не зависит от Wi-Fi зала; 2) в отдельном пространстве
 * localStorage («demo:») — реальные данные ученика не трогаются; 3) при каждом
 * открытии начинается с чистого листа — прогон повторяется один в один. Refresh — НЕ новое
 * открытие (флаг в sessionStorage): таймер и отметки переживают перезагрузку и в демо.
 */
const params = (() => {
  try { return [new URLSearchParams(location.search), new URLSearchParams(location.hash.replace(/^#/, ""))]; }
  catch { return [new URLSearchParams()]; }
})();

export const DEMO: boolean = params.some((p) => p.get("demo") === "1" || p.get("startapp") === "demo" || p.get("WebAppStartParam") === "demo");

/** Ключ хранилища: в демо — свой неймспейс. */
export const nsKey = (k: string) => (DEMO ? `demo:${roleContext().role === "teacher" ? "teacher:" : ""}${k}` : accountKey(k));

/** Чистый лист демо: стираем только «demo:»-ключи. */
export function resetDemo(): void {
  try { Object.keys(localStorage).filter((k) => k.startsWith("demo:")).forEach((k) => localStorage.removeItem(k)); } catch { /* приватный режим */ }
}
if (DEMO) {
  let fresh = true;
  try { fresh = sessionStorage.getItem("demo:launched") !== "1"; sessionStorage.setItem("demo:launched", "1"); } catch { /* нет sessionStorage — каждый раз чисто */ }
  if (fresh) resetDemo();
}
