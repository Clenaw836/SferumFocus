// v17.1 — контракты app/student_tools.py (1:1).
export interface TaskDetails {
  title: string; subject: string | null; text: string; refs: string[];
  source: string; teacher: string | null; issued_on: string | null;
  due: string | null; due_source: string | null;
  topic: string | null; topic_source: string;
  planned_minutes: number; estimate_source: string; type: string | null;
  is_demo: boolean; notice: string | null;
}
export interface CloseQuiz {
  ok: boolean; quiz_id: string | null; questions: { question: string; options: string[] }[];
  topic?: string | null; confidence: number; confidence_label?: string; pass_share?: number; message?: string; source?: string;
}
export interface CloseQuizResult { ok: boolean; title: string; correct: number; total: number; passed: boolean; marks: boolean[]; right: number[]; why: string[] }
export interface BuilderExtra { title: string; start: string | null; minutes: number }
export interface BuilderParams {
  date: string; start: string; lessons: number; lesson_minutes: number; break_minutes: number;
  long_break_after: number | null; long_break_minutes: number; subjects: string[];
  travel_minutes: number; extras: BuilderExtra[]; rest_minutes: number; homework_minutes: number; bedtime: string;
}
export interface BuilderOut {
  date: string; lessons: { n: number; subject: string; start: string; end: string }[];
  last_bell: string; home_at: string;
  extras: { title: string; start: string | null; end: string | null; minutes: number; conflict: boolean }[];
  forecast: { free_minutes: number; extras_minutes: number; rest_minutes: number; homework_minutes: number; left_minutes: number; status: "ok" | "tight" | "overload"; homework_start: string; done_by: string | null; tips: string[] };
  import_payload: string; named: boolean;
}
