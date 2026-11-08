"""Метрики ИИ-слоя и детерминированного движка (в памяти процесса, без зависимостей).

Зачем: подтверждать оптимизацию измерениями, а не словами (docs/COST_OPTIMIZATION.md).
Что считаем — только низкокардинальные метки (функция × исход/причина):
    ai_calls[feature][outcome]    вызовы провайдера: ok | timeout | rate_limited | auth | …
    ai_retries[feature][reason]   повторы временных ошибок
    fallback[feature][reason]     ответ построен без ИИ из-за сбоя/отсутствия ключа
    rules[feature]                запрос обслужен правилами БЕЗ попытки ИИ (по дизайну)
    cache[feature][hit|miss]      кэш проверенных ИИ-результатов
    invalid[feature]              ответ модели не прошёл JSON/схему
    tokens[feature][in|out]       usage провайдера (если он его прислал)
    latency_ms[op]                count/sum/max для ИИ-вызовов и планировщика
    ops[op][outcome]              успешность основных операций (process_media, calculate)
НЕ пишем: user id, тексты заданий, ключи, содержимое промптов. Один воркер uvicorn —
счётчики локальны процессу и обнуляются при перезапуске (см. README «Ограничения»).
"""
from __future__ import annotations

import threading
from collections import defaultdict
from typing import Any

_LOCK = threading.Lock()


def _nested() -> defaultdict[str, defaultdict[str, int]]:
    return defaultdict(lambda: defaultdict(int))


_ai_calls = _nested()
_ai_retries = _nested()
_fallback = _nested()
_cache = _nested()
_tokens = _nested()
_ops = _nested()
_rules: defaultdict[str, int] = defaultdict(int)
_invalid: defaultdict[str, int] = defaultdict(int)
_latency: dict[str, dict[str, float]] = {}


def _lat(op: str, ms: float) -> None:
    s = _latency.setdefault(op, {"count": 0, "sum_ms": 0.0, "max_ms": 0.0})
    s["count"] += 1
    s["sum_ms"] += ms
    s["max_ms"] = max(s["max_ms"], ms)


def ai_call(feature: str, outcome: str, latency_ms: float | None = None) -> None:
    with _LOCK:
        _ai_calls[feature][outcome] += 1
        if latency_ms is not None:
            _lat(f"ai:{feature}", latency_ms)


def ai_retry(feature: str, reason: str) -> None:
    with _LOCK:
        _ai_retries[feature][reason] += 1


def fallback(feature: str, reason: str) -> None:
    with _LOCK:
        _fallback[feature][reason] += 1


def rules(feature: str) -> None:
    with _LOCK:
        _rules[feature] += 1


def cache(feature: str, hit: bool) -> None:
    with _LOCK:
        _cache[feature]["hit" if hit else "miss"] += 1


def invalid(feature: str) -> None:
    with _LOCK:
        _invalid[feature] += 1


def tokens(feature: str, prompt: int | None, completion: int | None) -> None:
    with _LOCK:
        if isinstance(prompt, int):
            _tokens[feature]["in"] += prompt
        if isinstance(completion, int):
            _tokens[feature]["out"] += completion


def op(name: str, outcome: str, latency_ms: float | None = None) -> None:
    with _LOCK:
        _ops[name][outcome] += 1
        if latency_ms is not None:
            _lat(name, latency_ms)


def _plain(d: Any) -> Any:
    return {k: _plain(v) for k, v in d.items()} if isinstance(d, dict) else d


def snapshot() -> dict[str, Any]:
    with _LOCK:
        hits = sum(v.get("hit", 0) for v in _cache.values())
        total = hits + sum(v.get("miss", 0) for v in _cache.values())
        return {
            "ai_calls": _plain(_ai_calls), "ai_calls_total": sum(sum(v.values()) for v in _ai_calls.values()),
            "ai_retries": _plain(_ai_retries), "fallback": _plain(_fallback),
            "rules": dict(_rules), "cache": _plain(_cache),
            "cache_hit_rate": round(hits / total, 3) if total else None,
            "invalid": dict(_invalid), "tokens": _plain(_tokens),
            "latency_ms": {k: {"count": int(v["count"]), "avg": round(v["sum_ms"] / v["count"], 1),
                               "max": round(v["max_ms"], 1)} for k, v in _latency.items()},
            "ops": _plain(_ops),
            "cost": "не считается: тариф провайдера в конфигурации не задан — см. docs/COST_OPTIMIZATION.md",
        }


def reset() -> None:
    with _LOCK:
        for d in (_ai_calls, _ai_retries, _fallback, _cache, _tokens, _ops):
            d.clear()
        _rules.clear()
        _invalid.clear()
        _latency.clear()
