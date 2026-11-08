"""Local POSIX JSON persistence; no Windows/NFS/distributed/power-loss claim."""

from __future__ import annotations
import json
import os
import tempfile
import threading
import weakref
from contextlib import contextmanager
from pathlib import Path
from typing import Any

try:
    import fcntl
except ImportError:
    fcntl = None
_registry_guard = threading.Lock()
# Active holders/waiters retain a strong reference. Idle per-user locks must
# not accumulate for the lifetime of the process. The registry guard makes
# lookup + creation atomic; flock remains the interprocess authority.
_registry = weakref.WeakValueDictionary()
_local = threading.local()


def ensure_private_dir(directory: Path) -> None:
    """``mkdir -p``, но каждый СОЗДАННЫЙ уровень — 0700 (v2.2 · аудит данных «в покое»).

    ``Path.mkdir(parents=True, mode=…)`` применяет mode только к последнему уровню, родители
    получают права по umask (обычно 0755). Существующие каталоги не трогаются (права проверяет
    scripts/server_audit.py, а не приложение на лету)."""
    if directory.is_dir():
        return
    missing = []
    cur = directory
    while not cur.exists() and cur.parent != cur:
        missing.append(cur)
        cur = cur.parent
    for level in reversed(missing):
        try:
            level.mkdir(mode=0o700)
        except FileExistsError:
            pass


@contextmanager
def file_lock(resource: Path):
    """Same-inode interprocess lock + thread reentrancy; never unlink lock files."""
    if fcntl is None:
        raise RuntimeError(
            "JSON process safety requires POSIX flock on a local shared filesystem"
        )
    key = str(resource.resolve())
    with _registry_guard:
        guard = _registry.get(key)
        if guard is None:
            guard = threading.RLock()
            _registry[key] = guard
    with guard:
        held = getattr(_local, "held", None)
        if held is None:
            held = _local.held = set()
        if key in held:
            yield
            return
        ensure_private_dir(resource.parent)
        fd = os.open(
            resource.with_name("." + resource.name + ".lock"),
            os.O_CREAT | os.O_RDWR,
            0o600,
        )
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            held.add(key)
            try:
                # No cooperating writer can still own this target's orphan temp.
                if resource.suffix == ".json":
                    for orphan in resource.parent.glob("." + resource.name + ".*.tmp"):
                        orphan.unlink(missing_ok=True)
                yield
            finally:
                held.remove(key)
                fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


def atomic_json(path: Path, data: Any, *, default=None) -> None:
    """Caller holds whole-RMW lock; unique same-dir temp, fsync, replace, dir fsync.
    Error after replace can be an unknown committed outcome; retry using operation ID.
    """
    text = json.dumps(data, ensure_ascii=False, default=default)
    ensure_private_dir(path.parent)
    fd, name = tempfile.mkstemp(
        prefix="." + path.name + ".", suffix=".tmp", dir=path.parent
    )
    temp = Path(name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temp.unlink(missing_ok=True)


# Teacher files share one directory transaction boundary (personal/proposals/journal).
# A prepared redo record is the commit point; recovery rolls it forward under lock.
# Individual renames are NOT a simultaneous multi-file filesystem transaction.
def _transactions():
    if not hasattr(_local, "transactions"):
        _local.transactions = {}
    return _local.transactions


def _recover(root: Path) -> None:
    for orphan in root.glob(".*.json.*.tmp"):
        orphan.unlink(missing_ok=True)
    wal = root / ".transaction.json"
    if not wal.exists():
        return
    doc = json.loads(wal.read_text(encoding="utf-8"))
    if doc.get("v") != 1 or not isinstance(doc.get("writes"), dict):
        raise RuntimeError("invalid prepared transaction; manual recovery required")
    for name, data in doc["writes"].items():
        if not isinstance(name, str) or Path(name).name != name or name.startswith("."):
            raise RuntimeError("invalid transaction path")
        atomic_json(root / name, data)
    wal.unlink()
    fd = os.open(root, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


@contextmanager
def transaction(root: Path):
    root = root.resolve()
    with file_lock(root / ".transaction"):
        active = _transactions()
        if root in active:
            yield
            return
        _recover(root)
        active[root] = {}
        try:
            yield
            writes = active[root]
            if writes:
                # Serialization happened before publication; failure before WAL leaves all old.
                atomic_json(root / ".transaction.json", {"v": 1, "writes": writes})
                _recover(root)
        finally:
            active.pop(root, None)


def read_record(path: Path, default: Any) -> Any:
    root = path.parent.resolve()
    with transaction(root):
        writes = _transactions()[root]
        if path.name in writes:
            return json.loads(json.dumps(writes[path.name]))
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return default


def write_record(path: Path, data: Any) -> None:
    root = path.parent.resolve()
    if path.name.startswith("."):
        raise ValueError("transaction target cannot be a reserved record")
    with transaction(root):
        # Snapshot now, never retain a mutable caller reference until commit.
        _transactions()[root][path.name] = json.loads(
            json.dumps(data, ensure_ascii=False)
        )
