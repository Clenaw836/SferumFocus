"""v3.2 · Учитель ↔ АИС «Сетевой Город. Образование» (NetSchool WebAPI): чтение нагрузки и выгрузка в журнал.

Интеграция присланного sgo_teacher_client.py поверх существующей инфраструктуры:
* запросы идут через SgoHTTP (только публичные адреса портала, лимит размера ответа, авто-префикс /webapi,
  401/403 → повторный вход) от имени сессии учителя из шифрованного хранилища (тот же вход, что у обзора);
* никаких выдуманных значений: нет числа учеников / параллели в ответе СГО — поле None, а не «25» и «8»;
* запись в официальный журнал — только после явного «confirm» учителя И если на сервере включено
  SGO_TEACHER_WRITE=1. Открытого контракта учительских методов у NetSchool нет (пути отличаются по
  регионам), поэтому по умолчанию — честный предпросмотр: ровно то, что будет отправлено, и пометка
  «ничего не отправлено».

Пути (относительно /webapi): /context, /years/current, /eduGroups, /gradebook/init, /schedule/teacher,
POST /assignments, POST /gradebook/marks — как в присланном клиенте; регион может переопределить их в
metadata.teacher_api узла (ключи classes / schedule / gradebook / publish / marks).
"""
from __future__ import annotations

import logging
import os
import re
from datetime import date, timedelta
from typing import Any, Awaitable, Callable

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field, field_validator

logger = logging.getLogger(__name__)

NETSCHOOL_TEACHER_API: dict[str, str] = {
    "context": "/context", "year": "/years/current", "classes": "/eduGroups", "gradebook": "/gradebook/init",
    "schedule": "/schedule/teacher", "publish": "/assignments", "marks": "/gradebook/marks",
}
MAX_MARKS_PER_BATCH = 45
HOMEWORK_TYPE_ID = 3

Requester = Callable[..., Awaitable[Any]]

def write_enabled() -> bool:
    return os.getenv("SGO_TEACHER_WRITE", "").strip().lower() in {"1", "true", "yes", "on"}

class PublishHomeworkRequest(BaseModel):
    classmeeting_id: int = Field(..., gt=0)
    subject_id: int = Field(..., gt=0)
    title: str = Field(..., min_length=3, max_length=250)
    description: str = Field(default="", max_length=2000)
    due_date: date
    weight: int = Field(default=10, ge=1, le=100)
    assignment_type_id: int = Field(default=HOMEWORK_TYPE_ID, gt=0)
    confirm: bool = Field(default=False)

class StudentMarkItem(BaseModel):
    student_id: int = Field(..., gt=0)
    mark: int = Field(...)
    comment: str = Field(default="", max_length=200)

    @field_validator("mark")
    @classmethod
    def validate_russian_grade(cls, v: int) -> int:
        if v not in (2, 3, 4, 5):
            raise ValueError("Оценка в журнале СГО — целое число от 2 до 5")
        return v

class ExportMarksBatchRequest(BaseModel):
    classmeeting_id: int = Field(..., gt=0)
    assignment_id: int = Field(..., gt=0)
    marks: list[StudentMarkItem] = Field(..., min_length=1, max_length=MAX_MARKS_PER_BATCH)
    dry_run: bool = Field(default=True)
    confirm: bool = False

    @field_validator("marks")
    @classmethod
    def unique_students(cls, v: list[StudentMarkItem]) -> list[StudentMarkItem]:
        ids = [m.student_id for m in v]
        if len(ids) != len(set(ids)):
            raise ValueError("Один ученик — одна оценка за работу")
        return v

def _int(value: Any) -> int | None:
    if isinstance(value, bool): return None
    if isinstance(value, int): return value
    if isinstance(value, str) and value.strip().isdigit(): return int(value.strip())
    return None

def _text(value: Any, limit: int = 200) -> str | None:
    return str(value).strip()[:limit] if isinstance(value, (str, int)) and str(value).strip() else None

def _items(doc: Any, *keys: str) -> list[dict[str, Any]]:
    if isinstance(doc, dict):
        for k in keys:
            if isinstance(doc.get(k), list):
                doc = doc[k]
                break
    return [x for x in doc if isinstance(x, dict)] if isinstance(doc, list) else []

def grade_of(name: str | None, parallel: Any = None) -> int | None:
    p = _int(parallel)
    if p is not None and 1 <= p <= 11: return p
    m = re.match(r"\s*(\d{1,2})", name or "")
    return int(m.group(1)) if m and 1 <= int(m.group(1)) <= 11 else None

def norm_context(ctx: Any, year: Any = None) -> dict[str, Any]:
    ctx = ctx if isinstance(ctx, dict) else {}
    year = year if isinstance(year, dict) else {}
    from app.sgo_adapter import detect_roles
    detected = detect_roles(ctx)
    if isinstance(ctx.get("user"), dict): detected |= detect_roles(ctx["user"])
    roles = sorted(detected)
    school = ctx.get("school") if isinstance(ctx.get("school"), dict) else {}
    return {"user_id": _int(ctx.get("userId", ctx.get("id"))), "school_id": _int(ctx.get("schoolId", school.get("id"))),
            "year_id": _int(year.get("id", ctx.get("schoolYearId"))), "roles": roles[:10],
            "is_teacher": any(r.lower() in {"teacher", "учитель", "преподаватель", "director", "завуч"} for r in roles)}

def norm_classes(doc: Any) -> list[dict[str, Any]]:
    out = []
    for g in _items(doc, "items", "classes", "eduGroups"):
        cid = _int(g.get("id", g.get("classId")))
        if cid is None: continue
        name = _text(g.get("name", g.get("className")), 40) or f"Класс {cid}"
        subjects = [{"id": _int(s.get("id")), "name": _text(s.get("name"), 120)} for s in _items(g.get("subjects")) if _int(s.get("id")) is not None]
        out.append({"class_id": cid, "class_name": name, "grade": grade_of(name, g.get("parallel", g.get("grade"))), "students_count": _int(g.get("studentsCount", g.get("count"))), "subjects": subjects})
    return out

def norm_gradebook(doc: Any) -> dict[str, Any]:
    doc = doc if isinstance(doc, dict) else {}
    students = [{"student_id": _int(s.get("id", s.get("studentId"))), "student_name": _text(s.get("name", s.get("studentName")), 120) or ""} for s in _items(doc.get("students"))]
    types = [{"id": _int(t.get("id")), "name": _text(t.get("name"), 120)} for t in _items(doc.get("assignmentTypes"))]
    return {"students": [s for s in students if s["student_id"] is not None], "assignment_types": types}

def norm_schedule(doc: Any) -> list[dict[str, Any]]:
    flat: list[tuple[str, dict[str, Any]]] = []
    days = _items(doc, "days")
    if days and any("lessons" in d for d in days):
        for d in days:
            for lesson in _items(d.get("lessons")):
                flat.append((str(d.get("date") or "")[:10], lesson))
    else:
        flat = [(str(x.get("date") or x.get("day") or "")[:10], x) for x in _items(doc, "lessons", "items")]
    out = []
    for day, x in flat:
        if len(day) != 10: continue
        out.append({"date": day, "classmeeting_id": _int(x.get("classmeetingId", x.get("id"))), "class_id": _int(x.get("classId", x.get("groupId"))), "class_name": _text(x.get("className", x.get("groupName")), 40), "subject_id": _int(x.get("subjectId")), "subject": _text(x.get("subjectName"), 160) or "Урок", "number": _int(x.get("number", x.get("lessonNumber"))), "start": _text(x.get("startTime"), 5), "end": _text(x.get("endTime"), 5), "room": _text(x.get("room"), 40), "topic": _text(x.get("lessonTheme", x.get("topic")), 300)})
    return sorted(out, key=lambda r: (r["date"], r["number"] or 0))

def publish_payload(req: PublishHomeworkRequest) -> dict[str, Any]:
    return {"classmeetingId": req.classmeeting_id, "subjectId": req.subject_id, "assignmentTypeId": req.assignment_type_id, "assignmentName": req.title.strip()[:250], "description": req.description.strip()[:2000], "date": req.due_date.isoformat(), "weight": req.weight, "isDeleted": False}

def marks_payload(req: ExportMarksBatchRequest) -> dict[str, Any]:
    return {"marks": [{"studentId": m.student_id, "classmeetingId": req.classmeeting_id, "assignmentId": req.assignment_id, "mark": m.mark, "comment": (m.comment or "").strip()[:200]} for m in req.marks]}

def suggest_mark(percent: int | float | None) -> int | None:
    if percent is None: return None
    p = float(percent)
    return 5 if p >= 85 else 4 if p >= 65 else 3 if p >= 45 else 2

class NetSchoolTeacherClient:
    def __init__(self, request: Requester, access_token: str, paths: dict[str, str] | None = None) -> None:
        self._request = request
        self._headers = {"at": access_token}
        self.paths = {**NETSCHOOL_TEACHER_API, **{k: v for k, v in (paths or {}).items() if isinstance(v, str) and v.startswith("/") and k in NETSCHOOL_TEACHER_API}}

    async def _get(self, key: str, params: dict[str, Any] | None = None) -> Any:
        return await self._request("GET", self.paths[key], headers=self._headers, params=params, optional=True)

    async def get_teacher_context(self) -> dict[str, Any]:
        return norm_context(await self._get("context"), await self._get("year"))

    async def get_teacher_classes_and_subjects(self, school_id: int | None = None, year_id: int | None = None) -> list[dict[str, Any]]:
        params = {k: str(v) for k, v in (("schoolId", school_id), ("yearId", year_id)) if v is not None}
        return norm_classes(await self._get("classes", params or None))

    async def get_gradebook_students(self, class_id: int, subject_id: int | None = None) -> dict[str, Any]:
        params = {"classId": str(int(class_id))}
        if subject_id is not None: params["subjectId"] = str(int(subject_id))
        return {"class_id": class_id, "subject_id": subject_id, **norm_gradebook(await self._get("gradebook", params))}

    async def get_teacher_schedule(self, start: date, end: date, teacher_id: int | None = None) -> list[dict[str, Any]]:
        params = {"startDate": start.isoformat(), "endDate": end.isoformat()}
        if teacher_id is not None: params["teacherId"] = str(int(teacher_id))
        return norm_schedule(await self._get("schedule", params))

    async def publish_homework_assignment(self, req: PublishHomeworkRequest) -> dict[str, Any]:
        payload = publish_payload(req)
        resp = await self._request("POST", self.paths["publish"], headers=self._headers, json_body=payload)
        logger.info("teacher_sgo publish ok classmeeting=%s", req.classmeeting_id)
        sid = resp.get("id") if isinstance(resp, dict) else None
        return {"ok": True, "sgo_assignment_id": _int(sid), "sent": payload}

    async def export_verified_marks_to_sgo(self, req: ExportMarksBatchRequest) -> dict[str, Any]:
        payload = marks_payload(req)
        if req.dry_run: return {"ok": True, "dry_run": True, "exported_count": len(payload["marks"]), "preview": payload}
        reply = await self._request("POST", self.paths["marks"], headers=self._headers, json_body=payload, empty_ok=True)
        if isinstance(reply, dict) and (reply.get("ok") is False or reply.get("success") is False or reply.get("error") or reply.get("errors")):
            from app.sgo_client import SgoUnsupported
            raise SgoUnsupported("СГО не подтвердил запись оценки")
        logger.info("teacher_sgo marks ok count=%d classmeeting=%s", len(payload["marks"]), req.classmeeting_id)
        return {"ok": True, "dry_run": False, "exported_count": len(payload["marks"])}

router = APIRouter(prefix="/api/v1/teacher/sgo", tags=["teacher-sgo"])
_NOTE_OFF = ("Запись в журнал СГО на этом сервере выключена: показываем ровно то, что будет отправлено. "
             "Ничего не отправлено. Включает администратор (SGO_TEACHER_WRITE=1) после проверки на вашем регионе.")

def _teacher(request: Request, response: Response | None = None) -> str:
    from app import main as app_main
    from app.onboarding_routes import _uid
    app_main._require_teacher(request)
    if response is not None: response.headers["Cache-Control"] = "no-store"
    return _uid(request)

async def _live(request: Request, uid: str, op: Callable[[NetSchoolTeacherClient], Awaitable[Any]]) -> Any:
    from app.onboarding_routes import store, vault
    from app.sgo_adapter import SgoTeacherUnavailable, adapter
    try:
        return await adapter(store(), vault()).teacher_call(uid, op)
    except SgoTeacherUnavailable as exc:
        raise HTTPException(409, exc.message, headers={"X-SGO-Code": exc.code}) from None

def _preview(path_key: str, body: dict[str, Any], *, confirm: bool) -> dict[str, Any]:
    return {"ok": True, "dry_run": True, "write_enabled": write_enabled(), "confirm_required": not confirm,
            "would_send": {"method": "POST", "path": "/webapi" + NETSCHOOL_TEACHER_API[path_key], "body": body},
            "note": _NOTE_OFF if not write_enabled() else "Проверьте и подтвердите отправку в журнал СГО."}

@router.get("/status")
async def sgo_teacher_status(request: Request, response: Response) -> dict[str, Any]:
    uid = _teacher(request, response)
    from app import sgo_profiles as profiles
    from app.onboarding_routes import store, vault
    session = profiles.load_session(store(), vault(), uid)
    linked = bool(session and session.role == "teacher")
    return {"linked": linked, "write_enabled": write_enabled(), "mode": "live" if linked and write_enabled() else "preview", "max_marks_per_batch": MAX_MARKS_PER_BATCH, "note": None if linked else "Войдите в СГО как учитель (Профиль → Дневник), чтобы видеть классы и журнал."}

@router.get("/classes")
async def sgo_teacher_classes(request: Request, response: Response) -> dict[str, Any]:
    uid = _teacher(request, response)
    return {"classes": await _live(request, uid, lambda c: c.get_teacher_classes_and_subjects())}

@router.get("/gradebook")
async def sgo_teacher_gradebook(request: Request, response: Response, class_id: int, subject_id: int | None = None) -> dict[str, Any]:
    uid = _teacher(request, response)
    if class_id <= 0: raise HTTPException(422, "Укажите класс")
    return await _live(request, uid, lambda c: c.get_gradebook_students(class_id, subject_id))

@router.get("/schedule")
async def sgo_teacher_schedule(request: Request, response: Response, days: int = 7) -> dict[str, Any]:
    uid = _teacher(request, response)
    start = date.today(); end = start + timedelta(days=max(1, min(int(days), 14)) - 1)
    return {"lessons": await _live(request, uid, lambda c: c.get_teacher_schedule(start, end))}

@router.post("/assignments/publish")
async def sgo_teacher_publish(req: PublishHomeworkRequest, request: Request, response: Response) -> dict[str, Any]:
    uid = _teacher(request, response)
    from app.onboarding_routes import _limit
    _limit(request, "teacher_sgo_write", uid, 20)
    body = publish_payload(req)
    if not (write_enabled() and req.confirm): return _preview("publish", body, confirm=req.confirm)
    result = await _live(request, uid, lambda c: c.publish_homework_assignment(req))
    return {**result, "dry_run": False, "write_enabled": True}

@router.post("/gradebook/marks/export")
async def sgo_teacher_export_marks(req: ExportMarksBatchRequest, request: Request, response: Response) -> dict[str, Any]:
    uid = _teacher(request, response)
    from app.onboarding_routes import _limit
    _limit(request, "teacher_sgo_write", uid, 20)
    body = marks_payload(req)
    if req.dry_run or not (write_enabled() and req.confirm): return {**_preview("marks", body, confirm=req.confirm), "exported_count": 0, "checked_count": len(body["marks"])}
    result = await _live(request, uid, lambda c: c.export_verified_marks_to_sgo(req))
    return {**result, "write_enabled": True}
