"""v2.2 · Настоящее имя ученика/учителя из подключённого школьного дневника (СГО).

Раньше whoami знал имя только из песочницы, справочника школы, списка класса и MAX — и человек, вошедший в
СГО, видел «Ученик» и «?» вместо своего ФИО, хотя СГО его сообщает (students[].nickName, accountInfo.user.name).
Источник — только сервер: зашифрованная сессия мастера (sgo_sessions, поля student_name/class_name/user_name)
или прежняя связь дневника (student_school_binding.student_display_name). Клиентский ввод сюда не попадает.
"""
from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger("sferumfocus.identity")


def _clean(value: Any, limit: int = 80) -> str | None:
    if not isinstance(value, str):
        return None
    text = " ".join("".join(ch for ch in value if ch.isprintable()).split())[:limit].strip()
    return text or None


def sgo_identity(repo: Any, vault: Any, uid: str) -> dict[str, Any] | None:
    """{full_name, class_name, school, role} или None. Никогда не бросает: профиль не должен ронять whoami."""
    if not uid:
        return None
    name = cls = school = role = None
    try:
        from app import sgo_profiles
        session = sgo_profiles.load_session(repo, vault, uid) if vault is not None else None
        if session is not None and session.status != "revoked":
            role = session.role
            extra = session.extra or {}
            name = extra.get("student_name") if session.role == "student" else extra.get("user_name")
            cls = extra.get("class_name") if session.role == "student" else None
            school = sgo_profiles.get_profile(repo, uid).get("school_name")
    except Exception as exc:  # noqa: BLE001 — повреждённая запись/ключ: имени нет, вход продолжается
        logger.info("sgo_identity session_unavailable kind=%s", type(exc).__name__)
    if not _clean(name):
        try:
            from app.sgo_directory import Directory
            binding = Directory(repo).binding(uid)
        except Exception:  # noqa: BLE001 — школа исчезла из справочника и т. п.
            binding = None
        if binding and _clean(binding.get("student_display_name")):
            name = binding["student_display_name"]
            cls = cls or binding.get("class_name")
            school = school or binding.get("short_name") or binding.get("name")
            role = role or "student"
    full = _clean(name)
    if not full:
        return None
    return {"full_name": full, "class_name": _clean(cls, 30), "school": _clean(school, 200), "role": role}


def for_request(request: Any) -> dict[str, Any] | None:
    account = getattr(getattr(request, "state", None), "platform_account", None)
    if not isinstance(account, dict):
        return None
    try:
        from app.diary_vault import EncryptedDiaryVault
        from app.platform_auth import store
        repo = store()
        try:
            vault = EncryptedDiaryVault(repo)
        except ValueError:
            vault = None                   # шифрование не настроено — остаётся только прежняя связь дневника
        return sgo_identity(repo, vault, str(account.get("uid") or ""))
    except Exception as exc:  # noqa: BLE001
        logger.info("sgo_identity store_unavailable kind=%s", type(exc).__name__)
        return None
