"""v2.1: мгновенный поиск школы для мастера подключения (/api/v1/schools/search).

Кандидаты — из того же справочника, что и /api/platform/schools/search (FTS-триграммы по транслиту),
плюс ограниченный нечёткий проход для опечаток. Ранжирование — RapidFuzz (WRatio) по строкам
в латинице: «сош 5», «school 5», «шкала 5» и «СОШ №5» сравниваются одинаково. Номер школы
не «угадывается»: если в запросе есть число, у кандидата должно быть ровно это число.
"""
from __future__ import annotations

import re
import sqlite3
from typing import Any, Protocol

from app.school_regions import canonical_region
from app.school_text import latin

try:  # RapidFuzz — C-ускоренный; без него деградируем до difflib (те же правила, медленнее)
    from rapidfuzz import fuzz as _fuzz

    ENGINE = "rapidfuzz"

    def _ratio(a: str, b: str) -> float:
        return float(_fuzz.WRatio(a, b))
except ImportError:  # pragma: no cover - rapidfuzz в requirements.txt
    from difflib import SequenceMatcher

    ENGINE = "difflib"

    def _ratio(a: str, b: str) -> float:
        return SequenceMatcher(None, a, b).ratio() * 100

# Код субъекта РФ (как в коде региона на номерах/в ОКАТО-справочниках школ) → каноническое имя.
REGION_CODES: dict[str, str] = {
    "01": "Республика Адыгея", "02": "Республика Башкортостан", "03": "Республика Бурятия",
    "04": "Республика Алтай", "05": "Республика Дагестан", "06": "Республика Ингушетия",
    "07": "Кабардино-Балкарская Республика", "08": "Республика Калмыкия", "09": "Карачаево-Черкесская Республика",
    "10": "Республика Карелия", "11": "Республика Коми", "12": "Республика Марий Эл", "13": "Республика Мордовия",
    "14": "Республика Саха (Якутия)", "15": "Республика Северная Осетия — Алания", "16": "Республика Татарстан",
    "17": "Республика Тыва", "18": "Удмуртская Республика", "19": "Республика Хакасия", "20": "Чеченская Республика",
    "21": "Чувашская Республика", "22": "Алтайский край", "23": "Краснодарский край", "24": "Красноярский край",
    "25": "Приморский край", "26": "Ставропольский край", "27": "Хабаровский край", "28": "Амурская область",
    "29": "Архангельская область", "30": "Астраханская область", "31": "Белгородская область",
    "32": "Брянская область", "33": "Владимирская область", "34": "Волгоградская область",
    "35": "Вологодская область", "36": "Воронежская область", "37": "Ивановская область",
    "38": "Иркутская область", "39": "Калининградская область", "40": "Калужская область",
    "41": "Камчатский край", "42": "Кемеровская область — Кузбасс", "43": "Кировская область",
    "44": "Костромская область", "45": "Курганская область", "46": "Курская область",
    "47": "Ленинградская область", "48": "Липецкая область", "49": "Магаданская область",
    "50": "Московская область", "51": "Мурманская область", "52": "Нижегородская область",
    "53": "Новгородская область", "54": "Новосибирская область", "55": "Омская область",
    "56": "Оренбургская область", "57": "Орловская область", "58": "Пензенская область", "59": "Пермский край",
    "60": "Псковская область", "61": "Ростовская область", "62": "Рязанская область", "63": "Самарская область",
    "64": "Саратовская область", "65": "Сахалинская область", "66": "Свердловская область",
    "67": "Смоленская область", "68": "Тамбовская область", "69": "Тверская область", "70": "Томская область",
    "71": "Тульская область", "72": "Тюменская область", "73": "Ульяновская область",
    "74": "Челябинская область", "75": "Забайкальский край", "76": "Ярославская область", "77": "Москва",
    "78": "Санкт-Петербург", "79": "Еврейская автономная область", "80": "Донецкая Народная Республика",
    "81": "Луганская Народная Республика", "82": "Республика Крым", "83": "Ненецкий автономный округ",
    "84": "Херсонская область", "85": "Запорожская область",
    "86": "Ханты-Мансийский автономный округ — Югра", "87": "Чукотский автономный округ",
    "89": "Ямало-Ненецкий автономный округ", "92": "Севастополь",
}
_CODE_BY_NAME: dict[str, str] = {canonical_region(name): code for code, name in REGION_CODES.items()}


def region_code(name: str | None) -> str | None:
    return _CODE_BY_NAME.get(canonical_region(name)) if name else None


_KNOWN_NAMES: frozenset[str] = frozenset(canonical_region(name) for name in REGION_CODES.values())


def strict_region(value: str | None) -> str:
    """v2.3.2 (D1) · Регион обязателен: «73» или каноническое имя. ValueError(REGION_REQUIRED|REGION_UNKNOWN)."""
    if value is None or not value.strip():
        raise ValueError("REGION_REQUIRED")
    try:
        name = region_name(value)
    except ValueError:
        raise ValueError("REGION_UNKNOWN") from None
    if name not in _KNOWN_NAMES:
        name = _expanded(value)
    if not name or name not in _KNOWN_NAMES:
        raise ValueError("REGION_UNKNOWN")
    return name


_ABBREVIATIONS = ((re.compile(r"\bобл\b"), "область"), (re.compile(r"\bресп\b"), "республика"),
                  (re.compile(r"\bао\b"), "автономный округ"))


def _expanded(value: str) -> str | None:
    """«псковская обл.», «респ. Коми» → каноническое имя; только сокращения, никаких догадок."""
    from app.school_regions import region_key
    key = region_key(value)
    for pattern, full in _ABBREVIATIONS:
        key = pattern.sub(full, key)
    name = canonical_region(key)
    return name if name in _KNOWN_NAMES else None


def region_name(value: str | None) -> str | None:
    """«73», «Ульяновская область», «ульяновская обл» → каноническое имя (None — без фильтра)."""
    if not value or not value.strip():
        return None
    value = value.strip()
    if value.isascii() and value.isdigit():
        code = value.zfill(2)
        if code not in REGION_CODES:
            raise ValueError("unknown region code")
        return canonical_region(REGION_CODES[code])
    return canonical_region(value)


_ORG_FORMS = re.compile(r"\b(?:mbou|maou|mkou|gbou|gaou|mou|bou|mau|nou|chou|ou|g)\b")
_SYNONYMS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"\bsrednyaya shkola\b|\bsredn\w* shkola\b|\boosh\b|\bnosh\b|\bschool\b|\bshkala\b|\bshk\b"), "shkola"),
    (re.compile(r"\bgimnazi\w*|\bgymnasi\w*|\bgimn\b"), "gimnaziya"),
    (re.compile(r"\blitse\w*|\blice\w*|\blycee\w*|\blyceum\w*|\blitsey\w*"), "litsey"),
)


def canon(text: str) -> str:
    """Транслит + синонимы типов школ + без орг.-правовых форм: одна строка сравнения."""
    value = latin(text)  # кириллица → латиница; сош/школа/school → shkola
    for pattern, repl in _SYNONYMS:
        value = pattern.sub(repl, value)
    value = _ORG_FORMS.sub(" ", value)
    return " ".join(value.split())


def _numbers(text: str) -> set[str]:
    return set(re.findall(r"\d+", text))


class _Repo(Protocol):
    def tx(self) -> Any: ...


def _trusted_clause(db: sqlite3.Connection) -> tuple[str, list[Any]]:
    from app.sgo_directory import trusted_host_ids
    ids = trusted_host_ids(db)
    return " AND s.host_id IN (" + (",".join("?" for _ in ids) or "NULL") + ")", list(ids)


def _rows(db: sqlite3.Connection, region: str | None, limit: int) -> list[dict[str, Any]]:
    trusted, args = _trusted_clause(db)
    sql = ("SELECT s.school_uid, s.name, s.short_name, s.city, s.region, s.base_url, s.scid, s.host_id,"
           " s.supported_auth_methods FROM schools_directory s"
           " JOIN sgo_hosts_registry h ON s.host_id=h.host_id WHERE h.is_active=1" + trusted)
    if region:
        sql += " AND s.region=?"
        args.append(region)
    sql += " ORDER BY s.name LIMIT ?"
    args.append(limit)
    return [dict(r) for r in db.execute(sql, args)]


SCAN_LIMIT = 6000


MIN_TEXT_QUERY = 2   # одна буква даёт шум RapidFuzz; одна цифра — это номер школы, его ищем


def query_status(query: str) -> str:
    """empty_query | too_short | ok — до поиска; empty выставляет search_page по результату."""
    text = " ".join((query or "").split())
    if not text:
        return "empty_query"
    if len(text) < MIN_TEXT_QUERY and not text.isdigit():
        return "too_short"
    return "ok"


def search_page(repo: _Repo, query: str, region: str, limit: int = 15, offset: int = 0) -> dict[str, Any]:
    """Страница результатов строго в регионе: {items, has_more, query_status}. Только доверенные узлы."""
    status = query_status(query)
    if status != "ok":
        return {"items": [], "has_more": False, "query_status": status}
    rows = search_schools(repo, query, region, offset + limit + 1)
    page = rows[offset:offset + limit]
    return {"items": page, "has_more": len(rows) > offset + limit,
            "query_status": "ok" if page else "empty"}


def search_schools(repo: _Repo, query: str, region: str | None, limit: int = 15) -> list[dict[str, Any]]:
    from app.school_names import is_masked_school_name
    from app.sgo_directory import Directory

    query = " ".join((query or "").split())[:120]
    q = canon(query)
    wanted = _numbers(query)
    pool: dict[str, dict[str, Any]] = {}
    if q:
        for row in Directory(repo).search(query, region, limit=60):
            pool[row["school_uid"]] = row
    if len(pool) < limit:
        # Опечатки («гимназя», «лицэй») FTS не находит — ограниченный нечёткий проход по региону/всему справочнику.
        with repo.tx() as db:
            for row in _rows(db, region, SCAN_LIMIT):
                pool.setdefault(row["school_uid"], row)
    scored: list[tuple[float, str, dict[str, Any]]] = []
    for row in pool.values():
        if is_masked_school_name(row["name"]):
            continue
        text = " ".join(str(row.get(k) or "") for k in ("short_name", "name", "city"))
        if wanted and not wanted <= _numbers(row["name"] + " " + str(row.get("short_name") or "")):
            continue
        if q:
            candidate = canon(text)
            score = _ratio(q, candidate)
            if any(token in candidate.split() for token in q.split() if len(token) > 2):
                score += 4
            if wanted:
                score += 12
            if score < 62:
                continue
        else:
            score = 50.0
        scored.append((score, str(row["name"]), row))
    scored.sort(key=lambda item: (-item[0], item[1]))
    return [public_item(row) for _, _, row in scored[:limit]]


def _methods(row: dict[str, Any]) -> list[str]:
    raw = row.get("supported_auth_methods")
    if isinstance(raw, list):
        return [str(x) for x in raw]
    try:
        import json
        value = json.loads(raw or "[]")
    except (TypeError, ValueError):
        return []
    return [str(x) for x in value] if isinstance(value, list) else []


def public_item(row: dict[str, Any]) -> dict[str, Any]:
    methods = _methods(row)
    return {
        "scid": str(row["scid"]), "name": str(row["name"]), "short_name": str(row.get("short_name") or row["name"]),
        "region_code": region_code(row.get("region")), "region": row.get("region"), "city": row.get("city") or None,
        "sgo_base_url": str(row["base_url"]), "school_uid": str(row["school_uid"]),
        # v2.3.2 (D6) · без входа по паролю → карточка заранее предупреждает «вход только через Госуслуги».
        "password_login": "sgo_credentials" in methods,
    }


def regions(repo: _Repo) -> list[dict[str, Any]]:
    """Регионы, где справочник уже знает школы (чипы мастера), по убыванию числа школ."""
    with repo.tx() as db:
        trusted, args = _trusted_clause(db)
        rows = db.execute("SELECT s.region, COUNT(*) n FROM schools_directory s JOIN sgo_hosts_registry h"
                          " ON s.host_id=h.host_id WHERE h.is_active=1" + trusted +
                          " GROUP BY s.region ORDER BY n DESC", args).fetchall()
    # v2.3.2 (D1) · Только регионы с кодом субъекта: их можно выбрать, и поиск по ним не даст REGION_UNKNOWN.
    return [{"region_code": code, "name": r[0], "schools": int(r[1])} for r in rows
            if (code := region_code(r[0]))]
