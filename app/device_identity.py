"""Server-signed anonymous device identity for the browser demo (v2.4 Step 1).

The client never chooses its own identity any more. ``POST /api/v1/webapp/device-identity`` mints

    sfd1.<22 base64url chars from secrets>.<HMAC-SHA256 tag>

and the legacy authentication layer (``app.max_auth``) accepts an unsigned ``X-User-Id`` ONLY as such a
token, rewriting it to the random part before the request reaches the application. Any other client value
is refused (401 ``device_identity_invalid``). In production a valid MAX signature is mandatory
(DeploymentGate + MAX_REQUIRE_AUTH), so device identities are neither minted nor accepted there.

Key: ``DEMO_IDENTITY_KEY`` / ``DEMO_SANDBOX_KEY`` / ``SESSION_SIGNING_KEY`` (≥ 32 bytes) if configured.
Otherwise, in the DEMO profile only, a random key generated once by this server and kept next to the demo
data (``$SFERUM_DATA_DIR/device_identity.key``, mode 0600) so that a local demo keeps its browser profiles
across restarts; if it cannot be stored, a random per-process key (identities reset on restart). No key is
ever hard-coded or sent to the client; whoever can read the data directory can already read the demo data.

TEST profile only (``SFERUM_ENV=test``, used by pytest and the local E2E runners): the synthetic identity
harness may still send raw ids. The demo and production profiles have no switch for that.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
import re
import secrets
import threading
import time

PREFIX = "sfd1"
PATH = "/api/v1/webapp/device-identity"
_IDENT = re.compile(r"[A-Za-z0-9_-]{8,64}")
_TOKEN = re.compile(r"sfd1\.([A-Za-z0-9_-]{8,64})\.([A-Za-z0-9_-]{43})")
_process_key = secrets.token_bytes(32)
MINT_LIMIT_PER_HOUR = 300   # per client address; school NAT puts a whole class behind one IP
_mints: dict[str, list[float]] = {}
_lock = threading.Lock()


KEY_FILE = "device_identity.key"
_file_keys: dict[str, bytes] = {}


def _profile() -> str:
    return os.getenv("SFERUM_ENV", "production").strip().lower()


def _stored_key() -> bytes | None:
    """Demo profile: a per-installation random key in the data directory (created once, 0600)."""
    from pathlib import Path
    base = os.getenv("SFERUM_DATA_DIR", "").strip() or "data"
    path = Path(base) / KEY_FILE
    cached = _file_keys.get(str(path))
    if cached:
        return cached
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            raw = path.read_bytes()
        else:
            raw = secrets.token_bytes(32)
            with os.fdopen(fd, "wb") as fh:
                fh.write(raw)
        if len(raw) != 32:
            return None
    except OSError:
        return None
    _file_keys[str(path)] = raw
    return raw


def _key() -> bytes:
    for name in ("DEMO_IDENTITY_KEY", "DEMO_SANDBOX_KEY", "SESSION_SIGNING_KEY"):
        raw = os.getenv(name, "").encode()
        if len(raw) >= 32:
            return hashlib.sha256(b"sferumfocus-device-identity-key-v1\x00" + raw).digest()
    if _profile() == "demo":
        stored = _stored_key()
        if stored:
            return hashlib.sha256(b"sferumfocus-device-identity-file-v1\x00" + stored).digest()
    return _process_key


def _tag(ident: str) -> str:
    mac = hmac.new(_key(), b"sferumfocus-device-identity-v1\x00" + ident.encode("ascii"), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(mac).decode("ascii").rstrip("=")


def sign(ident: str) -> str:
    if not isinstance(ident, str) or not _IDENT.fullmatch(ident):
        raise ValueError("device identity: 8–64 symbols [A-Za-z0-9_-]")
    return f"{PREFIX}.{ident}.{_tag(ident)}"


def mint() -> str:
    return sign(base64.urlsafe_b64encode(secrets.token_bytes(16)).decode("ascii").rstrip("="))


def verify(token: str | None) -> str | None:
    """Random part of a token minted by THIS server (constant-time tag check), else None."""
    if not isinstance(token, str) or len(token) > 160:
        return None
    m = _TOKEN.fullmatch(token)
    if not m:
        return None
    return m.group(1) if hmac.compare_digest(m.group(2), _tag(m.group(1))) else None


def harness() -> bool:
    """Synthetic identity harness of the automated test profile (never demo or production)."""
    return _profile() == "test"


def allow_mint(client: str, now: float | None = None) -> int | None:
    """None if a new identity may be minted for this client address, else seconds to wait."""
    at = time.time() if now is None else now
    tag = hashlib.sha256(("device-mint:" + (client or "unknown")).encode()).hexdigest()[:16]
    with _lock:
        recent = [t for t in _mints.get(tag, []) if at - t < 3600]
        if len(recent) >= MINT_LIMIT_PER_HOUR:
            _mints[tag] = recent
            return int(3600 - (at - recent[0])) + 1
        recent.append(at)
        _mints[tag] = recent
        if len(_mints) > 10000:
            for k in list(_mints)[:5000]:
                _mints.pop(k, None)
    return None
