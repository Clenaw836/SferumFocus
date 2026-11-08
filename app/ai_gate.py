"""v2.4 · Внутренняя точка контроля внешних ИИ-запросов (решение владельца К1).

Это НЕ внешний «AI Gateway»/прокси и не новый сетевой узел (AGENTS.md п.7 запрещает возвращать
OpenRouter/AI Gateway): это функция внутри процесса, через которую обязан пройти КАЖДЫЙ запрос к
внешнему провайдеру. Единственное место отправки — ``ai_engine._request``; он вызывает ``authorize``
до любого сетевого действия и отправляет только то, что вернул шлюз.

По умолчанию внешний ИИ ВЫКЛЮЧЕН. Наличие ``GROQ_API_KEY`` его НЕ включает. Все сценарии продукта
работают на локальных алгоритмах (сократический шаг, разбор домашки правилами, локальный OCR, банк
вопросов); внешний ИИ — только надстройка, которую владелец включает осознанно.

Десять проверок каждого запроса (раздел 6 брифа):
 1. feature flag        — ``EXTERNAL_AI_ENABLED`` (по умолчанию выключен);
 2. сценарий            — известный, не запрещённый, в списке ``EXTERNAL_AI_SCENARIOS``;
 3. минимизация         — только роли/текст; медиа вырезаются; история тьютора — последние ходы;
 4. чувствительные данные — детекторы-«страховка» (пароли, учётные данные, телефоны, e-mail, СНИЛС,
                          паспорт, карта, ФИО с отчеством, токены); при срабатывании — отказ, а не
                          «маскирование и отправка» (псевдонимизация ≠ анонимизация);
 4b. v3.0 SEC-01 — ``scrub_pii`` (``app.pii_scrubber``): то, что детекторы не считают поводом для отказа
                          (имя с фамилией, «Имя Ф.», @ник, ссылка на профиль, адрес), маскируется метками;
 5. согласие и основание — ``EXTERNAL_AI_LEGAL_BASIS`` (ссылка владельца на правовое основание) и
                          согласие конкретного аккаунта (таблица ``ai_external_consent``);
 6. провайдер           — только официальный адрес Groq и ключ на сервере;
 7. размер              — не больше ``EXTERNAL_AI_MAX_CHARS`` символов текста;
 8. только разрешённое  — наружу уходит минимизированная копия, без полей ``user``/идентификаторов;
 9. ответ               — обрезка длины и управляющих символов (``sanitize_response``);
10. журнал             — только сценарий/решение/причина/размеры и псевдоним субъекта, без текста.

Регулярные выражения НЕ являются основной защитой (их легко обойти и они ошибаются). Основная
защита — выключено по умолчанию + закрытый список сценариев + запрет медиа + минимизация + согласие.
Детекторы — последний рубеж, и при сомнении они блокируют.
"""
from __future__ import annotations

import hashlib
import logging
import os
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any, Callable

logger = logging.getLogger("sferumfocus.ai_gate")

OFFICIAL_PROVIDER_URL = "https://api.groq.com/openai/v1"
CONSENT_POLICY_VERSION = "ai-external-v2"

# Сценарии продукта → тип данных. Медиа (фото, голос) не уходят наружу никогда (К1, без исключений).
SCENARIOS: dict[str, str] = {
    "homework_parse": "text", "tutor_hint": "text", "blitz": "text", "flashcard": "text",
    "quiz_manual": "text", "teacher_quiz": "text",
    "transcribe": "voice", "homework_audio": "voice",
    "ocr": "image", "homework_photo": "image", "quiz_photo": "image",
}
NEVER: frozenset[str] = frozenset(k for k, kind in SCENARIOS.items() if kind != "text")
TEXT_SCENARIOS: frozenset[str] = frozenset(k for k, kind in SCENARIOS.items() if kind == "text")

DEFAULT_MAX_CHARS = 8000
HARD_MAX_CHARS = 20000
TUTOR_HISTORY_MESSAGES = 4         # сократический диалог: последние 2 хода, а не вся переписка
RESPONSE_MAX_CHARS = 6000
_TRUE = {"1", "true", "yes", "on"}


# ------------------------------------------------------------------ настройки (читаются при каждом вызове)
def external_enabled() -> bool:
    """1. Флаг. Ключ провайдера флагом не является."""
    return os.getenv("EXTERNAL_AI_ENABLED", "").strip().lower() in _TRUE


def allowed_scenarios() -> frozenset[str]:
    raw = os.getenv("EXTERNAL_AI_SCENARIOS", "").strip()
    if not raw:
        return TEXT_SCENARIOS
    wanted = {x.strip() for x in raw.split(",") if x.strip()}
    # "tutor" is the operator-facing alias; only the existing tutor_hint
    # text scenario is enabled. Consent and all other gates remain unchanged.
    if "tutor" in wanted:
        wanted.add("tutor_hint")
    return frozenset(wanted & TEXT_SCENARIOS)        # медиа сюда добавить нельзя


def legal_basis() -> str:
    value = os.getenv("EXTERNAL_AI_LEGAL_BASIS", "").strip()[:200]
    # Known demo/placeholder labels are not a legal basis and must not open the provider gate.
    if value.casefold() in {"user_consent_checkbox_hackathon", "todo", "tbd", "placeholder", "test"}:
        return ""
    return value


def max_chars() -> int:
    try:
        value = int(os.getenv("EXTERNAL_AI_MAX_CHARS", str(DEFAULT_MAX_CHARS)))
    except ValueError:
        return DEFAULT_MAX_CHARS
    return max(500, min(value, HARD_MAX_CHARS))


def media_allowed() -> bool:
    """Фото и голос несовершеннолетних наружу не отправляются никогда (К1). Переключателя нет."""
    return False


# ------------------------------------------------------------------ согласие
CONSENT_SCHEMA = ("CREATE TABLE IF NOT EXISTS ai_external_consent(uid TEXT PRIMARY KEY,"
                  " policy_version TEXT NOT NULL, granted_at TEXT NOT NULL)")


def subject_of(rate_key: str) -> str | None:
    """rate_key → uid аккаунта. Песочница жюри — синтетика, внешнего ИИ там нет (К3/Кн2)."""
    key = (rate_key or "").strip()
    if not key or key.startswith("sandbox:") or key == "anon" or key.endswith(":anon"):
        return None
    if key.startswith("teacher:"):
        key = key[len("teacher:"):]
    return key or None


def _store_consent_lookup(uid: str) -> bool:
    from app.platform_auth import store
    with store().tx() as db:
        db.execute(CONSENT_SCHEMA)
        # Legacy product APIs pass the authenticated account's data_key, while consent is
        # stored under the immutable account uid. Resolve the mapping inside the store.
        row = db.execute("SELECT c.policy_version FROM ai_external_consent c "
                         "LEFT JOIN accounts a ON a.uid=c.uid "
                         "WHERE c.uid=? OR a.data_key=? LIMIT 1", (uid, uid)).fetchone()
    return bool(row) and row[0] == CONSENT_POLICY_VERSION


# Точка внедрения для тестов (как CLIENT_FACTORY в других модулях); в работе — таблица платформы.
CONSENT_RESOLVER: Callable[[str], bool] = _store_consent_lookup


def consent_granted(uid: str | None) -> bool:
    if not uid:
        return False
    try:
        return bool(CONSENT_RESOLVER(uid))
    except Exception:                    # noqa: BLE001 — нет хранилища/ошибка → отказ (fail closed)
        return False


def grant(repo: Any, uid: str) -> None:
    from app.sgo_directory import utc
    with repo.tx() as db:
        db.execute(CONSENT_SCHEMA)
        db.execute("INSERT INTO ai_external_consent(uid,policy_version,granted_at) VALUES(?,?,?)"
                   " ON CONFLICT(uid) DO UPDATE SET policy_version=excluded.policy_version, granted_at=excluded.granted_at",
                   (uid, CONSENT_POLICY_VERSION, utc()))


def revoke(repo: Any, uid: str) -> None:
    with repo.tx() as db:
        db.execute(CONSENT_SCHEMA)
        db.execute("DELETE FROM ai_external_consent WHERE uid=?", (uid,))


def consent_state(repo: Any, uid: str) -> dict[str, Any]:
    with repo.tx() as db:
        db.execute(CONSENT_SCHEMA)
        row = db.execute("SELECT policy_version, granted_at FROM ai_external_consent WHERE uid=?", (uid,)).fetchone()
    granted = bool(row) and row[0] == CONSENT_POLICY_VERSION
    return {"granted": granted, "policy_version": CONSENT_POLICY_VERSION, "granted_at": row[1] if granted else None,
            "external_ai_enabled": external_enabled(), "legal_basis_configured": bool(legal_basis()),
            "scenarios": sorted(allowed_scenarios()) if external_enabled() else [],
            "media_forbidden": True}


# ------------------------------------------------------------------ детекторы-«страховка» (не основная защита)
_DETECTORS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("credentials", re.compile(r"(?:парол\w*|password|passwd|pwd|логин|login|токен|token|api[_ -]?key|ключ)\s*[:=]\s*\S+", re.I)),
    ("email", re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")),
    ("phone", re.compile(r"(?<!\d)(?:\+7|8)[\s\-()]*\d{3}[\s\-()]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}(?!\d)")),
    ("snils", re.compile(r"(?<!\d)\d{3}-\d{3}-\d{3}[ -]\d{2}(?!\d)")),
    ("passport", re.compile(r"(?:паспорт\w*|серия)\s*[:№]?\s*\d{2}\s?\d{2}\s*(?:№|номер)?\s*\d{6}", re.I)),
    ("secret_token", re.compile(r"(?<![\w-])[A-Za-z0-9_\-]{32,}(?![\w-])")),
    ("url_with_token", re.compile(r"https?://\S+[?&](?:token|key|sig|auth|session|code)=", re.I)),
    # ФИО: фамилия + имя + отчество (отчество — надёжный признак полного имени человека)
    ("full_name", re.compile(r"\b[А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+(?:ович|евич|ич|овна|евна|ична|инична)\b")),
)


def _luhn_card(text: str) -> bool:
    for match in re.finditer(r"(?<!\d)(?:\d[ -]?){13,19}(?!\d)", text):
        digits = [int(c) for c in match.group() if c.isdigit()]
        if not 13 <= len(digits) <= 19:
            continue
        total = 0
        for i, d in enumerate(reversed(digits)):
            if i % 2 == 1:
                d *= 2
                if d > 9:
                    d -= 9
            total += d
        if total % 10 == 0:
            return True
    return False


def sensitive_findings(text: str) -> list[str]:
    norm = unicodedata.normalize("NFC", text or "")
    found = [name for name, pattern in _DETECTORS if pattern.search(norm)]
    if _luhn_card(norm):
        found.append("bank_card")
    return found


# ------------------------------------------------------------------ решение
@dataclass
class Decision:
    allowed: bool
    reason: str
    scenario: str
    payload: dict[str, Any] | None = None
    max_attempts: int = 1
    chars: int = 0
    findings: list[str] = field(default_factory=list)
    masked: int = 0


def _text_parts(content: Any) -> tuple[list[str], bool]:
    """Текст сообщения и признак медиа (image_url/input_audio/file) в нём."""
    if isinstance(content, str):
        return [content], False
    texts: list[str] = []
    media = False
    if isinstance(content, list):
        for part in content:
            if not isinstance(part, dict):
                continue
            kind = part.get("type")
            if kind == "text" and isinstance(part.get("text"), str):
                texts.append(part["text"])
            elif kind in {"image_url", "input_audio", "file", "image", "audio"}:
                media = True
    return texts, media


def minimize(scenario: str, payload: dict[str, Any]) -> tuple[dict[str, Any] | None, int, str | None]:
    """3 + 8. Копия только с разрешёнными полями: модель, параметры генерации, роли и ТЕКСТ.
    Медиа → отказ (media_forbidden), а не тихое вырезание: иначе модель отвечала бы «про картинку»."""
    messages = payload.get("messages")
    if not isinstance(messages, list) or not messages:
        return None, 0, "invalid_payload"
    out: list[dict[str, str]] = []
    for message in messages:
        if not isinstance(message, dict) or message.get("role") not in {"system", "user", "assistant"}:
            return None, 0, "invalid_payload"
        texts, media = _text_parts(message.get("content"))
        if media:
            return None, 0, "media_forbidden"
        out.append({"role": str(message["role"]), "content": "\n".join(texts)})
    if scenario == "tutor_hint":
        system = [m for m in out if m["role"] == "system"][:1]
        dialog = [m for m in out if m["role"] != "system"]
        out = system + dialog[-(TUTOR_HISTORY_MESSAGES + 1):]   # история + текущий вопрос
    keep = {k: payload[k] for k in ("model", "temperature", "max_completion_tokens", "response_format", "reasoning_effort") if k in payload}
    chars = sum(len(m["content"]) for m in out)
    return {**keep, "messages": out}, chars, None


def scrub_messages(payload: dict[str, Any]) -> tuple[dict[str, Any], int]:
    """4b. v3.0 SEC-01 / L-79: ``scrub_pii`` для каждого НЕсистемного сообщения минимизированной копии.

    Детекторы (шаг 4) уже отказали бы на явных ПДн; маскирование ловит остальное (имя с фамилией без
    отчества, «Имя Ф.», @ник, ссылку на профиль, адрес). Системный промпт — наш текст, его не трогаем."""
    from app.pii_scrubber import scrub
    masked = 0
    out: list[dict[str, str]] = []
    for message in payload.get("messages", []):
        if message.get("role") == "system":
            out.append(dict(message))
            continue
        result = scrub(message.get("content", ""))
        masked += result.total
        out.append({**message, "content": result.text})
    return {**payload, "messages": out}, masked


def provider_ok(base_url: str, api_key: str) -> str | None:
    if not api_key:
        return "no_key"
    if base_url.rstrip("/") != OFFICIAL_PROVIDER_URL:
        return "provider_not_allowed"
    return None


def authorize(*, endpoint: str, feature: str, rate_key: str, payload: dict[str, Any] | None,
              base_url: str, api_key: str) -> Decision:
    """Десять проверок до любого сетевого действия. Отказ → вызывающий код даёт локальный результат."""
    scenario = feature if feature in SCENARIOS else "unknown"
    if endpoint == "audio/transcriptions":
        scenario = "transcribe"

    def deny(reason: str, **extra: Any) -> Decision:
        decision = Decision(False, reason, scenario, **extra)
        _log(decision, rate_key)
        return decision

    if not external_enabled():                                              # 1
        return deny("flag_off")
    if scenario == "unknown":                                               # 2
        return deny("scenario_unknown")
    if scenario in NEVER and not media_allowed():                            # фото/голос — никогда
        return deny("media_forbidden")
    if scenario not in allowed_scenarios():
        return deny("scenario_not_allowed")
    if payload is None:                                                     # только чат с текстом
        return deny("media_forbidden")
    minimized, chars, problem = minimize(scenario, payload)                 # 3 + 8
    if problem:
        return deny(problem)
    assert minimized is not None
    texts = [m["content"] for m in minimized["messages"] if m["role"] != "system"]
    findings = sorted({f for t in texts for f in sensitive_findings(t)})    # 4
    subject = subject_of(rate_key)
    # The account id must not leave the process: neither "max:123456789" nor its bare number.
    needles = {n for n in ((subject or ""), (subject or "").rsplit(":", 1)[-1]) if len(n) >= 6}
    if any(n in t for n in needles for t in texts):
        findings.append("raw_identifier")
    if findings:
        return deny("sensitive_data", findings=findings, chars=chars)
    minimized, masked = scrub_messages(minimized)                           # 4b · v3.0 SEC-01: scrub_pii
    if not legal_basis():                                                   # 5
        return deny("legal_basis_missing", chars=chars)
    if not consent_granted(subject):
        return deny("consent_missing", chars=chars)
    problem = provider_ok(base_url, api_key)                                # 6
    if problem:
        return deny(problem, chars=chars)
    if chars > max_chars():                                                 # 7
        return deny("too_large", chars=chars)
    decision = Decision(True, "allowed", scenario, payload=minimized, max_attempts=1, chars=chars, masked=masked)
    _log(decision, rate_key)                                                # 10
    return decision


_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def sanitize_response(text: Any) -> str:
    """9. Ответ модели — недоверенные данные: строка, без управляющих символов, ограниченной длины."""
    value = text if isinstance(text, str) else ""
    return _CONTROL.sub("", value)[:RESPONSE_MAX_CHARS]


def pseudonym(rate_key: str) -> str:
    """Псевдоним субъекта для журнала. Это псевдонимизация, а НЕ анонимизация."""
    subject = subject_of(rate_key) or "none"
    return hashlib.sha256(("ai-gate:" + subject).encode()).hexdigest()[:10]


def _log(decision: Decision, rate_key: str) -> None:
    """10. Только метаданные: сценарий, решение, причина, размер, типы находок. Никакого текста."""
    logger.info("ai_gate scenario=%s allowed=%s reason=%s chars=%d findings=%s masked=%d subject=%s",
                decision.scenario, decision.allowed, decision.reason, decision.chars,
                ",".join(decision.findings) or "-", decision.masked, pseudonym(rate_key))