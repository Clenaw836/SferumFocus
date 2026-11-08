/** v2.1 · Честные состояния оценок. Причина прежнего бага: экран показывал «Показ оценок скрыт в настройках
 *  приватности» по флагу `private` — а это настройка push-уведомлений (по умолчанию true), а не скрытие оценок.
 *  Теперь скрытие — только явный выбор пользователя (profile.hide_grades → grades_state = "privacy_hidden"). */
import type { GradesState } from "./api";

export type GradeView = "privacy_hidden" | "empty" | "upstream_error" | "sgo_unlinked" | "ok";
export interface GradesLike { grades: readonly unknown[]; grades_state?: GradesState; hide_grades?: boolean; snapshot_available?: boolean; is_stale?: boolean }
/** Оценки показаны из сохранённой копии: новый сервер говорит grades_state="stale_cache", старый — только is_stale. */
export const gradesFromCache = (data: GradesLike | null): boolean =>
  !!data && data.grades.length > 0 && (data.grades_state === "stale_cache" || (data.is_stale === true && data.grades_state !== "privacy_hidden"));

export function gradeView(data: GradesLike | null, failed: boolean): GradeView {
  if (!data) return failed ? "upstream_error" : "sgo_unlinked";
  const state = data.grades_state;
  if (state === "privacy_hidden" || (state === undefined && data.hide_grades === true)) return "privacy_hidden";
  if (state === "sgo_unlinked" || state === "upstream_error") return state;
  // stale_cache — те же оценки, что и «ok», плюс пометка «сохранённая копия» (см. gradesFromCache).
  if (!data.grades.length) return state === undefined && data.snapshot_available === false ? "sgo_unlinked" : "empty";
  return "ok";
}
export const GRADE_COPY = {
  privacy_hidden: "Оценки скрыты в настройках приватности",
  empty: "За выбранный период оценок пока нет",
  upstream_error: "Школьный сервер сейчас не отвечает",
  sgo_unlinked: "Дневник не подключён — оценки появятся после подключения",
  stale: "Дневник временно не отвечает — показана сохранённая копия",
} as const;
