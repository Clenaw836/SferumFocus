// Контракты API — 1:1 с app/models.py. Переименование поля ломает обе стороны.
export type TaskType = "written" | "oral";

export interface Task {
  id?: string | null;
  provider_assignment_id?: string | null;
  title: string;
  type: TaskType;
  deadline: string | null;
  planned_minutes: number;
  blitz_eligible: boolean;
  source?: string | null;
}

export interface RestSlot { start: string; end: string; label: string }
export interface PersonalActivity {
  title: string;
  duration_minutes: number;
  is_fixed?: boolean;
  time_window?: Record<string, string> | null;
  /** «HH:MM» — точное время обязательного дела (is_fixed) → стена в плане */
  start_time?: string | null;
}

/** «Мои дела сегодня» — дело ученика, которое планировщик обязан учесть. */
export type ActivityType = "tutor" | "sport" | "games" | "club" | "meet" | "road" | "other" | "misc";
export interface DayActivity {
  id: string;
  type: ActivityType;
  title: string;
  /** «HH:MM» или null — «когда угодно» (гибкое) */
  startTime: string | null;
  durationMinutes: number;
  /** true — время неподвижно (репетитор в 17:00); false — можно сдвигать/сокращать */
  fixed: boolean;
  /** откуда дело: ученик добавил сам, сказал помощнику или пришло из настроек/дневника */
  source: "user" | "settings" | "assistant";
}

export interface InitialState {
  diary_mode: "mock" | "live" | "manual";
  diary_status?:string;
  diary_provider?:string|null;
  diary_portal?:string|null;
  is_stale?:boolean;
  last_synced_at?:string|null;
  snapshot_available?:boolean;
  bell_schedule_present?:boolean;
  diary_tasks: Task[];
  /** Recovery 2: server state of diary_tasks with source "teacher" (joined by provider_assignment_id). */
  teacher_assignments?: import("./hwTypes").TeacherAssignment[];
  settings: {
    recommended_start: string;
    bedtime: string;
    rest_slots: RestSlot[];
    personal_activities: PersonalActivity[];
    recommended_bedtime?: string; wake_time?: string; travel_minutes?: number; prep_minutes?: number; school_week_days?: number;
  };
  school_day: { date: string; lessons: { starts_at: string; ends_at: string; subject: string; lesson_number?: number | null; source?: string | null; was?: string | null; note?: string | null }[]; last_bell: string | null } | null;
  schedule?: { kind: "real" | "demo"; name: string; is_demo: boolean; real_status: string } | null;
  school_name: string | null;
  grade: string | null;
}

export type PlanKind = "work" | "break" | "rest" | "personal";
export interface PlanEntry {
  start: string; end: string; kind: PlanKind; label: string;
  segment: string | null; task: string | null;
}
export interface PlanOut {
  plan: PlanEntry[];
  summary: {
    window_start: string; window_end: string;
    total_work_minutes: number; total_break_minutes: number;
    total_rest_minutes: number; total_personal_minutes: number;
    free_minutes_left: number; utilization_percent: number;
    /** разбор потребности для блока «Времени не хватает» (сервер ≥ v12) */
    capacity_minutes?: number; need_work_minutes?: number;
    need_fixed_minutes?: number; need_flexible_minutes?: number; need_rest_minutes?: number;
    unplaced_personal?: string[];
    study_work_minutes?: number;
    mandatory_rest_minutes?: number;
    clean_gamepass_minutes?: number;
    homework_end_time?: string | null;
  };
  deficit_minutes: number;
  tradeoff_suggestions: string[];
  survival_dropped: { message: string } | null;
}
export interface CalculateResponse {
  plan: PlanOut;
  ai_reasoning: string | null;
  negotiator_message: string | null;
}

export type Verdict = "correct" | "partial" | "miss";
export interface BlitzResponse {
  question: string | null; verdict: Verdict | null; feedback: string | null;
  progress: number; done: boolean;
  /** v15: откуда ответ (ai | cache | rules | fallback) и честная пометка, если без ИИ. */
  source?: string | null; notice?: string | null;
}
export interface BlitzTurn { question: string; answer: string; verdict: Verdict }

export interface QuizQuestion { question: string; options: string[]; answer: number }

export interface Flashcard { points: string[]; trap_question: string; source?: string | null; notice?: string | null }

export interface Achievement { title: string; description: string; unlocked: boolean; progress_percent: number }
export interface Rewards {
  current_streak: number; total_points: number; level: number; level_name: string;
  points_to_next_level: number; level_progress_percent: number;
  achievements: Achievement[];
  grades: { subject: string; average: number; trend: "up" | "down" | "flat" }[];
}

export interface MyWeek {
  /** actual/estimate/tasks_done: null — «нет данных» (дни до разбивки), не ноль. Master v2.0 · Feature 3. */
  days: { date: string; study_minutes: number; counted: boolean; duels: number; blitz_avg: number | null;
    actual_minutes?: number | null; estimate_minutes?: number | null; tasks_done?: number | null }[];
  week_study_minutes: number; week_duels: number; blitz_average: number | null; counted_days_total: number;
}

export interface Heatmap {
  class_label: string; generated_for: string; blitz_average: number;
  submitted_count: number; class_size: number;
  subjects: { subject: string }[];
  roster: HeatRow[];
  five_minute_brief: string;
  /** демо-данные (mock-дневник) — UI ставит пометку */
  is_demo?: boolean;
}
/** Где ошибся ученик — только реальные данные; пустые поля не показываем. */
export interface ErrorDetail {
  task_title: string; question?: string | null; student_answer?: string | null;
  correct_answer?: string | null; error_type?: string | null; attempts?: number | null; submitted_at?: string | null;
}
export interface HeatRow {
  display_name: string; homework_submitted: boolean;
  /** качество: верных ответов в блице из blitz_max */
  blitz_score: number; blitz_max?: number;
  /** выполнение: сдано заданий ДЗ из total_tasks */
  submitted_tasks: number; total_tasks: number;
  /** доля ошибок в блице, %; null — проверки не было */
  error_rate?: number | null;
  problem_tasks: { title: string; error_rate: number; error_line: number | null; hint: string }[];
  error_details?: ErrorDetail[];
}
export interface TeacherDay {
  date: string;
  lessons: { starts_at: string; ends_at: string; subject: string; class_label: string; topic: string | null; prep_recommendation: string | null }[];
}

export interface Health { ai: boolean; bot: boolean; version: string; release?: string; bot_name?: string | null; ocr?: boolean; stt?: boolean; school_tz?: string | null; schedule_demo?: boolean; demo_sandbox?: boolean; teacher_ai?: boolean }
export type Role = "student" | "teacher";

export interface Triage { assignments: { title: string; day: number; reason: string }[]; explanation: string }
export interface QuarterDay {
  date: string; weekday: string;
  lessons: { subject: string }[];
  substitutions: { slot: string; was: string; became: string; reason: string }[];
}
export interface Quarter { quarter_start: string; quarter_end: string; days: QuarterDay[] }
/** Кто я для сервера: подписанный MAX-пользователь или демо. Роль в школьном режиме решает сервер. */
export interface WhoAmI { auth: "max" | "demo" | "telegram" | "web"; uid?:string; user: string; role: Role; role_source: "school" | "demo" | "sandbox"; role_switch: boolean; profile?: import("./roleContext").IdentityProfile; sandbox?: import("./sandbox").SandboxInfo;
  /** Master v2.0 · Feature 1: фото профиля MAX из подписанного initData (сервер), только для оформления. */
  avatar?: { url: string; source: "max" } | null }
