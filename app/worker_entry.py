"""Authenticated Cloudflare Worker boundary wrapping the EXISTING application.

Run app.worker_entry:app only behind the supplied Worker. Direct requests fail
closed. The witness diagnoses transport; Telegram/MAX validators remain mandatory.
"""
from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import logging
import os
import re
from urllib.parse import urlsplit

from app.main import app as application

_PRIVATE = {
    b"x-sferum-proxy-key", b"x-sferum-launch-proof",
    b"x-sferum-request-id", b"x-sferum-client-ip",
}
_SENSITIVE = _PRIVATE | {
    b"x-telegram-init-data", b"x-max-init-data", b"cookie",
    b"origin", b"x-csrf-token", b"x-web-bootstrap",
}


class WorkerBoundary:
    def __init__(self, app, secret: str, public_origin: str):
        if not re.fullmatch("[a-f0-9]{64}", secret):
            raise RuntimeError("SFERUM_WORKER_SECRET must be a private 64-character hex value")
        u = urlsplit(public_origin)
        if (u.scheme != "https" or not u.hostname or u.username or u.password
                or u.path not in {"", "/"} or u.query or u.fragment):
            raise RuntimeError("SFERUM_PUBLIC_ORIGIN must be the public HTTPS origin")
        self.app = app
        self.secret = secret.encode("ascii")
        self.host = u.netloc.encode("ascii")
        self.server = (u.hostname, u.port or 443)

    @staticmethod
    async def deny(send, status):
        body = b'{"detail":"Proxy request validation failed"}'
        await send({"type": "http.response.start", "status": status, "headers": [
            (b"content-type", b"application/json"), (b"cache-control", b"no-store"),
        ]})
        await send({"type": "http.response.body", "body": body})

    async def __call__(self, scope, receive, send):
        if scope["type"] == "lifespan":
            return await self.app(scope, receive, send)
        if scope["type"] != "http":
            return await send({"type": "websocket.close", "code": 1008})
        pairs = scope.get("headers", [])
        for name in _SENSITIVE:
            if sum(k.lower() == name for k, _ in pairs) > 1:
                return await self.deny(send, 400)
        headers = {k.lower(): v for k, v in pairs}
        if not hmac.compare_digest(headers.get(b"x-sferum-proxy-key", b""), self.secret):
            return await self.deny(send, 403)
        try:
            request_id = headers[b"x-sferum-request-id"].decode("ascii")
            proof = headers[b"x-sferum-launch-proof"].decode("ascii")
            tg = headers.get(b"x-telegram-init-data", b"").decode("ascii")
            mx = headers.get(b"x-max-init-data", b"").decode("ascii")
            ip = headers.get(b"x-sferum-client-ip", b"").decode("ascii")
            if not re.fullmatch("[a-f0-9-]{36}", request_id):
                raise ValueError
            if not re.fullmatch("[a-f0-9]{64}", proof):
                raise ValueError
            if any(len(v) > 16384 or re.search(r"[^\x20-\x7e]", v) for v in (tg, mx)):
                raise ValueError
            if len(ip) > 64:
                raise ValueError
            if ip:
                ipaddress.ip_address(ip)
        except (KeyError, UnicodeError, ValueError):
            return await self.deny(send, 400)
        witness = json.dumps([request_id, tg, mx, ip], ensure_ascii=False, separators=(",", ":"))
        expected = hmac.new(self.secret, witness.encode(), hashlib.sha256).hexdigest()
        intact = hmac.compare_digest(expected, proof)
        logging.getLogger("uvicorn.error").info(
            "worker_transport request_id=%s telegram_present=%s max_present=%s intact=%s",
            request_id, bool(tg), bool(mx), intact,
        )
        if not intact:
            return await self.deny(send, 502)
        # Only the authenticated edge may establish public host/scheme/client IP.
        # Drop private proxy credentials before any downstream middleware/handler.
        clean = [(k, v) for k, v in pairs
                 if k.lower() not in _PRIVATE | {b"host", b"forwarded",
                     b"x-forwarded-host", b"x-forwarded-proto", b"x-forwarded-for",
                     b"x-real-ip", b"cf-connecting-ip"}]
        clean.append((b"host", self.host))
        state = dict(scope.get("state", {}))
        state["worker_transport_intact"] = True
        state["worker_request_id"] = request_id
        updated = dict(scope, headers=clean, scheme="https", server=self.server, state=state)
        if ip:
            updated["client"] = (ip, 0)
        return await self.app(updated, receive, send)


app = WorkerBoundary(
    application, os.getenv("SFERUM_WORKER_SECRET", ""),
    os.getenv("SFERUM_PUBLIC_ORIGIN", ""),
)
