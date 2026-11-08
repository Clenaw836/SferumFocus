"""Нативный клиент «Сетевого Города. Образование» (NetSchool / ИРТех), v4.

Один протокол на все региональные порталы; различия узлов описываются metadata узла и автоопределением:

  * префикс API: /webapi (большинство), /api, /asp/api — первый 404 на непиннингованном узле перебирает
    варианты, найденный запоминается на процесс и (адаптером) в sgo_hosts_registry;
  * кодировка MD5-хеша пароля: cp1251 (веб-клиент СГО) — по умолчанию; UTF-8 — только для паролей, которые
    в cp1251 не кодируются, по metadata.password_encoding или как ОДИН страхующий повтор;
  * регистр полей формы входа (metadata.form_case): browser (по умолчанию: loginType/UN/pw/pw2 — как Angular),
    lower (un/pw), upper (LoginType/UN/PW);
  * страница прогрева сессии (metadata.warmup_path, по умолчанию /authorize): даёт NSSESSIONID/балансировщику
    cookie до запроса соли; отсутствие страницы (404) запоминается и больше не запрашивается;
  * отключённый школьный вход (logindata.schoolLogin=false) — пароль не отправляется вообще.

Цепочка входа: GET /authorize → GET /webapi/logindata → POST /webapi/auth/getdata → POST /webapi/login.
Гибридная кодировка: pw2 = md5(salt + md5(пароль в cp1251)), pw = pw2[:len(пароль)]; само тело формы —
application/x-www-form-urlencoded в UTF-8 (так отправляет Angular-клиент).

Транспорт: httpx.AsyncClient (таймаут 30 с, trust_env=False, без авто-редиректов). Для сетевого соединения
используется проверенный публичный IP; исходное имя сохраняется в Host и TLS SNI для проверки сертификата.
Пароль не сохраняется, не логируется и не попадает в исключения.
"""
from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import json
import os
import socket
import re
import time
from datetime import date, datetime, timedelta, timezone
from http.cookiejar import Cookie
from typing import Any
from urllib.parse import urlencode, urlsplit

import httpx

from app.diary_providers import (DiarySnapshot, Grade, ProviderUnavailable, ReauthRequired, portal_origin,
                                 portal_tls_context)
from app.sgo_directory import PARAMS


class SgoAuthRejected(ValueError):
    pass


class SgoUnsupported(ValueError):
    pass


class SgoPasswordUnsupported(SgoAuthRejected):
    """Пароль нельзя закодировать так, как ждёт сервер школы (например, эмодзи при кодировке cp1251)."""


# ------------------------------------------------------------------ транспорт
BROWSER_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
              "Chrome/129.0.0.0 Safari/537.36")
REQUEST_TIMEOUT = httpx.Timeout(30.0, connect=15.0)
DNS_TIMEOUT = 10.0
MAX_BODY = 2 * 1024 * 1024
MAX_PAGE_REDIRECTS = 3
SAFE_READ_ATTEMPTS = 3
SAFE_READ_RETRY_DELAY = 1.0
# A POST may already have reached the portal even when the response is lost.
# Never replay authentication, challenges, logout or writes automatically.
SAFE_READ_PATHS = frozenset({"/student/diary/init", "/Context", "/years/current",
                             "/grade/assignment/types", "/student/diary", "/announcements"})
API_PREFIXES = ("/webapi", "/api", "/asp/api")
_PREFIX_SEEN: dict[str, str] = {}
_PREFIX_SEEN_MAX = 5000
_WARMUP_MISSING: dict[str, float] = {}
_WARMUP_TTL = 6 * 3600


def browser_headers(origin: str) -> dict[str, str]:
    return {"User-Agent": BROWSER_UA, "Accept": "application/json, text/plain, */*",
            "Accept-Language": "ru-RU,ru;q=0.9", "Origin": origin, "Referer": origin + "/",
            "X-Requested-With": "XMLHttpRequest"}


def _jsonish(response: httpx.Response, body: bytes) -> bool:
    if not 200 <= response.status_code < 300:
        return False
    if not body:
        return True
    try:
        json.loads(body)
        return True
    except (ValueError, UnicodeError):
        return False


def _host_key(host: dict[str, Any], origin: str) -> str:
    return str(host.get("host_id") or origin)


async def assert_public_host(hostname: str) -> list[str]:
    """Вернуть только проверенные адреса для соединения без повторного DNS-разрешения."""
    try:
        infos = await asyncio.wait_for(
            asyncio.to_thread(socket.getaddrinfo, hostname, 443, type=socket.SOCK_STREAM), timeout=DNS_TIMEOUT)
    except (OSError, TimeoutError) as exc:
        raise ProviderUnavailable("Адрес портала СГО не разрешается") from exc
    addresses = sorted({x[4][0] for x in infos})
    if not addresses:
        raise SgoUnsupported("Непубличный адрес портала заблокирован")
    for address in addresses:
        try:
            # Scoped addresses are not needed for publicly routed school portals.
            if "%" in address or not ipaddress.ip_address(address).is_global:
                raise SgoUnsupported("Непубличный адрес портала заблокирован")
        except ValueError:
            raise SgoUnsupported("Непубличный адрес портала заблокирован") from None
    # IPv4 first for hosts advertising IPv6 without a usable IPv6 route.
    return sorted(addresses, key=lambda a: (ipaddress.ip_address(a).version, a))


def _emulator_target(host: dict[str, Any]) -> str | None:
    """Локальный эмулятор СГО для test/demo — только 127.0.0.1 по http и только узел local-emulator."""
    fixture = os.getenv("SFERUM_SGO_EMULATOR_URL", "")
    if not fixture or host.get("host_id") != "local-emulator" or os.getenv("SFERUM_ENV") not in {"test", "demo"}:
        return None
    u = urlsplit(fixture)
    if u.scheme != "http" or u.hostname != "127.0.0.1" or not u.port or u.path or u.query or u.fragment:
        raise SgoUnsupported("Invalid emulator address")
    return fixture


class SgoHTTP:
    """HTTP-сессия одного входа: cookie-jar узла + токен at. Не хранит пароль."""

    def __init__(self, host: dict[str, Any], cookies: list[dict] | None = None,
                 client: httpx.AsyncClient | None = None) -> None:
        self.host = host
        self.origin = portal_origin(host["base_url"])
        self.hostname = urlsplit(self.origin).hostname or ""
        self.cookies = httpx.Cookies()
        self.client = client
        self.discovered_prefix: str | None = None
        for c in cookies or []:
            domain = str(c.get("domain", "")).lstrip(".")
            # Cookie чужого сервера в сохранённой сессии — признак подмены: вход не продолжаем.
            if not domain or not (self.hostname == domain or self.hostname.endswith("." + domain)):
                raise SgoUnsupported("Cookie принадлежит другому серверу")
            expires = c.get("expires")
            if expires is not None and expires <= time.time():
                continue
            self.cookies.jar.set_cookie(Cookie(
                0, c["name"], c["value"], None, False, c["domain"], True, c["domain"].startswith("."),
                c.get("path", "/"), True, bool(c.get("secure", False)), expires, expires is None, None, None, {}, False))

    # ---------------------------------------------------------- cookies / token
    def export_cookies(self) -> list[dict]:
        return [{"name": c.name, "value": c.value, "domain": c.domain, "path": c.path, "expires": c.expires,
                 "secure": c.secure} for c in self.cookies.jar if not c.is_expired()]

    def has_cookie(self, name: str) -> bool:
        return any(c.name == name for c in self.cookies.jar)

    def remember_token(self, token: str) -> None:
        """Часть региональных WAF сверяет токен at и в заголовке, и в cookie (так делает веб-клиент)."""
        if (self.host.get("metadata") or {}).get("at_cookie") is False or self.has_cookie("at"):
            return
        self.cookies.jar.set_cookie(Cookie(
            0, "at", token, None, False, self.hostname, False, False, "/", True,
            self.origin.startswith("https://"), None, True, None, None, {}, False))

    # ---------------------------------------------------------- API prefix
    def _prefix(self) -> tuple[str, bool]:
        prefix = self.host.get("api_prefix", "/webapi")
        if prefix is None:
            prefix = "/webapi"
        if (prefix and not prefix.startswith("/")) or any(x in prefix for x in ["//", "\\", "?", "#", ".."]):
            raise SgoUnsupported("Некорректный API prefix")
        pinned = bool((self.host.get("metadata") or {}).get("api_prefix_pinned")) or prefix not in API_PREFIXES
        if pinned:
            return prefix, False
        seen = _PREFIX_SEEN.get(_host_key(self.host, self.origin))
        return (seen, False) if seen else (prefix, True)

    def _confirm(self, prefix: str, discovered: bool = False) -> None:
        key = _host_key(self.host, self.origin)
        if len(_PREFIX_SEEN) >= _PREFIX_SEEN_MAX and key not in _PREFIX_SEEN:
            _PREFIX_SEEN.clear()
        _PREFIX_SEEN[key] = prefix
        if discovered:
            self.discovered_prefix = prefix

    # ---------------------------------------------------------- wire
    async def _wire(self, request: httpx.Request) -> tuple[httpx.Response, bytes]:
        """Один запрос без редиректов, тело не больше MAX_BODY. Cookie ответа попадают в jar."""
        fixture = _emulator_target(self.host) if self.client is None else None
        original_url = request.url
        if (request.url.scheme != "https" or request.url.host != self.hostname
                or request.url.port not in {None, 443}):
            raise SgoUnsupported("Запрос направлен за пределы портала СГО")
        if fixture:
            target = httpx.URL(fixture + request.url.raw_path.decode("ascii"))
            request = httpx.Request(request.method, target, headers=request.headers, content=request.content)
        elif self.client is None:
            # Resolve once, reject mixed private/public records, connect to exactly a checked address.
            # Keep original Host and SNI, so TLS still authenticates the school hostname.
            addresses = await assert_public_host(self.hostname)
            request.url = request.url.copy_with(host=addresses[0])
            request.extensions["sni_hostname"] = self.hostname

        async def read(client: httpx.AsyncClient) -> tuple[httpx.Response, bytes]:
            response = await client.send(request, stream=True, follow_redirects=False)
            try:
                body = bytearray()
                async for part in response.aiter_bytes():
                    body.extend(part)
                    if len(body) > MAX_BODY:
                        raise ProviderUnavailable("Ответ СГО слишком большой")
            finally:
                await response.aclose()
            return response, bytes(body)

        try:
            if self.client is not None:
                response, body = await read(self.client)
            else:
                async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT, follow_redirects=False, trust_env=False,
                                             verify=portal_tls_context()) as client:
                    response, body = await read(client)
        finally:
            # Cookie policies and redirect metadata use the original hostname, not the pinned IP.
            request.url = original_url
        self.cookies.extract_cookies(response)
        return response, body

    async def _send(self, method: str, prefix: str, path: str, *, data: Any = None, params: Any = None,
                    headers: dict | None = None, json_body: Any = None,
                    content: bytes | None = None) -> tuple[httpx.Response, bytes]:
        url = self.origin + prefix.rstrip("/") + path
        safe_read = method.upper() == "GET" and (path in SAFE_READ_PATHS or
                    re.fullmatch(r"/student/diary/assigns/[0-9]+", path) is not None)
        attempts = SAFE_READ_ATTEMPTS if safe_read else 1
        for attempt in range(attempts):
            # Rebuild the request for every try: a streamed request is not safely reusable.
            request = httpx.Request(method, url, data=data, json=json_body, content=content, params=params,
                                    headers={**browser_headers(self.origin), **(headers or {})}, cookies=self.cookies)
            try:
                return await self._wire(request)
            except httpx.TransportError:
                if attempt + 1 == attempts:
                    raise
                await asyncio.sleep(SAFE_READ_RETRY_DELAY)
        raise AssertionError("unreachable")

    async def request(self, method: str, path: str, *, data: Any = None, params: Any = None,
                      headers: dict | None = None, optional: bool = False, empty_ok: bool = False,
                      json_body: Any = None, content: bytes | None = None) -> Any:
        if not path.startswith("/") or path.startswith("//") or any(x in path for x in ["\\", "?", "#"]):
            raise SgoUnsupported("Некорректный endpoint")
        prefix, probe = self._prefix()
        response, body = await self._send(method, prefix, path, data=data, params=params, headers=headers,
                                          json_body=json_body, content=content)
        if probe and response.status_code == 404:
            for alt in API_PREFIXES:
                if alt == prefix:
                    continue
                again, again_body = await self._send(method, alt, path, data=data, params=params, headers=headers,
                                                     json_body=json_body, content=content)
                if again.status_code == 404:
                    continue
                if _jsonish(again, again_body):
                    self._confirm(alt, discovered=True)
                response, body = again, again_body
                break
        elif probe and _jsonish(response, body):
            self._confirm(prefix)
        status = response.status_code
        if empty_ok and status in {200, 204} and not body:
            return {}
        if status in {404, 405} and optional:
            return None
        if status in {401, 403}:
            raise ReauthRequired()
        if status in {400, 409, 422}:
            raise SgoAuthRejected("СГО отклонил данные входа; проверь логин, пароль и доступный способ авторизации")
        if status == 429:
            raise SgoAuthRejected("СГО ограничил попытки; повтори вход позже")
        if 300 <= status < 400:
            raise SgoUnsupported("СГО требует вход на региональном портале; перенаправление не выполнялось")
        if status != 200:
            raise ProviderUnavailable("СГО временно недоступен")
        if not body and empty_ok:
            return {}
        try:
            return json.loads(body)
        except (ValueError, UnicodeError):
            raise ProviderUnavailable("СГО вернул несовместимый формат") from None

    async def warmup(self, path: str = "/authorize") -> int | None:
        """GET страницы портала (не API) ради cookie сессии/балансировщика. Лучшее усилие: ошибки не фатальны.
        Редиректы — только внутри origin узла и не больше трёх. Возвращает HTTP-статус или None."""
        if not path.startswith("/") or path.startswith("//") or any(x in path for x in ["\\", "?", "#", ".."]):
            raise SgoUnsupported("Некорректный путь страницы")
        key = _host_key(self.host, self.origin) + path
        missing = _WARMUP_MISSING.get(key)
        if missing and time.time() - missing < _WARMUP_TTL:
            return None
        url = self.origin + path
        headers = {**browser_headers(self.origin), "Accept": "text/html,application/xhtml+xml,*/*;q=0.8"}
        headers.pop("X-Requested-With", None)
        headers.pop("Origin", None)
        status = None
        try:
            for _ in range(MAX_PAGE_REDIRECTS + 1):
                response, _body = await self._wire(httpx.Request("GET", url, headers=headers, cookies=self.cookies))
                status = response.status_code
                if status in {301, 302, 303, 307, 308} and response.headers.get("location"):
                    nxt = httpx.URL(url).join(response.headers["location"])
                    if f"{nxt.scheme}://{nxt.host}" != self.origin:
                        break   # редирект на ЕСИА/чужой домен не выполняем
                    url = str(nxt)
                    continue
                break
        except (httpx.HTTPError, OSError, TimeoutError, ProviderUnavailable):
            return None
        if status == 404:
            if len(_WARMUP_MISSING) > 5000:
                _WARMUP_MISSING.clear()
            _WARMUP_MISSING[key] = time.time()
        return status


# ------------------------------------------------------------------ пароль
def password_hash(password: str, salt: str, encoding: str = "cp1251") -> tuple[str, str]:
    """Гибридная схема NetSchool: pw2 = md5(salt + md5(пароль в encoding)); pw — маска pw2[:len(пароль)]."""
    if encoding not in {"utf-8", "cp1251"}:
        raise SgoUnsupported("Неподдерживаемая кодировка")
    try:
        encoded = password.encode(encoding, errors="strict")
    except UnicodeError:
        raise SgoPasswordUnsupported("Пароль содержит символы, не поддерживаемые кодировкой этого сервера") from None
    inner = hashlib.md5(encoded).hexdigest()
    full = hashlib.md5((salt + inner).encode("utf-8")).hexdigest()
    return full[:len(password)], full


# Порядок кодировок хеша (password_encodings):
#  * metadata.password_encoding узла → только она;
#  * ASCII-пароль → cp1251 (байты те же, что в UTF-8);
#  * пароль не кодируется в cp1251 (эмодзи и т.п.) → сразу UTF-8;
#  * не-ASCII пароль, кодировка узла неизвестна → cp1251, при отказе — ОДИН повтор в UTF-8; удачная запоминается.
_ENCODING_SEEN: dict[str, str] = {}


def password_encodings(password: str, host: dict[str, Any]) -> list[str]:
    pinned = (host.get("metadata") or {}).get("password_encoding")
    if pinned in {"utf-8", "cp1251"}:
        return [pinned]
    if password.isascii():
        return ["cp1251"]
    try:
        password.encode("cp1251", errors="strict")
    except UnicodeError:
        return ["utf-8"]
    seen = _ENCODING_SEEN.get(str(host.get("host_id") or host.get("base_url")))
    if seen == "utf-8":
        return ["utf-8", "cp1251"]
    return ["cp1251", "utf-8"]


def remember_encoding(host: dict[str, Any], encoding: str) -> None:
    if len(_ENCODING_SEEN) > 5000:
        _ENCODING_SEEN.clear()
    _ENCODING_SEEN[str(host.get("host_id") or host.get("base_url"))] = encoding


MAX_LOGIN_ATTEMPTS = 2


def login_attempts(login: str, password: str, host: dict[str, Any]) -> list[tuple[str, str]]:
    """Логин неизменен при каждой попытке; меняется только кодировка хеша пароля."""
    return [(login, enc) for enc in password_encodings(password, host)[:MAX_LOGIN_ATTEMPTS]]


FORM_CASES = {
    "browser": {"loginType": "loginType", "un": "UN", "pw": "pw", "pw2": "pw2"},
    "lower": {"loginType": "loginType", "un": "un", "pw": "pw", "pw2": "pw2"},
    "upper": {"loginType": "LoginType", "un": "UN", "pw": "PW", "pw2": "pw2"},
}


def encode_form(fields: dict[str, str] | list[tuple[str, str]], encoding: str = "utf-8") -> tuple[bytes, str]:
    """Default UTF-8; legacy form encoding is permitted only when explicitly configured for a portal."""
    if encoding not in {"utf-8", "cp1251"}:
        raise SgoUnsupported("Неподдерживаемая кодировка формы")
    try:
        body = urlencode(fields, encoding=encoding, errors="strict").encode("ascii")
    except UnicodeEncodeError:
        raise SgoUnsupported("Логин содержит символы, не поддерживаемые кодировкой формы") from None
    charset = "UTF-8" if encoding == "utf-8" else "windows-1251"
    return body, "application/x-www-form-urlencoded; charset=" + charset


def login_form(params: dict[str, str], login: str, pw: str, pw2: str, lt: str, ver: str,
               form_case: str | None = None, form_encoding: str = "utf-8") -> bytes:
    """По умолчанию UTF-8; cp1251 только по явной настройке конкретного портала."""
    names = FORM_CASES.get(form_case or "browser", FORM_CASES["browser"])
    fields: list[tuple[str, str]] = [(names["loginType"], "1")]
    fields += [(k, str(params[k])) for k in PARAMS if params.get(k) not in (None, "")]
    fields += [(names["un"], login), (names["pw"], pw), (names["pw2"], pw2), ("lt", str(lt)), ("ver", str(ver))]
    return encode_form(fields, form_encoding)[0]


FORM_HEADERS = {"Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"}


def school_login_params(school: dict[str, Any]) -> dict[str, str]:
    raw = school.get("login_params") or {k: school[k] for k in PARAMS if school.get(k) is not None}
    return {k: str(v) for k, v in raw.items() if k in PARAMS and v is not None}


# ------------------------------------------------------------------ клиент
class NetSchoolClient:
    def __init__(self, host: dict[str, Any], client: httpx.AsyncClient | None = None) -> None:
        self.host = host
        self.client = client

    @property
    def metadata(self) -> dict[str, Any]:
        return self.host.get("metadata") or {}

    def http(self, session: dict | None = None) -> SgoHTTP:
        return SgoHTTP(self.host, (session or {}).get("cookies"), self.client)

    # ---------------------------------------------------------- вход
    async def login(self, school, login, password, student_id=None, role='student'):
        from app.sgo_auth_diagnostics import AuthDiagnostics
        diagnostic = AuthDiagnostics()
        h, session, login_result = await self.authenticate(school, login, password, diagnostic=diagnostic)
        from app.sgo_adapter import detect_roles, SGOTeacherStrategy, Ctx
        detected = detect_roles(login_result)
        if not detected:
            try:
                context = await h.request("GET", "/Context", headers={"at": session["access_token"]}, optional=True)
            except (ReauthRequired, ProviderUnavailable):
                context = None
            detected = detect_roles(context) if isinstance(context, dict) else set()
            if isinstance(context, dict) and isinstance(context.get("user"), dict):
                detected |= detect_roles(context["user"])
        if "teacher" in detected:
            role = "teacher"
        session.update(role=role, is_teacher=role == "teacher", teacher_verified="teacher" in detected)
        if role == 'teacher':
            await SGOTeacherStrategy().verify(Ctx(self, h, session, login_result, school, self.host, student_id))
            context = await h.request("GET", "/Context", headers={"at": session["access_token"]}, optional=True)
            if isinstance(context, dict):
                session["student_id"] = 0
                session["student_name"] = str(context.get("userName") or "Учитель")
                session["class_name"] = "Учитель"
                session["year_id"] = context.get("schoolYearId") or context.get("yearId") or 1
            else:
                session["student_id"] = 0
                session["student_name"] = "Учитель"
                session["class_name"] = "Учитель"
                session["year_id"] = 1
            diagnostic.record("initialize", "ok")
            snapshot = DiarySnapshot(role="teacher", is_teacher=True, tasks=[], lessons=[], days={}, bell_schedule_present=False, breaks={}, synced_at=datetime.now(timezone.utc).isoformat(), grades=[], school_date=date.today().isoformat(), school_name=str(school.get("name", "")), grade="")
            diagnostic.record("snapshot", "ok")
            diagnostic.record("complete", "ok")
            return session, snapshot
        else:
            await self._initialize(h, session, student_id)
            diagnostic.record("initialize", "ok")
            snapshot = await self.fetch(session, http=h, school=school)
            diagnostic.record("snapshot", "ok")
            diagnostic.record("complete", "ok")
            return session, snapshot

    async def capabilities(self, h: SgoHTTP | None = None) -> dict[str, Any]:
        """Публичные возможности узла (GET /logindata): школьный вход, ЕСИА, версия. Без учётных данных."""
        h = h or SgoHTTP(self.host, client=self.client)
        doc = await h.request("GET", "/logindata", optional=True)
        doc = doc if isinstance(doc, dict) else {}
        school_login = doc.get("schoolLogin")
        esia = any(doc.get(k) is True for k in ("esiaLogin", "esiaButton", "esiaMainAuth"))
        version = doc.get("version") if isinstance(doc.get("version"), str) and len(doc["version"]) <= 40 else None
        return {"school_login": school_login if type(school_login) is bool else None,
                "esia_advertised": esia, "esia_main": doc.get("esiaMainAuth") is True,
                "version": version, "raw_known": bool(doc)}

    async def authenticate(self, school, login, password, diagnostic=None):
        """Только вход: /authorize → /logindata → /auth/getdata → /login. Возвращает (http, session, ответ /login
        без токенов). Пароль не сохраняется и не логируется; роль аккаунта проверяют стратегии sgo_adapter."""
        from app.sgo_auth_diagnostics import AuthDiagnostics
        diagnostic = diagnostic or AuthDiagnostics()
        diagnostic.record("start", "begin")
        if not isinstance(password, str) or not password:
            raise SgoAuthRejected("Неверные данные входа или прямой вход отключён")
        h = SgoHTTP(self.host, client=self.client)
        warmup_path = self.metadata.get("warmup_path", "/authorize")
        if warmup_path:
            await h.warmup(str(warmup_path))
        diagnostic.record("warmup", "ok")
        capabilities = await h.request("GET", "/logindata", optional=True)
        if isinstance(capabilities, dict) and capabilities.get("schoolLogin") is False:
            diagnostic.record("capabilities", "disabled")
            raise SgoUnsupported("Региональный портал отключил вход по школьному логину и паролю; "
                                 "используйте официальный доступный способ входа")
        diagnostic.record("capabilities", "ok")
        params = school_login_params(school)
        form_case = self.metadata.get("form_case")
        plan = login_attempts(login, password, self.host)
        result = None
        for attempt, (account, encoding) in enumerate(plan):
            last = attempt + 1 >= len(plan)
            # Новая соль и lt на каждую попытку: они одноразовые и привязаны к NSSESSIONID.
            meta = await h.request("POST", "/auth/getdata", content=b"", headers=FORM_HEADERS)
            if (not isinstance(meta, dict) or not all(k in meta for k in ("salt", "lt", "ver"))
                    or not isinstance(meta["salt"], str) or len(meta["salt"]) > 512):
                raise ProviderUnavailable("Неверные параметры входа СГО")
            diagnostic.record("challenge", "ok")
            pw, pw2 = password_hash(password, meta["salt"], encoding)
            form_encoding = self.metadata.get("form_encoding", "utf-8")
            body = login_form(params, account, pw, pw2, str(meta["lt"]), str(meta["ver"]), form_case, form_encoding)
            _, content_type = encode_form([], form_encoding)
            diagnostic.record("authenticate", "begin")
            try:
                result = await h.request("POST", "/login", content=body, headers={"Content-Type": content_type})
            except SgoAuthRejected as exc:
                limited = "огранич" in str(exc)
                if limited:
                    # 429 / «ограничил попытки» — никогда не повторяем: прямой путь к блокировке аккаунта.
                    diagnostic.record("authenticate", "rejected")
                    raise
                if not last:
                    diagnostic.record("authenticate", "retry_variant")
                    continue
                diagnostic.record("authenticate", "rejected")
                raise SgoAuthRejected("Неверные данные входа или прямой вход отключён") from None
            except ReauthRequired:
                if not last:
                    diagnostic.record("authenticate", "retry_variant")
                    continue
                diagnostic.record("authenticate", "rejected")
                raise SgoAuthRejected("Неверные данные входа или прямой вход отключён") from None
            if encoding != "cp1251" or any(enc != encoding for _, enc in plan):
                remember_encoding(self.host, encoding)
            break
        token = None
        if isinstance(result, dict):
            token = result.get("at") if isinstance(result.get("at"), str) else result.get("accessToken")
        if not isinstance(token, str) or not 1 <= len(token) <= 8192:
            raise SgoAuthRejected("СГО не подтвердил вход; возможно, нужен другой способ авторизации")
        h.remember_token(token)
        session = {"protocol": "netschool-native-v1", "host_id": self.host["host_id"], "access_token": token,
                   "cookies": h.export_cookies()}
        diagnostic.record("authenticate", "ok")
        return h, session, {k: v for k, v in result.items() if k not in {"at", "accessToken", "refreshToken"}}

    async def logout(self, session):
        h = SgoHTTP(self.host, session.get("cookies"), self.client)
        await h.request("POST", "/auth/logout", headers={"at": session["access_token"]}, empty_ok=True)

    # ---------------------------------------------------------- контекст ученика
    async def _initialize(self, h, session, student_id=None):
        headers = {"at": session["access_token"]}
        init = await h.request("GET", "/student/diary/init", headers=headers)
        students = init.get("students", []) if isinstance(init, dict) else []
        if not isinstance(students, list) or not students:
            raise SgoUnsupported("У аккаунта нет доступного дневника ученика")
        current = student_id if student_id is not None else init.get("currentStudentId")
        choices = [s for s in students if isinstance(s, dict) and str(s.get("studentId")) == str(current)]
        if not choices and student_id is None and type(current) is int and 0 <= current < len(students):
            choices = [students[current]]
        if not choices and len(students) == 1 and student_id is None:
            choices = students
        if len(choices) != 1:
            raise SgoUnsupported("Нужен однозначный выбор ребёнка в аккаунте СГО; автоматический выбор не выполнен")
        student = choices[0]
        session["student_id"] = int(student["studentId"])
        session["student_name"] = str(student.get("nickName") or student.get("name") or "")[:200]
        session["class_name"] = str(student.get("className") or init.get("className") or "")[:30]
        # ID учебного года провайдера — не календарный год: сначала контракт diary/init.
        year = init.get("schoolYearId", init.get("yearId"))
        if year is None and isinstance(init.get("schoolYear"), dict):
            year = init["schoolYear"].get("id")
        context = await h.request("GET", "/Context", headers=headers, optional=True)
        if year is None and isinstance(context, dict):
            year = context.get("schoolYearId", context.get("yearId"))
        if year is None:
            current_year = await h.request("GET", "/years/current", headers=headers)
            year = current_year.get("id") if isinstance(current_year, dict) else None
        if type(year) is not int or year <= 0:
            raise ProviderUnavailable("Учебный год не определён")
        provider_school_id = context.get("schoolId") if isinstance(context, dict) else None
        if provider_school_id is None:
            provider_school_id = student.get("schoolId")
        if type(provider_school_id) is int:
            session["provider_school_id"] = provider_school_id
        session["year_id"] = year
        types = await h.request("GET", "/grade/assignment/types", headers=headers, params={"all": "false"},
                                optional=True)
        session["assignment_types"] = ({str(t["id"]): str(t["name"])[:200] for t in types
                                        if isinstance(t, dict) and "id" in t and "name" in t}
                                       if isinstance(types, list) else {})
        session["cookies"] = h.export_cookies()

    async def keep_alive(self, session, http=None, now=None):
        now = time.time() if now is None else now
        if now - session.get("last_keep_alive", 0) < 480:
            return False
        h = http or SgoHTTP(self.host, session.get("cookies"), self.client)
        context = await h.request("GET", "/Context", headers={"at": session["access_token"]}, optional=True)
        if context is None:
            await h.request("GET", "/student/diary/init", headers={"at": session["access_token"]})
        session["cookies"] = h.export_cookies()
        session["last_keep_alive"] = now
        return True

    # ---------------------------------------------------------- сырые недели дневника
    async def _week(self, h, session, start: date) -> list[dict]:
        raw = await h.request("GET", "/student/diary", headers={"at": session["access_token"]},
                              params={"studentId": session["student_id"], "yearId": session["year_id"],
                                      "weekStart": start.isoformat(),
                                      "weekEnd": (start + timedelta(days=6)).isoformat(),
                                      "withLaAssigns": "true"})
        if not isinstance(raw, dict) or not isinstance(raw.get("weekDays"), list):
            raise ProviderUnavailable("Несовместимая схема дневника")
        return [wd for wd in raw["weekDays"][:7] if isinstance(wd, dict)]

    async def _week_days(self, h, session, start: date, end: date, max_weeks: int) -> list[dict]:
        if end < start:
            raise ValueError("Конец периода раньше начала")
        if not session.get("student_id") or not session.get("year_id"):
            await self._initialize(h, session)
        monday = start - timedelta(days=start.weekday())
        weeks = 0
        out: list[dict] = []
        while monday <= end:
            weeks += 1
            if weeks > max_weeks:
                raise ValueError("Период больше " + str(max_weeks) + " недель")
            out.extend(await self._week(h, session, monday))
            monday += timedelta(days=7)
        session["cookies"] = h.export_cookies()
        return out

    async def fetch(self, session, *, http=None, school=None, day=None):
        h = http or SgoHTTP(self.host, session.get("cookies"), self.client)
        if not session.get("student_id") or not session.get("year_id"):
            await self._initialize(h, session)
        day = day or date.today()
        monday = day - timedelta(days=day.weekday())
        # Текущая и следующая недели: в воскресенье планировщику нужны реальные уроки понедельника.
        weeks: list[dict] = []
        for offset in (0, 7):
            weeks.extend(await self._week(h, session, monday + timedelta(days=offset)))
        # Каникулы: пустые недели → ищем ближайшую учебную (не больше двух доп. запросов, снимок ≤ 21 дня).
        session.pop("next_school_week", None)
        if not any(wd.get("lessons") for wd in weeks):
            for offset in (14, 21):
                start = monday + timedelta(days=offset)
                found = await self._week(h, session, start)
                if any(wd.get("lessons") for wd in found):
                    weeks = weeks[:7] + found
                    session["next_school_week"] = start.isoformat()
                    break
        session["cookies"] = h.export_cookies()
        session["last_sync_at"] = time.time()
        return convert_diary({"weekDays": weeks}, session, school or {}, day)

    async def fetch_days(self, session, *, http, start, end):
        """Архив дневника: уроки, ДЗ и отметки за период ≤ 3 недель (GET /student/diary неделями)."""
        if end < start or (end - start).days > 20:
            raise ValueError("Период — не больше 3 недель")
        week_days = await self._week_days(http, session, start, end, max_weeks=4)
        return diary_days(week_days, session, start, end)

    # ---------------------------------------------------------- парсеры для приложения
    async def get_diary(self, session, start: date, end: date, *, http=None) -> list[dict]:
        """Дни дневника за период ≤ 6 недель: [{date, lessons:[{number,start,end,subject,room,topic,homework,marks}]}]."""
        h = http or self.http(session)
        if (end - start).days > 41:
            raise ValueError("Период — не больше 6 недель")
        return diary_days(await self._week_days(h, session, start, end, max_weeks=7), session, start, end)

    async def get_grades(self, session, start: date, end: date, *, http=None) -> list[Grade]:
        """Отметки за период ≤ 20 недель в модели Grade (стабильный grade_id, вес, тип работы)."""
        h = http or self.http(session)
        if (end - start).days > 140:
            raise ValueError("Период — не больше 20 недель")
        return grades_from_days(await self._week_days(h, session, start, end, max_weeks=21), session, start, end)

    async def get_homework(self, session, start: date, end: date, *, http=None) -> list[dict]:
        """Домашние задания с датой сдачи в [start, end]: [{subject, text, due, lesson_date, assignment_id}]."""
        h = http or self.http(session)
        if (end - start).days > 41:
            raise ValueError("Период — не больше 6 недель")
        lookback = start - timedelta(days=14)   # ДЗ задают раньше даты сдачи
        days = await self._week_days(h, session, lookback, end, max_weeks=9)
        return homework_from_days(days, session, start, end)

    async def get_assignment(self, session, assignment_id: int, *, http=None) -> dict | None:
        """Подробности задания (текст, вложения) — GET /student/diary/assigns/{id}; на старых узлах None."""
        if type(assignment_id) is not int or assignment_id <= 0:
            raise ValueError("Некорректный ID задания")
        h = http or self.http(session)
        raw = await h.request("GET", "/student/diary/assigns/" + str(assignment_id),
                              headers={"at": session["access_token"]},
                              params={"studentId": session["student_id"]}, optional=True)
        session["cookies"] = h.export_cookies()
        return parse_assignment(raw) if isinstance(raw, dict) else None

    async def get_announcements(self, session, *, http=None, limit: int = 30) -> list[dict]:
        """Объявления школы (GET /announcements); узлы без этого API возвращают []."""
        h = http or self.http(session)
        raw = await h.request("GET", "/announcements", headers={"at": session["access_token"]},
                              params={"take": str(max(1, min(limit, 100)))}, optional=True)
        session["cookies"] = h.export_cookies()
        return parse_announcements(raw, limit)


# ------------------------------------------------------------------ парсеры ответа СГО
def _mark_weight(raw):
    """Вес работы: пусто → 1; 0/битый → 0 (в средний не входит, см. app/grade_marks.py)."""
    from app.grade_marks import weight_of
    if raw is None or raw == "":
        return 1.0
    w = weight_of(raw)
    return float(w) if w is not None else 0.0


def marks_in(assignment):
    """Все отметки работы. mark бывает числом, строкой, объектом {mark, weight, dutyMark} или списком;
    «5/4», «4-», «Н», «Зач» сохраняются как есть; dutyMark без отметки — задолженность («долг»)."""
    raw = assignment.get("mark")
    items = raw if isinstance(raw, list) else [raw]
    if isinstance(assignment.get("marks"), list):
        items = [*items, *assignment["marks"]]
    out = []
    for mark in items[:6]:
        if isinstance(mark, dict):
            value = mark.get("mark")
            weight = mark.get("weight", assignment.get("weight"))
            if value in (None, "") and mark.get("dutyMark") is True:
                value = "долг"
        else:
            value = mark
            weight = assignment.get("weight")
        if value is None or isinstance(value, bool):
            continue
        text = str(value).strip()[:32]
        if not text:
            continue
        out.append((text, _mark_weight(weight)))
    return out



_TLS_CONTEXT = None


def sgo_tls_context():
    """Совместимое имя (CHANGELOG v3.3): TLS-контекст узлов СГО = diary_providers.portal_tls_context()."""
    global _TLS_CONTEXT
    if _TLS_CONTEXT is None:
        _TLS_CONTEXT = portal_tls_context()
    return _TLS_CONTEXT


_PLACEHOLDER_RE = re.compile(
    r"(без (домашнего )?задани[яй]|без дз|нет (дз|задани[яй]|домашнего задания)"
    r"|(дз|задани[ея]|домашнее задание|домашнего задания|тема) (нет|не задан[оа]?|не указан[аоы]?|отсутствует)"
    r"|не задан[оа]?|не задавал(ось|и|а)?|не указан[аоы]?|нет|отсутствует)")


def is_placeholder_text(value: str) -> bool:
    """v3.2.1 · заглушки учителя вместо ДЗ/темы («Без  задания», «Не задано», «---Не указана---», live СГО 05.11.2026).
    Это не задание: в «План дня» не идут, под уроком не показываются как ДЗ."""
    t = re.sub(r"[\s\-\u2010-\u2015_.,:;!*()«»\"']+", " ", value.lower().replace("ё", "е")).strip()
    return not re.search(r"[a-zа-я0-9§№]", t) or bool(_PLACEHOLDER_RE.fullmatch(t))


def assignment_text(a: dict, limit: int | None = 500) -> str:
    """v3.2.1 · текст задания урока: assignmentName, а если узел его не заполнил — description/text/name.
    Без этого ДЗ, записанное учителем только в описании, терялось и не попадало ни под урок, ни в «План дня».
    Заглушки («без задания», «---Не указана---») пропускаются — следующее поле или пустая строка."""
    for key in ("assignmentName", "description", "text", "name"):
        value = a.get(key)
        if isinstance(value, str) and value.strip() and not is_placeholder_text(value):
            text = " ".join(value.split())
            return text[:limit] if limit else text
    return ""

def _checked_time(value):
    if value in (None, ""):
        return None
    from datetime import time as clock
    value = str(value)[:5]
    clock.fromisoformat(value)
    return value


def convert_diary(raw, session, school, day):
    if not isinstance(raw, dict) or not isinstance(raw.get("weekDays"), list):
        raise ProviderUnavailable("Несовместимая схема дневника")
    from app.academic import task_blitz_eligible
    from app.scheduler import estimate_minutes
    lessons = []
    days: dict[str, list[dict]] = {}
    tasks = []
    grades: dict[str, Grade] = {}
    seen_tasks = set()
    strict_hw = _hw_strict(session.get("assignment_types") or {})
    try:
        for wd in raw["weekDays"]:
            stamp = date.fromisoformat(str(wd["date"])[:10])
            daily = wd.get("lessons", [])
            if not isinstance(daily, list) or len(daily) > 30:
                raise ValueError("Invalid lessons")
            days.setdefault(stamp.isoformat(), [])
            for lesson in daily:
                subject = str(lesson["subjectName"])[:160]
                assignments = lesson.get("assignments") or []
                starts = _checked_time(lesson.get("startTime"))
                ends = _checked_time(lesson.get("endTime"))
                if starts and ends and ends <= starts:
                    raise ValueError("Invalid lesson interval")
                number = lesson.get("number")
                if type(number) is not int or not 1 <= number <= 30:
                    raise ValueError("Invalid lesson number")
                item = {"start_time": starts, "end_time": ends, "subject": subject, "lesson_number": number,
                        "room": str(lesson.get("room") or ""), "source": "real"}
                previous = next((x for x in days[stamp.isoformat()] if x["lesson_number"] == number), None)
                if previous is not None and previous != item:
                    raise ValueError("Conflicting provider lesson")
                if previous is None:
                    days[stamp.isoformat()].append(item)
                if stamp == day and previous is None and starts and ends:
                    lessons.append({"starts_at": starts, "ends_at": ends, "subject": subject, "lesson_number": number,
                                    "room": item["room"], "source": "real"})
                for assignment in assignments:
                    text = assignment_text(assignment, None)
                    due = date.fromisoformat(str(assignment.get("dueDate") or stamp.isoformat())[:10])
                    kind_name = session.get("assignment_types", {}).get(str(assignment.get("typeId")), "")
                    # v3.2.1 · узел со справочником (есть тип «Домашнее задание») — в план только ДЗ;
                    # без справочника — прежнее поведение (любой текст задания).
                    if text and due >= day and (not strict_hw or _is_homework(assignment, kind_name, bool(marks_in(assignment)), True)):
                        if assignment.get("id") is not None:
                            key = str((session.get("host_id", ""), session.get("year_id", ""), session["student_id"],
                                       stamp.isoformat(), number, assignment.get("id")))
                        else:
                            key = subject + ":" + due.isoformat() + ":" + text
                        if key not in seen_tasks:
                            seen_tasks.add(key)
                            title = (subject + ": " + text)[:300]
                            oral = any(x in text.lower() for x in ["§", "читать", "выучить", "пересказ"])
                            kind = "oral" if oral else "written"
                            identity = {}
                            if assignment.get("id") is not None:
                                identity = {"id": "sgo:" + hashlib.sha256(key.encode()).hexdigest(),
                                            "provider_assignment_id": str(assignment["id"])}
                            if len(identity.get("provider_assignment_id", "")) > 200:
                                raise ValueError("Provider assignment ID too long")
                            tasks.append({**identity, "title": title, "type": kind, "deadline": due.isoformat(),
                                          "planned_minutes": max(1, min(600, estimate_minutes(title))),
                                          "blitz_eligible": task_blitz_eligible(title, kind)})
                    found = marks_in(assignment)
                    if not found:
                        continue
                    stable = assignment.get("id")
                    if stable is None:
                        raise ProviderUnavailable("У оценки отсутствует стабильный ID задания")
                    for index, (value, weight) in enumerate(found):
                        gid = _grade_id(session, stamp, lesson, stable, index)
                        grade = Grade(grade_id=gid, subject=subject, date=stamp.isoformat(),
                                      work_type=session.get("assignment_types", {}).get(str(assignment.get("typeId")), ""),
                                      topic=text[:300], value=value, weight=weight)
                        if gid in grades and grades[gid] != grade:
                            raise ProviderUnavailable("Противоречивые оценки провайдера")
                        grades[gid] = grade
        breaks: dict[str, list[dict]] = {}
        for stamp_key, entries in days.items():
            ordered = sorted(entries, key=lambda x: x["lesson_number"])
            breaks[stamp_key] = []
            for left, right in zip(ordered, ordered[1:]):
                end = left.get("end_time")
                start = right.get("start_time")
                if end and start and start > end:
                    breaks[stamp_key].append({"start_time": end, "end_time": start,
                                              "minutes": _minutes(start) - _minutes(end)})
        timed = [x for entries in days.values() for x in entries]
        bells = bool(timed) and all(x.get("start_time") and x.get("end_time") for x in timed)
        return DiarySnapshot(tasks=tasks[:500], lessons=lessons, days=days, bell_schedule_present=bells, breaks=breaks,
                             synced_at=datetime.now(timezone.utc).isoformat(), grades=list(grades.values()),
                             school_date=day.isoformat(), school_name=str(school.get("name", ""))[:200],
                             grade=session.get("class_name", ""), next_school_week=session.get("next_school_week"))
    except (ValueError, TypeError, KeyError, AttributeError) as exc:
        raise ProviderUnavailable("Не удалось проверить данные дневника") from exc


def _minutes(t: str) -> int:
    return int(t[:2]) * 60 + int(t[3:])


def _grade_id(session, stamp: date, lesson: dict, stable, index: int) -> str:
    # Одно задание может повторяться: ID — ученик + дата + урок + задание (+ индекс для нескольких отметок).
    gid = str(session["student_id"]) + ":" + stamp.isoformat() + ":" + str(lesson.get("number", "")) + ":" + str(stable)
    return gid + (":" + str(index) if index else "")


def grades_from_days(week_days, session, start: date, end: date) -> list[Grade]:
    types = {str(k): str(v) for k, v in (session.get("assignment_types") or {}).items()}
    out: dict[str, Grade] = {}
    for wd in week_days:
        try:
            stamp = date.fromisoformat(str(wd.get("date") or "")[:10])
        except ValueError:
            continue
        if not start <= stamp <= end:
            continue
        for lesson in wd.get("lessons") or []:
            if not isinstance(lesson, dict):
                continue
            subject = str(lesson.get("subjectName") or "").strip()[:160]
            if not subject:
                continue
            for a in lesson.get("assignments") or []:
                if not isinstance(a, dict) or a.get("id") is None:
                    continue
                for index, (value, weight) in enumerate(marks_in(a)):
                    gid = _grade_id(session, stamp, lesson, a["id"], index)[:128]
                    out[gid] = Grade(grade_id=gid, subject=subject, date=stamp.isoformat(),
                                     work_type=types.get(str(a.get("typeId")), "")[:200],
                                     topic=assignment_text(a, 300), value=value,
                                     weight=weight)
    return sorted(out.values(), key=lambda g: (g.date, g.subject, g.grade_id or ""))


HOMEWORK_WORDS = ("домаш", "дз")
# v3.2.1 · типы работы НА уроке (справочник /grade/assignment/types, live СГО Волгоград: 10 «Ответ на уроке»,
# 20 «Работа на уроке»). Их assignmentName — тема урока, а не ДЗ: раньше без отметки они попадали в ДЗ и в план.
CLASSWORK_WORDS = ("на уроке", "контрольн", "диктант", "изложен", "лаборатор", "проверочн", "тестирован",
                   "диагностич", "тематическ", "норматив", "зачёт", "зачет", "оценка за тему", "ведение тетради")


def _hw_strict(types: dict) -> bool:
    """Справочник узла содержит тип «Домашнее задание» → ДЗ только он; прочие типы — работа на уроке/контроль."""
    return any(any(w in str(v).lower() for w in HOMEWORK_WORDS) for v in (types or {}).values())


def _is_homework(assignment: dict, kind: str, has_marks: bool, strict: bool = False) -> bool:
    low = kind.lower()
    if assignment.get("typeId") == 3 or any(w in low for w in HOMEWORK_WORDS):
        return True
    if strict or any(w in low for w in CLASSWORK_WORDS):
        return False
    return not has_marks  # узел без справочника типов: прежнее правило (совместимость)


def _is_lesson_topic(kind: str) -> bool:
    return "на уроке" in kind.lower()


def homework_from_days(week_days, session, start: date, end: date) -> list[dict]:
    types = {str(k): str(v) for k, v in (session.get("assignment_types") or {}).items()}
    out: dict[str, dict] = {}
    for wd in week_days:
        try:
            stamp = date.fromisoformat(str(wd.get("date") or "")[:10])
        except ValueError:
            continue
        for lesson in wd.get("lessons") or []:
            if not isinstance(lesson, dict):
                continue
            subject = str(lesson.get("subjectName") or "").strip()[:160]
            for a in lesson.get("assignments") or []:
                if not isinstance(a, dict):
                    continue
                text = assignment_text(a)
                if not text or not _is_homework(a, types.get(str(a.get("typeId")), ""), bool(marks_in(a)), _hw_strict(types)):
                    continue
                try:
                    due = date.fromisoformat(str(a.get("dueDate") or "")[:10])
                except ValueError:
                    due = stamp
                if not start <= due <= end:
                    continue
                key = str(a.get("id")) if a.get("id") is not None else subject + ":" + due.isoformat() + ":" + text
                out.setdefault(key, {"subject": subject, "text": text, "due": due.isoformat(),
                                     "lesson_date": stamp.isoformat(),
                                     "assignment_id": a.get("id") if type(a.get("id")) is int else None})
    return sorted(out.values(), key=lambda x: (x["due"], x["subject"]))


def parse_assignment(raw: dict) -> dict:
    attachments = []
    for f in raw.get("attachments") or []:
        if isinstance(f, dict) and type(f.get("id")) is int:
            attachments.append({"id": f["id"], "name": str(f.get("originalFileName") or f.get("name") or "")[:200]})
    subject = raw.get("subjectGroup") if isinstance(raw.get("subjectGroup"), dict) else {}
    teachers = [str(t.get("name"))[:120] for t in raw.get("teachers") or [] if isinstance(t, dict) and t.get("name")]
    return {"id": raw.get("id") if type(raw.get("id")) is int else None,
            "name": str(raw.get("assignmentName") or "").strip()[:500],
            "description": str(raw.get("description") or "").strip()[:4000],
            "subject": str(subject.get("name") or "")[:160] or None,
            "due": str(raw.get("date") or raw.get("dueDate") or "")[:10] or None,
            "weight": raw.get("weight") if isinstance(raw.get("weight"), (int, float)) else None,
            "teachers": teachers[:5], "attachments": attachments[:20]}


def parse_announcements(raw, limit: int = 30) -> list[dict]:
    if not isinstance(raw, list):
        return []
    out = []
    for item in raw[:max(1, min(limit, 100))]:
        if not isinstance(item, dict):
            continue
        author = item.get("author") if isinstance(item.get("author"), dict) else {}
        out.append({"id": item.get("id") if type(item.get("id")) is int else None,
                    "title": str(item.get("name") or item.get("title") or "").strip()[:300],
                    "text": str(item.get("description") or "").strip()[:8000],
                    "posted_at": str(item.get("postDate") or "")[:25] or None,
                    "author": str(author.get("fio") or author.get("name") or "")[:120] or None})
    return out


def diary_days(week_days, session, start, end):
    """Дни дневника для «Учёбы»: под каждым уроком — его ДЗ и отметки. Пустые поля остаются пустыми."""
    types = {str(k): str(v) for k, v in (session.get("assignment_types") or {}).items()}
    strict = _hw_strict(types)
    out = {}
    for wd in week_days:
        if not isinstance(wd, dict):
            raise ProviderUnavailable("Несовместимый формат дня дневника")
        try:
            stamp = date.fromisoformat(str(wd.get("date") or "")[:10])
        except ValueError:
            raise ProviderUnavailable("Несовместимая дата дня дневника") from None
        if not start <= stamp <= end:
            continue
        lessons = []
        raw_lessons = wd.get("lessons")
        if raw_lessons is None:
            raw_lessons = []
        if not isinstance(raw_lessons, list) or len(raw_lessons) > 30:
            raise ProviderUnavailable("Несовместимый формат уроков дневника")
        for lesson in raw_lessons:
            if not isinstance(lesson, dict):
                raise ProviderUnavailable("Несовместимый формат урока дневника")
            subject = str(lesson.get("subjectName") or "").strip()[:160]
            if not subject:
                raise ProviderUnavailable("В уроке не указан предмет")
            number = lesson.get("number") if type(lesson.get("number")) is int and 0 <= lesson.get("number") <= 30 else None
            homework = []
            marks = []
            class_topic = None
            raw_assignments = lesson.get("assignments") if isinstance(lesson.get("assignments"), list) else []
            for a in raw_assignments[:20]:
                if not isinstance(a, dict):
                    continue
                text = assignment_text(a)
                kind = types.get(str(a.get("typeId")), "")
                found = marks_in(a)
                for value, _w in found:
                    marks.append({"value": value, "work_type": kind or None, "topic": text[:300] or None})
                is_hw = bool(text) and _is_homework(a, kind, bool(found), strict)
                if text and not is_hw and class_topic is None and _is_lesson_topic(kind):
                    class_topic = text
                if is_hw:
                    due = str(a.get("dueDate") or "")[:10]
                    try:
                        due = date.fromisoformat(due).isoformat()
                    except ValueError:
                        due = stamp.isoformat()
                    if not any(h["text"] == text for h in homework):
                        homework.append({"text": text, "due": due})
            topic = lesson.get("lessonTheme") or lesson.get("theme") or lesson.get("topic") or class_topic
            lessons.append({"number": number, "start": _hhmm(lesson.get("startTime")), "end": _hhmm(lesson.get("endTime")),
                            "subject": subject, "room": str(lesson.get("room") or "").strip()[:40] or None,
                            "topic": str(topic).strip()[:300] if isinstance(topic, str) and topic.strip() else None,
                            "homework": homework, "marks": marks[:6]})
        lessons.sort(key=lambda x: (x["number"] is None, x["number"] or 0))
        out[stamp.isoformat()] = {"date": stamp.isoformat(), "lessons": lessons}
    return [out[k] for k in sorted(out)]


def _hhmm(v):
    v = str(v or "")[:5]
    return v if len(v) == 5 and v[2] == ":" and v[:2].isdigit() and v[3:].isdigit() else None


class NativeDiaryAdapter:
    def __init__(self, directory, host_id):
        self.directory = directory
        self.host = directory.host(host_id)

    async def fetch(self, session):
        school = self.directory.school(session["school_uid"])
        try:
            client = NetSchoolClient(self.host)
            await client.keep_alive(session)
            return await client.fetch(session, school=school)
        except (httpx.HTTPError, OSError, TimeoutError):
            raise ProviderUnavailable("СГО временно недоступен") from None
