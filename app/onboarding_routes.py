"""v2.1: мастер подключения (роль → школа → дневник) и обзор дневника по роли.

GET  /api/v1/schools/search   поиск школы СТРОГО в регионе (v2.3.2: region обязателен, только доверенные узлы)
GET  /api/v1/schools/regions  v2.4: все 89 субъектов РФ + connection_mode (выбор региона — первый шаг мастера)
POST /api/v1/schools/select   v2.3.2: сохранить выбор школы на сервере (school_uid из каталога)
GET  /api/v1/schools/selection v2.3.2: восстановить выбор + доступные способы входа (school_removed)
POST /api/v1/schools/autonomous v2.4: автономный режим (регион + номер/название, без дневника)
POST /api/v1/auth/role        выбор роли → user_profiles
GET  /api/v1/profile          профиль: роль, школа, hide_grades, font_scale, onboarding_completed
POST /api/v1/profile          частичное обновление hide_grades / font_scale / onboarding_completed
POST /api/v1/sgo/connect      вход в СГО выбранной роли по school_uid (пароль не сохраняется и не логируется)
GET  /api/v1/diary/overview   обзор: student_data | teacher_data (discriminated union по role), SWR
GET  /api/v1/diary/schedule   только расписание из того же обзора

Личность — только из проверенной платформенной сессии (MAX/Telegram/cookie), uid клиент не передаёт.
"""
from __future__ import annotations

import logging
import sqlite3
from typing import Annotated, Any, Literal, Union

from fastapi import APIRouter, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, SecretStr, StrictBool, TypeAdapter

from app import autonomous_school, live_discovery, region_coverage
from app import school_selection as selection
from app import sgo_profiles as profiles
from app.api_errors import CodedError
from app.platform_auth import store
from app.school_fuzzy import region_code as code_of_region, regions, search_page, strict_region
from app.sgo_adapter import SgoConnectError, adapter
from app.sgo_routes import SafeRoute

logger = logging.getLogger("sferumfocus.onboarding")
router = APIRouter(route_class=SafeRoute)

RoleName = Literal["student", "teacher"]
FontScaleName = Literal["small", "normal", "large", "xlarge"]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class RoleBody(Strict):
    role: RoleName


class ProfilePatch(Strict):
    hide_grades: bool | None = None
    font_scale: FontScaleName | None = None
    onboarding_completed: bool | None = None


class ConnectBody(Strict):
    role: RoleName = "student"
    # v2.3.2 (D2/A3) · Единственный идентификатор школы — school_uid из каталога. Поля прежнего контракта
    # (scid, sgo_base_url, school_name, region_code) принимаются только ради понятной ошибки
    # SCHOOL_SELECTION_REQUIRED и НИКОГДА не используются для выбора сервера.
    school_uid: str | None = Field(default=None, max_length=111, pattern=selection.SCHOOL_UID_PATTERN)
    scid: str | None = Field(default=None, max_length=10)
    sgo_base_url: str | None = Field(default=None, max_length=300)
    school_name: str | None = Field(default=None, max_length=300)
    region_code: str | None = Field(default=None, max_length=2)
    login: str = Field(min_length=1, max_length=200)
    password: SecretStr = Field(min_length=1, max_length=300, repr=False)
    student_id: int | None = Field(default=None, gt=0, lt=2**31)
    user_consent_ai: StrictBool = False
    consent_policy_version: str | None = Field(default=None, max_length=80)


# ------------------------------------------------------------------ response models
class SchoolItem(Strict):
    scid: str
    name: str
    short_name: str
    region_code: str | None
    region: str | None
    city: str | None
    sgo_base_url: str
    school_uid: str
    password_login: bool = True


QueryStatus = Literal["ok", "empty", "empty_query", "too_short"]


class LiveProbe(Strict):
    """v2.4 · Итог живого поиска у доверенных узлов (3.0 с). Ошибка узла — не 503, а статус."""
    attempted: bool
    status: Literal["disabled", "skipped", "no_trusted_host", "cached", "found", "not_found", "unavailable", "timeout"]
    hosts: int = 0
    resolved: int = 0
    timeout_s: float = 3.0


class InstitutionHint(Strict):
    name: str
    city: str | None = None


class AutonomousOffer(Strict):
    region_code: str | None
    region: str
    title: str
    hint: str
    school_label: str | None = None
    institution_matches: list[InstitutionHint] = []


class SchoolSearch(Strict):
    items: list[SchoolItem]
    region_code: str | None
    query_status: QueryStatus = "ok"
    offset: int = 0
    limit: int = 15
    has_more: bool = False
    source: Literal["local", "live"] = "local"
    live: LiveProbe | None = None
    autonomous: AutonomousOffer | None = None


class SelectBody(Strict):
    school_uid: str = Field(min_length=3, max_length=111, pattern=selection.SCHOOL_UID_PATTERN)


AuthMethod = Literal["sgo_credentials", "gosuslugi_esia", "moya_shkola"]


class AuthInfo(Strict):
    available_auth_methods: list[AuthMethod]
    primary_auth_method: AuthMethod | None
    auth_status: Literal["available", "unavailable"]
    reason: Literal["esia_disabled", "esia_misconfigured", "esia_not_configured", "no_supported_method"] | None
    esia_state: Literal["disabled", "misconfigured", "awaiting_official_credentials", "ready"]


class SelectedSchool(Strict):
    school_uid: str
    name: str
    short_name: str
    city: str | None
    region: str | None
    region_code: str | None


class SelectionResponse(Strict):
    status: Literal["none", "selected", "school_removed"]
    school: SelectedSchool | None
    auth: AuthInfo | None


class AutonomousChoice(Strict):
    region_code: str
    region: str
    school_label: str | None
    school_number: str | None
    display_name: str
    title: str
    connection_mode: Literal["autonomous_bridge"]
    region_connection_mode: Literal["sgo_direct", "esia_gateway", "autonomous_bridge"]
    diary_connected: bool
    features: list[str]


class AutonomousSelection(Strict):
    """v2.4 · Отдельная модель: ключ ``autonomous`` есть только в этом состоянии (старые ответы не меняются)."""
    status: Literal["autonomous"]
    school: None
    auth: None
    autonomous: AutonomousChoice


AnySelection = Union[SelectionResponse, AutonomousSelection]


class AutonomousBody(Strict):
    region: str = Field(min_length=1, max_length=150)
    school_label: str | None = Field(default=None, max_length=200)
    school_number: str | None = Field(default=None, max_length=12)


class Profile(Strict):
    role: RoleName
    scid: str | None
    school_name: str | None
    region_code: str | None
    sgo_base_url: str | None
    hide_grades: bool
    font_scale: FontScaleName
    onboarding_completed: bool
    updated_at: int
    # v2.2: ФИО и класс из подключённого СГО (только сервер; None — дневник не подключён или имя не пришло)
    full_name: str | None = None
    class_name: str | None = None


class SchoolRef(Strict):
    scid: str | None
    name: str | None


class Lesson(Strict):
    number: int | None
    start: str | None
    end: str | None
    subject: str
    room: str | None = None
    class_name: str | None = None


class ScheduleDay(Strict):
    date: str
    lessons: list[Lesson]


class Homework(Strict):
    title: str
    subject: str | None
    deadline: str | None
    type: str


class GradeItem(Strict):
    subject: str
    value: str
    date: str
    work_type: str = ""
    topic: str = ""


# v2.1: stale_cache — оценки показаны из сохранённой копии, потому что СГО не ответил (SWR). privacy_hidden важнее.
GradesState = Literal["ok", "empty", "privacy_hidden", "stale_cache", "upstream_error", "sgo_unlinked"]
OverviewStatus = Literal["ok", "empty", "privacy_hidden", "sgo_unlinked", "upstream_error"]


class StudentData(Strict):
    schedule: list[ScheduleDay]
    homework: list[Homework]
    grades: list[GradeItem]
    grades_state: GradesState
    average_score: float | None
    school_week_note: str | None = None      # v2.2: каникулы — показана ближайшая учебная неделя (СГО)


class TeacherClass(Strict):
    id: str
    name: str
    students_count: int | None
    subject: str | None


class JournalEntry(Strict):
    class_name: str | None
    subject: str | None
    lessons_without_marks: int | None
    marks_this_week: int | None
    average_mark: float | None
    last_lesson_date: str | None


class IssuedAssignment(Strict):
    id: str
    title: str
    class_name: str | None
    subject: str | None
    due_date: str | None
    submitted: int | None
    total: int | None


class TeacherData(Strict):
    classes: list[TeacherClass]
    schedule: list[ScheduleDay]
    journal_summary: list[JournalEntry]
    assignments_issued: list[IssuedAssignment]
    source: Literal["sgo", "sgo_without_teacher_api"]


class _Overview(Strict):
    status: OverviewStatus
    is_stale: bool
    cached_at: str | None
    school: SchoolRef | None
    reason: Literal["not_connected", "reauth_required", "upstream_unavailable"] | None = None


class StudentOverview(_Overview):
    role: Literal["student"]
    student_data: StudentData | None
    teacher_data: None = None


class TeacherOverview(_Overview):
    role: Literal["teacher"]
    teacher_data: TeacherData | None
    student_data: None = None


DiaryOverview = Annotated[Union[StudentOverview, TeacherOverview], Field(discriminator="role")]
_OVERVIEW = TypeAdapter(DiaryOverview)


class ScheduleResponse(Strict):
    status: OverviewStatus
    role: RoleName
    is_stale: bool
    cached_at: str | None
    schedule: list[ScheduleDay]


class ConnectResponse(Strict):
    status: Literal["connected"]
    role: RoleName
    is_teacher: bool
    school_name: str
    scid: str
    overview: DiaryOverview


# ------------------------------------------------------------------ helpers
# v2.1 · Ошибки дневника помечаются доменом: 401 INVALID_CREDENTIALS от СГО ≠ истёкшая сессия приложения.
SGO_ERROR: dict[str, str] = {"X-Error-Domain": "sgo"}


# platform_routes подключает этот роутер у себя в конце — импорт оттуда только ленивый (без цикла).
def vault() -> Any:
    from app.platform_routes import vault as platform_vault
    return platform_vault()


def _uid(request: Request) -> str:
    from app.platform_routes import account
    return str(account(request)["uid"])


def _limit(request: Request, kind: str, uid: str, per_user: int) -> None:
    from app.platform_routes import rate, too_many
    rate(request, kind, per_user * 4)
    bucket = f"{kind}:{uid}"
    if not store().rate(bucket, per_user, 300):
        raise too_many(bucket, "Слишком много запросов; повторите чуть позже")


def present(result: dict[str, Any], profile: dict[str, Any]) -> dict[str, Any]:
    """Сырые данные адаптера → публичный обзор. Приватность оценок применяется здесь, а не в кэше."""
    state = result["state"]
    role = result.get("role") or profile["role"]
    empty: dict[str, Any] = {"role": role, "is_stale": False, "cached_at": None,
                             "school": {"scid": profile["scid"], "name": profile["school_name"]} if profile["scid"] else None}
    data_key = "student_data" if role == "student" else "teacher_data"
    if state == "sgo_unlinked":
        return _OVERVIEW.validate_python({**empty, "status": "sgo_unlinked", "reason": "not_connected", data_key: None}).model_dump()
    cached: profiles.CacheEntry | None = result.get("cached")
    if cached is None or cached.payload.get("role") != role:
        status = "sgo_unlinked" if state == "reauth" else "upstream_error"
        reason = "reauth_required" if state == "reauth" else "upstream_unavailable"
        return _OVERVIEW.validate_python({**empty, "status": status, "reason": reason, data_key: None}).model_dump()
    payload = cached.payload
    stale = state in {"upstream_error", "reauth"}
    body: dict[str, Any] = {
        "role": role, "school": payload.get("school"), "cached_at": profiles.iso(cached.fetched_at),
        "is_stale": stale,
        "reason": {"reauth": "reauth_required", "upstream_error": "upstream_unavailable"}.get(state),
    }
    if role == "student":
        data = dict(payload["student_data"])
        hidden = bool(profile["hide_grades"])
        grades = [] if hidden else list(data.get("grades") or [])
        grades_state = "privacy_hidden" if hidden else ("empty" if not grades else ("stale_cache" if stale else "ok"))
        data.update(grades=grades, grades_state=grades_state,
                    average_score=None if hidden else data.get("average_score"))
        lessons = any(day["lessons"] for day in data.get("schedule") or [])
        anything = lessons or bool(data.get("homework")) or bool(grades)
        body.update(student_data=data, status="ok" if anything else ("privacy_hidden" if hidden else "empty"))
    else:
        data = dict(payload["teacher_data"])
        anything = any(bool(data.get(k)) for k in ("classes", "schedule", "assignments_issued", "journal_summary"))
        body.update(teacher_data=data, status="ok" if anything else "empty")
    return _OVERVIEW.validate_python(body).model_dump()


# ------------------------------------------------------------------ schools
REGION_TEXT = {
    "REGION_REQUIRED": "Сначала выберите регион — школы ищутся только в нём.",
    "REGION_UNKNOWN": "Такого региона нет в списке. Выберите регион из списка.",
}
CATALOG_TEXT = "Каталог школ временно недоступен. Повторите через полминуты."


@router.get("/api/v1/schools/search", response_model=SchoolSearch)
async def schools_search(request: Request, q: str = Query("", max_length=120), region: str | None = Query(None, max_length=150),
                         limit: int = Query(15, ge=1, le=50), offset: int = Query(0, ge=0, le=1000)) -> dict[str, Any]:
    """Локальный справочник → (пусто) живой поиск у доверенных узлов 3.0 с → (пусто) автономный режим.

    503 CATALOG_UNAVAILABLE — только если недоступен СОБСТВЕННЫЙ справочник. Недоступный/гео-заблокированный
    портал региона даёт 200 с пустым списком и карточкой автономного режима, а не ошибку.
    """
    uid = _uid(request)
    _limit(request, "school-search", uid, 240)
    try:
        name = strict_region(region)
    except ValueError as exc:
        code = str(exc)
        raise CodedError(422, code, REGION_TEXT[code]) from None
    try:
        page = search_page(store(), q, name, limit, offset)
    except sqlite3.Error:
        logger.warning("school_search catalog_unavailable")
        raise CodedError(503, "CATALOG_UNAVAILABLE", CATALOG_TEXT, retry_after=30) from None
    body: dict[str, Any] = {**page, "region_code": code_of_region(name), "offset": offset, "limit": limit}
    if page["query_status"] != "empty" or offset:
        return body
    # Ничего не нашли локально — один ограниченный живой поиск (отдельный лимит: порталы не нагружаем).
    probe = None
    if live_discovery.enabled() and store().rate(f"school-live:{uid}", 30, 300):
        probe = await live_discovery.discover(store(), q, name)
        if probe["status"] == "found":
            try:
                page = search_page(store(), q, name, limit, offset)
            except sqlite3.Error:
                page = {**page, "items": []}
            body.update(page)
            if page["items"]:
                body["source"] = "live"
    body["live"] = probe
    if not body["items"]:
        body["autonomous"] = autonomous_school.offer(name, q, _institution_hints(q, name))
    return body


def _institution_hints(query: str, region: str) -> list[dict[str, Any]]:
    """Подсказки из проверенного публичного реестра организаций (только чтение, без подключения дневника)."""
    from app import institution_catalog
    try:
        with store().tx() as db:
            rows = institution_catalog.search(db, query, region=region, limit=5)
    except (sqlite3.Error, ValueError, TypeError):
        return []
    hints = []
    for row in rows or []:
        row = dict(row)
        if row.get("name"):
            hints.append({"name": str(row["name"])[:300], "city": (str(row.get("city") or "")[:120] or None)})
    return hints[:5]


@router.post("/api/v1/schools/autonomous", response_model=AnySelection)
def school_autonomous(body: AutonomousBody, request: Request) -> dict[str, Any]:
    """v2.4 · «Выбрать школу в автономном режиме для региона …»: регион + номер/название без дневника."""
    uid = _uid(request)
    _limit(request, "school-select", uid, 30)
    try:
        v = vault()
    except HTTPException:
        v = None
    return autonomous_school.choose(store(), v, uid, body.region, body.school_label, body.school_number)


@router.get("/api/v1/schools/regions")
def school_regions(request: Request, q: str = Query("", max_length=80)) -> dict[str, Any]:
    """v2.4 · Все 89 субъектов РФ с честным режимом подключения (sgo_direct/esia_gateway/autonomous_bridge).

    Раньше — только субъекты с доверенными школами (7 из 89): остальные ученики упирались в тупик.
    ``regions`` (старый счётчик) сохранён: на нём держится проверка доступности каталога.
    """
    _uid(request)
    try:
        regions(store())                      # доступность каталога (sqlite3.Error → 503), как и раньше
        items = region_coverage.all_regions(store(), q)
        return {"items": items, "summary": region_coverage.summary(items)}
    except sqlite3.Error:
        logger.warning("school_regions catalog_unavailable")
        raise CodedError(503, "CATALOG_UNAVAILABLE", CATALOG_TEXT, retry_after=30) from None


def _telegram_id(request: Request) -> int | None:
    principal = str(getattr(request.state, "platform_principal", "") or "")
    return int(principal[3:]) if principal.startswith("tg:") and principal[3:].isdigit() else None


@router.post("/api/v1/schools/select", response_model=AnySelection)
def school_select(body: SelectBody, request: Request) -> dict[str, Any]:
    """Сохраняет выбор школы на сервере. Повторный выбор той же школы ничего не дублирует."""
    uid = _uid(request)
    _limit(request, "school-select", uid, 30)
    try:
        v = vault()
    except HTTPException:
        v = None
    return selection.select(store(), v, uid, body.school_uid, _telegram_id(request))


@router.get("/api/v1/schools/selection", response_model=AnySelection)
def school_selection(request: Request) -> dict[str, Any]:
    uid = _uid(request)
    return selection.selection(store(), uid)


# ------------------------------------------------------------------ role & profile
@router.post("/api/v1/auth/role", response_model=Profile)
def choose_role(body: RoleBody, request: Request) -> dict[str, Any]:
    uid = _uid(request)
    _limit(request, "profile-write", uid, 60)
    from app.user_roles import set_user_role
    set_user_role(store(), uid, body.role)
    return profiles.get_profile(store(), uid)


def _with_name(uid: str, profile: dict[str, Any]) -> dict[str, Any]:
    from app.identity_names import sgo_identity
    try:
        v = vault()
    except HTTPException:
        v = None
    got = sgo_identity(store(), v, uid) or {}
    return {**profile, "full_name": got.get("full_name"), "class_name": got.get("class_name")}


@router.get("/api/v1/profile", response_model=Profile)
def get_profile(request: Request) -> dict[str, Any]:
    uid = _uid(request)
    return _with_name(uid, profiles.get_profile(store(), uid))


@router.post("/api/v1/profile", response_model=Profile)
def patch_profile(body: ProfilePatch, request: Request) -> dict[str, Any]:
    uid = _uid(request)
    _limit(request, "profile-write", uid, 60)
    fields = body.model_dump(exclude_none=True)
    return _with_name(uid, profiles.update_profile(store(), uid, **fields))


# ------------------------------------------------------------------ connect
@router.post("/api/v1/sgo/connect", response_model=ConnectResponse,
             responses={401: {}, 403: {}, 404: {}, 409: {}, 429: {}, 503: {}})
async def sgo_connect(body: ConnectBody, request: Request) -> Any:
    uid = _uid(request)
    _limit(request, "sgo-connect", uid, 8)
    from app import ai_gate
    if body.user_consent_ai and body.consent_policy_version != ai_gate.CONSENT_POLICY_VERSION:
        raise HTTPException(409, "Текст согласия изменился. Обновите приложение и ознакомьтесь с ним снова.")
    password = body.password.get_secret_value()
    body.password = SecretStr("")
    # v2.3.2 · Школа — только из доверенного каталога по school_uid; до этой точки ни одного сетевого запроса.
    school, host = selection.resolve(store(), body.school_uid)
    if "sgo_credentials" not in (school.get("supported_auth_methods") or []):
        password = ""
        info = selection.auth_info(school, host)
        logger.info("sgo_connect role=%s result=LOGIN_METHOD_UNSUPPORTED", body.role)
        exc = SgoConnectError("LOGIN_METHOD_UNSUPPORTED", extra={"code": "LOGIN_METHOD_UNSUPPORTED", "auth": info})
        return JSONResponse(exc.body(), status_code=exc.status, headers={"Cache-Control": "no-store", **SGO_ERROR})
    v = vault()
    sgo = adapter(store(), v)
    try:
        resolved = sgo.resolved(school, host)
        result = await sgo.connect(uid=uid, role=body.role, resolved=resolved, login=body.login,
                                   password=password, student_id=body.student_id,
                                   region_code=code_of_region(school.get("region")))
    except SgoConnectError as exc:
        logger.info("sgo_connect role=%s result=%s", body.role, exc.code)
        # Ошибка ДНЕВНИКА (неверный пароль, роль, недоступность СГО), а не сессии приложения: фронт по
        # X-Error-Domain/error_code не сбрасывает вход. 401 «нет сессии» из account() заголовок НЕ получает.
        return JSONResponse(exc.body(), status_code=exc.status, headers={"Cache-Control": "no-store", **SGO_ERROR})
    finally:
        password = ""
        if sgo.client is not None:
            await sgo.client.aclose()
    if body.user_consent_ai:
        ai_gate.grant(store(), uid)
    actual_role = result["payload"]["role"]
    from app.user_roles import set_user_role
    set_user_role(store(), uid, actual_role)
    if actual_role == "teacher":
        selection.remember(store(), uid, school, _telegram_id(request))
    payload = result["payload"]
    profile = profiles.get_profile(store(), uid)
    entry = profiles.CacheEntry(payload, result["fetched_at"], result["fetched_at"])
    overview = present({"state": "fresh", "role": actual_role, "cached": entry}, profile)
    return {"status": "connected", "role": actual_role, "is_teacher": actual_role == "teacher", "school_name": payload["school"]["name"],
            "scid": payload["school"]["scid"], "overview": overview}


class LogoutResponse(Strict):
    status: Literal["logged_out"]
    deleted: bool
    remote_logout: str


@router.post("/api/v1/sgo/logout", response_model=LogoutResponse)
async def sgo_logout(request: Request) -> dict[str, Any]:
    """v2.2 · «Выйти / Сменить аккаунт СГО»: удаляет связь дневника, сессию мастера (токен, cookies, ФИО),
    SWR-кэш и снимок оценок, пробует выйти на стороне СГО и снова открывает мастер подключения
    (onboarding_completed=false). Аккаунт приложения (MAX/Telegram) и настройки оформления остаются.
    Несколько аккаунтов СГО одновременно не поддерживаются: смена = выход из текущего + новый вход."""
    from app.diary_disconnect import disconnect_diary
    uid = _uid(request)
    _limit(request, "sgo-logout", uid, 10)
    result = await disconnect_diary(store(), vault(), uid)
    profiles.update_profile(store(), uid, onboarding_completed=False)
    logger.info("sgo_logout remote=%s", result.get("remote_logout"))
    return {"status": "logged_out", "deleted": bool(result.get("deleted")),
            "remote_logout": str(result.get("remote_logout") or "not_applicable")}


# ------------------------------------------------------------------ overview
async def _overview(request: Request, refresh: bool) -> dict[str, Any]:
    uid = _uid(request)
    _limit(request, "diary-overview", uid, 120 if not refresh else 20)
    sgo = adapter(store(), vault())
    try:
        result = await sgo.overview(uid, refresh=refresh)
    finally:
        if sgo.client is not None:
            await sgo.client.aclose()
    return present(result, profiles.get_profile(store(), uid))


@router.get("/api/v1/diary/overview", response_model=DiaryOverview)
async def diary_overview(request: Request, refresh: bool = False) -> dict[str, Any]:
    return await _overview(request, refresh)


@router.get("/api/v1/diary/days")
async def diary_days(request: Request, start: str = Query(pattern=r"^\d{4}-\d{2}-\d{2}$"),
                     end: str = Query(pattern=r"^\d{4}-\d{2}-\d{2}$")) -> dict[str, Any]:
    """v3.2 · дни дневника СГО за период ≤ 3 недель: уроки, ДЗ под каждым уроком, отметки — и прошлые дни."""
    from datetime import date as _d, timedelta as _td
    uid = _uid(request)
    try:
        a, b = _d.fromisoformat(start), _d.fromisoformat(end)
    except ValueError:
        raise HTTPException(422, "Дата в формате ГГГГ-ММ-ДД") from None
    if b < a or (b - a).days > 20:
        raise HTTPException(422, "Период — от 1 дня до 3 недель")
    if abs((a - _d.today()).days) > 500:
        raise HTTPException(422, "Дата вне прошлого, текущего и следующего учебного года")
    _limit(request, "diary-days", uid, 60)
    sgo = adapter(store(), vault())
    try:
        result = await sgo.diary_days(uid, a, b)
    finally:
        if sgo.client is not None:
            await sgo.client.aclose()
    if profiles.get_profile(store(), uid).get("hide_grades"):
        result = {**result, "days": [{**d, "lessons": [{**l, "marks": []} for l in d["lessons"]]} for d in result["days"]]}
    return {**result, "start": a.isoformat(), "end": b.isoformat(), "source": "sgo"}


@router.get("/api/v1/diary/grades/period")
async def diary_grades_period(request: Request, response: Response,
    start: str = Query(pattern=r"^\d{4}-\d{2}-\d{2}$"), end: str = Query(pattern=r"^\d{4}-\d{2}-\d{2}$")) -> dict[str, Any]:
    from datetime import date as _d
    uid = _uid(request)
    response.headers["Cache-Control"] = "no-store"
    try:
        a, b = _d.fromisoformat(start), _d.fromisoformat(end)
    except ValueError:
        raise HTTPException(422, "Дата в формате ГГГГ-ММ-ДД") from None
    if b < a or (b-a).days > 20 or abs((a-_d.today()).days)>500:
        raise HTTPException(422, "Период — до 3 недель в пределах доступного учебного года")
    _limit(request, "diary-grades-period", uid, 60)
    if profiles.get_profile(store(), uid).get("hide_grades"):
        return {"state":"privacy_hidden", "grades": [], "start":start, "end":end}
    sgo = adapter(store(), vault())
    try:
        result = await sgo.grades_period(uid, a, b)
    finally:
        if sgo.client is not None:
            await sgo.client.aclose()
    if profiles.get_profile(store(), uid).get("hide_grades"):
        result = {"state":"privacy_hidden", "grades": []}
    return {**result, "start":start, "end":end, "source":"sgo_diary", "official_period_grades":None}


@router.get("/api/v1/diary/schedule", response_model=ScheduleResponse)
async def diary_schedule(request: Request, refresh: bool = False) -> dict[str, Any]:
    body = await _overview(request, refresh)
    data = body.get("student_data") or body.get("teacher_data") or {}
    return {"status": body["status"], "role": body["role"], "is_stale": body["is_stale"],
            "cached_at": body["cached_at"], "schedule": data.get("schedule") or []}
