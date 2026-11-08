/** Recovery 2: contracts of /api/v1/teacher/hw/* and /api/v1/student/* (see docs/recovery-2/API.md). */
export type HwStatus = "assigned" | "in_progress" | "paused" | "completed" | "revoked";
export type HwAction = "start" | "pause" | "resume" | "complete";
export type HwReason = "pause" | "break" | "drop" | "switch" | "resume" | "next_round" | "timer" | "list" | "restore";

/** One individual assignment as the student sees it (initial-state.teacher_assignments). */
export interface TeacherAssignment {
  issue_id: string; template_id: string; task_title: string; class: string; subject: string; title: string;
  instructions: string; type: "written" | "oral"; planned_minutes: number; due_date: string | null;
  teacher_name: string | null; status: HwStatus; issued_at: string; first_started_at: string | null;
  completed_at: string | null; completed_study_day: string | null; timer_sec: number; confirmed_sec: number;
  running_since: string | null; segments: number; pomodoro_round: number; revision: number;
  snapshot_revision: number; is_demo: boolean; server_now?: string | null;
  /** v2: «quiz» — блиц-опрос; seen_at — когда ученик открыл выдачу (индикатор «Новое» гаснет). */
  kind?: HwKind; seen_at?: string | null; quiz?: QuizSummary | null;
}
export interface HwEvent {
  seq: number; kind: "issued" | "reissued" | "started" | "paused" | "resumed" | "completed" | "revoked" | "updated";
  label: string; actor: "teacher" | "student" | "system"; received_at: string; effective_at: string;
  delay_sec: number; delayed: boolean; status_before: HwStatus | null; status_after: HwStatus; payload: Record<string, unknown>;
}
export interface HwTransitionResult { issue: Omit<TeacherAssignment, "task_title">; changed: boolean; event: HwEvent | null; auto_paused: string[] }
export interface HwCode { code: string; expires_at: string; created_at: string }
export interface HwClass { class: string; subjects: string[]; active: number; pending: number; code: HwCode | null }
export interface HwOverview { source: "demo" | "school"; is_demo: boolean; teacher_name: string; classes: HwClass[] }
export interface HwMember { roster_id: string; class: string; display_name: string; status: "pending" | "active" | "rejected" | "removed" | "left"; origin: string; requested_at: string; decided_at: string | null; access?: HwAccess; last_activity_at?: string | null }
export interface HwRoster { class: string; code: HwCode | null; members: HwMember[]; is_demo: boolean }
export type HwCounts = Record<HwStatus, number> & { total: number };
export interface HwTemplate {
  template_id: string; class: string; subject: string; title: string; instructions: string; type: "written" | "oral";
  planned_minutes: number; due_date: string | null; revision: number; created_at: string; updated_at: string;
  archived_at: string | null; is_demo: boolean; counts: HwCounts; kind?: HwKind; quiz?: QuizBrief | null;
}
export interface HwIssueRow {
  issue_id: string; roster_id: string; display_name: string; member_status: string | null; status: HwStatus;
  issued_at: string; first_started_at: string | null; completed_at: string | null; revoked_at: string | null;
  timer_sec: number; confirmed_sec: number; wall_sec: number | null; segments: number; pomodoro_round: number;
  running: boolean; running_since: string | null; last_signal_at: string | null; client_elapsed_sec: number | null;
  snapshot_revision: number; revision: number; updated_at: string; delayed_events: number;
  kind?: HwKind; seen_at?: string | null; access?: HwAccess; quiz?: QuizSummary | null; manual?: ManualResult | null;
}
export interface HwTemplateDetail { template: HwTemplate; students: HwIssueRow[]; not_issued: HwMember[]; server_now: string }
export interface HwIssueDetail { issue: HwIssueRow & { title: string; subject: string; class: string; planned_minutes: number; due_date: string | null }; template: HwTemplate | null; events: HwEvent[]; server_now: string }
export interface HwIssueResult { template: HwTemplate; created: string[]; reissued: string[]; already: string[] }
export interface HwMembership { membership_id: string; class: string; teacher_name: string | null; display_name: string; status: HwMember["status"]; requested_at: string; decided_at: string | null; is_demo: boolean }
export interface HwNewTemplate { class: string; subject: string; title: string; instructions: string; type: "written" | "oral"; planned_minutes: number; due_date: string | null; roster_ids: string[]; allow_duplicate?: boolean; kind?: HwKind; quiz?: QuizDraft; whole_class?: boolean }

/* ---------- v2: блиц-опросы учителя, смешанный класс ---------- */
export type HwKind = "task" | "quiz";
/** «offline» — ученик без приложения: есть только в списке учителя, результат вносит учитель. */
export type HwAccess = "app" | "offline";
export type QuizKind = "single" | "multi" | "short";
export interface QuizQuestionDraft { kind: QuizKind; text: string; options: string[]; correct: number[]; answers: string[]; points: number; explain: string }
export type QuizOrigin = "manual" | "ai" | "ai_edited" | "bank";
export interface QuizDraft { topic: string; origin: QuizOrigin; questions: QuizQuestionDraft[]; time_limit_min: number | null; show_answers: boolean; reviewed?: boolean }
export interface QuizBrief { count: number; max_score: number; time_limit_min: number | null; origin: string; topic: string; show_answers: boolean }
export interface QuizSummary { count: number; max_score: number; time_limit_min: number | null; state: "not_started" | "started" | "submitted"; started_at: string | null; submitted_at: string | null; score: number | null; late: boolean; overtime: boolean }
/** v2.2 · как сдана работа без приложения: «Сдал(а) устно» / «На листочке» (баллы можно добавить позже). */
export type ManualHow = "oral" | "paper";
export interface ManualResult { score: number | null; max_score: number | null; note: string; entered_at: string | null; how?: ManualHow | null }
export interface QuizQuestionStat { id: string; kind: QuizKind; text: string; answered: number; correct: number; correct_pct: number | null; options: { text: string; picked: number; is_correct: boolean }[]; top_wrong: [string, number][] }
export interface QuizStats {
  received: number; with_app: number; without_app: number; seen: number; started: number; submitted: number; manual: number;
  manual_oral?: number; manual_paper?: number;
  not_started: number; in_progress: number; late: number; overtime: number; avg_pct: number | null; results: number;
  buckets: Record<string, number>; questions: QuizQuestionStat[]; older_version: number; insufficient: boolean;
}
export interface TeacherQuiz { template_id: string; quiz: QuizDraft & { questions: (QuizQuestionDraft & { id: string })[] }; stats: QuizStats | null; server_now: string }
export interface StudentQuizQuestion { id: string; kind: QuizKind; text: string; options: string[]; points: number;
  result?: { answered: boolean; correct: boolean; choice?: number[]; text?: string }; correct?: number[]; answers?: string[]; explain?: string }
export interface StudentQuiz {
  issue_id: string; title: string; subject: string; class: string; teacher_name: string | null; instructions: string; status: HwStatus;
  state: "not_started" | "started" | "submitted" | "closed"; count: number; max_score: number; time_limit_min: number | null; show_answers: boolean;
  started_at: string | null; deadline_at: string | null; submitted_at: string | null; score: number | null; late: boolean; overtime: boolean;
  due_date: string | null; manual: ManualResult | null; questions: StudentQuizQuestion[]; is_demo: boolean; server_now: string; changed?: boolean;
}
export interface QuizAnswer { id: string; choice?: number[]; text?: string }
export interface QuizDraftRequest { class: string; subject: string; topic: string; count: number; difficulty: "easy" | "normal" | "hard"; notes: string; source?: "ai" | "bank"; variant?: number }
/** v2.2 · встроенный банк: темы с генераторами задач по предмету (без ИИ и без сети). */
export interface QuizBankTopics { subject: string; supported: boolean; topics: { key: string; title: string }[] }
export interface QuizDraftResult { draft: QuizDraft; dropped: number; source: string; notice: string; variant?: number; families?: string[] }

/** R-08 · class report for a period (server: GET /teacher/hw/report; only recorded facts). */
export interface HwReportRow { name: string; issued: number; completed: number; overdue_open: number; avg_percent: number | null; results: number }
export interface HwReportAssignment { template_id: string; title: string; subject: string; kind: "task" | "quiz"; issued: number; completed: number; avg_percent: number | null; results: number }
export interface HwReport {
  class: string; from: string; to: string; as_of: string; basis: "hw_events";
  totals: { issued: number; revoked: number; completed: number; completed_late: number; in_progress: number; not_started: number;
    overdue_open: number; results: number; completion_percent: number | null; avg_percent: number | null };
  students: HwReportRow[]; assignments: HwReportAssignment[];
}
