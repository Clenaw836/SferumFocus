"""v2.3.2 · Вход через Госуслуги (ЕСИА): единая точка конфигурации и готовности. Модуль НЕ ходит в сеть.

Флаг: ENABLE_ESIA_AUTH (основной) и ENABLE_GOSUSLUGI_AUTH (устаревший синоним). Значения строго
true/false/1/0/yes/no/on/off (регистр не важен). По умолчанию выключено. Оба заданы и расходятся,
или значение не распознано, — состояние misconfigured: вход через Госуслуги заблокирован, а не
«молча включён».

Состояния провайдера (безопасная причина без значений переменных):
  disabled                       — флаг выключен: ни одного запроса, редиректа или callback;
  misconfigured                  — конфликт/ошибка конфигурации: всё ЕСИА-зависимое отключено;
  awaiting_official_credentials  — флаг включён, официальных реквизитов прямого шлюза ЕСИА нет;
                                   работают только уже настроенные оператором региональные шлюзы;
  ready                          — реквизиты прямого шлюза заданы и прошли проверку формы.
Флаг ≠ готовность. v3.0: контур OAuth 2.0 + PKCE (S256) собирается полностью (``authorization_request``,
``token_request``), подпись client_secret — через ``EsiaSignerProtocol`` (ГОСТ Р 34.10-2012, криптопровайдер
оператора). Сетевой отправки в этом релизе нет: без подписанта оператора и состояния ``ready`` ничего не строится.
"""
from __future__ import annotations

import base64 as _b64
import hashlib as _hashlib
import logging
import os
import secrets as _secrets
import uuid as _uuid
from dataclasses import dataclass, field
from datetime import datetime as _dt, timezone as _tz
from typing import Any, Mapping, Protocol, runtime_checkable
from urllib.parse import urlencode as _urlencode, urlsplit

from app.api_errors import CodedError

PRIMARY = "ENABLE_ESIA_AUTH"
ALIAS = "ENABLE_GOSUSLUGI_AUTH"
_TRUE = {"1", "true", "yes", "on"}
_FALSE = {"0", "false", "no", "off"}
# Официальные реквизиты прямого шлюза. Значения выдаёт оператор ЕСИА; приложение их не придумывает.
REQUISITES = ("ESIA_CLIENT_ID", "ESIA_REDIRECT_URI", "ESIA_AUTH_URL", "ESIA_TOKEN_URL", "ESIA_SCOPE")
SECRET_SOURCES = ("ESIA_CERT_PATH", "ESIA_CLIENT_SECRET_ENV")
# Хосты из методических рекомендаций ЕСИА (продуктив и тестовая среда). Любой другой — misconfigured.
OFFICIAL_HOSTS = frozenset({"esia.gosuslugi.ru", "esia-portal1.test.gosuslugi.ru"})
CURRENT_PATHS = {"ESIA_AUTH_URL": "/aas/oauth2/v2/ac", "ESIA_TOKEN_URL": "/aas/oauth2/v3/te"}
_PLACEHOLDERS = ("changeme", "change-me", "example", "your_", "your-", "<", ">", "xxx", "todo", "placeholder")

STATES = ("disabled", "misconfigured", "awaiting_official_credentials", "ready")


@dataclass(frozen=True)
class EsiaConfig:
    state: str
    reason: str
    flag_source: str | None = None           # какая переменная включила флаг (имя, не значение)
    missing: tuple[str, ...] = field(default_factory=tuple)

    @property
    def enabled(self) -> bool:
        """ЕСИА-зависимые сценарии (региональный шлюз оператора, тестовые песочницы) разрешены."""
        return self.state in {"awaiting_official_credentials", "ready"}

    def public(self) -> dict[str, object]:
        return {"state": self.state, "reason": self.reason}


def parse_flag(raw: str | None) -> bool | None:
    """None — значение не распознано (это ошибка конфигурации, а не «выключено»)."""
    if raw is None:
        return False
    value = raw.strip().lower()
    if value == "":
        return False
    if value in _TRUE:
        return True
    if value in _FALSE:
        return False
    return None


def _placeholder(value: str) -> bool:
    low = value.lower()
    return any(mark in low for mark in _PLACEHOLDERS)


def config(env: Mapping[str, str] | None = None) -> EsiaConfig:
    env = os.environ if env is None else env
    primary_raw, alias_raw = env.get(PRIMARY), env.get(ALIAS)
    primary, alias = parse_flag(primary_raw), parse_flag(alias_raw)
    if primary is None or alias is None:
        return EsiaConfig("misconfigured", "invalid_flag_value")
    primary_set = primary_raw is not None and primary_raw.strip() != ""
    alias_set = alias_raw is not None and alias_raw.strip() != ""
    if primary_set and alias_set and primary != alias:
        return EsiaConfig("misconfigured", "conflicting_flags")
    enabled = primary if primary_set else alias if alias_set else False
    source = PRIMARY if primary_set else ALIAS if alias_set else None
    if not enabled:
        return EsiaConfig("disabled", "flag_off", source)
    values = {name: (env.get(name) or "").strip() for name in REQUISITES}
    secret = {name: (env.get(name) or "").strip() for name in SECRET_SOURCES}
    missing = tuple(name for name, value in values.items() if not value)
    if not any(secret.values()):
        missing += ("ESIA_CERT_PATH|ESIA_CLIENT_SECRET_ENV",)
    present = [v for v in (*values.values(), *secret.values()) if v]
    if any(_placeholder(v) for v in present):
        return EsiaConfig("misconfigured", "placeholder_value", source)
    for name in ("ESIA_AUTH_URL", "ESIA_TOKEN_URL"):
        if values[name]:
            u = urlsplit(values[name])
            if u.scheme != "https" or u.hostname not in OFFICIAL_HOSTS or u.username or u.password or u.query or u.fragment:
                return EsiaConfig("misconfigured", "unofficial_endpoint", source)
            # v3.2 · проверено (Perplexity, МР ЕСИА 3.48): старые /aas/oauth2/ac и /te (PKCS#7) не допускаются
            # для новых систем-клиентов — только пара /v2/ac + /v3/te (raw-подпись, client_certificate_hash, PKCE).
            if u.path.rstrip("/") != CURRENT_PATHS[name]:
                return EsiaConfig("misconfigured", "legacy_endpoint", source)
    if values["ESIA_REDIRECT_URI"]:
        u = urlsplit(values["ESIA_REDIRECT_URI"])
        origin = urlsplit((env.get("SFERUM_PUBLIC_ORIGIN") or "").strip())
        if (u.scheme != "https" or not u.hostname or u.username or u.password or u.query or u.fragment
                or origin.scheme != "https" or (u.scheme, u.netloc) != (origin.scheme, origin.netloc)):
            return EsiaConfig("misconfigured", "redirect_uri_mismatch", source)
    if values["ESIA_SCOPE"] and "openid" not in values["ESIA_SCOPE"].split():
        return EsiaConfig("misconfigured", "scope_without_openid", source)
    if secret["ESIA_CLIENT_SECRET_ENV"] and not (env.get(secret["ESIA_CLIENT_SECRET_ENV"]) or "").strip():
        missing += ("value of ESIA_CLIENT_SECRET_ENV",)
    if missing:
        return EsiaConfig("awaiting_official_credentials", "missing_official_requisites", source, missing)
    return EsiaConfig("ready", "configured", source)


def require_enabled(what: str = "esia") -> EsiaConfig:
    """Вызывается ДО любого сетевого/состояния-меняющего шага ЕСИА-сценария."""
    cfg = config()
    if cfg.state == "misconfigured":
        raise CodedError(503, "ESIA_MISCONFIGURED",
                         "Вход через Госуслуги отключён из-за ошибки настройки сервера. Используйте другой способ входа.",
                         extra={"auth_method": what, "esia_state": cfg.state})
    if not cfg.enabled:
        raise CodedError(409, "AUTH_METHOD_DISABLED",
                         "Вход через Госуслуги в этом приложении сейчас недоступен. Выберите другой способ входа.",
                         extra={"auth_method": what, "esia_state": cfg.state})
    return cfg


def require_bridge() -> EsiaConfig:
    """Привязка собственной сессии и песочница 2FA — только тестовая/демо-среда и включённый флаг."""
    cfg = require_enabled("bridge")
    if os.getenv("SFERUM_ENV") not in {"test", "demo"}:
        raise CodedError(409, "AUTH_METHOD_DISABLED",
                         "Этот способ привязки доступен только в тестовой среде.",
                         extra={"auth_method": "bridge", "esia_state": cfg.state})
    return cfg


def gate() -> None:
    """FastAPI-зависимость для маршрутов Госуслуг/«Моей школы» (регион. OAuth, handoff, legacy auth)."""
    require_enabled()


def bridge_gate() -> None:
    require_bridge()


def log_startup_state(logger: logging.Logger | None = None) -> EsiaConfig:
    cfg = config()
    log = logger or logging.getLogger("sferumfocus.esia")
    extra = f" missing={','.join(cfg.missing)}" if cfg.missing else ""
    (log.warning if cfg.state == "misconfigured" else log.info)(
        "esia_provider state=%s reason=%s flag=%s%s", cfg.state, cfg.reason, cfg.flag_source or "default", extra)
    return cfg


# ------------------------------------------------------------------ v3.0 · OAuth 2.0 + PKCE (RFC 7636) без сети
# Контур прямого шлюза собирается полностью, но НЕ отправляется: подпись client_secret по ГОСТ Р 34.10-2012
# делает только криптопровайдер оператора (КриптоПро CSP / HSM), подключаемый через EsiaSignerProtocol.
# Без подписанта и без состояния ``ready`` ни URL, ни тело обмена кода не строятся.
PKCE_METHOD = "S256"


@runtime_checkable
class EsiaSignerProtocol(Protocol):
    """Подпись по ГОСТ Р 34.10-2012 в raw-формате (base64url) для /v2/ac и /v3/te — реализует оператор, не приложение.
    ``certificate_hash`` — значение client_certificate_hash зарегистрированного в ЕСИА сертификата ИС (МР 3.48)."""
    algorithm: str
    certificate_hash: str

    def sign(self, payload: bytes) -> bytes: ...


class OperatorSignerMissing(CodedError):
    def __init__(self) -> None:
        super().__init__(503, "ESIA_SIGNER_MISSING",
                         "Вход через Госуслуги не настроен: нет криптопровайдера оператора (ГОСТ Р 34.10-2012).",
                         extra={"auth_method": "esia"})


def _b64url(raw: bytes) -> str:
    return _b64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def pkce_pair() -> tuple[str, str]:
    """(code_verifier 64 символа из [A-Za-z0-9-._~], code_challenge = BASE64URL(SHA256(verifier)))."""
    verifier = _b64url(_secrets.token_bytes(48))
    return verifier, _b64url(_hashlib.sha256(verifier.encode("ascii")).digest())


def _timestamp(now: _dt | None = None) -> str:
    return (now or _dt.now(_tz.utc)).strftime("%Y.%m.%d %H:%M:%S +0000")


def _signed_secret(signer: EsiaSignerProtocol | None, *parts: str) -> str:
    if (signer is None or not isinstance(signer, EsiaSignerProtocol) or not str(getattr(signer, "algorithm", "")).upper().startswith("GOST")
            or not str(getattr(signer, "certificate_hash", "") or "").strip()):
        raise OperatorSignerMissing()
    return _b64url(signer.sign("".join(parts).encode("utf-8")))


def authorization_request(signer: EsiaSignerProtocol | None, *, env: Mapping[str, str] | None = None,
                          now: _dt | None = None) -> dict[str, str]:
    """URL авторизации ЕСИА v2 (+ PKCE S256) и то, что сервер должен сохранить до callback (state, verifier).

    Ни одного сетевого запроса. ``disabled``/``misconfigured``/``awaiting_official_credentials`` — CodedError."""
    cfg = config(env)
    if cfg.state != "ready":
        if cfg.state == "misconfigured":
            raise CodedError(503, "ESIA_MISCONFIGURED", "Вход через Госуслуги отключён из-за ошибки настройки сервера.",
                             extra={"auth_method": "esia", "esia_state": cfg.state})
        raise CodedError(409, "AUTH_METHOD_DISABLED", "Вход через Госуслуги в этом приложении сейчас недоступен.",
                         extra={"auth_method": "esia", "esia_state": cfg.state})
    src = os.environ if env is None else env
    client_id, scope = src["ESIA_CLIENT_ID"].strip(), src["ESIA_SCOPE"].strip()
    state, ts = str(_uuid.uuid4()), _timestamp(now)
    verifier, challenge = pkce_pair()
    secret = _signed_secret(signer, client_id, scope, ts, state, src["ESIA_REDIRECT_URI"].strip())
    params = {"client_id": client_id, "client_secret": secret, "redirect_uri": src["ESIA_REDIRECT_URI"].strip(),
              "scope": scope, "response_type": "code", "state": state, "timestamp": ts, "access_type": "online",
              "code_challenge": challenge, "code_challenge_method": PKCE_METHOD,
              "client_certificate_hash": str(signer.certificate_hash).strip()}
    return {"url": f"{src['ESIA_AUTH_URL'].strip()}?{_urlencode(params)}", "state": state, "code_verifier": verifier,
            "timestamp": ts}


def token_request(signer: EsiaSignerProtocol | None, code: str, state: str, code_verifier: str, *,
                  env: Mapping[str, str] | None = None, now: _dt | None = None) -> dict[str, Any]:
    """Тело обмена кода на токен (POST form) — собирается, но этим модулем не отправляется."""
    cfg = config(env)
    if cfg.state != "ready":
        raise CodedError(409, "AUTH_METHOD_DISABLED", "Вход через Госуслуги в этом приложении сейчас недоступен.",
                         extra={"auth_method": "esia", "esia_state": cfg.state})
    if not (43 <= len(code_verifier or "") <= 128) or not all(c.isalnum() or c in "-._~" for c in code_verifier):
        raise CodedError(400, "ESIA_PKCE_INVALID", "Некорректный PKCE-верификатор.", extra={"auth_method": "esia"})
    src = os.environ if env is None else env
    client_id, scope, ts = src["ESIA_CLIENT_ID"].strip(), src["ESIA_SCOPE"].strip(), _timestamp(now)
    secret = _signed_secret(signer, client_id, scope, ts, state, src["ESIA_REDIRECT_URI"].strip(), code)
    return {"url": src["ESIA_TOKEN_URL"].strip(), "form": {
        "client_id": client_id, "code": code, "grant_type": "authorization_code", "client_secret": secret, "state": state,
        "redirect_uri": src["ESIA_REDIRECT_URI"].strip(), "scope": scope, "timestamp": ts, "token_type": "Bearer",
        "code_verifier": code_verifier, "client_certificate_hash": str(signer.certificate_hash).strip()}}
