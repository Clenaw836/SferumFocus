"""v2.4 · Live Trusted Host Discovery для ``/api/v1/schools/search``.

Порядок поиска школы:
1. Локальный справочник (SQLite, доверенные узлы) — мгновенно.
2. Если ничего не нашли и запрос осмысленный — ОДИН ограниченный по времени (``LIVE_TIMEOUT`` = 3.0 с)
   запрос к публичному API школ ДОВЕРЕННЫХ узлов этого субъекта (каталог/оператор, не адрес от
   пользователя): ``/webapi/prepareloginform`` + ``/webapi/schools/search?name=…``. Найденное
   сохраняется в ``schools_directory`` (существующий ``SchoolResolver.discover``) и сразу ищется.
3. Таймаут/гео-блок/ошибка узла → НЕ 503: поиск отвечает 200 с пустым списком, а мастер предлагает
   автономный режим для региона (``app/autonomous_school.py``).

Безопасность и приватность:
* только доверенные узлы (``Directory.trusted_host``), никакой регистрации узлов по запросу;
* в портал уходит только текст поиска школы (≤ 120 символов) — без uid, cookies и личности ученика;
  запросы, похожие на персональные данные (e-mail, телефон), в сеть не отправляются;
* отрицательный кэш 60 с на узел (``last_status='unavailable'``) и положительный кэш запроса 300 с
  (``directory_query_cache``) — автодополнение не превращается в поток запросов к порталам;
* SSRF/DNS-pinning/лимит ответа — в ``app/sgo_client.SgoHTTP`` (без изменений).

В тестовом окружении живой поиск выключен, пока тест явно не включит ``SGO_LIVE_DISCOVERY=1``
и не подставит ``CLIENT_FACTORY`` (ASGI-эмулятор): тесты никогда не ходят в настоящую сеть.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import time
from datetime import datetime, timezone
from typing import Any, Callable

from app.school_regions import canonical_region

logger = logging.getLogger("sferumfocus.live_discovery")

LIVE_TIMEOUT = 3.0          # общий бюджет живого поиска, секунды (требование директивы)
MAX_HOSTS = 3               # не больше трёх узлов субъекта за один поиск
NEGATIVE_TTL = 60.0         # узел недоступен → минуту его не трогаем
POSITIVE_TTL = 300.0        # тот же запрос к тому же узлу → 5 минут из справочника
MIN_LIVE_QUERY = 3          # «лиц», «№ 5»… — одна-две буквы в сеть не уходят (кроме номера школы)

# Тесты подставляют фабрику httpx.AsyncClient с ASGI-транспортом эмулятора.
CLIENT_FACTORY: Callable[[], Any] | None = None

_EMAIL = re.compile(r"[^\s@]+@[^\s@]+")
_PHONE = re.compile(r"(?:\+?\d[\s\-()]*){7,}")


def enabled() -> bool:
    raw = os.getenv("SGO_LIVE_DISCOVERY", "").strip().lower()
    if raw in {"1", "true", "yes", "on"}:
        return True
    if raw in {"0", "false", "no", "off"}:
        return False
    return os.getenv("SFERUM_ENV", "").strip().lower() != "test"


def safe_query(query: str) -> str | None:
    """Текст, который можно отправить в публичный поиск портала, или None (не отправлять)."""
    text = " ".join((query or "").split())[:120]
    if not text:
        return None
    if _EMAIL.search(text) or _PHONE.search(text):
        return None                       # похоже на персональные данные — в сеть не уходит
    if "://" in text or text.lower().startswith("www."):
        return None                       # адреса узлов от пользователя не принимаются (D6)
    if len(text) < MIN_LIVE_QUERY and not text.isdigit():
        return None
    return text


def _recently_unavailable(host: dict[str, Any], now: datetime) -> bool:
    if host.get("last_status") != "unavailable" or not host.get("last_probed_at"):
        return False
    try:
        probed = datetime.fromisoformat(str(host["last_probed_at"]))
    except ValueError:
        return False
    return (now - probed).total_seconds() < NEGATIVE_TTL


def _cached(repo: Any, host_id: str, key: str) -> bool:
    with repo.tx() as db:
        return db.execute("SELECT 1 FROM directory_query_cache WHERE host_id=? AND query=? AND expires>?",
                          (host_id, key, time.time())).fetchone() is not None


def _remember(repo: Any, host_id: str, key: str) -> None:
    with repo.tx() as db:
        db.execute("DELETE FROM directory_query_cache WHERE expires<=?", (time.time(),))
        db.execute("INSERT OR REPLACE INTO directory_query_cache VALUES(?,?,?)", (host_id, key, time.time() + POSITIVE_TTL))


def _result(status: str, hosts: int = 0, resolved: int = 0, attempted: bool = False) -> dict[str, Any]:
    return {"attempted": attempted, "status": status, "hosts": hosts, "resolved": resolved, "timeout_s": LIVE_TIMEOUT}


async def discover(repo: Any, query: str, region: str) -> dict[str, Any]:
    """Живой поиск школы у доверенных узлов субъекта. Никогда не бросает исключений наружу."""
    from app.sgo_directory import Directory
    from app.sgo_resolver import SchoolResolver

    if not enabled():
        return _result("disabled")
    text = safe_query(query)
    if text is None:
        return _result("skipped")
    region = canonical_region(region)
    directory = Directory(repo)
    now = datetime.now(timezone.utc)
    key = text.casefold()
    hosts = [h for h in directory.hosts() if canonical_region(h["region_name"]) == region]
    if not hosts:
        return _result("no_trusted_host")
    fresh = [h for h in hosts if not _recently_unavailable(h, now)]
    if not fresh:
        return _result("unavailable", hosts=len(hosts))
    todo = [h for h in fresh if not _cached(repo, h["host_id"], key)][:MAX_HOSTS]
    if not todo:
        return _result("cached", hosts=len(fresh))

    client = CLIENT_FACTORY() if CLIENT_FACTORY else None
    resolver = SchoolResolver(repo, client=client)
    tasks = [asyncio.create_task(resolver.discover(h["host_id"], text, flat_only=True)) for h in todo]
    try:
        done, pending = await asyncio.wait(tasks, timeout=LIVE_TIMEOUT)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        resolved = online = 0
        for host, task in zip(todo, tasks):
            if task in pending:
                directory.mark(host["host_id"], "unavailable")
                continue
            try:
                outcome = task.result()
            except Exception:            # noqa: BLE001 — живой поиск не должен ронять поиск школы
                logger.warning("live_discovery host_failed host=%s", host["host_id"])
                directory.mark(host["host_id"], "unavailable")
                continue
            if isinstance(outcome, dict) and outcome.get("host_status") == "online":
                online += 1
                resolved += int(outcome.get("resolved") or 0)
                _remember(repo, host["host_id"], key)
        if resolved:
            status = "found"
        elif online:
            status = "not_found"
        else:
            status = "timeout" if pending and len(pending) == len(todo) else "unavailable"
        logger.info("live_discovery region=%s hosts=%d status=%s", region, len(todo), status)
        return _result(status, hosts=len(todo), resolved=resolved, attempted=True)
    finally:
        if client is not None:
            try:
                await client.aclose()
            except Exception:            # noqa: BLE001
                pass