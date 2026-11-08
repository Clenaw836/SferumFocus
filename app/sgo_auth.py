"""Единая карта способов входа в дневник для любой школы любого региона «Сетевого Города».

Способы (метод → кто вводит секреты → что делает приложение):

  sgo_credentials  школьный логин/пароль СГО   → пароль вводится в приложении, уходит только на узел школы
                                                 (POST /api/v1/sgo/connect → NetSchoolClient.authenticate);
  gosuslugi_esia   Госуслуги через ЗАРЕГИСТРИРОВАННЫЙ OAuth-шлюз региона/ЕСИА
                                               → логин, пароль и коды Госуслуг пользователь вводит ТОЛЬКО на
                                                 gosuslugi.ru; приложение получает код авторизации
                                                 (POST /api/v1/diary/oauth/start, PKCE S256, app.sgo_oauth);
  moya_shkola      «Моя школа» через OAuth-шлюз → так же, как ЕСИА;
  portal_bridge    вход на портал СГО через Госуслуги в своём браузере + передача СВОЕЙ сессии
                                               → только test/demo (app.handoff_routes), с подтверждением.

Пароль Госуслуг приложение не принимает и не автоматизирует: ЕСИА запрещает вход третьих лиц от имени
пользователя, требует 2FA/антибот и разрешает интеграцию только зарегистрированным информационным системам.
Модуль не хранит секретов; сеть — только анонимный GET /logindata узла школы (возможности портала).
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx
from fastapi import APIRouter, Query, Request

from app import esia_provider
from app.diary_providers import ProviderUnavailable, ReauthRequired, UnsupportedPortal
from app.sgo_client import NetSchoolClient, SgoAuthRejected, SgoUnsupported
from app.sgo_login import normalize_login

logger = logging.getLogger("sferumfocus.sgo.auth_methods")
CAPABILITIES_TIMEOUT = 15
NETWORK_ERRORS = (ProviderUnavailable, ReauthRequired, SgoAuthRejected, SgoUnsupported, UnsupportedPortal,
                  httpx.HTTPError, OSError, TimeoutError, ValueError)


def _oauth_configured(host: dict[str, Any], method: str) -> bool:
    profile = ((host.get("metadata") or {}).get("oauth") or {}).get(method)
    return isinstance(profile, dict) and all(isinstance(profile.get(k), str) and profile[k]
                                             for k in ("authorization_url", "token_url", "client_id", "redirect_uri"))


async def portal_capabilities(host: dict[str, Any], client: httpx.AsyncClient | None = None) -> dict[str, Any]:
    try:
        caps = await asyncio.wait_for(NetSchoolClient(host, client).capabilities(), CAPABILITIES_TIMEOUT)
        return {"status": "checked", **caps}
    except NETWORK_ERRORS as exc:
        logger.info("sgo_capabilities host=%s result=%s", host.get("host_id"), type(exc).__name__)
        return {"status": "temporarily_unavailable", "school_login": None, "esia_advertised": False,
                "esia_main": False, "version": None, "raw_known": False}


async def discover_auth_methods(school: dict[str, Any], host: dict[str, Any], *,
                                client: httpx.AsyncClient | None = None, live: bool = True) -> dict[str, Any]:
    """Все способы входа для школы: доступность, причина недоступности и следующий шаг для фронтенда."""
    import os
    catalog = set(school.get("supported_auth_methods") or [])
    esia = esia_provider.config()
    caps = await portal_capabilities(host, client) if live else {"status": "not_checked", "school_login": None,
                                                                  "esia_advertised": False, "esia_main": False,
                                                                  "version": None, "raw_known": False}
    methods: list[dict[str, Any]] = []

    if "sgo_credentials" not in catalog:
        reason = "disabled_in_catalog"
    elif caps.get("school_login") is False:
        reason = "disabled_by_portal"
    else:
        reason = None
    methods.append({"method": "sgo_credentials", "title": "Логин и пароль «Сетевого Города»",
                    "available": reason is None, "reason": reason,
                    "action": {"type": "form", "endpoint": "/api/v1/sgo/connect",
                               "fields": ["role", "school_uid", "login", "password"]} if reason is None else None,
                    "hints": ["Введите логин точно как его выдала школа. Буквы и цифры не заменяются."]})

    for method, title in (("gosuslugi_esia", "Госуслуги (ЕСИА)"), ("moya_shkola", "«Моя школа»")):
        if method not in catalog and not (method == "gosuslugi_esia" and caps.get("esia_advertised")):
            reason = "not_offered_by_region"
        elif not esia.enabled:
            reason = "esia_" + str(esia.state)
        elif not _oauth_configured(host, method):
            reason = "gateway_not_registered"
        else:
            reason = None
        methods.append({"method": method, "title": title, "available": reason is None, "reason": reason,
                        "action": {"type": "redirect", "endpoint": "/api/v1/diary/oauth/start",
                                   "body": {"school_uid": school.get("school_uid"), "portal_url": host.get("base_url"),
                                            "scid": school.get("scid"), "method": method}} if reason is None else None,
                        "portal_advertises_esia": bool(caps.get("esia_advertised")) if method == "gosuslugi_esia" else None})

    test_env = os.getenv("SFERUM_ENV") in {"test", "demo"}
    bridge = esia.enabled and test_env
    methods.append({"method": "portal_bridge", "title": "Своя сессия портала (вход через Госуслуги на портале)",
                    "available": bridge, "reason": None if bridge else "test_or_demo_only",
                    "action": {"type": "bookmarklet", "endpoint": "/api/v1/diary/auth/bridge/start"} if bridge else None})

    available = [m["method"] for m in methods if m["available"]]
    return {"school_uid": school.get("school_uid"), "portal": host.get("base_url"),
            "portal_status": caps.get("status"), "provider_version": caps.get("version"),
            "esia_only_portal": caps.get("school_login") is False and bool(caps.get("esia_advertised")),
            "esia_state": esia.state, "available_methods": available,
            "primary_method": available[0] if available else None, "methods": methods}


from app.sgo_routes import SafeRoute  # noqa: E402

router = APIRouter(route_class=SafeRoute)


@router.get("/api/v1/sgo/auth-methods")
async def auth_methods(request: Request, school_uid: str = Query(min_length=1, max_length=160),
                       live: bool = True) -> dict[str, Any]:
    """Способы входа выбранной школы (только доверенный каталог; без учётных данных)."""
    from app import school_selection as selection
    from app.onboarding_routes import _limit, _uid
    from app.platform_auth import store
    uid = _uid(request)
    _limit(request, "sgo-auth-methods", uid, 30)
    school, host = selection.resolve(store(), school_uid)
    return await discover_auth_methods(school, host, live=live)


@router.get("/api/v1/sgo/login-check")
def login_check(request: Request, login: str = Query(min_length=1, max_length=200)) -> dict[str, Any]:
    """Подсказка для формы входа: как логин будет отправлен в СГО (без сети, без пароля)."""
    from app.onboarding_routes import _limit, _uid
    uid = _uid(request)
    _limit(request, "sgo-login-check", uid, 60)
    v = normalize_login(login)
    return {"normalized": v.normalized, "changed": v.changed, "changes": list(v.changes)}
