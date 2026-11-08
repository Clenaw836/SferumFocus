"""Recovery 2 HTTP surface for teacher -> student assignments.

Identity comes only from the server: teachers via ``app.main._tctx`` +
``resolve_role`` (school directory for verified MAX, explicit demo selection
otherwise), students via the ``x-user-id`` rewritten by the auth middleware.
Bodies are strict (unknown fields are rejected) so a client cannot smuggle a
teacher id, student key or status.  Every mutation requires one UUIDv4
``X-Idempotency-Key`` and replays its stored response on retry.
"""
from __future__ import annotations

from datetime import date, timedelta
from functools import wraps
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator

from app import assignments as hw

router = APIRouter()
_ISO = r"^\d{4}-\d{2}-\d{2}$"
_ID = r"^[a-z]{3}_[0-9a-f]{32}$"


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class CodeBody(_Strict):
    class_name: str = Field(alias="class", min_length=1, max_length=8)
    rotate: bool = False


class DecisionBody(_Strict):
    approve: bool


def _check_due(v: str | None) -> str | None:
    if v is None:
        return v
    try:
        d = date.fromisoformat(v)
    except ValueError as exc:
        raise ValueError("Срок в формате ГГГГ-ММ-ДД") from exc
    today = date.today()
    if d < today - timedelta(days=1) or d > today + timedelta(days=366):
        raise ValueError("Срок должен быть не раньше вчерашнего дня и не дальше года")
    return v


class QuizQuestionBody(_Strict):
    kind: Literal["single", "multi", "short"] = "single"
    text: str = Field(min_length=1, max_length=500)
    options: list[str] = Field(default_factory=list, max_length=6)
    correct: list[int] = Field(default_factory=list, max_length=6)
    answers: list[str] = Field(default_factory=list, max_length=5)
    points: int = Field(default=1, ge=1, le=5)
    explain: str = Field(default="", max_length=500)

    @field_validator("options", "answers")
    @classmethod
    def _short_items(cls, v: list[str]) -> list[str]:
        if any(len(x) > 200 for x in v):
            raise ValueError("Слишком длинный вариант ответа (до 200 символов)")
        return v


class QuizBody(_Strict):
    questions: list[QuizQuestionBody] = Field(min_length=1, max_length=hw.QUIZ_MAX_QUESTIONS)
    time_limit_min: int | None = Field(default=None, ge=1, le=90)
    show_answers: bool = True
    origin: Literal["manual", "ai", "ai_edited", "bank"] = "manual"
    topic: str = Field(default="", max_length=120)
    reviewed: bool = False           # explicit teacher confirmation of a draft (required for origin ai/ai_edited/bank)


class TemplateBody(_Strict):
    class_name: str = Field(alias="class", min_length=1, max_length=8)
    subject: str = Field(min_length=1, max_length=60)
    title: str = Field(min_length=1, max_length=120)
    instructions: str = Field(default="", max_length=2000)
    type: Literal["written", "oral"] = "written"
    planned_minutes: int = Field(ge=5, le=240)
    due_date: str | None = Field(default=None, pattern=_ISO)
    roster_ids: list[str] = Field(default_factory=list, max_length=hw.MAX_ROSTER)
    allow_duplicate: bool = False
    kind: Literal["task", "quiz"] = "task"
    quiz: QuizBody | None = None
    whole_class: bool = False

    @field_validator("due_date")
    @classmethod
    def check_due(cls, v: str | None) -> str | None:
        return _check_due(v)


class UpdateBody(_Strict):
    expected_revision: int = Field(ge=1)
    title: str | None = Field(default=None, min_length=1, max_length=120)
    instructions: str | None = Field(default=None, max_length=2000)
    type: Literal["written", "oral"] | None = None
    planned_minutes: int | None = Field(default=None, ge=5, le=240)
    due_date: str | None = Field(default=None, pattern=_ISO)
    clear_due_date: bool = False
    quiz: QuizBody | None = None

    @field_validator("due_date")
    @classmethod
    def check_due(cls, v: str | None) -> str | None:
        return _check_due(v)


class IssueBody(_Strict):
    roster_ids: list[str] = Field(default_factory=list, max_length=hw.MAX_ROSTER)
    whole_class: bool = False


class JoinBody(_Strict):
    code: str = Field(min_length=4, max_length=16)
    display_name: str = Field(min_length=1, max_length=60)


class TransitionBody(_Strict):
    client_event_at: int | None = Field(default=None, ge=1_500_000_000_000, le=4_102_444_800_000)
    client_sent_at: int | None = Field(default=None, ge=1_500_000_000_000, le=4_102_444_800_000)
    reason: Literal["pause", "break", "drop", "switch", "resume", "next_round", "timer", "list", "restore"] | None = None
    round: int | None = Field(default=None, ge=1, le=99)
    study_day: str | None = Field(default=None, pattern=_ISO)
    client_elapsed_sec: int | None = Field(default=None, ge=0, le=12 * 3600)

    @field_validator("study_day")
    @classmethod
    def _day(cls, v: str | None) -> str | None:
        if v is None:
            return v
        try:
            d = date.fromisoformat(v)
        except ValueError as exc:
            raise ValueError("Учебный день в формате ГГГГ-ММ-ДД") from exc
        return v if abs((d - date.today()).days) <= 2 else None   # implausible device day -> server day


def _key(request: Request) -> str:
    from app import progress
    values = request.headers.getlist("x-idempotency-key")
    if not values:
        raise HTTPException(428, "Для изменения нужен X-Idempotency-Key (UUIDv4)")
    if len(values) != 1:
        raise HTTPException(422, "Нужен один X-Idempotency-Key")
    try:
        return progress.validate_mutation_key(values[0])
    except progress.IdempotencyKeyError as exc:
        raise HTTPException(422, str(exc)) from exc


def _teacher(request: Request) -> dict[str, Any]:
    from app.main import _tctx, resolve_role
    from app.demo_sandbox import state_of
    role, _ = resolve_role(request)          # role first: a student never learns how teachers are resolved
    if role != "teacher":
        raise HTTPException(403, "Раздел доступен только учителю")
    t, src = _tctx(request)
    sb = state_of(request)
    return hw.actor_of(t, src, sandbox=sb["sid"] if sb else None)


def _student(request: Request) -> tuple[str, str]:
    from app.main import _tsource
    src = _tsource(request)
    key = request.headers.get("x-user-id", "")
    if not key or len(key) > 200:
        raise HTTPException(401, "Нужна авторизация")
    if src == "school":
        verified = hasattr(getattr(request, "state", None), "platform_account") or (
            request.headers.get("x-auth") == "max" and key.startswith("max:"))
        if not verified:
            raise HTTPException(401, "Нужна подтверждённая авторизация")
    return src, key


def student_identity(request: Request) -> tuple[str, str] | None:
    """Non-raising variant for read-only merges (initial-state, day plan)."""
    try:
        return _student(request)
    except HTTPException:
        return None


def _call(fn, *args) -> Any:
    return fn(*args)


def guarded(endpoint):
    """Domain refusals become JSON with a readable ``detail`` plus machine fields."""
    @wraps(endpoint)
    def inner(*args, **kwargs):
        from app.progress import IdempotencyConflict
        try:
            return endpoint(*args, **kwargs)
        except hw.HwError as exc:
            headers = {"Retry-After": str(exc.extra["retry_after"])} if "retry_after" in exc.extra else None
            return JSONResponse({"detail": exc.detail, **{k: v for k, v in exc.extra.items() if k != "retry_after"}},
                                status_code=exc.status, headers=headers)
        except IdempotencyConflict as exc:
            return JSONResponse({"detail": str(exc)}, status_code=409)
    return inner


def _done(response: Response, pair: tuple[dict[str, Any], bool]) -> dict[str, Any]:
    result, replayed = pair
    response.headers["X-Idempotency-Replayed"] = "true" if replayed else "false"
    return result


def _rid(value: str, what: str = "Объект") -> str:
    import re
    if not re.match(_ID, value or ""):
        raise HTTPException(404, f"{what} не найден")
    return value


# ------------------------------------------------------------------ teacher
@router.get("/api/v1/teacher/hw/overview")
@guarded
def hw_overview(request: Request) -> dict:
    return _call(hw.overview, _teacher(request))


@router.get("/api/v1/teacher/hw/roster")
@guarded
def hw_roster(request: Request, cls: str = Query(alias="class", min_length=1, max_length=8)) -> dict:
    return _call(hw.roster, _teacher(request), cls)


@router.post("/api/v1/teacher/hw/roster/code")
@guarded
def hw_code(body: CodeBody, request: Request, response: Response) -> dict:
    actor, key = _teacher(request), _key(request)
    return _done(response, _call(hw.ensure_code, actor, body.class_name, body.rotate, key))


@router.post("/api/v1/teacher/hw/roster/{roster_id}/decision")
@guarded
def hw_decide(roster_id: str, body: DecisionBody, request: Request, response: Response) -> dict:
    actor, key = _teacher(request), _key(request)
    return _done(response, _call(hw.decide, actor, _rid(roster_id, "Ученик"), body.approve, key))


@router.post("/api/v1/teacher/hw/roster/{roster_id}/remove")
@guarded
def hw_remove(roster_id: str, request: Request, response: Response) -> dict:
    actor, key = _teacher(request), _key(request)
    return _done(response, _call(hw.remove_member, actor, _rid(roster_id, "Ученик"), key))


@router.get("/api/v1/teacher/hw/templates")
@guarded
def hw_templates(request: Request, cls: str | None = Query(default=None, alias="class", max_length=8),
                 archived: bool = Query(default=False)) -> dict:
    return _call(hw.list_templates, _teacher(request), cls, archived)


@router.post("/api/v1/teacher/hw/templates")
@guarded
def hw_create(body: TemplateBody, request: Request, response: Response) -> dict:
    actor, key = _teacher(request), _key(request)
    payload = body.model_dump()
    payload["class"] = payload.pop("class_name")
    return _done(response, _call(hw.create_template, actor, payload, key))


@router.get("/api/v1/teacher/hw/templates/{template_id}")
@guarded
def hw_template(template_id: str, request: Request) -> dict:
    return _call(hw.template_detail, _teacher(request), _rid(template_id, "Задание"))


@router.post("/api/v1/teacher/hw/templates/{template_id}/update")
@guarded
def hw_update(template_id: str, body: UpdateBody, request: Request, response: Response) -> dict:
    actor, key = _teacher(request), _key(request)
    changes = {k: v for k, v in body.model_dump(exclude_unset=True).items() if k not in ("expected_revision", "clear_due_date")}
    if body.clear_due_date:
        changes["due_date"] = None
    if not changes:
        raise HTTPException(422, "Нет изменений")
    return _done(response, _call(hw.update_template, actor, _rid(template_id, "Задание"), changes, body.expected_revision, key))


@router.post("/api/v1/teacher/hw/templates/{template_id}/issue")
@guarded
def hw_issue(template_id: str, body: IssueBody, request: Request, response: Response) -> dict:
    actor, key = _teacher(request), _key(request)
    if not body.whole_class and not body.roster_ids:
        raise HTTPException(422, "Выберите хотя бы одного ученика или «Всему классу»")
    return _done(response, _call(hw.issue_template, actor, _rid(template_id, "Задание"), body.roster_ids, key, body.whole_class))


@router.post("/api/v1/teacher/hw/templates/{template_id}/archive")
@guarded
def hw_archive(template_id: str, request: Request, response: Response) -> dict:
    actor, key = _teacher(request), _key(request)
    return _done(response, _call(hw.archive_template, actor, _rid(template_id, "Задание"), key))


@router.get("/api/v1/teacher/hw/issues/{issue_id}")
@guarded
def hw_teacher_issue(issue_id: str, request: Request) -> dict:
    return _call(hw.teacher_issue, _teacher(request), _rid(issue_id, "Выдача"))


@router.post("/api/v1/teacher/hw/issues/{issue_id}/revoke")
@guarded
def hw_revoke(issue_id: str, request: Request, response: Response) -> dict:
    actor, key = _teacher(request), _key(request)
    return _done(response, _call(hw.revoke_issue, actor, _rid(issue_id, "Выдача"), key))


# ------------------------------------------------------------------ student
@router.post("/api/v1/student/classes/join")
@guarded
def hw_join(body: JoinBody, request: Request, response: Response) -> dict:
    (src, uid), key = _student(request), _key(request)
    return _done(response, _call(hw.join, src, uid, body.code, body.display_name, key))


@router.get("/api/v1/student/classes")
@guarded
def hw_classes(request: Request) -> dict:
    src, uid = _student(request)
    return _call(hw.memberships, src, uid)


@router.post("/api/v1/student/classes/{membership_id}/leave")
@guarded
def hw_leave(membership_id: str, request: Request, response: Response) -> dict:
    (src, uid), key = _student(request), _key(request)
    return _done(response, _call(hw.leave, src, uid, _rid(membership_id, "Класс"), key))


@router.get("/api/v1/student/assignments")
@guarded
def hw_student_list(request: Request) -> dict:
    src, uid = _student(request)
    return {"assignments": _call(hw.student_list, src, uid), "server_now": hw.iso(hw.now()), "is_demo": src == "demo"}


@router.get("/api/v1/student/assignments/{issue_id}")
@guarded
def hw_student_issue(issue_id: str, request: Request) -> dict:
    src, uid = _student(request)
    return _call(hw.student_issue, src, uid, _rid(issue_id, "Задание"))


@router.post("/api/v1/student/assignments/{issue_id}/heartbeat")
@guarded
def hw_heartbeat(issue_id: str, request: Request) -> dict:
    src, uid = _student(request)
    return _call(hw.heartbeat, src, uid, _rid(issue_id, "Задание"))


@router.post("/api/v1/student/assignments/{issue_id}/{action}")
@guarded
def hw_transition(issue_id: str, action: str, body: TransitionBody, request: Request, response: Response) -> dict:
    if action not in hw.STUDENT_ACTIONS:
        return JSONResponse({"detail": "Not Found"}, status_code=404)
    (src, uid), key = _student(request), _key(request)
    return _done(response, _call(hw.transition, src, uid, _rid(issue_id, "Задание"), action, body.model_dump(), key))
