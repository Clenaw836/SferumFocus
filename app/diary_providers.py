"""School adapter boundary. Unknown portals never become implicit trusted APIs.

Regional contracts are administrator-supplied and versioned. No invented login
endpoints, ESIA scraping, cookie capture or third-party password handling.
"""
from __future__ import annotations
from typing import Literal, Protocol
from urllib.parse import urlsplit
import ipaddress
import json
import os
import socket
import hashlib
import httpx
from pydantic import BaseModel, ConfigDict, Field, field_validator

ConnectionStatus=Literal['connected','reauth_required','temporarily_unavailable','revoked','unsupported_manual','demo']

_PORTAL_TLS = None


def portal_tls_context():
    """v3.2.1 · TLS к школьным порталам: системные корни ОС + НУЦ Минцифры (Russian Trusted Root CA, проверка
    sha256 в app.max_transport) + необязательный SGO_CA_FILE оператора. Без этого httpx брал только certifi —
    порталы на сертификатах Минцифры (проба 05.11.2026: sgo.mari-el.gov.ru, e-school.ryazan.gov.ru) не открывались."""
    global _PORTAL_TLS
    if _PORTAL_TLS is None:
        from app.max_transport import tls_context
        _PORTAL_TLS = tls_context(os.getenv("SGO_CA_FILE") or None)
    return _PORTAL_TLS

class Grade(BaseModel):
    model_config=ConfigDict(extra='forbid')
    grade_id: str | None=Field(default=None,max_length=128)
    subject: str=Field(min_length=1,max_length=160)
    date: str=Field(pattern=r'^\d{4}-\d{2}-\d{2}$')
    work_type: str=Field(default='',max_length=200)
    topic: str=Field(default='',max_length=300)
    value: str=Field(min_length=1,max_length=32)
    average: float | None=Field(default=None,ge=0,le=100,allow_inf_nan=False)
    # v2.2: вес 0 («работа не учитывается») — допустимое значение СГО; в средний такая отметка не входит (app/grade_marks.py).
    weight: float=Field(default=1,ge=0,le=1000,allow_inf_nan=False)
    @property
    def identity(self):
        # Exclude value so a changed mark can be matched to the same work.
        return self.grade_id or hashlib.sha256(json.dumps([self.subject,self.date,self.work_type,self.topic],ensure_ascii=False).encode()).hexdigest()

class DiarySnapshot(BaseModel):
    model_config=ConfigDict(extra='forbid')
    role: str = Field(default='student', pattern='^(student|teacher)$')
    is_teacher: bool = False
    tasks: list[dict]=Field(default_factory=list,max_length=500)
    lessons: list[dict]=Field(default_factory=list,max_length=100)
    days: dict[str,list[dict]]=Field(default_factory=dict,max_length=21)
    synced_at: str | None=Field(default=None,max_length=40)
    bell_schedule_present: bool=False
    breaks: dict[str,list[dict]]=Field(default_factory=dict,max_length=21)
    grades: list[Grade]=Field(default_factory=list,max_length=2000)
    school_date: str | None=Field(default=None,pattern=r'^\d{4}-\d{2}-\d{2}$')
    school_name: str=Field(default='',max_length=200)
    grade: str=Field(default='',max_length=30)
    # v2.2: на каникулах текущая и следующая недели пустые — понедельник ближайшей учебной недели из СГО.
    next_school_week: str | None=Field(default=None,pattern=r'^\d{4}-\d{2}-\d{2}$')
    @field_validator('days')
    @classmethod
    def checked_days(cls, days):
        from datetime import date, time
        for stamp,lessons in days.items():
            if date.fromisoformat(stamp).isoformat()!=stamp or len(lessons)>30:raise ValueError('Invalid school day')
            seen=set()
            for lesson in lessons:
                n=lesson.get('lesson_number')
                if type(n) is not int or not 1<=n<=30 or n in seen:raise ValueError('Invalid lesson number')
                seen.add(n)
                if not isinstance(lesson.get('subject'),str) or not 1<=len(lesson['subject'])<=160:raise ValueError('Invalid subject')
                for key in ('start_time','end_time'):
                    value=lesson.get(key)
                    if value is not None:
                        if not isinstance(value,str) or len(value)!=5:raise ValueError('Invalid bell')
                        time.fromisoformat(value)
                if lesson.get('start_time') and lesson.get('end_time') and lesson['end_time']<=lesson['start_time']:raise ValueError('Invalid interval')
        return days
    @field_validator('grades')
    @classmethod
    def no_ambiguous_duplicates(cls, grades):
        ids=[g.identity for g in grades]
        if len(set(ids))!=len(ids): raise ValueError('Grade identity collision: provider IDs required')
        return grades

class ReauthRequired(Exception):
    """Provider revoked/expired the session."""
class ProviderUnavailable(Exception):
    """Network/schema problem; no fabricated data."""
class UnsupportedPortal(ValueError):
    """No approved integration contract."""
class DiaryProviderAdapter(Protocol):
    async def fetch(self, session: dict) -> DiarySnapshot: ...

class MockDemoAdapter:
    async def fetch(self, session):
        from app import mock_diary
        return DiarySnapshot(tasks=[dict(t) for t in mock_diary.MOCK_TASKS],school_name=mock_diary.SCHOOL_NAME,grade=mock_diary.GRADE)
class ManualImportAdapter:
    async def fetch(self, session): return DiarySnapshot.model_validate(session.get('snapshot',{}))

def portal_origin(value: str) -> str:
    try:
        p=urlsplit(value)
        if p.scheme!='https' or not p.hostname or p.username or p.password or p.query or p.fragment or p.path not in {'','/'} or p.port not in {None,443} or '\\' in value or any(c.isspace() for c in value):
            raise ValueError()
        host=p.hostname.encode('idna').decode('ascii').lower()
        if host=='localhost' or host.endswith(('.localhost','.local')): raise ValueError()
        try:
            if not ipaddress.ip_address(host).is_global: raise ValueError()
        except ValueError:
            # A domain is resolved and pinned before every network request.
            if ':' in host or host.replace('.','').isdigit(): raise ValueError()
        return 'https://'+host
    except (ValueError,UnicodeError) as exc: raise UnsupportedPortal('Нужен публичный HTTPS origin без пути и параметров') from exc

def profiles():
    # Trusted server configuration only; never sourced from a user-submitted URL.
    raw=json.loads(os.getenv('DIARY_PORTAL_PROFILES','[]'))
    if not isinstance(raw,list) or len(raw)>500: raise UnsupportedPortal('Invalid portal catalog')
    return raw

def approved_profile(url: str):
    origin=portal_origin(url)
    for item in profiles():
        if portal_origin(item['origin'])==origin and item.get('contract')=='sferum-normalized-v1':
            path=item.get('snapshot_path','')
            if not path.startswith('/') or path.startswith('//') or '?' in path or '#' in path or '\\' in path or any(c.isspace() for c in path): raise UnsupportedPortal('Invalid provider path')
            return {**item,'origin':origin}
    raise UnsupportedPortal('Портал не проверен: доступен ручной режим')

def strict_cp1251(value: str) -> bytes:
    # No lossy errors="ignore". Legacy challenge algorithms need a verified contract.
    return value.encode('cp1251',errors='strict')

async def pinned_get(origin: str, path: str, headers: dict, cookies: dict):
    host=urlsplit(origin).hostname
    import asyncio
    infos=await asyncio.to_thread(socket.getaddrinfo,host,443,type=socket.SOCK_STREAM)
    addresses=sorted({x[4][0] for x in infos})
    if not addresses or any(not ipaddress.ip_address(x).is_global for x in addresses): raise UnsupportedPortal('Непубличный адрес портала заблокирован')
    ip=addresses[0]; ip=f'[{ip}]' if ':' in ip else ip
    # Connect to the resolved IP, retain the original TLS SNI/certificate and Host.
    # No second DNS lookup, redirects, environment proxy, or cookie forwarding elsewhere.
    async with httpx.AsyncClient(timeout=8,follow_redirects=False,trust_env=False,verify=portal_tls_context()) as client:
        async with client.stream('GET',f'https://{ip}{path}',headers={**headers,'Host':host},cookies=cookies,extensions={'sni_hostname':host}) as response:
            content=bytearray()
            async for chunk in response.aiter_bytes():
                content.extend(chunk)
                if len(content)>2*1024*1024: raise ProviderUnavailable('Ответ слишком большой')
            return httpx.Response(response.status_code,content=bytes(content),headers={'content-type':response.headers.get('content-type','')})

class NetSchoolRegionalAdapter:
    def __init__(self, origin: str, fetcher=None):
        self.profile=approved_profile(origin);self.fetcher=fetcher or pinned_get
    async def fetch(self, session):
        # This connector consumes a server-approved normalized gateway contract.
        # Native SGO endpoints/auth mapping must be validated per region first.
        try:
            response=await self.fetcher(self.profile['origin'],self.profile['snapshot_path'],{'at':session['access_token']},session.get('cookies',{}))
            try:
                if response.status_code in {401,403}: raise ReauthRequired()
                if response.status_code!=200: raise ProviderUnavailable()
                data=bytearray()
                async for chunk in response.aiter_bytes():
                    data.extend(chunk)
                    if len(data)>2*1024*1024:raise ProviderUnavailable()
                return DiarySnapshot.model_validate_json(bytes(data))
            finally: await response.aclose()
        except ReauthRequired: raise
        except (httpx.HTTPError,ValueError,KeyError,UnsupportedPortal) as exc: raise ProviderUnavailable('Провайдер недоступен или контракт не подтверждён') from exc
