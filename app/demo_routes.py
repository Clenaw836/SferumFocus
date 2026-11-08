"""HTTP surface of the demo sandbox (see app/demo_sandbox.py).

POST   /api/v1/demo/session   {persona?}  -> new isolated sandbox (+ token); with a token: restart (old data purged)
GET    /api/v1/demo/session               -> who am I in this sandbox, available personas
POST   /api/v1/demo/persona   {persona}   -> new token for the same sandbox (teacher <-> student), no data change
DELETE /api/v1/demo/session               -> end the sandbox and purge its data
"""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict

from app import demo_sandbox as sbx

router = APIRouter()
Persona = Literal["teacher", "s1", "s2", "s3"]


class SessionBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    persona: Persona = "teacher"


class PersonaBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    persona: Persona


def _err(exc: sbx.SandboxError) -> JSONResponse:
    headers = {"Retry-After": "3600"} if exc.status == 429 else None
    return JSONResponse({"detail": exc.detail, "reason_code": exc.reason}, status_code=exc.status, headers=headers)


def _need(request: Request) -> dict | JSONResponse:
    sb = sbx.state_of(request)
    if not sb:
        return JSONResponse({"detail": "Нужна демо-сессия (заголовок X-Demo-Session)", "reason_code": "demo_session_required"}, status_code=401)
    return sb


@router.post("/api/v1/demo/session")
def demo_session_create(request: Request, body: SessionBody | None = None):
    if not sbx.enabled():
        return JSONResponse({"detail": "Демо-песочница на этом сервере выключена", "reason_code": "demo_sandbox_disabled"}, status_code=404)
    old = sbx.state_of(request)
    try:
        made = sbx.create(request.client.host if request.client else "")
    except sbx.SandboxError as exc:
        return _err(exc)
    if old:
        sbx.end(old["sid"])
    persona = (body or SessionBody()).persona
    return {"token": sbx.issue_token(made["sid"], persona, made["expires"]), **sbx.describe(made["sid"], persona, made["expires"]),
            "restarted": bool(old)}


@router.get("/api/v1/demo/session")
def demo_session_read(request: Request):
    sb = _need(request)
    if isinstance(sb, JSONResponse):
        return sb
    return sbx.describe(sb["sid"], sb["persona"], sb["expires"])


@router.post("/api/v1/demo/persona")
def demo_persona(body: PersonaBody, request: Request):
    sb = _need(request)
    if isinstance(sb, JSONResponse):
        return sb
    return {"token": sbx.issue_token(sb["sid"], body.persona, sb["expires"]), **sbx.describe(sb["sid"], body.persona, sb["expires"])}


@router.delete("/api/v1/demo/session")
def demo_session_end(request: Request):
    sb = _need(request)
    if isinstance(sb, JSONResponse):
        return sb
    sbx.end(sb["sid"])
    return {"ended": True}
