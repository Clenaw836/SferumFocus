"""v2 HTTP surface: teacher blitz quizzes, «просмотрено», mixed class (students without the app).

Same identity rules as ``app.assignment_routes``: a teacher is resolved only by the server
(``resolve_role`` + ``_tctx``; demo sandbox by its signed token), a student only by the rewritten
``x-user-id``.  Bodies are strict.  Answer keys are returned only by teacher routes; student routes
return questions without keys until the attempt is submitted (and only if the teacher allowed it).

Student
  POST /api/v1/student/assignments/{id}/seen          — opened: indicator off, teacher sees «просмотрено»
  GET  /api/v1/student/assignments/{id}/quiz          — quiz state (no keys before submit)
  POST /api/v1/student/assignments/{id}/quiz/start    — one attempt, server start time (idempotent)
  POST /api/v1/student/assignments/{id}/quiz/submit   — server grading, idempotent, no re-submit
Teacher
  GET  /api/v1/teacher/hw/templates/{id}/quiz         — questions with keys + participation/results
  POST /api/v1/teacher/hw/roster/offline              — add a classmate without the app
  POST /api/v1/teacher/hw/issues/{id}/manual          — enter a paper/oral result (v2.2: one-tap ``how`` oral|paper)
  POST /api/v1/teacher/hw/issues/{id}/manual/clear    — take back a mistaken teacher mark (history is kept)
  POST /api/v1/teacher/hw/quiz/draft                  — AI draft (teacher policy) or built-in bank (source=bank), never auto-issued
  GET  /api/v1/teacher/hw/quiz/bank?subject=          — topics of the built-in bank for the subject (no AI, no network)
  GET  /api/v1/teacher/hw/report?class=&from=&to=     — R-08 period report from recorded events only
v3.2: the guest PIN blitz (F9, /api/v1/blitz/pin/* and …/guest-pin*) is removed — sign-in through SGO / Gosuslugi
(ESIA) is mandatory, a student takes only quizzes the teacher issued to them (see app/assignments.py, schema 4).
"""
from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import Field, field_validator

from app import assignments as hw
from app.assignment_routes import _ID, _ISO, _Strict, _call, _done, _key, _rid, _student, _teacher, guarded

router = APIRouter()


class AnswerBody(_Strict):
    id: str = Field(pattern=r"^q\d{1,2}$")
    choice: list[int] | None = Field(default=None, max_length=6)
    text: str | None = Field(default=None, max_length=200)


class SubmitBody(_Strict):
    answers: list[AnswerBody] = Field(default_factory=list, max_length=hw.QUIZ_MAX_QUESTIONS)
    study_day: str | None = Field(default=None, pattern=_ISO)

    @field_validator("answers")
    @classmethod
    def _unique(cls, v: list[AnswerBody]) -> list[AnswerBody]:
        if len({a.id for a in v}) != len(v):
            raise ValueError("Ответ на каждый вопрос — один раз")
        return v


class OfflineBody(_Strict):
    class_name: str = Field(alias="class", min_length=1, max_length=8)
    display_name: str = Field(min_length=2, max_length=60)


class ManualBody(_Strict):
    score: int | None = Field(default=None, ge=0, le=500)
    max_score: int | None = Field(default=None, ge=1, le=500)
    note: str = Field(default="", max_length=300)
    how: Literal["oral", "paper"] | None = None   # v2.2: one-tap «Сдал устно» / «На листочке» (score may come later)


class DraftBody(_Strict):
    class_name: str = Field(alias="class", min_length=1, max_length=8)
    subject: str = Field(min_length=1, max_length=60)
    topic: str = Field(min_length=2, max_length=200)
    count: int = Field(default=5, ge=1, le=10)
    difficulty: Literal["easy", "normal", "hard"] = "normal"
    notes: str = Field(default="", max_length=1500)
    source: Literal["ai", "bank"] = "ai"          # bank: deterministic templates, works without an AI key
    variant: int = Field(default=0, ge=0, le=999)  # bank only: another set of numbers of the same difficulty


# ------------------------------------------------------------------ student
@router.post("/api/v1/student/assignments/{issue_id}/seen")
@guarded
def hw_seen(issue_id: str, request: Request) -> dict:
    """Set-once flag: naturally idempotent, so no X-Idempotency-Key is required."""
    src, uid = _student(request)
    return _call(hw.mark_seen, src, uid, _rid(issue_id, "Задание"))


@router.get("/api/v1/student/assignments/{issue_id}/quiz")
@guarded
def hw_quiz(issue_id: str, request: Request) -> dict:
    src, uid = _student(request)
    return _call(hw.student_quiz, src, uid, _rid(issue_id, "Задание"))


@router.post("/api/v1/student/assignments/{issue_id}/quiz/start")
@guarded
def hw_quiz_start(issue_id: str, request: Request, response: Response) -> dict:
    (src, uid), key = _student(request), _key(request)
    return _done(response, _call(hw.quiz_start, src, uid, _rid(issue_id, "Задание"), key))


@router.post("/api/v1/student/assignments/{issue_id}/quiz/submit")
@guarded
def hw_quiz_submit(issue_id: str, body: SubmitBody, request: Request, response: Response) -> dict:
    (src, uid), key = _student(request), _key(request)
    answers = [a.model_dump(exclude_none=True) for a in body.answers]
    return _done(response, _call(hw.quiz_submit, src, uid, _rid(issue_id, "Задание"), answers, key, body.study_day))


# ------------------------------------------------------------------ teacher
@router.get("/api/v1/teacher/hw/templates/{template_id}/quiz")
@guarded
def hw_teacher_quiz(template_id: str, request: Request) -> dict:
    return _call(hw.teacher_quiz, _teacher(request), _rid(template_id, "Задание"))


@router.get("/api/v1/teacher/hw/report")
@guarded
def hw_class_report(request: Request) -> dict:
    """R-08: class report for a period (≤ 92 days) from recorded events only; read-only, sandbox included."""
    actor = _teacher(request)
    qp = request.query_params
    cls, d0, d1 = (qp.get("class") or "").strip(), qp.get("from") or "", qp.get("to") or ""
    if not cls or len(cls) > 8:
        raise HTTPException(422, "Укажите класс")
    return hw.class_report(actor, cls, d0, d1)


@router.post("/api/v1/teacher/hw/roster/offline")
@guarded
def hw_add_offline(body: OfflineBody, request: Request, response: Response) -> dict:
    actor, key = _teacher(request), _key(request)
    return _done(response, _call(hw.add_offline, actor, body.class_name, body.display_name, key))


@router.post("/api/v1/teacher/hw/issues/{issue_id}/manual")
@guarded
def hw_manual(issue_id: str, body: ManualBody, request: Request, response: Response) -> dict:
    actor, key = _teacher(request), _key(request)
    return _done(response, _call(hw.manual_result, actor, _rid(issue_id, "Выдача"), body.model_dump(), key))


@router.post("/api/v1/teacher/hw/issues/{issue_id}/manual/clear")
@guarded
def hw_manual_clear(issue_id: str, request: Request, response: Response) -> dict:
    """v2.2: «Снять отметку» — only a teacher-entered mark; the log keeps both events."""
    actor, key = _teacher(request), _key(request)
    return _done(response, _call(hw.manual_clear, actor, _rid(issue_id, "Выдача"), key))


def draft_questions(raw: Any) -> tuple[list[dict[str, Any]], int]:
    """AI output → only questions that pass the same server validation as a manual quiz."""
    out: list[dict[str, Any]] = []
    items = raw if isinstance(raw, list) else []
    for q in items[:hw.QUIZ_MAX_QUESTIONS]:
        if not isinstance(q, dict):
            continue
        correct = q.get("correct")
        if not isinstance(correct, list):
            correct = [q["answer"]] if isinstance(q.get("answer"), int) else []
        options = [str(o) for o in (q.get("options") or []) if isinstance(o, (str, int, float))][:6]
        answers = [str(a) for a in (q.get("answers") or []) if isinstance(a, (str, int, float))][:5]
        kind = q.get("kind") if q.get("kind") in hw.QUIZ_KINDS else ("short" if answers and not options else "single")
        if kind == "single" and len([c for c in correct if isinstance(c, int)]) > 1:
            kind = "multi"
        cand = {"kind": kind, "text": str(q.get("text") or q.get("question") or ""), "options": options,
                "correct": [c for c in correct if isinstance(c, int) and not isinstance(c, bool)], "answers": answers,
                "points": 1, "explain": str(q.get("explain") or "")[:500]}
        try:
            item = hw.normalize_quiz({"questions": [cand]})["questions"][0]
        except hw.HwError:
            continue
        out.append({k: item[k] for k in ("kind", "text", "options", "correct", "answers", "points", "explain")})
    return out, max(0, len(items) - len(out))


SANDBOX_DRAFTS_PER_MINUTE_ALL = 10   # all demo sandboxes together
SANDBOX_DRAFTS_PER_DAY_ALL = 200


def _reserve_sandbox_ceiling() -> None:
    """Shared provider budget of every sandbox teacher draft → 429 with Retry-After when exhausted."""
    from app import ai_engine, ai_quota
    try:
        ai_quota.reserve("sandbox:teacher_draft:all", SANDBOX_DRAFTS_PER_MINUTE_ALL, SANDBOX_DRAFTS_PER_DAY_ALL)
    except ai_quota.QuotaExceeded as exc:
        raise ai_engine.RateLimitError(exc.retry_after, exc.daily) from exc
    except (OSError, ValueError, TypeError) as exc:
        raise ai_engine.ProviderError("Не удалось безопасно сохранить AI-квоту", reason="quota_storage") from exc


BANK_NOTICE = ("Вопросы из встроенного банка: шаблоны с числами, ответы посчитаны программой, без ИИ и без сети. "
               "Проверьте каждый вопрос — ученики ничего не увидят, пока вы не нажмёте «Выдать».")


@router.get("/api/v1/teacher/hw/quiz/bank")
@guarded
def hw_quiz_bank_topics(request: Request) -> dict:
    """Topics of the built-in bank for the teacher's subject (chips in the builder)."""
    from app import quiz_bank
    _teacher(request)
    subject = (request.query_params.get("subject") or "").strip()[:60]
    topics = quiz_bank.topics_for(subject)
    return {"subject": subject, "supported": bool(topics), "topics": topics}


def _bank_draft(body: DraftBody) -> Any:
    from app import quiz_bank
    try:
        got = quiz_bank.build(body.subject, body.topic, body.count, body.difficulty, body.variant)
    except quiz_bank.BankError as exc:
        return JSONResponse({"detail": exc.detail, "code": exc.code, "topics": exc.topics}, status_code=422)
    questions = got["questions"]
    return {"draft": {"topic": body.topic.strip()[:120], "origin": "bank", "questions": questions,
                      "time_limit_min": min(90, max(3, 2 * len(questions))), "show_answers": True},
            "dropped": 0, "source": "template_bank", "variant": got["variant"], "families": got["families"],
            "notice": BANK_NOTICE}


@router.post("/api/v1/teacher/hw/quiz/draft")
async def hw_quiz_draft(body: DraftBody, request: Request) -> Any:
    """Teacher AI policy: separate prompt with answer keys, separate quota key, moderation of the teacher
    input, a draft that is never stored or issued by the server.  Without an AI key → honest 503.
    ``source=bank`` → deterministic built-in templates (no AI, no quota, no network), same review rules."""
    from app import ai_engine
    from app.demo_sandbox import state_of
    try:
        actor = _teacher(request)
        hw._require_class(actor, body.class_name, body.subject)  # noqa: SLF001 — same rule as issuing
    except hw.HwError as exc:
        return JSONResponse({"detail": exc.detail}, status_code=exc.status)
    if body.source == "bank":
        return _bank_draft(body)
    sb = state_of(request)
    # Per-sandbox bucket (one jury visitor cannot exhaust the quota of the others) plus one shared ceiling for
    # all sandboxes together (new sandboxes cannot be minted to multiply the provider spend).
    rate_key = f"sandbox:{sb['sid']}" if sb else actor["teacher_id"]
    if sb and ai_engine.has_key():
        _reserve_sandbox_ceiling()
    got = await ai_engine.generate_teacher_quiz(topic=body.topic, class_name=body.class_name, subject=body.subject,
                                                count=body.count, difficulty=body.difficulty, notes=body.notes,
                                                user_id=rate_key)
    questions, dropped = draft_questions(got.get("questions"))
    if not questions:
        raise HTTPException(422, "ИИ вернул вопросы, которые не прошли проверку. Уточните тему или соберите опрос вручную.")
    return {"draft": {"topic": body.topic.strip()[:120], "origin": "ai", "questions": questions,
                      "time_limit_min": min(90, max(3, 2 * len(questions))), "show_answers": True},
            "dropped": dropped, "source": got.get("source", "ai"),
            "notice": "Черновик ИИ. Проверьте каждый вопрос и верные ответы — ученики ничего не увидят, пока вы не нажмёте «Выдать»."}


__all__ = ["router", "draft_questions", "_ID"]
