/** v2.1 · Синтетические оценки ТОЛЬКО для демо-режима (?demo=1 / mock-дневник) — экран «Что, если…».
 *  Всегда показываются с пометкой «демо-оценки (пример, не из дневника)»; на сервер не отправляются. */
import type { MarkLike } from "./gradeTarget";

export interface DemoSubjectMarks { subject: string; topic: string; marks: readonly MarkLike[] }
export const DEMO_RECOVERY: readonly DemoSubjectMarks[] = [
  { subject: "Алгебра", topic: "Квадратные уравнения", marks: [{ value: "3" }, { value: "4" }, { value: "3", weight: 2 }, { value: "5" }, { value: "2" }] },
  { subject: "Русский язык", topic: "Обособленные определения", marks: [{ value: "4" }, { value: "3" }, { value: "4" }, { value: "4" }] },
];
