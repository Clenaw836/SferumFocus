"""HTTP-контракты «Практикумов СферумФокус» (v3.0).

GET  /api/v1/curriculum/subjects?grade=8                — предметы класса и число практикумов
GET  /api/v1/subjects/{subject}/hub?grade=8&topic_id=&hw= — развилка «Квиз-опрос | Практикум», карта и маршрут
GET  /api/v1/practicums/catalog?subject=&grade=&topic_id=&scope=&difficulty=&format_type=
GET  /api/v1/practicums/{id}/session                     — загрузить или начать сессию с того же этапа
GET  /api/v1/practicums/{id}/state · POST …/state         — автосохранение лаборатории
POST /api/v1/practicums/{id}/action                      — advance · answer · check · hint · skip · restart
POST /api/v1/practicums/{id}/tutor-help                  — PracticumTutorContext → наводящий вопрос
GET  /api/v1/topics/{topic_id}/skill-map
POST /api/v1/topics/{topic_id}/quiz · POST /api/v1/quiz/{attempt_id}/submit

Хранилище — синхронный SQLite, поэтому обработчики — обычные ``def`` (FastAPI выполняет их в пуле потоков),
а единственный ``async``-обработчик (тьютор с ИИ) уводит работу с БД в ``asyncio.to_thread`` (DB-01).
"""
from __future__ import annotations

import asyncio
import logging
import re
from functools import wraps
from typing import Any, Literal

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from app import practicum_engine as engine

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1", tags=["practicums"])
_ID = re.compile(r"^[a-z0-9][a-z0-9-]{2,80}$")
_ATTEMPT = re.compile(r"^qa_[A-Za-z0-9_-]{8,40}$")


_DEMO_KEY = re.compile(r"[0-9a-f]{32}")


def _uid(request: Request) -> str:
    """Тот же принцип, что у /api/v1/webapp/*: x-user-id после платформенной авторизации/песочницы демо.

    v3.0: браузер без подписанного профиля попадает в общий «demo-user» — тогда прогресс практикумов одного
    посетителя DEMO-копии видел бы другой. Только в этом случае принимается X-Practicum-Demo (случайные 128 бит
    с телефона) и ученик хранится как ``demo-practicum:<ключ>``: проверенную личность ключ не заменяет и к
    чужим настоящим данным доступа не даёт."""
    value = (request.headers.get("x-user-id", "demo-user").strip()[:200]) or "demo-user"
    if value == "demo-user":
        key = request.headers.get("x-practicum-demo", "").strip().lower()
        if _DEMO_KEY.fullmatch(key):
            return f"demo-practicum:{key}"
    return value


def _err(status: int, detail: str, code: str) -> JSONResponse:
    return JSONResponse({"detail": detail, "code": code, "error_code": code}, status_code=status,
                        headers={"Cache-Control": "no-store"})


def guarded(endpoint):
    if asyncio.iscoroutinefunction(endpoint):
        @wraps(endpoint)
        async def inner_async(*args, **kwargs):
            try:
                return await endpoint(*args, **kwargs)
            except engine.PracticumError as exc:
                return _err(exc.status, exc.detail, exc.code)
        return inner_async

    @wraps(endpoint)
    def inner(*args, **kwargs):
        try:
            return endpoint(*args, **kwargs)
        except engine.PracticumError as exc:
            return _err(exc.status, exc.detail, exc.code)
    return inner


def _pid(value: str) -> str:
    if not _ID.match(value or ""):
        raise engine.PracticumError(404, "Практикум не найден", "PRACTICUM_NOT_FOUND")
    return value


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class StateBody(_Strict):
    stage_index: int | None = Field(default=None, ge=0, le=7)
    lab_state: dict[str, Any] = Field(default_factory=dict)
    answers: dict[str, Any] = Field(default_factory=dict)


class ActionBody(_Strict):
    type: Literal["advance", "answer", "check", "hint", "skip", "restart"]
    stage_index: int | None = Field(default=None, ge=0, le=7)
    lab_state: dict[str, Any] = Field(default_factory=dict)
    answers: dict[str, Any] = Field(default_factory=dict)
    selected_answer: int | None = Field(default=None, ge=0, le=9)


class TutorBody(_Strict):
    question: str = Field(default="", max_length=1000)
    lab_state: dict[str, Any] = Field(default_factory=dict)
    answers: dict[str, Any] = Field(default_factory=dict)


class QuizSubmitBody(_Strict):
    answers: dict[str, Any] = Field(default_factory=dict)


@router.get("/curriculum/subjects")
@guarded
def curriculum_subjects(request: Request, grade: int = Query(8, ge=5, le=11)) -> Any:
    return engine.subjects_overview(_uid(request), grade)


@router.get("/subjects/{subject}/hub")
@guarded
def subject_hub(subject: str, request: Request, grade: int = Query(8, ge=5, le=11),
                topic_id: str | None = Query(None, max_length=90), hw: str | None = Query(None, max_length=2000),
                region: str | None = Query(None, max_length=80), textbook_id: str | None = Query(None, max_length=60)) -> Any:
    return engine.hub(_uid(request), subject[:60], grade, topic_id, hw, region, textbook_id)


@router.get("/practicums/catalog")
@guarded
def practicum_catalog(request: Request, subject: str | None = Query(None, max_length=60),
                      grade: int | None = Query(None, ge=5, le=11), topic_id: str | None = Query(None, max_length=90),
                      scope: Literal["all", "current"] = "all", difficulty: str | None = Query(None, max_length=40),
                      format_type: str | None = Query(None, max_length=40), hw: str | None = Query(None, max_length=2000)) -> Any:
    return engine.catalog(_uid(request), subject, grade, topic_id, scope, difficulty, format_type, hw)


@router.get("/practicums/{practicum_id}/session")
@guarded
def practicum_session(practicum_id: str, request: Request) -> Any:
    return engine.get_session(_uid(request), _pid(practicum_id))


@router.get("/practicums/{practicum_id}/state")
@guarded
def practicum_state(practicum_id: str, request: Request) -> Any:
    return engine.get_state(_uid(request), _pid(practicum_id))


@router.post("/practicums/{practicum_id}/state")
@guarded
def practicum_save_state(practicum_id: str, body: StateBody, request: Request) -> Any:
    return engine.save_state(_uid(request), _pid(practicum_id), body.lab_state, body.answers, body.stage_index)


@router.post("/practicums/{practicum_id}/action")
@guarded
def practicum_action(practicum_id: str, body: ActionBody, request: Request) -> Any:
    return engine.action(_uid(request), _pid(practicum_id), body.model_dump())


@router.post("/practicums/{practicum_id}/tutor-help")
@guarded
async def practicum_tutor(practicum_id: str, body: TutorBody, request: Request) -> Any:
    uid = _uid(request)
    pid = _pid(practicum_id)
    ctx = await asyncio.to_thread(engine.tutor_context, uid, pid, body.lab_state, body.answers)
    question = engine.scrub_pii(body.question.strip())
    reply, source, notice = engine.socratic_reply(ctx), "deterministic", None
    from app import ai_engine
    if ai_engine.has_key():
        meta: dict[str, Any] = {}
        try:
            text = await ai_engine.generate_socratic_hint(task_context=engine.tutor_prompt(ctx),
                                                          student_query=question or "Что у меня не так? Задай наводящий вопрос.",
                                                          history=[], user_id=uid, meta=meta)
        except ai_engine.ContentFlaggedError:
            return _err(422, "Вопрос не прошёл фильтр безопасности. Переформулируй его по теме практикума.", "CONTENT_FLAGGED")
        except ai_engine.RateLimitError:
            text, meta = "", {"source": "fallback"}
        if meta.get("source") == "ai" and text.strip() and not engine._leaks_hidden(text, ctx):
            reply, source = text.strip()[:1200], "ai"
        elif meta.get("source") == "ai":
            notice = "Ответ ИИ назвал бы скрытую величину этапа — показываю наводящий вопрос движка практикума."
    return {"reply": reply, "source": source, "notice": notice, "context": ctx, "question": question}


@router.get("/topics/{topic_id}/skill-map")
@guarded
def topic_skill_map(topic_id: str, request: Request) -> Any:
    t = engine.reg.topic(topic_id[:90])
    if t is None:
        raise engine.PracticumError(404, "Тема не найдена", "TOPIC_UNKNOWN")
    uk = engine.user_key(_uid(request))
    with engine.tx() as db:
        smap = engine.skill_map(db, uk, t)
        return {"skill_map": smap, "recommendation": engine.recommendation(db, uk, t, smap)}


@router.post("/topics/{topic_id}/quiz")
@guarded
def topic_quiz(topic_id: str, request: Request) -> Any:
    return engine.start_quiz(_uid(request), topic_id[:90])


@router.post("/quiz/{attempt_id}/submit")
@guarded
def quiz_submit(attempt_id: str, body: QuizSubmitBody, request: Request) -> Any:
    if not _ATTEMPT.match(attempt_id or ""):
        raise engine.PracticumError(404, "Квиз-опрос не найден или устарел", "QUIZ_NOT_FOUND")
    return engine.submit_quiz(_uid(request), attempt_id, body.answers)
