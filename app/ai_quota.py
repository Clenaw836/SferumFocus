"""Durable per-UID provider-attempt reservations on one local POSIX volume.

All cooperating processes use the existing whole-RMW lock/atomic writer. A charge
is committed BEFORE each provider attempt (including retry/json-mode fallback).
Failures/cancellation after reservation are conservatively charged; no refund can
reopen capacity while a provider might still bill. Waiting for a semaphore does
not spend quota. No Redis/new dependency, no NFS/Windows/multi-replica claim.
"""
from __future__ import annotations
import json
import math
import os
import time
from datetime import date
from pathlib import Path
from .json_storage import file_lock, atomic_json
from .uid_store import user_key

class QuotaExceeded(Exception):
    def __init__(self, retry_after: int, daily: bool = False):
        self.retry_after = retry_after
        self.daily = daily

def reserve(uid: str, per_minute: int, per_day: int) -> None:
    path = Path(os.environ.get("SFERUM_DATA_DIR", "data")) / "ai_quota" / (user_key(uid) + ".json")
    with file_lock(path):
        try:
            d = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            d = {"v": 1, "window": [], "day": "", "count": 0, "last": 0.0}
        if (not isinstance(d, dict) or d.get("v") != 1 or not isinstance(d.get("window"), list)
                or not isinstance(d.get("day"), str) or type(d.get("count")) is not int
                or d["count"] < 0 or not isinstance(d.get("last"), (int, float)) or not math.isfinite(d["last"])
                or any(type(t) not in (float, int) or not math.isfinite(t) for t in d["window"])):
            raise ValueError("invalid quota ledger; operator recovery required")
        # A backwards wall-clock step must not refill quota; clocks must be managed by operator.
        now = max(time.time(), d["last"])
        window = [t for t in d["window"] if t > now - 60]
        today = date.fromtimestamp(now).isoformat()
        count = d["count"] if d["day"] == today else 0
        if len(window) >= per_minute:
            raise QuotaExceeded(max(1, math.ceil(min(window) + 60 - now)))
        if count >= per_day:
            raise QuotaExceeded(3600, daily=True)
        atomic_json(path, {"v": 1, "window": window + [now], "day": today, "count": count + 1, "last": now})
