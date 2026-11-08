// v3.2 — помощник выгрузки отметок в СГО (учительский журнал).
// Чистые функции без DOM: используются в ui/SgoJournal.tsx и в unit-тестах.

export type SgoMark = 2 | 3 | 4 | 5;

/** Предложение отметки по проценту выполнения ДЗ. Пороги совпадают с backend
 *  app/sgo_teacher_client.py::suggest_mark (≥85→5, ≥65→4, ≥45→3, иначе 2). */
export function suggestMark(percent: number | null | undefined): SgoMark | null {
  if (percent === null || percent === undefined) return null;
  const p = Number(percent);
  if (!Number.isFinite(p)) return null;
  if (p >= 85) return 5;
  if (p >= 65) return 4;
  if (p >= 45) return 3;
  return 2;
}

/** Нормализация ФИО для сопоставления ученика Фокуса и ученика СГО:
 *  регистр, ё→е, лишние пробелы и знаки препинания не влияют. */
export function normName(name: string | null | undefined): string {
  return String(name || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9\s-]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Ключ «фамилия + имя» — СГО часто отдаёт ФИО с отчеством, а в Фокусе его нет. */
export function nameKey(name: string | null | undefined): string {
  return normName(name).split(" ").slice(0, 2).sort().join(" ");
}

export interface SgoStudent { student_id: string | number; student_name: string }
export interface FocusStudent { name: string; avg_percent?: number | null }
export interface MarkRow {
  student_id: string | number;
  student_name: string;
  percent: number | null;
  mark: SgoMark | null;
  matched: boolean;
}

/** Сопоставляет журнал СГО с результатами ДЗ в Фокусе. Ученики без пары
 *  остаются в списке с mark=null — учитель видит их и решает сам. */
export function buildMarkRows(sgo: SgoStudent[], focus: FocusStudent[]): MarkRow[] {
  const byFull = new Map<string, FocusStudent>();
  const byKey = new Map<string, FocusStudent | null>();
  for (const f of focus || []) {
    byFull.set(normName(f.name), f);
    const k = nameKey(f.name);
    byKey.set(k, byKey.has(k) ? null : f); // null = неоднозначно, не угадываем
  }
  return (sgo || []).map((s) => {
    const hit = byFull.get(normName(s.student_name)) ?? byKey.get(nameKey(s.student_name)) ?? null;
    const percent = hit && typeof hit.avg_percent === "number" ? hit.avg_percent : null;
    return {
      student_id: s.student_id,
      student_name: s.student_name,
      percent,
      mark: suggestMark(percent),
      matched: !!hit,
    };
  });
}

export const MAX_MARKS_PER_BATCH = 45;

// ---------- ответы /api/v1/teacher/sgo/* (app/sgo_teacher_client.py) ----------
export interface SgoStatus { linked: boolean; write_enabled: boolean; mode: string; max_marks_per_batch: number; note?: string }
export interface SgoClass { class_id: number; class_name: string; grade: number | null; students_count: number | null; subjects: { id: number | null; name: string | null }[] }
export interface SgoLesson {
  date: string; classmeeting_id: number; class_id: number | null; class_name: string | null; subject_id: number | null;
  subject: string | null; number: number | null; start: string | null; end: string | null; room: string | null; topic: string | null;
}
export interface SgoGradebook { class_id: number; subject_id: number; students: SgoStudent[]; assignment_types?: unknown[] }
export interface SgoSendResult {
  dry_run?: boolean; write_enabled?: boolean; confirm_required?: boolean; would_send?: unknown; note?: string;
  ok?: boolean; sgo_assignment_id?: number | null; sent?: unknown; exported_count?: number; checked_count?: number;
}

/** «8А», «8 а», «8-А» → «8а»: сравнение класса Фокуса с классом СГО. */
export function classKey(name: string | null | undefined): string {
  return String(name || "").toLowerCase().replace(/ё/g, "е").replace(/[\s\-–—«»"'.]/g, "");
}

/** Строит тело запроса POST /api/v1/teacher/sgo/gradebook/marks/export
 *  (модель ExportMarksBatchRequest: целые id, 2..5, ≤45, один ученик — одна отметка). */
export function marksPayload(
  rows: MarkRow[], classmeetingId: number | string, assignmentId: number | string, dryRun: boolean,
) {
  const seen = new Set<number>();
  const marks: { student_id: number; mark: number }[] = [];
  for (const r of rows) {
    const id = Number(r.student_id);
    if (r.mark === null || !Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    marks.push({ student_id: id, mark: r.mark });
  }
  return {
    classmeeting_id: Number(classmeetingId) || 0,
    assignment_id: Number(assignmentId) || 0,
    marks: marks.slice(0, MAX_MARKS_PER_BATCH),
    dry_run: dryRun,
    confirm: !dryRun,
  };
}
