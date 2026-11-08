"""DB-01: единая точка открытия SQLite для всех хранилищ СферумФокус.

* ``journal_mode=WAL`` — читатели не блокируют писателя (каталог практикумов, сессии, блиц по PIN
  читаются параллельно с записью прогресса). Режим WAL хранится в самом файле БД; на файловых системах
  без поддержки разделяемой памяти SQLite честно остаётся в ``delete`` — это видно в ``deep_health``.
* ``busy_timeout`` — вместо мгновенной ``database is locked`` ждём до 5 с.
* Файл создаётся с правами 0600, каталог — 0700 (ПДн учеников не должны читаться другими пользователями ОС).

Правило для роутеров: синхронный sqlite3 нельзя вызывать прямо в ``async def`` — либо ``def``-обработчик
(FastAPI выполнит его в пуле потоков), либо ``await asyncio.to_thread(...)``. Это проверяет
``tests/test_sqlite_wal_db01.py`` статическим разбором AST.
"""
from __future__ import annotations

import os
import sqlite3
from pathlib import Path

BUSY_TIMEOUT_MS = 5000


def ensure_file(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    os.close(fd)
    os.chmod(path, 0o600)


def connect(path: str | os.PathLike[str], *, synchronous: str = "NORMAL", busy_timeout_ms: int = BUSY_TIMEOUT_MS,
            foreign_keys: bool = True, row_factory: bool = True) -> sqlite3.Connection:
    """Открывает соединение с WAL и busy_timeout. ``synchronous=NORMAL`` в WAL не теряет целостность."""
    target = Path(path)
    ensure_file(target)
    db = sqlite3.connect(str(target), timeout=busy_timeout_ms / 1000)
    if row_factory:
        db.row_factory = sqlite3.Row
    db.execute(f"PRAGMA busy_timeout={int(busy_timeout_ms)}")
    db.execute("PRAGMA journal_mode=WAL")
    db.execute(f"PRAGMA synchronous={'FULL' if synchronous.upper() == 'FULL' else 'NORMAL'}")
    if foreign_keys:
        db.execute("PRAGMA foreign_keys=ON")
    return db


def journal_mode(db: sqlite3.Connection) -> str:
    row = db.execute("PRAGMA journal_mode").fetchone()
    return str(row[0]).lower() if row else "unknown"


__all__ = ["BUSY_TIMEOUT_MS", "connect", "ensure_file", "journal_mode"]
