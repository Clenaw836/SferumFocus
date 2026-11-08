"""v2.1: SGOMultiRegionAdapter — подключение любого регионального СГО (NetSchool) и данные по роли.

* Транспорт: app.sgo_client.SgoHTTP (httpx, DNS-пиннинг публичных адресов, лимит ответа 2 МБ,
  браузерные заголовки UA/Accept/Accept-Language/Origin/Referer/X-Requested-With).
* Role-Based Strategy Dispatcher: SGOStudentStrategy / SGOTeacherStrategy проверяют, что аккаунт
  соответствует выбранной роли, и собирают student_data / teacher_data.
* Сессия: cookies и токен — зашифрованно в sgo_sessions (пароль не хранится). Истечение или
  401/403 обрабатывает ОДИН «освежитель» на пользователя (_user_sgo_locks), остальные ждут его.
* Stale-While-Revalidate: удачный ответ кладётся в sgo_data_cache; при таймауте/5xx СГО отдаём
  сохранённую копию со статусом 200, is_stale=true и cached_at.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import time
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any, Protocol

import httpx

from app import sgo_profiles as profiles
from app.diary_providers import DiarySnapshot, ProviderUnavailable, ReauthRequired, UnsupportedPortal
from app.sgo_client import NetSchoolClient, SgoAuthRejected, SgoHTTP, SgoPasswordUnsupported, SgoUnsupported
from app.sgo_directory import Directory
from app.sgo_profiles import Role

logger = logging.getLogger("sferumfocus.sgo")

SESSION_TTL = 50 * 60          # NetSchool гасит неактивную сессию примерно через час
CACHE_FRESH_SECONDS = 5 * 60   # свежая копия отдаётся без похода в СГО
CONNECT_TIMEOUT = 40.0
UPSTREAM_TIMEOUT = 15.0
MAX_LOCKS = 20_000

# Тестовая точка подмены: httpx.AsyncClient c ASGITransport эмулятора. В проде None —
# SgoHTTP ходит сам через защищённый транспорт.
CLIENT_FACTORY: Any = None

ERRORS: dict[str, tuple[int, str]] = {
    "INVALID_CREDENTIALS": (401, "Неверный логин или пароль от дневника"),
    "SCHOOL_NOT_FOUND": (404, "Школа не найдена на сервере региона. Выберите её из списка ещё раз"),
    "ROLE_MISMATCH": (403, "Учётная запись не соответствует выбранной роли"),
    "SGO_UNAVAILABLE": (503, "Сервер школы сейчас не отвечает. Попробуйте через минуту"),
    "TOO_MANY_ATTEMPTS": (429, "Сервер школы ограничил попытки входа. Подождите пару минут"),
    "LOGIN_METHOD_UNSUPPORTED": (409, "Эта школа принимает вход в дневник только через Госуслуги. "
                                      "В приложении этот способ сейчас недоступен — выберите другую школу или демо-режим"),
    "DIARY_ALREADY_CONNECTED": (409, "Сначала отключите текущий дневник в настройках"),
    "STUDENT_CHOICE_REQUIRED": (409, "В аккаунте несколько детей — выберите, чей дневник подключить"),
    "CONNECT_IN_PROGRESS": (409, "Подключение уже выполняется — подождите несколько секунд"),
    "PASSWORD_UNSUPPORTED_CHARS": (422, "В пароле есть символы, которые сервер этой школы не принимает (например, эмодзи). "
                                        "Смените пароль в СГО на буквы и цифры и войдите снова"),
}


class SgoConnectError(Exception):
    def __init__(self, code: str, *, extra: dict[str, Any] | None = None) -> None:
        self.code = code
        self.status, self.message = ERRORS[code]
        self.extra = extra or {}
        super().__init__(code)

    def body(self) -> dict[str, Any]:
        # v2.3.2 · единый конверт: code == error_code (lib/api.ts читает любой из них)
        return {"error_code": self.code, "code": self.code, "detail": self.message, **self.extra}


class SgoTeacherUnavailable(Exception):
    """v3.2: живой учительский вызов невозможен — код для UI (sgo_not_linked / reauth_required / upstream)."""
    def __init__(self, code: str, message: str) -> None:
        super().__init__(code)
        self.code, self.message = code, message


class _SessionDead(Exception):
    """Токен СГО больше не принимается: нужен новый вход (пароль мы не храним)."""


# ------------------------------------------------------------------ per-user single-flight
_user_sgo_locks: dict[str, asyncio.Lock] = {}
_lock_loops: dict[str, asyncio.AbstractEventLoop] = {}


def user_lock(uid: str) -> asyncio.Lock:
    """Один asyncio.Lock на пользователя: один вход/освежение сессии СГО за раз."""
    loop = asyncio.get_running_loop()
    lock = _user_sgo_locks.get(uid)
    if lock is None or _lock_loops.get(uid) is not loop:
        if len(_user_sgo_locks) >= MAX_LOCKS:
            for key in [k for k, v in _user_sgo_locks.items() if not v.locked()][: MAX_LOCKS // 2]:
                _user_sgo_locks.pop(key, None)
                _lock_loops.pop(key, None)
        lock = _user_sgo_locks[uid] = asyncio.Lock()
        _lock_loops[uid] = loop
    return lock


# Монотонный маркер последнего удачного похода в СГО (uid → time.monotonic()). fetched_at хранится в секундах,
# поэтому явный refresh=true в ту же секунду, что и подключение, раньше «склеивался» с ним и не доходил до СГО.
_refreshed_at: dict[str, float] = {}
_REFRESHED_MAX = 10_000


def mark_refreshed(uid: str) -> None:
    _refreshed_at[uid] = time.monotonic()
    if len(_refreshed_at) > _REFRESHED_MAX:
        # Зачистка: выбрасываем самую старую половину (маркер нужен лишь на время ожидания замка).
        for key, _ in sorted(_refreshed_at.items(), key=lambda kv: kv[1])[: len(_refreshed_at) // 2]:
            _refreshed_at.pop(key, None)


def refreshed_since(uid: str, moment: float) -> bool:
    return _refreshed_at.get(uid, float("-inf")) > moment


# ------------------------------------------------------------------ role detection
_TEACHER_WORDS = ("учител", "teacher", "преподава", "педагог", "администр", "завуч", "директор", "воспитат")
_STUDENT_WORDS = ("ученик", "student", "обучающ", "родител", "parent", "законн")


def detect_roles(login_result: dict[str, Any]) -> set[str]:
    """Роли из ответа /login (accountInfo.userRoles / roles). Пусто — СГО роли не сообщил."""
    found: set[str] = set()
    info = login_result.get("accountInfo") if isinstance(login_result, dict) else None
    raw: list[Any] = []
    user = info.get("user") if isinstance(info, dict) else None
    for source in (info if isinstance(info, dict) else {}, user if isinstance(user, dict) else {}, login_result if isinstance(login_result, dict) else {}):
        for key in ("userRoles", "roles", "role"):
            value = source.get(key)
            if isinstance(value, list):
                raw.extend(value)
            elif isinstance(value, str):
                raw.append(value)
    for item in raw[:50]:
        name = item.get("name") if isinstance(item, dict) else item
        if not isinstance(name, str):
            continue
        low = name.casefold()
        if any(w in low for w in _TEACHER_WORDS):
            found.add("teacher")
        if any(w in low for w in _STUDENT_WORDS):
            found.add("student")
    return found


# ------------------------------------------------------------------ strategies
@dataclass
class Ctx:
    client: NetSchoolClient
    http: SgoHTTP
    native: dict[str, Any]
    login_result: dict[str, Any]
    school: dict[str, Any]
    host: dict[str, Any]
    student_id: int | None = None


class RoleStrategy(Protocol):
    role: Role

    async def verify(self, ctx: Ctx) -> None: ...

    async def fetch(self, ctx: Ctx) -> dict[str, Any]: ...


def _hhmm(value: Any) -> str | None:
    return value[:5] if isinstance(value, str) and len(value) >= 5 and value[2] == ":" else None


def _numeric_grade(value: str) -> float | None:
    """Совместимость: среднее числовых частей отметки («5/4» → 4.5) по правилу app/grade_marks.py."""
    from app.grade_marks import marks_of
    marks = marks_of(value)
    return float(sum(marks) / len(marks)) if marks else None


def student_payload(snapshot: DiarySnapshot, school_date: date) -> dict[str, Any]:
    days = []
    for stamp in sorted(snapshot.days):
        if stamp < school_date.isoformat():
            continue
        lessons = [{"number": x.get("lesson_number"), "start": x.get("start_time"), "end": x.get("end_time"),
                    "subject": x.get("subject") or "", "room": x.get("room") or None, "class_name": None}
                   for x in sorted(snapshot.days[stamp], key=lambda x: x.get("lesson_number") or 0)]
        days.append({"date": stamp, "lessons": lessons})
    homework = []
    for task in snapshot.tasks[:200]:
        title = str(task.get("title") or "")
        subject, _, rest = title.partition(": ")
        homework.append({"title": rest or title, "subject": subject if rest else None,
                         "deadline": task.get("deadline"), "type": task.get("type") or "written"})
    grades = sorted(({"subject": g.subject, "value": g.value, "date": g.date, "work_type": g.work_type, "topic": g.topic}
                     for g in snapshot.grades), key=lambda g: g["date"], reverse=True)
    from app.grade_marks import weighted_average
    average = weighted_average(snapshot.grades)
    out = {"schedule": days[:14], "homework": homework, "grades": grades[:300], "average_score": average}
    if snapshot.next_school_week:
        d = date.fromisoformat(snapshot.next_school_week)
        out["school_week_note"] = f"Каникулы или выходные: в СГО нет уроков на эту и следующую неделю. Показана ближайшая учебная неделя с {d.day:02d}.{d.month:02d}."
    return out


class SGOStudentStrategy:
    role: Role = "student"

    async def verify(self, ctx: Ctx) -> None:
        roles = detect_roles(ctx.login_result)
        if roles and "student" not in roles:
            raise SgoConnectError("ROLE_MISMATCH")
        init = await ctx.http.request("GET", "/student/diary/init", headers={"at": ctx.native["access_token"]})
        students = init.get("students") if isinstance(init, dict) else None
        if not isinstance(students, list) or not students:
            raise SgoConnectError("ROLE_MISMATCH")  # учительский аккаунт без дневника ученика
        if len(students) > 1 and ctx.student_id is None:
            current = init.get("currentStudentId")
            known = {str(s.get("studentId")) for s in students if isinstance(s, dict)}
            if str(current) not in known:
                raise SgoConnectError("STUDENT_CHOICE_REQUIRED", extra={"students": [
                    {"id": int(s["studentId"]), "name": str(s.get("nickName") or s.get("name") or "")[:120],
                     "class_name": str(s.get("className") or "")[:30]}
                    for s in students[:10] if isinstance(s, dict) and type(s.get("studentId")) is int]})
        try:
            await ctx.client._initialize(ctx.http, ctx.native, ctx.student_id)
        except SgoUnsupported as exc:
            raise SgoConnectError("ROLE_MISMATCH") from exc

    async def fetch(self, ctx: Ctx) -> dict[str, Any]:
        today = date.today()
        snapshot = await ctx.client.fetch(ctx.native, http=ctx.http, school=ctx.school, day=today)
        ctx.native["_snapshot"] = snapshot.model_dump()
        return {"student_data": student_payload(snapshot, today)}


def _as_list(doc: Any, *keys: str) -> list[dict[str, Any]]:
    if isinstance(doc, dict):
        for key in keys:
            if isinstance(doc.get(key), list):
                doc = doc[key]
                break
    return [x for x in doc[:200] if isinstance(x, dict)] if isinstance(doc, list) else []


def _int_or_none(value: Any) -> int | None:
    return value if type(value) is int and 0 <= value < 1_000_000 else None


def _text(value: Any, limit: int = 200) -> str | None:
    return str(value).strip()[:limit] if isinstance(value, (str, int)) and str(value).strip() else None


class SGOTeacherStrategy:
    """Учитель: роль подтверждается по ответу /login; данные — из учительского API региона.

    Открытого контракта учительских методов у NetSchool нет: пути задаются в metadata.teacher_api
    узла (classes / schedule / journal / assignments). Если регион их не открыл — разделы пустые,
    а интерфейс честно предлагает собственные классы и задания SferumFocus.
    """
    role: Role = "teacher"

    async def verify(self, ctx: Ctx) -> None:
        """v2.2: учитель, у которого в том же аккаунте СГО есть собственный ребёнок, видит в
        /student/diary/init непустой список students — раньше это давало ложный ROLE_MISMATCH.
        Порядок: роли из /login → роли из /context → учительский API узла → сверка id: свой ли это
        ученический дневник (id пользователя = studentId) или ребёнок учителя-родителя."""
        if ctx.native.get("teacher_verified") is True:
            return
        roles = detect_roles(ctx.login_result)
        if "teacher" in roles:
            return
        if roles:
            raise SgoConnectError("ROLE_MISMATCH")     # СГО явно назвал роли, учителя среди них нет
        headers = {"at": ctx.native["access_token"]}

        async def optional(path: str) -> Any:
            try:
                return await ctx.http.request("GET", path, headers=headers, optional=True)
            except ReauthRequired:
                return None                            # 401/403 на чужой раздел — ожидаемо, это не ошибка входа
        context = await optional("/context")
        if isinstance(context, dict):
            found = detect_roles(context) | detect_roles(context.get("user") if isinstance(context.get("user"), dict) else {})
            if "teacher" in found:
                return
            if found:
                raise SgoConnectError("ROLE_MISMATCH")
        api = (ctx.host.get("metadata") or {}).get("teacher_api") or {}
        probe = api.get("classes")
        if isinstance(probe, str) and probe.startswith("/") and await optional(probe) is not None:
            return                                     # учительский раздел узла ответил этому токену
        init = await optional("/student/diary/init")
        students = init.get("students") if isinstance(init, dict) else None
        if not isinstance(students, list) or not students:
            return                                     # ученического дневника нет — это не ученик
        info = ctx.login_result.get("accountInfo") if isinstance(ctx.login_result, dict) else None
        user = info.get("user") if isinstance(info, dict) else None
        uid = user.get("id") if isinstance(user, dict) else None
        own = {s.get("studentId") for s in students if isinstance(s, dict)}
        if uid is not None and uid in own:
            raise SgoConnectError("ROLE_MISMATCH")     # это собственный дневник ученика
        ctx.native["teacher_roles"] = "unconfirmed_parent_account"   # роль не названа сервером — честная пометка

    async def fetch(self, ctx: Ctx) -> dict[str, Any]:
        api = ctx.host.get("metadata", {}).get("teacher_api") or {}
        headers = {"at": ctx.native["access_token"]}

        alive: list[bool] = []                         # кэш проверки «сессия жива?» на один fetch

        async def get(name: str, params: dict[str, str] | None = None) -> Any:
            path = api.get(name)
            if not isinstance(path, str) or not path.startswith("/"):
                return None
            try:
                return await ctx.http.request("GET", path, headers=headers, params=params, optional=True)
            except ReauthRequired:
                # v2.2: 401/403 на учительский раздел бывает и у живой сессии (учитель-родитель, раздел закрыт
                # регионом). Различаем одним запросом /context: жив — раздел честно пуст; мёртв — повторный вход.
                if not alive:
                    try:
                        alive.append(await ctx.http.request("GET", "/context", headers=headers, optional=True) is not None)
                    except ReauthRequired:
                        alive.append(False)
                if not alive[0]:
                    raise
                return None

        monday = date.today() - timedelta(days=date.today().weekday())
        week = {"weekStart": monday.isoformat(), "weekEnd": (monday + timedelta(days=6)).isoformat()}
        classes_doc, schedule_doc, journal_doc, assignments_doc = (
            await get("classes"), await get("schedule", week), await get("journal", week), await get("assignments"))
        probed = False
        if not api:
            # v3.2: узел не описал учительский API — пробуем стандартные пути NetSchool (sgo_teacher_client).
            # Любой отказ раздела (404/400/401/403/сбой) — раздел честно пуст, вход учителя не ломаем.
            from app.sgo_teacher_client import NETSCHOOL_TEACHER_API, norm_classes, norm_schedule

            async def probe(path: str, params: dict[str, str] | None = None) -> Any:
                try:
                    return await ctx.http.request("GET", path, headers=headers, params=params, optional=True)
                except (ReauthRequired, SgoAuthRejected, SgoUnsupported, ProviderUnavailable, httpx.HTTPError,
                        TimeoutError, OSError, ValueError):
                    return None
            groups = norm_classes(await probe(NETSCHOOL_TEACHER_API["classes"]))
            lessons = norm_schedule(await probe(NETSCHOOL_TEACHER_API["schedule"],
                                                {"startDate": week["weekStart"], "endDate": week["weekEnd"]}))
            if groups:
                classes_doc = [{"id": g["class_id"], "name": g["class_name"], "studentsCount": g["students_count"],
                                "subjectName": ", ".join(x["name"] for x in g["subjects"] if x["name"]) or None}
                               for g in groups]
            if lessons:
                schedule_doc = [{"date": x["date"], "number": x["number"], "startTime": x["start"], "endTime": x["end"],
                                 "subjectName": x["subject"], "room": x["room"], "className": x["class_name"]}
                                for x in lessons]
            probed = bool(groups or lessons)
        classes = [{"id": str(c.get("id")), "name": _text(c.get("name"), 40) or "Класс",
                    "students_count": _int_or_none(c.get("studentsCount", c.get("students_count"))),
                    "subject": _text(c.get("subjectName", c.get("subject")), 120)}
                   for c in _as_list(classes_doc, "classes", "items") if c.get("id") is not None]
        by_day: dict[str, list[dict[str, Any]]] = {}
        for lesson in _as_list(schedule_doc, "lessons", "items"):
            day = str(lesson.get("date") or "")[:10]
            if len(day) != 10:
                continue
            by_day.setdefault(day, []).append({
                "number": _int_or_none(lesson.get("number")), "start": _hhmm(lesson.get("startTime")),
                "end": _hhmm(lesson.get("endTime")), "subject": _text(lesson.get("subjectName"), 160) or "Урок",
                "room": _text(lesson.get("room"), 40), "class_name": _text(lesson.get("className"), 40)})
        schedule = [{"date": d, "lessons": sorted(v, key=lambda x: x["number"] or 0)}
                    for d, v in sorted(by_day.items()) if d >= date.today().isoformat()][:14]
        # Контракт 7.2: journal_summary — список (статус заполнения журнала по каждому классу/предмету).
        # Узел региона может отдать список по классам или одну общую сводку — во втором случае это одна строка.
        rows = _as_list(journal_doc, "classes", "items", "entries")
        if not rows and isinstance(journal_doc, dict) and any(
                k in journal_doc for k in ("lessonsWithoutMarks", "marksThisWeek", "averageMark", "lastLessonDate")):
            rows = [journal_doc]
        journal = []
        for row in rows[:60]:
            avg = row.get("averageMark")
            journal.append({"class_name": _text(row.get("className"), 40), "subject": _text(row.get("subjectName"), 160),
                            "lessons_without_marks": _int_or_none(row.get("lessonsWithoutMarks")),
                            "marks_this_week": _int_or_none(row.get("marksThisWeek")),
                            "average_mark": round(float(avg), 2) if isinstance(avg, (int, float)) and 0 < avg <= 5 else None,
                            "last_lesson_date": _text(row.get("lastLessonDate"), 10)})
        assignments = [{"id": str(a.get("id")), "title": _text(a.get("title", a.get("assignmentName")), 300) or "Задание",
                        "class_name": _text(a.get("className"), 40), "subject": _text(a.get("subjectName"), 160),
                        "due_date": _text(a.get("dueDate"), 10), "submitted": _int_or_none(a.get("submitted")),
                        "total": _int_or_none(a.get("total"))}
                       for a in _as_list(assignments_doc, "assignments", "items") if a.get("id") is not None]
        return {"teacher_data": {"classes": classes, "schedule": schedule, "journal_summary": journal,
                                 "assignments_issued": assignments,
                                 "source": "sgo" if api or probed else "sgo_without_teacher_api"}}


STRATEGIES: dict[str, RoleStrategy] = {"student": SGOStudentStrategy(), "teacher": SGOTeacherStrategy()}


def strategy_for(role: str) -> RoleStrategy:
    """Role-Based Strategy Dispatcher."""
    try:
        return STRATEGIES[role]
    except KeyError:
        raise ValueError("unknown role") from None


# ------------------------------------------------------------------ adapter
class _Vault(Protocol):
    def seal(self, uid: str, purpose: str, value: Any) -> str: ...
    def open(self, uid: str, purpose: str, ciphertext: str) -> Any: ...
    def get(self, uid: str) -> dict[str, Any] | None: ...
    def bind(self, uid: str, provider: str, **kw: Any) -> None: ...
    def disconnect(self, uid: str) -> dict[str, Any]: ...


@dataclass
class Resolved:
    school: dict[str, Any]
    host: dict[str, Any]


class SGOMultiRegionAdapter:
    def __init__(self, repo: Any, vault: _Vault, *, client: httpx.AsyncClient | None = None) -> None:
        self.repo = repo
        self.vault = vault
        self.client = client
        self.directory = Directory(repo)

    # -------------------------------------------------- school
    def resolved(self, school: dict[str, Any], host: dict[str, Any]) -> Resolved:
        """v2.3.2 (D2) · Школа и узел приходят только из доверенного каталога (app.school_selection.resolve).
        Прежний resolve(scid, base_url) регистрировал адрес из запроса как новый узел, ходил на него в сеть и
        создавал «Школа · код N» — каталог отравлялся, а пароль уходил на адрес клиента. Удалён без замены."""
        from app.sgo_directory import is_trusted
        if not is_trusted(host) or school.get("host_id") != host.get("host_id"):
            raise SgoConnectError("SCHOOL_NOT_FOUND")
        return Resolved(school, host)

    # -------------------------------------------------- connect
    async def connect(self, *, uid: str, role: Role, resolved: Resolved, login: str, password: str,
                      student_id: int | None = None, region_code: str | None = None) -> dict[str, Any]:
        lock = user_lock(uid)
        if lock.locked():
            raise SgoConnectError("CONNECT_IN_PROGRESS")
        async with lock:
            strategy = strategy_for(role)
            school, host = resolved.school, resolved.host
            if role == "student":
                self._check_existing_diary(uid, school["school_uid"])
            nsc = NetSchoolClient(host, client=self.client)
            try:
                http, native, result = await asyncio.wait_for(nsc.authenticate(school, login, password), CONNECT_TIMEOUT)
                ctx = Ctx(nsc, http, native, result, school, host, student_id)
                detected = detect_roles(result)
                if not detected:
                    try:
                        context = await http.request("GET", "/Context", headers={"at": native["access_token"]}, optional=True)
                    except (ReauthRequired, ProviderUnavailable):
                        context = None
                    detected = detect_roles(context) if isinstance(context, dict) else set()
                    if isinstance(context, dict) and isinstance(context.get("user"), dict):
                        detected |= detect_roles(context["user"])
                if role == "student" and "teacher" in detected:
                    role, strategy = "teacher", strategy_for("teacher")
                native.update(role=role, is_teacher=role == "teacher", teacher_verified="teacher" in detected)
                await asyncio.wait_for(strategy.verify(ctx), UPSTREAM_TIMEOUT)
                data = await asyncio.wait_for(strategy.fetch(ctx), CONNECT_TIMEOUT)
            except SgoConnectError:
                raise
            except SgoPasswordUnsupported:
                raise SgoConnectError("PASSWORD_UNSUPPORTED_CHARS") from None
            except SgoAuthRejected as exc:
                code = "TOO_MANY_ATTEMPTS" if "огранич" in str(exc) else "INVALID_CREDENTIALS"
                raise SgoConnectError(code) from None
            except SgoUnsupported as exc:
                text = str(exc)
                if "отключил вход" in text:
                    raise SgoConnectError("LOGIN_METHOD_UNSUPPORTED") from None
                raise SgoConnectError("SGO_UNAVAILABLE") from None
            except ReauthRequired:
                raise SgoConnectError("SGO_UNAVAILABLE") from None  # 401/403 до /login — WAF/блокировка, не пароль
            except (ProviderUnavailable, httpx.HTTPError, TimeoutError, OSError, ValueError, KeyError, TypeError):
                raise SgoConnectError("SGO_UNAVAILABLE") from None
            native["cookies"] = http.export_cookies()
            info = result.get("accountInfo") if isinstance(result, dict) else None
            user = info.get("user") if isinstance(info, dict) else None
            name = user.get("name") if isinstance(user, dict) else None
            if isinstance(name, str) and name.strip():
                native["user_name"] = "".join(ch for ch in name.strip() if ch.isprintable())[:120]   # ФИО учётной записи СГО
            if http.discovered_prefix:
                self.directory.set_prefix(host["host_id"], http.discovered_prefix)
            snapshot = native.pop("_snapshot", None)
            if role == "student" and snapshot is not None:
                self._bind_legacy(uid, school, host, native, snapshot)
            native["school_uid"] = school["school_uid"]
            profiles.save_session(self.repo, self.vault, uid=uid, role=role, scid=str(school["scid"]),
                                  base_url=host["base_url"], login=login, native=native, ttl=SESSION_TTL)
            payload = {"role": role, "school": {"scid": str(school["scid"]), "name": school["short_name"] or school["name"]},
                       **data}
            entry = profiles.cache_put(self.repo, self.vault, uid, role, "overview", payload, CACHE_FRESH_SECONDS)
            mark_refreshed(uid)
            from app.user_roles import set_user_role
            set_user_role(self.repo, uid, role)
            profiles.update_profile(self.repo, uid, role=role, scid=str(school["scid"]),
                                    school_name=school["short_name"] or school["name"],
                                    region_code=region_code, sgo_base_url=host["base_url"], onboarding_completed=True)
            self.directory.mark(host["host_id"], "online")
            logger.info("sgo_connect role=%s result=connected", role)
            return {"payload": payload, "fetched_at": entry.fetched_at}

    def _check_existing_diary(self, uid: str, school_uid: str) -> None:
        existing = self.vault.get(uid)
        if not existing or existing.get("provider") == "demo":
            return
        if existing.get("provider") == "manual":
            snap = existing.get("snapshot") or {}
            if any(snap.get(k) for k in ("tasks", "lessons", "grades")):
                raise SgoConnectError("DIARY_ALREADY_CONNECTED")
            return
        binding = self.directory.binding(uid)
        if (binding and binding.get("school_uid") != school_uid
                and existing.get("status") in {"connected", "temporarily_unavailable"}):
            raise SgoConnectError("DIARY_ALREADY_CONNECTED")

    def _bind_legacy(self, uid: str, school: dict[str, Any], host: dict[str, Any], native: dict[str, Any],
                     snapshot: dict[str, Any]) -> None:
        """Ученик: та же зашифрованная связь, что у прежнего входа — план дня, ДЗ и уведомления работают."""
        with self.repo.tx() as db:
            principal = db.execute("SELECT principal FROM identities WHERE uid=? AND principal LIKE 'tg:%'",
                                   (uid,)).fetchone()
        telegram = int(principal[0][3:]) if principal and principal[0][3:].isdigit() else None
        existing = self.vault.get(uid)
        binding = self.directory.binding(uid)
        if existing and (existing.get("provider") in {"demo", "manual"}
                         or (binding and binding.get("school_uid") != school["school_uid"])):
            # Пустая демо/ручная связь или погасшая связь с другой школой — освобождаем место новой.
            self.vault.disconnect(uid)
        self.directory.select(uid, school["school_uid"], telegram)
        legacy = {k: v for k, v in native.items() if k != "_snapshot"}
        legacy.update(school_uid=school["school_uid"], auth_method="sgo_credentials")
        self.vault.bind(uid, "netschool", portal=host["base_url"], session=legacy, expires=time.time() + 86400,
                        snapshot=snapshot, expected_school=school["school_uid"])

    def _sync_legacy(self, uid: str, school: dict[str, Any], host: dict[str, Any], native: dict[str, Any],
                     snapshot: dict[str, Any], legacy: dict[str, Any] | None) -> None:
        """V2.3 BUG-001: one diary snapshot for every screen. A live row is refreshed in place (fenced);
        a row whose 24 h grant lapsed while the SGO session stayed valid is bound again. A disconnected
        diary (no row) stays disconnected."""
        if not legacy or legacy.get("provider") != "netschool":
            return
        if legacy.get("session"):
            self.vault.refresh_snapshot(uid, snapshot, connection_id=legacy["session"]["connection_id"],
                                        revision=legacy["_sync_revision"], expires=time.time() + 86400)
        elif legacy.get("status") == "reauth_required":
            self._bind_legacy(uid, school, host, native, snapshot)

    # -------------------------------------------------- overview (SWR)
    async def overview(self, uid: str, *, refresh: bool = False) -> dict[str, Any]:
        session = profiles.load_session(self.repo, self.vault, uid)
        if session is None:
            return {"state": "sgo_unlinked", "reason": "not_connected"}
        if session.status in {"reauth_required", "revoked"} or not session.at_token:
            cached = profiles.cache_get(self.repo, self.vault, uid, session.role, "overview")
            return {"state": "reauth", "role": session.role, "cached": cached}
        cached = profiles.cache_get(self.repo, self.vault, uid, session.role, "overview")
        if cached and cached.fresh and not refresh:
            return {"state": "fresh", "role": session.role, "cached": cached}
        asked_at = time.monotonic()
        async with user_lock(uid):
            # Пока ждали замок, соседний запрос мог уже сходить в СГО — берём его результат (coalescing).
            # Сравнение по монотонному маркеру, а не по fetched_at с точностью до секунды.
            again = profiles.cache_get(self.repo, self.vault, uid, session.role, "overview")
            if again and again.fresh and refreshed_since(uid, asked_at):
                return {"state": "fresh", "role": session.role, "cached": again}
            session = profiles.load_session(self.repo, self.vault, uid) or session
            try:
                payload = await asyncio.wait_for(self._fetch(session), UPSTREAM_TIMEOUT)
            except _SessionDead:
                profiles.mark_session(self.repo, uid, "reauth_required")
                return {"state": "reauth", "role": session.role, "cached": again or cached}
            except (ProviderUnavailable, httpx.HTTPError, TimeoutError, OSError, SgoUnsupported, SgoAuthRejected,
                    UnsupportedPortal, ValueError, KeyError, TypeError) as exc:
                logger.warning("sgo_overview upstream_error kind=%s", type(exc).__name__)
                return {"state": "upstream_error", "role": session.role, "cached": again or cached}
            entry = profiles.cache_put(self.repo, self.vault, uid, session.role, "overview", payload,
                                       CACHE_FRESH_SECONDS)
            mark_refreshed(uid)
            return {"state": "fresh", "role": session.role, "cached": entry}

    async def _fetch(self, session: profiles.SgoSession) -> dict[str, Any]:
        host = self.directory.host(session.sgo_base_url)
        school = self.directory.school(f"{host['host_id']}:{session.scid}")
        native = session.as_native(host["host_id"])
        http = SgoHTTP(host, native.get("cookies"), self.client)
        nsc = NetSchoolClient(host, client=self.client)
        ctx = Ctx(nsc, http, native, {}, school, host)
        strategy = strategy_for(session.role)
        legacy = self.vault.get(session.user_id) if session.role == "student" else None
        if session.expires_at <= profiles.now():
            await self._refresh(ctx, session)
        try:
            data = await strategy.fetch(ctx)
        except ReauthRequired:
            # 401/403 посреди чтения: один повтор после освежения (под тем же замком пользователя).
            await self._refresh(ctx, session)
            try:
                data = await strategy.fetch(ctx)
            except ReauthRequired as exc:
                raise _SessionDead() from exc
        snapshot = native.pop("_snapshot", None)
        if session.role == "student" and snapshot is not None:
            self._sync_legacy(session.user_id, school, host, native, snapshot, legacy)
        extra = {k: v for k, v in native.items() if k in {"year_id", "student_name", "class_name", "provider_school_id",
                                                        "assignment_types", "last_keep_alive", "school_uid", "user_name",
                                                        "teacher_roles", "session_cache_nonce"}}
        profiles.refresh_session(self.repo, self.vault, session, cookies=http.export_cookies(), extra=extra,
                                 ttl=SESSION_TTL)
        return {"role": session.role, "school": {"scid": session.scid, "name": school["short_name"] or school["name"]},
                **data}

    async def diary_days(self, uid: str, start: date, end: date) -> dict[str, Any]:
        """v3.2 · архив дневника ученика за период (прошлые дни, ДЗ под каждым уроком, отметки).
        Короткий кэш в памяти процесса: листание туда-обратно не дёргает СГО. Ошибка — честное состояние."""
        # Сессию проверяем ДО кэша: после отключения дневника или выхода архив не должен отдаваться из памяти
        # (находка персонного прогона v3.2). Ключ кэша включает школу и портал — другой вход = другой кэш.
        session = profiles.load_session(self.repo, self.vault, uid)
        if session is None or session.role != "student":
            return {"state": "sgo_unlinked", "days": []}
        if session.status in {"reauth_required", "revoked"} or not session.at_token:
            return {"state": "reauth", "days": []}
        # Смена аккаунта в той же школе не должна получать архив предыдущей сессии.
        # Для старых записей без nonce используем только отпечаток токена, не сам токен.
        nonce = session.extra.get("session_cache_nonce")
        if not isinstance(nonce, str) or not nonce:
            nonce = hashlib.sha256(session.at_token.encode("utf-8")).hexdigest()
        key = (uid, f"{session.sgo_base_url}|{session.scid}|{nonce}|{start.isoformat()}", end.isoformat())
        hit = _DAYS_CACHE.get(key)
        if hit and hit[0] > time.monotonic():
            return hit[1]
        async with user_lock(uid):
            host = self.directory.host(session.sgo_base_url)
            school = self.directory.school(f"{host['host_id']}:{session.scid}")
            native = session.as_native(host["host_id"])
            http = SgoHTTP(host, native.get("cookies"), self.client)
            nsc = NetSchoolClient(host, client=self.client)
            ctx = Ctx(nsc, http, native, {}, school, host)
            try:
                if session.expires_at <= profiles.now():
                    await self._refresh(ctx, session)
                days = await asyncio.wait_for(nsc.fetch_days(native, http=http, start=start, end=end), UPSTREAM_TIMEOUT)
            except (_SessionDead, ReauthRequired):
                profiles.mark_session(self.repo, uid, "reauth_required")
                return {"state": "reauth", "days": []}
            except (ProviderUnavailable, httpx.HTTPError, TimeoutError, OSError, SgoUnsupported, SgoAuthRejected,
                    UnsupportedPortal, ValueError, KeyError, TypeError) as exc:
                logger.warning("sgo_diary_days upstream_error kind=%s", type(exc).__name__)
                return {"state": "upstream_error", "days": []}
            extra = {k: v for k, v in native.items() if k in {"year_id", "student_name", "class_name", "provider_school_id",
                                                            "assignment_types", "last_keep_alive", "school_uid", "user_name",
                                                            "teacher_roles", "session_cache_nonce"}}
            profiles.refresh_session(self.repo, self.vault, session, cookies=http.export_cookies(), extra=extra,
                                     ttl=SESSION_TTL)
        out = {"state": "fresh", "days": days}
        if len(_DAYS_CACHE) >= 512:
            _DAYS_CACHE.pop(next(iter(_DAYS_CACHE)))
        _DAYS_CACHE[key] = (time.monotonic() + 600, out)
        return out

    async def grades_period(self, uid: str, start: date, end: date) -> dict[str, Any]:
        """Bounded read of journal marks for one account; no result is invented or cached."""
        async with user_lock(uid):
            session = profiles.load_session(self.repo, self.vault, uid)
            if session is None or session.role != "student":
                return {"state": "sgo_unlinked", "grades": []}
            if session.status in {"reauth_required", "revoked"} or not session.at_token:
                return {"state": "reauth", "grades": []}
            host = self.directory.host(session.sgo_base_url)
            school = self.directory.school(f"{host['host_id']}:{session.scid}")
            native = session.as_native(host["host_id"])
            http = SgoHTTP(host, native.get("cookies"), self.client)
            nsc = NetSchoolClient(host, client=self.client)
            ctx = Ctx(nsc, http, native, {}, school, host)
            try:
                if session.expires_at <= profiles.now():
                    await self._refresh(ctx, session)
                grades = await asyncio.wait_for(nsc.get_grades(native, start, end, http=http), 45.0)
            except (_SessionDead, ReauthRequired):
                return {"state": "reauth", "grades": []}
            except (ProviderUnavailable, httpx.HTTPError, TimeoutError, OSError, SgoUnsupported, SgoAuthRejected,
                    UnsupportedPortal, ValueError, KeyError, TypeError) as exc:
                logger.warning("sgo_grades_period upstream_error kind=%s", type(exc).__name__)
                return {"state": "upstream_error", "grades": []}
            # A disconnect or switch while the remote request was in flight must not
            # leak old results to the new session or revive its cookies.
            current = profiles.load_session(self.repo, self.vault, uid)
            if not current or current.status in {"reauth_required", "revoked"} or current.at_token != session.at_token:
                return {"state": "reauth", "grades": []}
            return {"state": "fresh", "grades": [g.model_dump() for g in grades]}

    async def teacher_call(self, uid: str, op: Any) -> Any:
        """v3.2 · sgo_teacher_client: вызов учительского API СГО от имени учителя той же сессией, что и обзор
        (шифрованное хранилище; истекла — keep-alive без пароля; 401/403 — нужен повторный вход)."""
        from app.sgo_teacher_client import NetSchoolTeacherClient
        session = profiles.load_session(self.repo, self.vault, uid)
        if session is None or session.role != "teacher":
            raise SgoTeacherUnavailable("sgo_not_linked", "Войдите в СГО как учитель, чтобы работать с журналом")
        async with user_lock(uid):
            host = self.directory.host(session.sgo_base_url)
            school = self.directory.school(f"{host['host_id']}:{session.scid}")
            native = session.as_native(host["host_id"])
            http = SgoHTTP(host, native.get("cookies"), self.client)
            ctx = Ctx(NetSchoolClient(host, client=self.client), http, native, {}, school, host)
            api = (host.get("metadata") or {}).get("teacher_api") or {}
            try:
                if session.expires_at <= profiles.now():
                    await self._refresh(ctx, session)
                return await op(NetSchoolTeacherClient(http.request, native["access_token"], api))
            except (_SessionDead, ReauthRequired):
                profiles.mark_session(self.repo, uid, "reauth_required")
                raise SgoTeacherUnavailable("reauth_required", "Сессия СГО закончилась — войдите заново") from None
            except (ProviderUnavailable, httpx.HTTPError, TimeoutError, OSError, SgoUnsupported, SgoAuthRejected) as exc:
                logger.warning("teacher_sgo upstream_error kind=%s", type(exc).__name__)
                raise SgoTeacherUnavailable("upstream_error", "СГО сейчас не ответил — попробуйте позже") from None

    async def _refresh(self, ctx: Ctx, session: profiles.SgoSession) -> None:
        """Продление без пароля: keep-alive тем же токеном. Отказ — сессия мертва, нужен новый вход."""
        headers = {"at": ctx.native["access_token"]}
        try:
            context = await ctx.http.request("GET", "/Context", headers=headers, optional=True)
            if context is None and session.role == "student":
                await ctx.http.request("GET", "/student/diary/init", headers=headers)
        except ReauthRequired as exc:
            raise _SessionDead() from exc
        ctx.native["last_keep_alive"] = time.time()


_DAYS_CACHE: dict[tuple[str, str, str], tuple[float, dict[str, Any]]] = {}


def adapter(repo: Any, vault: _Vault) -> SGOMultiRegionAdapter:
    factory = CLIENT_FACTORY
    return SGOMultiRegionAdapter(repo, vault, client=factory() if callable(factory) else None)
