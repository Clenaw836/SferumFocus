"""
v18: файловое хранилище короткоживущих объектов (превью импорта, блиц-опросы) — переживает рестарт.

Раньше превью/опросы жили в dict процесса: рестарт сервера между «Проверить» и «Подтвердить»
терял превью («Превью устарело»), а опрос — ответы. Теперь:
  • файл на объект: $SFERUM_DATA_DIR/ephemeral/<имя>/<ключ>.json, запись атомарная (tmp + os.replace);
  • TTL: просроченное не отдаётся и удаляется; глобальный лимит: вытесняется только старый idle-объект того же владельца; иначе отказ;
  • валидация: ключ только [A-Za-z0-9_-]{1,64} (нет обхода путей), битый/чужой формат → как отсутствует;
  • привязка к владельцу (uid): чужой ключ не читается и не «съедается»;
  • take() — однократное извлечение под общей POSIX-блокировкой: даже при нескольких процессах на локальном диске
    опрос проверяется ровно один раз.
Честные ограничения: общий диск обязателен (несколько машин без общего тома — не поддерживается);
GC ленивый (при записи), без фонового потока.
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
import uuid
from pathlib import Path
from typing import Any
from functools import wraps
from contextlib import contextmanager
from app.json_storage import file_lock, atomic_json

_KEY = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
class ResourceLimitError(ValueError):
    """Capacity full: refuse new resource, never evict a live peer."""

class ResourceOwnerError(ValueError):
    """An active key is already owned by another user."""

def _store_guard(fn):
    @wraps(fn)
    def call(self, *args, **kwargs):
        with file_lock(self.dir() / '.store'):
            return fn(self, *args, **kwargs)
    return call



class FileStore:
    def __init__(self, name: str, ttl: float, max_items: int = 5000) -> None:
        self.name, self.ttl, self.max_items = name, ttl, max_items

    # каталог вычисляется при каждом обращении: тесты/деплой меняют SFERUM_DATA_DIR
    def dir(self) -> Path:
        return Path(os.getenv("SFERUM_DATA_DIR", "data")) / "ephemeral" / self.name

    def _path(self, key: str) -> Path | None:
        return self.dir() / f"{key}.json" if isinstance(key, str) and _KEY.match(key) else None

    @staticmethod
    def _load(p: Path) -> dict[str, Any] | None:
        try:
            doc = json.loads(p.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None
        except ValueError:
            p.unlink(missing_ok=True)                      # битый файл — как отсутствует, не падаем
            return None
        if not isinstance(doc, dict) or doc.get("v") != 1 or not isinstance(doc.get("at"), (int, float)) or "data" not in doc:
            p.unlink(missing_ok=True)
            return None
        return doc

    def _alive(self, doc: dict[str, Any], now: float) -> bool:
        return now - doc["at"] <= self.ttl

    def _gc(self, now: float) -> None:
        # Store-wide guard excludes cooperating active writers; only known orphan
        # temporary/legacy claim names may be removed. Never unlink lock inodes.
        for orphan in self.dir().iterdir():
            name = orphan.name
            if not name.startswith(".") or not orphan.is_file() or orphan.is_symlink():
                continue
            if not (name.endswith(".tmp") or re.fullmatch(r"\.[A-Za-z0-9_-]+\.claim\.[0-9]+\.[A-Za-z0-9]+", name)):
                continue
            try:
                if now - orphan.stat().st_mtime > self.ttl:
                    orphan.unlink(missing_ok=True)
            except FileNotFoundError:
                pass
        for p in self.dir().glob('*.json'):
            doc = self._load(p)
            if doc is not None and not self._alive(doc, now):
                p.unlink(missing_ok=True)

    @contextmanager
    def lease(self, key: str, owner: str | None = None):
        """Consume a preview while cleanup is excluded by the same store lock."""
        with file_lock(self.dir() / '.store'):
            yield self.get(key, owner)

    @_store_guard
    def put(self, key: str, owner: str, data: Any) -> None:
        p = self._path(key)
        if p is None:
            raise ValueError("bad key")
        now = time.time()
        self._gc(now)
        old = self._load(p)
        if old is not None and old.get('owner') != owner:
            raise ResourceOwnerError('resource key owned by another user')
        victim = None
        if old is None and len(self) >= self.max_items:
            # Existing bounded-quiz policy: a user may replace their own oldest
            # idle item, never a peer's. Leases hold this store lock during use.
            owned = []
            for candidate in self.dir().glob('*.json'):
                doc = self._load(candidate)
                if doc is not None and doc.get('owner') == owner:
                    owned.append((doc['at'], candidate))
            if not owned:
                raise ResourceLimitError('temporary resource capacity reached; retry after expiration')
            victim = min(owned, key=lambda x: (x[0], x[1].name))[1]
        atomic_json(p, {"v": 1, "at": now, "owner": owner, "data": data}, default=str)
        if victim is not None:
            victim.unlink(missing_ok=True)

    @_store_guard
    def get(self, key: str, owner: str | None = None) -> Any | None:
        p = self._path(key)
        if p is None:
            return None
        doc = self._load(p)
        if doc is None:
            return None
        if not self._alive(doc, time.time()):
            p.unlink(missing_ok=True)
            return None
        if owner is not None and doc.get("owner") != owner:
            return None
        return doc["data"]

    @_store_guard
    def take(self, key: str, owner: str | None = None) -> Any | None:
        """Однократно забрать объект под общей межпроцессной блокировкой."""
        p = self._path(key)
        if p is None:
            return None
        doc = self._load(p)
        if doc is None:
            return None
        if not self._alive(doc, time.time()):
            p.unlink(missing_ok=True)
            return None
        if owner is not None and doc.get('owner') != owner:
            return None
        p.unlink()
        return doc['data']

    @_store_guard
    def discard(self, key: str) -> None:
        p = self._path(key)
        if p is not None:
            p.unlink(missing_ok=True)

    @_store_guard
    def clear(self) -> None:
        d = self.dir()
        if d.exists():
            for p in d.glob("*.json"):
                p.unlink(missing_ok=True)

    @_store_guard
    def __len__(self) -> int:
        d = self.dir()
        return sum(1 for _ in d.glob("*.json")) if d.exists() else 0

    def __getitem__(self, key: str) -> Any:          # для тестов: прямой доступ к данным
        v = self.get(key)
        if v is None:
            raise KeyError(key)
        return v
