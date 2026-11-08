"""v2.4 · Полный канонический список субъектов РФ (89) для первого шага мастера подключения.

Зачем: до v2.4 ``/api/v1/schools/regions`` возвращал только субъекты, где в локальном справочнике уже
есть доверенные школы (7 из 89). Ученик из остальных 82 субъектов не видел свой регион и упирался
в тупик. Теперь список полный, а у каждого субъекта есть ЧЕСТНЫЙ режим подключения:

* ``sgo_direct``        — в доверенном каталоге есть школы этого субъекта (их можно найти и выбрать);
* ``esia_gateway``      — у регионального портала политика входа только через Госуслуги (``esia_only``);
* ``autonomous_bridge`` — школ в каталоге пока нет: продукт работает автономно (задания учителя,
  ручные задачи, класс по ссылке), дневник подключается позже. Это не отказ и не «скоро».

Режим — это свойство *нашего каталога*, а не утверждение о том, что регион «подключён» к СГО.
``automatic_import_verified`` всегда ``False``: живой вход в региональные порталы из этой среды
не проверялся (см. docs/v23/SGO_COMPATIBILITY_V23.md). Никаких процентов «покрытия» здесь нет.
"""
from __future__ import annotations

import sqlite3
from typing import Any, Literal

from app.school_fuzzy import REGION_CODES, _trusted_clause
from app.school_regions import canonical_region, search_aliases

ConnectionMode = Literal["sgo_direct", "esia_gateway", "autonomous_bridge"]

# Подписи бейджей — то, что ученик видит в списке. Без обещаний, которых каталог не подтверждает.
BADGES: dict[str, str] = {
    "sgo_direct": "СГО каталог",
    "esia_gateway": "Через Госуслуги",
    "autonomous_bridge": "Автономный режим",
}


def _trusted_school_counts(db: sqlite3.Connection) -> dict[str, int]:
    trusted, args = _trusted_clause(db)
    rows = db.execute(
        "SELECT s.region, COUNT(*) FROM schools_directory s JOIN sgo_hosts_registry h"
        " ON s.host_id=h.host_id WHERE h.is_active=1" + trusted + " GROUP BY s.region",
        args,
    ).fetchall()
    counts: dict[str, int] = {}
    for region, n in rows:
        key = canonical_region(str(region))
        counts[key] = counts.get(key, 0) + int(n)
    return counts


def _trusted_host_counts(repo: Any) -> dict[str, int]:
    """Доверенные узлы по субъектам: где они есть, живой поиск (app/live_discovery) может найти школу,
    даже если в локальном справочнике её пока нет."""
    from app.sgo_directory import Directory

    counts: dict[str, int] = {}
    for host in Directory(repo).hosts(trusted_only=True):
        key = canonical_region(str(host["region_name"]))
        counts[key] = counts.get(key, 0) + 1
    return counts


def _esia_only_regions() -> set[str]:
    """Субъекты, где региональный портал каталога разрешает вход только через Госуслуги."""
    from app.school_registry import catalog

    return {canonical_region(p["region"]) for p in catalog().get("portals", [])
            if p.get("auth_policy") == "esia_only"}


def connection_mode(schools: int, esia_only: bool) -> ConnectionMode:
    """Порядок важен: если доверенные школы есть — их можно выбрать напрямую (sgo_direct),
    даже если вход у части из них только через Госуслуги (это видно на карточке школы)."""
    if schools > 0:
        return "sgo_direct"
    if esia_only:
        return "esia_gateway"
    return "autonomous_bridge"


def all_regions(repo: Any, query: str = "") -> list[dict[str, Any]]:
    """Все 89 субъектов: сначала субъекты с СГО-каталогом (по числу школ), затем по алфавиту.

    ``query`` — необязательный фильтр по названию/сокращению/коду («кчр», «хмао», «73»).
    """
    with repo.tx() as db:
        counts = _trusted_school_counts(db)
    esia_only = _esia_only_regions()
    hosts = _trusted_host_counts(repo)
    needle = _key(query)
    items: list[dict[str, Any]] = []
    for code, raw_name in REGION_CODES.items():
        name = canonical_region(raw_name)
        aliases = search_aliases(name)
        if needle and not _matches(needle, code, name, aliases):
            continue
        schools = counts.get(name, 0)
        mode = connection_mode(schools, name in esia_only)
        items.append({
            "region_code": code,
            "name": name,
            "aliases": aliases,
            "schools": schools,
            "connection_mode": mode,
            "badge": BADGES[mode],
            "sgo_catalog": mode == "sgo_direct",
            "live_hosts": hosts.get(name, 0),
            "automatic_import_verified": False,
        })
    # СГО-каталог первым (больше школ — выше), остальные строго по алфавиту (ё = е).
    items.sort(key=lambda r: (0 if r["sgo_catalog"] else 1, -r["schools"], _key(r["name"])))
    return items


def _key(value: str) -> str:
    from app.school_regions import region_key

    return region_key(value or "")


def _matches(needle: str, code: str, name: str, aliases: list[str]) -> bool:
    if needle.isdigit():
        return code == needle.zfill(2)
    return any(needle in _key(candidate) for candidate in (name, *aliases))


def summary(items: list[dict[str, Any]]) -> dict[str, int]:
    """Счётчики для честного отображения долей (без выдуманных процентов покрытия)."""
    out = {"total": len(items), "sgo_direct": 0, "esia_gateway": 0, "autonomous_bridge": 0}
    for item in items:
        out[item["connection_mode"]] += 1
    return out