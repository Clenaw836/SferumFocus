"""Конфигурация сервиса: чтение .env и переменных окружения.

.env читается app/envfile.py ровно как systemd EnvironmentFile= (v252): последнее присваивание ключа
побеждает, строки с недопустимым именем (`export KEY=`, BOM) игнорируются. Переменная, уже заданная
в окружении процесса (systemd, Docker, shell), важнее файла. Файл опционален. DeploymentPolicy по умолчанию
включает production fail-closed; demo/test требуют явного профиля, отсутствующая конфигурация
не разрешает приватные API. ENV_FILE_REPORT (без значений) — для /ready и строки deployment_config в журнале.
"""
from __future__ import annotations

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
ENV_FILE = BASE_DIR / ".env"

from app.envfile import EnvFileReport, load_env_file as _load_env

def _load_env_file() -> EnvFileReport:
    """ENV-01: та же семантика, что у systemd (раньше дубликат решался «первый побеждает» — расходилось
    с systemd «последний побеждает»). Нечитаемый/не-UTF-8 .env не роняет импорт: значения не берутся,
    причина видна в ENV_FILE_REPORT.error (production-проверки тогда честно не проходят)."""
    global ENV_FILE_REPORT
    ENV_FILE_REPORT = _load_env(ENV_FILE)
    return ENV_FILE_REPORT

ENV_FILE_REPORT: EnvFileReport = _load_env_file()
from app.runtime_secrets import configure as _configure_runtime
_configure_runtime()
from app.log_redaction import install as _install_redaction
_install_redaction()

def _env(name: str, default: str = "") -> str:
    value = os.getenv(name, default).strip()
    return value or default

def _env_bool(name: str, default: bool) -> bool:
    return _env(name, "true" if default else "false").lower() in {"1", "true", "yes", "on"}

GROQ_API_KEY: str = _env("GROQ_API_KEY")
GROQ_BASE_URL: str = _env("GROQ_BASE_URL", "https://api.groq.com/openai/v1")
# v3.2: основная текстовая модель — reasoning-модель openai/gpt-oss-120b (ответ в message.content,
# рассуждение — отдельным полем message.reasoning; глубина — GROQ_REASONING_EFFORT, по умолчанию low).
GROQ_MODEL: str = _env("GROQ_MODEL", "openai/gpt-oss-120b")
# Optional text model dedicated to tutor hints; empty preserves GROQ_MODEL.
GROQ_TUTOR_MODEL: str = _env("GROQ_TUTOR_MODEL")
GROQ_REASONING_EFFORT: str = (_env("GROQ_REASONING_EFFORT", "low") or "low").lower()

# Independent capabilities: text, images and transcription use different models.
GROQ_VISION_MODEL: str = _env("GROQ_VISION_MODEL", "qwen/qwen3.8-27b")
GROQ_STT_MODEL: str = _env("GROQ_STT_MODEL", "whisper-large-v3-turbo")
GROQ_DEBUG_ERRORS: bool = _env_bool("GROQ_DEBUG_ERRORS", False)

# v2.1: исходящий прокси ТОЛЬКО для Groq (api.groq.com отвечает 403 из части регионов).
# Пример: GROQ_PROXY_URL=http://127.0.0.1:8118 (Privoxy → Tor/VPN/зарубежный хост). Пусто — напрямую.
# Остальные клиенты (СГО, MAX, OCR) прокси не получают: trust_env=False, транспорт задаётся явно.
_PROXY_SCHEMES = frozenset({"http", "https", "socks5", "socks5h"})


def parse_proxy_url(raw: str) -> tuple[str, str]:
    """GROQ_PROXY_URL → (url, error). Ошибка — короткий код без самого адреса и учётных данных."""
    value = (raw or "").strip()
    if not value:
        return "", ""
    if "://" not in value:
        value = "http://" + value  # «127.0.0.1:8118» — частая запись в .env
    from urllib.parse import urlsplit
    try:
        parts = urlsplit(value)
        port = parts.port
    except ValueError:
        return "", "invalid_url"
    scheme = parts.scheme.lower()
    if scheme not in _PROXY_SCHEMES:
        return "", "unsupported_scheme"
    if not parts.hostname:
        return "", "missing_host"
    if parts.path not in ("", "/") or parts.query or parts.fragment:
        return "", "unexpected_path"
    if port is not None and not 0 < port < 65536:
        return "", "invalid_port"
    if scheme.startswith("socks"):
        import importlib.util
        if importlib.util.find_spec("socksio") is None:
            return "", "socks_requires_socksio"
    return value.rstrip("/"), ""


def proxy_label(url: str) -> str:
    """Адрес прокси без логина и пароля — для /api/v1/ai/status и журнала."""
    if not url:
        return ""
    from urllib.parse import urlsplit
    parts = urlsplit(url)
    host = parts.hostname or ""
    if ":" in host:
        host = f"[{host}]"
    return f"{parts.scheme}://{host}" + (f":{parts.port}" if parts.port else "")


GROQ_PROXY_URL, GROQ_PROXY_ERROR = parse_proxy_url(_env("GROQ_PROXY_URL"))
GROQ_PROXY_LABEL: str = proxy_label(GROQ_PROXY_URL)

SFERUM_USE_MOCK: bool = _env_bool("SFERUM_USE_MOCK", True)
SFERUM_DATA_DIR: str = _env("SFERUM_DATA_DIR", "data")

# v2.4 Step 1: общий TEACHER_TOKEN / X-Teacher-Token удалён — учитель подтверждается подписью MAX и
# справочником школы или одноразовым приглашением (app.teacher_invites, scripts/teacher_invites.py).
# Переменная больше ничего не включает; в production её наличие — ошибка конфигурации (fail closed).
LEGACY_TEACHER_TOKEN_PRESENT: bool = bool(_env("TEACHER_TOKEN"))

# Бот MAX (app/bot.py). Токен — только из окружения/.env, в репозиторий не попадает.
MAX_BOT_TOKEN: str = _env("MAX_BOT_TOKEN")
# Срок жизни подписи initData, с. Доки MAX рекомендуют ~1 ч — дефолт 3600.
# Старое значение 21600 (6 ч) давало широкое окно replay; стенду хватало,
# но проду нужен час. Минимум на проверке — 60 с (см. app/max_auth.validate).
MAX_AUTH_MAX_AGE: int = int(_env("MAX_AUTH_MAX_AGE") or 3600)
MAX_REQUIRE_AUTH: bool = _env_bool("MAX_REQUIRE_AUTH", False)  # 1 → API только с валидной подписью initData
# ID пользователей MAX с ролью учителя (через запятую). Если задано — роль teacher
# принимается ТОЛЬКО от проверенной подписи initData с одним из этих ID.
TEACHER_MAX_IDS: frozenset[str] = frozenset(x.strip() for x in _env("TEACHER_MAX_IDS").split(",") if x.strip())
MAX_BOT_NAME: str = _env("MAX_BOT_NAME")            # ник бота для диплинка https://max.ru/<name>?startapp=...
MAX_API_BASE: str = _env("MAX_API_BASE", "https://platform-api2.max.ru")

REQUEST_TIMEOUT_SECONDS: float = float(_env("REQUEST_TIMEOUT_SECONDS", "15"))
PORT: int = int(_env("PORT", "8000"))