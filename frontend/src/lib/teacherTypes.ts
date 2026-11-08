/** v17 Teacher Intelligence — контракты ответов /api/v1/teacher/* (app/teacher_mode.py). */
export interface TmPerson { id: string; school_id: string; full_name: string; role_note?: string | null; subjects: string[]; classes: string[] }
export interface TmDirectory { source: "demo" | "school"; is_demo: boolean; schools: { id: string; name: string }[]; teachers: TmPerson[]; scenarios?: string[] }
export interface TmAssignment { class: string; subject: string; perms: Record<string, boolean> }
export interface TmProfile extends TmPerson { school: { id: string; name: string }; source: string; is_demo: boolean; assignments: TmAssignment[]; can_approve: boolean; grade_supported: boolean; grade_note: string }
export interface TmLesson {
  id: string; date: string; n: number; start: string; end: string; class: string; subject: string; room: string | null; group: string | null;
  teacher_id: string | null; topic: string | null; topic_source: string | null; source: string; confirmation: string; status: "active" | "cancelled";
  notes: string[]; duration_min: number; is_demo: boolean; was?: Record<string, string | null>;
}
export type TmState = "ok" | "no_lessons" | "not_loaded" | "partial" | "pending_import" | "stale" | "unavailable" | "conflict";
export interface TmDay { date: string; state: TmState; lessons: TmLesson[]; conflicts: string[][]; meta: { source: string; source_label: string; last_sync_at: string | null; stale: boolean };
  pending_proposals: string[]; changes: string[]; is_demo: boolean; next: TmLesson | null; profile: TmProfile }
export interface TmRow { student: string; answers: (boolean | null)[]; answered: number; correct: number; correct_pct: number | null }
export interface TmQuestion { id: string; text: string; topic: string | null; topic_link_confirmed: boolean; answered: number; correct_pct: number | null }
export interface TmResults { available: boolean; reason?: string; is_demo: boolean; class: string; subject: string; check: { id: string; kind: string; title: string; date: string; questions: number; period: string };
  class_size: number; responded: number; insufficient: boolean; rows: TmRow[]; questions: TmQuestion[]; hardest: TmQuestion[]; caveat: string; order?: string }
export interface TmRec { kind: "data" | "general" | "missing"; text: string; basis: string }
export interface TmMaterial { id?: string; title: string; org?: string; author?: string | null; url?: string | null; license?: string | null; checked_at?: string; kind?: string; priority?: number; topic?: string | null }
export interface TmMaterials { teacher: TmMaterial[]; official: TmMaterial[]; note: string }
export interface TmStage { title: string; minutes: number; text: string }
export interface TmPlan { lesson_id: string; duration_min: number; topic: string | null; stages: TmStage[]; adaptation: string; status: "draft" | "saved"; note?: string; saved_at?: string }
export interface TmPrep { lesson: TmLesson; facts: { k: string; v: string; source: string }[]; stats: null | { check: TmResults["check"]; responded: number; class_size: number; insufficient: boolean; hardest: TmQuestion[]; caveat: string };
  stats_note: string | null; recommendations: TmRec[]; check_questions: { text: string; basis: string }[]; materials: TmMaterials; is_demo: boolean; ai_used: boolean; plan: TmPlan | null }
export interface TmPreviewRow { id: string; row: number; raw: string; date: string | null; n: number | null; start: string | null; end: string | null; class: string | null; subject: string | null; room: string | null;
  teacher_name: string | null; kind: string; kind_label: string; unrecognized: string[]; confidence: number; owner: string; owner_teacher?: TmPerson; owner_candidates?: TmPerson[];
  effect: "new" | "changed" | "cancelled" | "same" | "nothing_to_cancel"; was?: Record<string, string | null>; conflict: string | null; blocked: string[]; applicable: boolean }
export interface TmPreview { ok: boolean; token: string; rows: TmPreviewRow[]; groups: Record<string, string[]>; conflicts: string[]; unrecognized: string[]; duplicate_of: null | { journal_id: string; at: string };
  source_kind: string; confidence: number; is_demo: boolean; official: boolean; note: string }
export interface TmConfirm { ok: boolean; repeat?: boolean; journal_id?: string; applied?: string[]; proposed?: string[]; proposal_id?: string | null; error?: string }
export interface TmJournal { id: string; at: string; applied: string[]; proposed: string[]; proposal_id: string | null; reverted: boolean; source_kind: string }
export interface TmProposal { id: string; status: string; by: string; at: string; source_kind: string; official: boolean; changes: { date: string; n: number; class: string; subject: string; start: string; end: string; room: string | null; kind_label: string; teacher_id: string }[];
  affected_teachers: string[]; affected_classes: string[] }
