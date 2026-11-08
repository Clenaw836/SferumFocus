"""Pydantic-контракты всех эндпоинтов «СферумФокус».

Имена полей 1:1 совпадают с тем, что читает фронтенд (app/static/index.html):
любое переименование здесь ломает фронт — сверяйся с main.py перед правкой.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
import json
import math

# ---------- Общие сущности ----------

_TIME_HHMM = r"^(?:(?:[01]?\d|2[0-3]):[0-5]\d|24:00)$"      # «15:30», «9:05», «24:00»
_DATE_ISO = r"^\d{4}-\d{2}-\d{2}$"   # «2026-10-01»

class TaskItem(BaseModel):
    id: str | None = Field(default=None, max_length=100)
    provider_assignment_id: str | None = Field(default=None, max_length=200)
    title: str = Field(min_length=1, max_length=300)
    type: Literal["written", "oral"] = "written"
    deadline: str | None = Field(default=None, pattern=_DATE_ISO)
    planned_minutes: int = Field(default=20, ge=1, le=600)
    blitz_eligible: bool = True
    # Откуда задача: None — дневник, "bot" — прислана боту в MAX, "manual" — добавлена в приложении,
    # "teacher" — индивидуальная выдача учителя (Recovery 2; состояние — InitialState.teacher_assignments).
    source: Literal["bot", "manual", "teacher"] | None = None

class RestSlot(BaseModel):
    start: str = Field(pattern=_TIME_HHMM)
    end: str = Field(pattern=_TIME_HHMM)
    label: str = "Отдых"

class PersonalActivity(BaseModel):
    title: str
    duration_minutes: int = Field(default=0, ge=0, le=600)
    is_fixed: bool = False
    time_window: dict | None = None
    # Точное время начала обязательного дела («HH:MM»). Есть start_time и
    # is_fixed — дело становится стеной в плане; иначе — гибкое.
    start_time: str | None = Field(default=None, pattern=_TIME_HHMM)

class AppSettings(BaseModel):
    recommended_start: str = "15:30"
    bedtime: str = "22:00"
    rest_slots: list[RestSlot] = []
    personal_activities: list[PersonalActivity] = []
    # Цикл утро ↔ вечер (v13): сон — гибкий (рекомендуемый / обычный / сегодня),
    # окно вечера = последний звонок + дорога; утро = подъём → выход (первый урок − дорога).
    recommended_bedtime: str = "22:00"
    wake_time: str = "06:45"
    travel_minutes: int = 45
    prep_minutes: int = 15
    school_week_days: int = 5

# ---------- initial-state ----------

class LessonSlot(BaseModel):
    starts_at: str | None
    ends_at: str | None
    subject: str
    lesson_number: int | None = None
    source: str | None = None       # real | demo | student_voice | photo_ocr | manual | text
    status: str | None = None
    room: str | None = None
    teacher: str | None = None
    was: str | None = None          # предмет до изменения (для «вместо физики — информатика»)
    note: str | None = None

class SchoolDay(BaseModel):
    date: str
    lessons: list[LessonSlot] = []
    last_bell: str | None = None

class Capabilities(BaseModel):
    ai: bool
    bot: bool
    version: str
    release: str = ""   # v2.4: метка выпуска продукта (app.__release__), совпадает с frontend/package.json
    auth: str = "demo"  # demo | verified | required — режим проверки подписи initData MAX
    bot_name: str | None = None  # ник бота для диплинков-вызовов https://max.ru/<bot>?startapp=...
    ocr: bool = False   # фото расписания читается на сервере (ИИ-зрение или Tesseract)
    stt: bool = False   # голос → текст на сервере (ИИ); на устройстве может быть свой Web Speech
    school_tz: str | None = None   # v16: IANA-пояс школы (SCHOOL_TZ); None — считаем по телефону
    schedule_demo: bool = True     # v16: SCHEDULE_DEMO — разрешены ли демо-уроки
    demo_sandbox: bool = False     # v2: живая демо-песочница жюри (изолированная сессия на сервере)
    teacher_ai: bool = False       # v2: ИИ-черновик блиц-опроса учителя (нужен ключ ИИ)

class FocusReminderRequest(BaseModel):
    """Старт/пауза/финиш фокус-сессии: бот MAX напомнит, когда время выйдет."""
    subject: str = Field(default="", max_length=80)
    ends_in_sec: int | None = Field(default=None, ge=0, le=4 * 3600)
    cancel: bool = False

class FocusReminderResponse(BaseModel):
    scheduled: bool

class ScheduleMeta(BaseModel):
    kind: str = "demo"              # real | demo — UI показывает «ДЕМО» или «Сферум»
    name: str = ""
    is_demo: bool = True
    real_status: str = "not_configured"
    # v16 (обратно совместимо): статус синхронизации и пояс школы
    status: str | None = None           # fresh|stale|partial|conflict|imported|demo|unavailable|none
    last_sync_at: str | None = None
    error: str | None = None
    has_import: bool = False
    school_tz: str | None = None
    feed_configured: bool = False

class TeacherAssignmentInfo(BaseModel):
    """Recovery 2: server state of one individual teacher assignment, as the student sees it.

    timer_sec — server segments between start/resume and pause/complete;
    confirmed_sec — only live-signal gaps <= 90 s (app open, timer running);
    neither proves attention.  See docs/recovery-2/TIME_ACCOUNTING.md."""
    model_config = ConfigDict(populate_by_name=True)
    issue_id: str
    template_id: str
    task_title: str
    class_name: str = Field(alias="class")
    subject: str
    title: str
    instructions: str = ""
    type: Literal["written", "oral"] = "written"
    planned_minutes: int
    due_date: str | None = None
    teacher_name: str | None = None
    status: Literal["assigned", "in_progress", "paused", "completed", "revoked"]
    issued_at: str
    first_started_at: str | None = None
    completed_at: str | None = None
    completed_study_day: str | None = None
    timer_sec: int = 0
    confirmed_sec: int = 0
    running_since: str | None = None
    segments: int = 0
    pomodoro_round: int = 0
    revision: int = 1
    snapshot_revision: int = 1
    is_demo: bool = False
    server_now: str | None = None
    # v2 (backward compatible): blitz quiz kind, first-open mark and the quiz summary.  Without
    # these declared fields response_model=InitialState silently dropped them and the student
    # app rendered a quiz as an ordinary task (live_v2 E2E caught it).
    kind: Literal["task", "quiz"] = "task"
    seen_at: str | None = None
    quiz: dict[str, object] | None = None

class InitialState(BaseModel):
    schedule: ScheduleMeta | None = None
    diary_mode: Literal["mock", "live", "manual"] = "mock"
    diary_status: str | None = None
    diary_provider: str | None = None
    diary_portal: str | None = None
    is_stale: bool = False
    last_synced_at: str | None = None
    snapshot_available: bool = False
    bell_schedule_present: bool = False
    diary_tasks: list[TaskItem] = []
    # Recovery 2: state of diary_tasks with source="teacher", joined by provider_assignment_id.
    teacher_assignments: list[TeacherAssignmentInfo] = []
    settings: AppSettings
    school_day: SchoolDay | None = None
    school_name: str | None = None
    grade: str | None = None

# ---------- process-media ----------

class MediaRequest(BaseModel):
    media_type: Literal["photo", "voice", "audio"]
    base64: str | None = Field(default=None, max_length=10_000_000)  # ~7 МБ фото; больше — 413 на фронте
    mime: str | None = Field(default=None, max_length=100)
    text: str | None = Field(default=None, max_length=20_000)

class MediaResponse(BaseModel):
    tasks: list[TaskItem] = []
    # v15 (обратно совместимо, необязательные): откуда ответ — ai | cache | rules | fallback,
    # и честная пометка для UI, если ответ построен без ИИ.
    source: str | None = None
    notice: str | None = None

# ---------- calculate ----------

class CalculateRequest(BaseModel):
    tasks: list[TaskItem] = Field(default=[], max_length=100)
    start_time: str = Field(default="15:30", pattern=_TIME_HHMM)
    bedtime: str = Field(default="22:00", pattern=_TIME_HHMM)
    rest_slots: list[RestSlot] = Field(default_factory=list, max_length=100)
    personal_activities: list[PersonalActivity] = Field(default_factory=list, max_length=100)
    post_school_rest_minutes: int = Field(default=0, ge=0, le=180)
    survival: bool = False
    # Режим спасения: перерывы только каждые 50 мин внутри задания (между заданиями — всегда)
    compact_breaks: bool = False
    order: Literal["default", "short_first"] = "default"
    completed_titles: list[str] = Field(default=[], max_length=100)
    actual_minutes: dict = {}

class PlanEntry(BaseModel):
    start: str
    end: str
    kind: Literal["work", "break", "rest", "personal"]
    label: str
    segment: str | None = None
    task: str | None = None

class PlanSummary(BaseModel):
    window_start: str
    window_end: str
    total_work_minutes: int
    total_break_minutes: int
    total_rest_minutes: int
    total_personal_minutes: int
    free_minutes_left: int
    utilization_percent: int
    # Разбор потребности для блока «Времени не хватает» (по умолчанию — 0,
    # обратная совместимость со старыми клиентами/кэшем).
    capacity_minutes: int = 0
    need_work_minutes: int = 0
    need_fixed_minutes: int = 0
    need_flexible_minutes: int = 0
    need_rest_minutes: int = 0
    unplaced_personal: list[str] = []
    # Requested workload/budget, not proof that a student studied these minutes.
    study_work_minutes: int = 0
    mandatory_rest_minutes: int = 0
    clean_gamepass_minutes: int = 0
    homework_end_time: str | None = None

class SurvivalDrop(BaseModel):
    message: str

class PlanOut(BaseModel):
    plan: list[PlanEntry]
    summary: PlanSummary
    deficit_minutes: int = 0
    tradeoff_suggestions: list[str] = []
    survival_dropped: SurvivalDrop | None = None

class CalculateResponse(BaseModel):
    plan: PlanOut
    ai_reasoning: str | None = None
    negotiator_message: str | None = None

# ---------- socratic-hint ----------

class HintRequest(BaseModel):
    task_context: str = Field(default="", max_length=4000)
    student_query: str = Field(default="", max_length=2000)
    history: list[dict] = Field(default=[], max_length=50)
    image_base64: str | None = Field(default=None, max_length=10_000_000)

    @field_validator("history")
    @classmethod
    def safe_history(cls, items: list[dict]) -> list[dict]:
        for item in items:
            if (not isinstance(item.get("role"), str) or item.get("role") not in {"user", "assistant"}
                    or not isinstance(item.get("content"), str)
                    or len(item["content"]) > 4000):
                raise ValueError("История содержит только user/assistant и текст до4000 символов")
        return [{"role": i["role"], "content": i["content"]} for i in items]

class HintGuide(BaseModel):
    """v2.1: автономный план метода по предмету (не ответ): 4 шага, которые ученик делает сам."""
    subject: str
    title: str
    steps: list[str]

class HintResponse(BaseModel):
    hint: str
    # v15 (обратно совместимо, необязательные): откуда ответ — ai | cache | rules | fallback,
    # и честная пометка для UI, если ответ построен без ИИ.
    source: str | None = None
    notice: str | None = None
    # v2.1: ok — ответил ИИ; degraded_gracefully — ИИ недоступен (нет ключа, 403/таймаут/сбой прокси), ученик
    # получает шаг метода + план по предмету, а не ошибку 5xx. Готового решения нет ни в одном режиме.
    status: Literal["ok", "degraded_gracefully"] | None = None
    guide: HintGuide | None = None

# ---------- blitz ----------

class BlitzRequest(BaseModel):
    task_title: str = Field(min_length=1, max_length=300)
    mode: Literal["start", "answer"]
    answer: dict | None = None
    history: list[dict] = Field(default=[], max_length=50)
    current_question: str | None = None

class BlitzResponse(BaseModel):
    question: str | None = None
    verdict: Literal["correct", "partial", "miss"] | None = None
    feedback: str | None = None
    progress: int = 0
    done: bool = False
    # v15 (обратно совместимо, необязательные): откуда ответ — ai | cache | rules | fallback,
    # и честная пометка для UI, если ответ построен без ИИ.
    source: str | None = None
    notice: str | None = None

# ---------- blitz-quiz (фото) / blitz-quiz-manual (свой опрос) ----------

class QuizImage(BaseModel):
    base64: str = Field(min_length=32, max_length=10_000_000)
    mime: str = Field(default="image/jpeg", max_length=100)

class QuizRequest(BaseModel):
    images: list[QuizImage] = Field(min_length=1, max_length=8)
    question_count: int = Field(default=4, ge=3, le=6)

class ManualQuizRequest(BaseModel):
    topic: str = Field(default="", max_length=300)
    raw_text: str = Field(min_length=1, max_length=20000)
    question_count: int = Field(default=4, ge=3, le=6)

class QuizQuestion(BaseModel):
    question: str
    options: list[str] = Field(min_length=2, max_length=6)
    answer: int = Field(ge=0)

class QuizResponse(BaseModel):
    questions: list[QuizQuestion]
    # v15 (обратно совместимо, необязательные): откуда ответ — ai | cache | rules | fallback,
    # и честная пометка для UI, если ответ построен без ИИ.
    source: str | None = None
    notice: str | None = None

# ---------- flashcard / triage ----------

class FlashcardRequest(BaseModel):
    task_title: str = Field(min_length=1, max_length=300)

class FlashcardResponse(BaseModel):
    points: list[str] = Field(min_length=1, max_length=5)
    trap_question: str
    # v15 (обратно совместимо, необязательные): откуда ответ — ai | cache | rules | fallback,
    # и честная пометка для UI, если ответ построен без ИИ.
    source: str | None = None
    notice: str | None = None

class TriageRequest(BaseModel):
    tasks: list[TaskItem] = Field(default=[], max_length=100)
    horizon_days: int = Field(default=2, ge=1, le=3)

class TriageAssignment(BaseModel):
    title: str
    day: int = Field(ge=0, le=2)
    reason: str = ""

class TriageResponse(BaseModel):
    assignments: list[TriageAssignment]
    explanation: str

# ---------- progress ----------

class ProgressEventRequest(BaseModel):
    kind: Literal["task_done", "plan_built", "duel_completed", "flashcard_used"]
    payload: dict = Field(default_factory=dict)

    @model_validator(mode="after")
    def bounded_event(self):
        p = self.payload
        try:
            size = len(json.dumps(p, ensure_ascii=False, allow_nan=False).encode())
        except (ValueError, TypeError) as exc:
            raise ValueError("Событие должно быть конечным JSON") from exc
        if size > 16000:
            raise ValueError("Событие слишком большое")
        for key, upper in (("day_total", 100), ("day_done", 100), ("planned_minutes", 600), ("attempt", 100)):
            if key in p and (type(p[key]) is not int or not 0 <= p[key] <= upper):
                raise ValueError(f"Некорректное поле {key}")
        if "actual_minutes" in p and p["actual_minutes"] is not None:
            v = p["actual_minutes"]
            if type(v) not in (int, float) or not math.isfinite(v) or not 0 <= v <= 1440:
                raise ValueError("Некорректное фактическое время")
        if "day_done" in p and "day_total" in p and p["day_done"] > p["day_total"]:
            raise ValueError("Выполнено больше заданий, чем запланировано")
        if "oral_eligible" in p and type(p["oral_eligible"]) is not bool:
            raise ValueError("oral_eligible должен быть boolean")
        if "type" in p and p["type"] not in ("written", "oral"):
            raise ValueError("Неизвестный тип задания")
        if "event_id" in p and (not isinstance(p["event_id"], str) or not 1 <= len(p["event_id"]) <= 1024):
            raise ValueError("event_id: от1 до1024 символов")
        for key in ("task", "topic", "mode"):
            if key in p and (not isinstance(p[key], str) or len(p[key]) > 300):
                raise ValueError(f"Некорректное поле {key}")
        if "score" in p and (type(p["score"]) not in (int, float) or not math.isfinite(p["score"]) or not 0 <= p["score"] <= 3):
            raise ValueError("Счёт дуэли: от0 до3")
        return self

class MyWeekDay(BaseModel):
    date: str
    study_minutes: int
    counted: bool
    duels: int
    blitz_avg: float | None = None
    # Master v2.0 · Feature 3: None = «нет данных» (старые дни без разбивки), а не ноль.
    actual_minutes: int | None = None
    estimate_minutes: int | None = None
    tasks_done: int | None = None

class MyWeekResponse(BaseModel):
    days: list[MyWeekDay]
    week_study_minutes: int
    week_duels: int
    blitz_average: float | None = None
    counted_days_total: int

# ---------- teacher ----------

class HeatProblem(BaseModel):
    title: str
    error_rate: int
    error_line: int | None = None
    hint: str = ""

class ErrorDetail(BaseModel):
    """Где именно ошибся ученик. Расширяемая модель: заполняется ТОЛЬКО
    реальными данными дневника/блица; пустые поля UI не показывает и не
    придумывает (вопрос, ответ ученика, верный ответ, попытки, время)."""
    task_title: str
    question: str | None = None
    student_answer: str | None = None
    correct_answer: str | None = None
    error_type: str | None = None
    attempts: int | None = None
    submitted_at: str | None = None

class HeatRow(BaseModel):
    display_name: str
    homework_submitted: bool
    # Качество: блиц-проверка по теме ДЗ, верных ответов из blitz_max.
    blitz_score: int = Field(ge=0, le=3)
    blitz_max: int = 3
    # Выполнение: сдано заданий ДЗ из total_tasks (это НЕ качество).
    submitted_tasks: int
    total_tasks: int
    # Доля ошибок в блице, % = (blitz_max − blitz_score) / blitz_max.
    # None — проверки не было; UI покажет «нет данных», а не 0 %.
    error_rate: int | None = Field(default=None, ge=0, le=100)
    problem_tasks: list[HeatProblem] = []
    error_details: list[ErrorDetail] = []

class HeatSubject(BaseModel):
    subject: str

class HeatmapResponse(BaseModel):
    class_label: str
    generated_for: str
    blitz_average: float
    submitted_count: int
    class_size: int
    subjects: list[HeatSubject]
    roster: list[HeatRow]
    five_minute_brief: str
    # True — данные демонстрационные (mock-дневник); UI ставит пометку «Демо».
    is_demo: bool = False

class DayLesson(BaseModel):
    starts_at: str | None
    ends_at: str | None
    subject: str
    class_label: str = ""
    topic: str | None = None
    prep_recommendation: str | None = None

class DayScheduleResponse(BaseModel):
    date: str
    lessons: list[DayLesson] = []

# ---------- rewards ----------

class GradeRow(BaseModel):
    subject: str
    average: float
    trend: Literal["up", "down", "flat"]

class AchievementRow(BaseModel):
    title: str
    description: str
    unlocked: bool
    progress_percent: int = Field(ge=0, le=100)

class RewardsResponse(BaseModel):
    current_streak: int
    total_points: int
    level: int
    level_name: str
    points_to_next_level: int
    level_progress_percent: int
    achievements: list[AchievementRow]
    grades: list[GradeRow]

# ---------- quarter ----------

class Substitution(BaseModel):
    slot: str
    was: str
    became: str
    reason: str = ""

class QuarterLesson(BaseModel):
    subject: str

class QuarterDay(BaseModel):
    date: str
    weekday: str
    lessons: list[QuarterLesson] = []
    substitutions: list[Substitution] = []

class QuarterResponse(BaseModel):
    quarter_start: str
    quarter_end: str
    days: list[QuarterDay]

# ---------- расписание (v13) ----------

class ScheduleChangeIn(BaseModel):
    """Изменение расписания с телефона. Нормализуется в app/schedule.normalize_change."""
    id: str = Field(min_length=1, max_length=64)
    date: str = Field(pattern=_DATE_ISO)
    change_type: str = "UNKNOWN"
    lesson_number: int | None = Field(default=None, ge=1, le=8)
    to_lesson_number: int | None = Field(default=None, ge=1, le=8)
    shift: bool = False
    subject: str | None = Field(default=None, max_length=80)
    before: str | None = Field(default=None, max_length=80)
    start_time: str | None = None
    end_time: str | None = None
    teacher: str | None = Field(default=None, max_length=80)
    room: str | None = Field(default=None, max_length=30)
    note: str | None = Field(default=None, max_length=140)
    reason: str | None = Field(default=None, max_length=140)
    source: str = "manual"
    evidence: list[str] = []
    evidence_note: str | None = Field(default=None, max_length=200)
    confidence: float = Field(default=1.0, ge=0, le=1)
    created_at: str | None = None
    updated_at: str | None = None
    status: Literal["applied", "reverted"] = "applied"

class ScheduleSyncRequest(BaseModel):
    changes: list[ScheduleChangeIn] = Field(default=[], max_length=500)
    school_week: int | None = Field(default=None, ge=5, le=6)

class EvidenceImageRequest(BaseModel):
    kind: Literal["photo", "file"] = "photo"
    base64: str = Field(min_length=1, max_length=10_000_000)
    mime: str | None = Field(default=None, max_length=100)
    hint: str | None = Field(default=None, max_length=300)

class EvidenceRead(BaseModel):
    engine: str
    text: str = ""
    lessons: list[dict] = []
    day_hint: str | None = None
    legibility: float = 0.0

class TranscribeRequest(BaseModel):
    base64: str = Field(min_length=1, max_length=10_000_000)
    mime: str | None = Field(default=None, max_length=100)

class TranscribeResponse(BaseModel):
    engine: str
    text: str


# ---------- v16: импорт расписания, состояние дня, клиентские метрики ----------

class ScheduleImportPreviewRequest(BaseModel):
    format: Literal["text", "json"] = "text"
    payload: str = Field(min_length=1, max_length=60_000)


class ScheduleImportConfirmRequest(BaseModel):
    token: str = Field(min_length=8, max_length=64)


class ClientMetricsRequest(BaseModel):
    """Без PII: только числа и коды из закрытого списка (см. app/main.py::client_metrics)."""
    ttuc_ms: float | None = Field(default=None, ge=0, le=120_000)
    day_engine_ms: float | None = Field(default=None, ge=0, le=10_000)
    day_engine_error: bool = False
    scene: Literal["svg", "static", "reduced", "error"] | None = None

# ---------- v17 Teacher Intelligence (контракты запросов; ответы — dict, см. docs/TEACHER_MODE.md) ----------

class TeacherImportPreviewRequest(BaseModel):
    payload: str = Field(min_length=1, max_length=20000)
    source_kind: Literal["text", "image", "file", "manual"] = "text"
    legibility: float = Field(default=1.0, ge=0.0, le=1.0)

class TeacherImportConfirmRequest(BaseModel):
    token: str = Field(min_length=8, max_length=64)
    accept: list[str] = Field(default_factory=list, max_length=300)

class TeacherRevertRequest(BaseModel):
    journal_id: str = Field(min_length=4, max_length=32)

class TeacherDecideRequest(BaseModel):
    approve: bool

class TeacherMatchRequest(BaseModel):
    full_name: str | None = Field(default=None, max_length=120)
    teacher_id: str | None = Field(default=None, max_length=64)
    school_id: str | None = Field(default=None, max_length=64)
    subject: str | None = Field(default=None, max_length=60)

class TeacherPlanStage(BaseModel):
    title: str = Field(max_length=120)
    minutes: int = Field(ge=0, le=240)
    text: str = Field(default="", max_length=1000)

class TeacherPlanRequest(BaseModel):
    lesson_id: str = Field(min_length=5, max_length=120)
    topic: str | None = Field(default=None, max_length=200)
    stages: list[TeacherPlanStage] = Field(min_length=1, max_length=12)
    adaptation: str = Field(default="", max_length=1000)

class TeacherMaterialRequest(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    author: str | None = Field(default=None, max_length=300)
    subject: str | None = Field(default=None, max_length=60)
    class_: str | None = Field(default=None, alias="class", max_length=8)
    topic: str | None = Field(default=None, max_length=200)
    url: str | None = Field(default=None, max_length=300)
    edition: str | None = Field(default=None, max_length=100)
    license: str | None = Field(default=None, max_length=300)


# --------------------------- v17.1: инструменты ученика ---------------------------
_HHMM = r"^([01]\d|2[0-3]):[0-5]\d$"


class CloseQuizStartRequest(BaseModel):
    task_title: str = Field(min_length=1, max_length=300)


class CloseQuizCheckRequest(BaseModel):
    quiz_id: str = Field(min_length=8, max_length=40)
    answers: list[int] = Field(max_length=10)


class BuilderExtra(BaseModel):
    title: str = Field(min_length=1, max_length=60)
    start: str | None = Field(default=None, pattern=_HHMM)
    minutes: int = Field(ge=5, le=300)


class ScheduleBuilderRequest(BaseModel):
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    start: str = Field(pattern=_HHMM)
    lessons: int = Field(ge=1, le=10)
    lesson_minutes: int = Field(default=45, ge=20, le=90)
    break_minutes: int = Field(default=10, ge=0, le=40)
    long_break_after: int | None = Field(default=None, ge=1, le=9)
    long_break_minutes: int = Field(default=20, ge=5, le=60)
    subjects: list[str] = Field(default_factory=list, max_length=10)
    travel_minutes: int = Field(default=45, ge=0, le=180)
    extras: list[BuilderExtra] = Field(default_factory=list, max_length=6)
    rest_minutes: int = Field(default=60, ge=0, le=240)
    homework_minutes: int = Field(default=0, ge=0, le=600)
    bedtime: str = Field(default="22:00", pattern=_HHMM)
