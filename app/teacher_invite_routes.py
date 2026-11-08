"""POST /api/v1/teacher/invites/redeem — a verified MAX user redeems a one-time teacher invitation.

There is deliberately no API to create, list or reveal invitations: only the server operator can create
them (scripts/teacher_invites.py). Identity comes only from the server-side MAX initData check
(app.max_auth / app.platform_auth); X-User-Id / X-User-Role / X-Teacher-Token are never consulted.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from app import teacher_invites

router = APIRouter()
REDEEM_PATH = "/api/v1/teacher/invites/redeem"


class RedeemBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    code: str = Field(min_length=1, max_length=64)


def verified_max_uid(request: Request) -> str | None:
    """Numeric MAX id proven by a valid initData signature on THIS request, else None."""
    from app import demo_sandbox
    if demo_sandbox.state_of(request):
        return None
    state = getattr(request, "state", None)
    if hasattr(state, "platform_account"):
        principal = str(getattr(state, "platform_principal", ""))
        return principal[4:] if getattr(state, "platform_auth", "") == "max" and principal.startswith("max:") else None
    uid = request.headers.get("x-user-id", "")
    # x-auth=max and the «max:» prefix are set only by MaxAuthMiddleware after the HMAC check;
    # client-supplied values of both are stripped before the request reaches the app.
    if request.headers.get("x-auth") == "max" and uid.startswith("max:"):
        return uid[4:]
    return None


@router.post(REDEEM_PATH)
def redeem_invite(body: RedeemBody, request: Request) -> dict:
    from app import demo_sandbox
    if demo_sandbox.state_of(request):
        raise HTTPException(403, "В демо-песочнице приглашения учителя не принимаются")
    uid = verified_max_uid(request)
    if not uid:
        raise HTTPException(401, "Откройте приложение в MAX, чтобы принять приглашение")
    client = request.client.host if request.client else "unknown"
    try:
        return teacher_invites.redeem(uid, body.code, client)
    except teacher_invites.InviteError as exc:
        headers = {"Retry-After": str(exc.retry_after)} if exc.retry_after else None
        raise HTTPException(exc.status, exc.detail, headers=headers) from None
