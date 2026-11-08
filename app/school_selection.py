"""v2.3.2 (D2/D6/D8) · Выбор школы на сервере и доступные способы входа.

* Школа идентифицируется только school_uid из доверенного каталога (host_id:scid). Адрес сервера,
  код школы и регион из запроса не принимаются: хост берётся из каталога, а не от клиента.
* Выбор хранится в существующей таблице student_school_binding (тот же механизм, что у
  /api/platform/schools/select), привязан к проверенной сессии MAX/Telegram/cookie, а не к X-User-Id.
* Удалённая/выключенная/недоверенная школа → status=school_removed; данные дневника не удаляются.
* Старые профили (только scid + sgo_base_url) чинятся при чтении, если школа однозначно находится
  в доверенном каталоге.
"""
from __future__ import annotations

from typing import Any

from app import esia_provider
from app.api_errors import CodedError
from app.diary_providers import UnsupportedPortal
from app.school_fuzzy import region_code as code_of_region
from app.sgo_directory import Directory, is_trusted, utc

SCHOOL_UID_PATTERN = r"^[A-Za-z0-9_.-]{1,100}:\d{1,10}$"
OAUTH_METHODS = ("gosuslugi_esia", "moya_shkola")

TEXT = {
    "SCHOOL_SELECTION_REQUIRED": "Сначала выберите школу из списка — без этого дневник не подключить.",
    "SCHOOL_NOT_FOUND": "Этой школы нет в каталоге. Найдите её в списке ещё раз.",
    "HOST_NOT_TRUSTED": "Сервер этой школы не входит в проверенный каталог. Выберите школу из списка.",
    "SCHOOL_REMOVED": "Выбранная школа больше недоступна в каталоге. Выберите школу заново.",
    "DIARY_ALREADY_CONNECTED": "Сначала отключите текущий дневник в настройках, затем выберите другую школу.",
}


def resolve(repo: Any, school_uid: str | None) -> tuple[dict[str, Any], dict[str, Any]]:
    """school_uid → (школа, доверенный узел) или CodedError. Ни одного сетевого запроса."""
    if not school_uid:
        raise CodedError(422, "SCHOOL_SELECTION_REQUIRED", TEXT["SCHOOL_SELECTION_REQUIRED"], domain="sgo")
    directory = Directory(repo)
    try:
        school = directory.school(school_uid)
        host = directory.host(school["host_id"])
    except UnsupportedPortal:
        raise CodedError(422, "SCHOOL_NOT_FOUND", TEXT["SCHOOL_NOT_FOUND"], domain="sgo") from None
    if not is_trusted(host):
        raise CodedError(422, "HOST_NOT_TRUSTED", TEXT["HOST_NOT_TRUSTED"], domain="sgo")
    return school, host


def auth_info(school: dict[str, Any], host: dict[str, Any]) -> dict[str, Any]:
    """Только подтверждённые способы входа. Выключенный способ не попадает в available_auth_methods."""
    methods = list(school.get("supported_auth_methods") or [])
    esia = esia_provider.config()
    available = ["sgo_credentials"] if "sgo_credentials" in methods else []
    oauth = [m for m in OAUTH_METHODS if m in methods]
    if esia.enabled:
        available += oauth
    if available:
        return {"available_auth_methods": available, "primary_auth_method": available[0],
                "auth_status": "available", "reason": None, "esia_state": esia.state}
    esia_only = (host.get("metadata") or {}).get("auth_policy") == "esia_only" or bool(oauth)
    if not esia_only:
        reason = "no_supported_method"
    elif esia.state == "misconfigured":
        reason = "esia_misconfigured"
    elif esia.state == "disabled":
        reason = "esia_disabled"
    else:
        reason = "esia_not_configured"
    return {"available_auth_methods": [], "primary_auth_method": None, "auth_status": "unavailable",
            "reason": reason, "esia_state": esia.state}


def public_school(school: dict[str, Any]) -> dict[str, Any]:
    return {"school_uid": str(school["school_uid"]), "name": str(school["name"]),
            "short_name": str(school.get("short_name") or school["name"]), "city": school.get("city") or None,
            "region": school.get("region") or None, "region_code": code_of_region(school.get("region"))}


def _view(school: dict[str, Any], host: dict[str, Any]) -> dict[str, Any]:
    return {"status": "selected", "school": public_school(school), "auth": auth_info(school, host)}


def _binding(db: Any, uid: str) -> str | None:
    row = db.execute("SELECT school_uid FROM student_school_binding WHERE student_uid=?", (uid,)).fetchone()
    return str(row[0]) if row else None


def _store_binding(db: Any, uid: str, school: dict[str, Any], telegram_id: int | None) -> None:
    db.execute("DELETE FROM sgo_auth_flows WHERE student_uid=?", (uid,))
    db.execute(
        "INSERT INTO student_school_binding(student_uid,tg_user_id,school_uid,resolved_base_url,bound_at)"
        " VALUES(?,?,?,?,?) ON CONFLICT(student_uid) DO UPDATE SET school_uid=excluded.school_uid,"
        "resolved_base_url=excluded.resolved_base_url,tg_user_id=COALESCE(excluded.tg_user_id,tg_user_id),"
        "sgo_student_id=NULL,student_display_name=NULL,class_name=NULL,last_login_at=NULL",
        (uid, telegram_id, school["school_uid"], school["base_url"], utc()))
    # v2.4 · выбор школы из каталога заменяет автономный выбор (они взаимоисключающие)
    from app import autonomous_school
    autonomous_school.clear(db, uid)


def _live_diary_elsewhere(repo: Any, vault: Any, uid: str, school: dict[str, Any], current: str | None) -> bool:
    """Живая связь дневника или сессия мастера с ДРУГОЙ школой — смена школы только после отключения."""
    if current == school["school_uid"]:
        return False
    existing = vault.get(uid) if vault is not None else None
    if existing and existing.get("provider") == "netschool" and existing.get("status") in {"connected", "temporarily_unavailable"}:
        return True
    if existing and existing.get("provider") == "manual":
        snap = existing.get("snapshot") or {}
        if any(snap.get(k) for k in ("tasks", "lessons", "grades")):
            return True
    with repo.tx() as db:
        row = db.execute("SELECT scid, sgo_base_url, status FROM sgo_sessions WHERE user_id=?", (uid,)).fetchone()
    if row and row[2] == "active":
        return (str(row[0]), str(row[1])) != (str(school["scid"]), str(school["base_url"]))
    return False


def select(repo: Any, vault: Any, uid: str, school_uid: str, telegram_id: int | None = None) -> dict[str, Any]:
    school, host = resolve(repo, school_uid)
    with repo.tx() as db:
        current = _binding(db, uid)
    if _live_diary_elsewhere(repo, vault, uid, school, current):
        raise CodedError(409, "DIARY_ALREADY_CONNECTED", TEXT["DIARY_ALREADY_CONNECTED"], domain="sgo")
    if current != school["school_uid"]:
        with repo.tx() as db:
            _store_binding(db, uid, school, telegram_id)
            db.execute("UPDATE accounts SET used=1 WHERE uid=?", (uid,))
    return _view(school, host)


def remember(repo: Any, uid: str, school: dict[str, Any], telegram_id: int | None = None) -> None:
    """После успешного входа (в т.ч. учителя): выбор = школа, с которой реально подключились."""
    with repo.tx() as db:
        if _binding(db, uid) != school["school_uid"]:
            _store_binding(db, uid, school, telegram_id)


def _repair(repo: Any, uid: str) -> tuple[str, dict[str, Any] | None]:
    """Профиль до v2.3.2 хранил только scid + sgo_base_url. Однозначная доверенная школа → выбор."""
    from app import sgo_profiles as profiles
    profile = profiles.get_profile(repo, uid)
    scid, base = profile.get("scid"), profile.get("sgo_base_url")
    if not scid or not base:
        return "none", None
    with repo.tx() as db:
        rows = db.execute("SELECT s.school_uid FROM schools_directory s JOIN sgo_hosts_registry h ON s.host_id=h.host_id"
                          " WHERE h.is_active=1 AND h.base_url=? AND s.scid=?", (base, int(scid) if str(scid).isdigit() else -1)).fetchall()
    if len(rows) != 1:
        return "school_removed", None
    try:
        school, host = resolve(repo, rows[0][0])
    except CodedError:
        return "school_removed", None
    remember(repo, uid, school)
    return "selected", _view(school, host)


def selection(repo: Any, uid: str) -> dict[str, Any]:
    with repo.tx() as db:
        current = _binding(db, uid)
    if current is None:
        from app import autonomous_school
        chosen = autonomous_school.get(repo, uid)
        if chosen is not None:
            return autonomous_school.view(repo, chosen)
        status, view = _repair(repo, uid)
        return view or {"status": status, "school": None, "auth": None}
    try:
        school, host = resolve(repo, current)
    except CodedError:
        return {"status": "school_removed", "school": None, "auth": None}
    return _view(school, host)
