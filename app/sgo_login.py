"""Логин СГО передаётся строго как введён; без подмен, обрезки или Unicode-нормализации.

Исторический API normalize_login сохранён ради совместимости login-check, но ничего не исправляет.
"""
from __future__ import annotations
from dataclasses import dataclass


@dataclass(frozen=True)
class LoginVariants:
    original: str
    normalized: str
    changes: tuple[str, ...] = ()

    @property
    def changed(self) -> bool:
        return False

    def candidates(self) -> list[str]:
        return [self.original]


def normalize_login(raw: str) -> LoginVariants:
    return LoginVariants(original=raw, normalized=raw)


def login_candidates(raw: str) -> list[str]:
    return [raw]
