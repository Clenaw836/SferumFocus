"""v2.4 · Автономный режим школы: регион + номер/название школы без подключения дневника.

Когда школа не нашлась (её узла нет в каталоге, портал недоступен из сети сервера, гео-блок,
таймаут), ученик не упирается в тупик: он выбирает «Школу в автономном режиме для региона …»,
и продукт работает дальше — задания учителя, ручные задачи, класс по ссылке, фокус-сессии,
локальный тьютор. Дневник подключается позже, когда для региона появится поддерживаемый способ.

Решения (безопасные допущения, см. docs/v24/AUTONOMOUS_MODE_V24.md):
* Выбор хранится ПРИВАТНО в ``autonomous_school_choice`` (одна строка на аккаунт). Введённое
  пользователем название НЕ попадает в общий проверенный каталог ``public_institutions`` и
  в ``schools_directory`` — иначе любой мог бы «добавить» школу, видимую другим.
* Адреса серверов, scid и прочие параметры портала здесь не принимаются (правило D6).
* Внешний ИИ в автономном режиме не используется: разбор — локальные правила (решение К1).
* Автономный выбор и выбор школы из каталога взаимоисключающие: новый выбор заменяет старый.
"""
from __future__ import annotations

import re
import unicodedata
from typing import Any

from app.api_errors import CodedError
from app.school_fuzzy import REGION_CODES
from app.school_regions import canonical_region
from app.sgo_directory import utc

SCHEMA = (
    "CREATE TABLE IF NOT EXISTS autonomous_school_choice("
    "uid TEXT PRIMARY KEY, region_code TEXT NOT NULL, region TEXT NOT NULL,"
    " school_label TEXT, school_number TEXT, created_at TEXT NOT NULL)"
)

# Что работает без дневника — показывается на карточке честно, без «скоро».
FEATURES = ("teacher_assignments", "class_join", "manual_tasks", "focus_sessions", "local_tutor")

TEXT = {
    "REGION_UNKNOWN": "Такого региона нет в списке. Выберите регион из списка.",
    "SCHOOL_LABEL_INVALID": "Название школы — обычный текст, без адресов сайтов. Например: «Лицей № 9».",
    "SCHOOL_NUMBER_INVALID": "Номер школы — только цифры, например 121.",
    "DIARY_ALREADY_CONNECTED": "Сначала отключите текущий дневник в настройках, затем выберите другую школу.",
}

_URLISH = re.compile(r"(?:https?:|://|www\.|\.ru\b|\.рф\b|\.com\b|\.org\b)", re.I)
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


def ensure(db: Any) -> None:
    db.execute(SCHEMA)


def title_for(region: str) -> str:
    return f"Выбрать школу в автономном режиме для региона {region}"


def offer(region: str, query: str | None = None, institutions: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """Карточка-предложение для пустого поиска (поиск отвечает 200, а не 503)."""
    name = canonical_region(region)
    code = next((c for c, n in REGION_CODES.items() if canonical_region(n) == name), None)
    label = _prefill(query)
    return {
        "region_code": code,
        "region": name,
        "title": title_for(name),
        "hint": "Школы нет в подключённом каталоге или портал региона сейчас недоступен. "
                "Задания учителя, ручные задачи и фокус работают без дневника — его можно подключить позже.",
        "school_label": label,
        "institution_matches": institutions or [],
    }


def _prefill(query: str | None) -> str | None:
    """Подстановка текста поиска в карточку. Никогда не роняет поиск: адрес сайта, e-mail или телефон
    просто не подставляются (а не дают 422 на поиске)."""
    if not query:
        return None
    try:
        label = clean_label(query)
    except CodedError:
        return None
    from app.live_discovery import safe_query
    return label if label and safe_query(label) else None


def clean_label(value: str | None) -> str | None:
    if value is None:
        return None
    # NFC, не NFKC: NFKC превращает «№» в «No» («Лицей No 42»), а «№» — часть названий школ.
    text = unicodedata.normalize("NFC", str(value))
    text = _CONTROL.sub(" ", text)
    text = " ".join(text.split())[:120]
    if not text:
        return None
    if _URLISH.search(text):
        raise CodedError(422, "SCHOOL_LABEL_INVALID", TEXT["SCHOOL_LABEL_INVALID"])
    return text


def clean_number(value: str | None) -> str | None:
    if value is None or not str(value).strip():
        return None
    text = str(value).strip().lstrip("№").strip()
    if not re.fullmatch(r"\d{1,6}", text):
        raise CodedError(422, "SCHOOL_NUMBER_INVALID", TEXT["SCHOOL_NUMBER_INVALID"])
    return str(int(text))


def _region(value: str) -> tuple[str, str]:
    from app.school_fuzzy import strict_region, region_code
    try:
        name = strict_region(value)
    except ValueError:
        raise CodedError(422, "REGION_UNKNOWN", TEXT["REGION_UNKNOWN"]) from None
    return str(region_code(name)), name


def _diary_connected(vault: Any, uid: str) -> bool:
    existing = vault.get(uid) if vault is not None else None
    return bool(existing and existing.get("provider") == "netschool"
                and existing.get("status") in {"connected", "temporarily_unavailable"})


def choose(repo: Any, vault: Any, uid: str, region: str, school_label: str | None = None,
           school_number: str | None = None) -> dict[str, Any]:
    code, name = _region(region)
    label, number = clean_label(school_label), clean_number(school_number)
    if _diary_connected(vault, uid):
        raise CodedError(409, "DIARY_ALREADY_CONNECTED", TEXT["DIARY_ALREADY_CONNECTED"], domain="sgo")
    with repo.tx() as db:
        ensure(db)
        # Новый выбор заменяет выбор школы из каталога (они взаимоисключающие).
        db.execute("DELETE FROM sgo_auth_flows WHERE student_uid=?", (uid,))
        db.execute("DELETE FROM student_school_binding WHERE student_uid=?", (uid,))
        db.execute(
            "INSERT INTO autonomous_school_choice(uid,region_code,region,school_label,school_number,created_at)"
            " VALUES(?,?,?,?,?,?) ON CONFLICT(uid) DO UPDATE SET region_code=excluded.region_code,"
            " region=excluded.region, school_label=excluded.school_label, school_number=excluded.school_number,"
            " created_at=excluded.created_at",
            (uid, code, name, label, number, utc()))
        db.execute("UPDATE accounts SET used=1 WHERE uid=?", (uid,))
    return view(repo, get(repo, uid))


def get(repo: Any, uid: str) -> dict[str, Any] | None:
    with repo.tx() as db:
        ensure(db)
        row = db.execute("SELECT region_code,region,school_label,school_number FROM autonomous_school_choice WHERE uid=?",
                         (uid,)).fetchone()
    return dict(row) if row else None


def clear(db: Any, uid: str) -> None:
    ensure(db)
    db.execute("DELETE FROM autonomous_school_choice WHERE uid=?", (uid,))


def view(repo: Any, row: dict[str, Any] | None) -> dict[str, Any]:
    if row is None:
        return {"status": "none", "school": None, "auth": None}
    label = row.get("school_label")
    number = row.get("school_number")
    display = label or (f"Школа № {number}" if number else "Школа не указана")
    return {
        "status": "autonomous", "school": None, "auth": None,
        "autonomous": {
            "region_code": row["region_code"], "region": row["region"],
            "school_label": label, "school_number": number, "display_name": display,
            "title": title_for(row["region"]),
            # Режим ЭТОГО аккаунта — автономный; режим региона по каталогу — отдельно
            # (если в регионе есть каталог СГО, интерфейс предложит поискать школу ещё раз).
            "connection_mode": "autonomous_bridge",
            "region_connection_mode": _region_mode(repo, row["region_code"]),
            "diary_connected": False,
            "features": list(FEATURES),
        },
    }

def _region_mode(repo: Any, code: str) -> str:
    from app.region_coverage import all_regions
    hits = all_regions(repo, code)
    return hits[0]["connection_mode"] if hits else "autonomous_bridge"
