"""SEC-02: explicit non-production opt-in; local configuration readiness, not deployment approval.

No external calls, no storage writes. Environment is captured once at process startup.
Worker/storage declarations must also be verified operationally; this gate cannot inspect a proxy fleet.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
from urllib.parse import urlsplit

_TRUE = {"1", "true", "yes", "on"}
_FALSE = {"0", "false", "no", "off"}

def https_origin(value: str) -> bool:
    try:
        u = urlsplit(value)
        return bool(value and value == value.strip() and u.scheme == "https" and u.hostname
                    and not u.username and not u.password and not u.path and not u.query
                    and not u.fragment and u.port != 0 and not any(c.isspace() for c in value)
                    and "\\" not in value and "%" not in u.netloc and "*" not in value)
    except ValueError:
        return False

ORIGIN_ERROR = "explicit_same_https_origin_and_cors_required"
ORIGIN_KEYS = ("SFERUM_PUBLIC_ORIGIN", "CORS_ORIGINS")
# v2.0.2: /ready names the CLASS of every error (only in a not_ready body; the ready body is unchanged).
DEPENDENCY_ERRORS = frozenset({"data_dir_not_accessible"})          # the declared resource exists in config, but is unusable
MAX_WEBHOOK_ERRORS = frozenset({"max_subscription_not_ready"})      # the MAX webhook subscription itself, see max_webhook.reason


def classify_errors(errors) -> dict:
    """{"configuration"|"dependency"|"max_webhook": [codes]} — codes only."""
    out: dict[str, list[str]] = {}
    for code in errors:
        cls = "max_webhook" if code in MAX_WEBHOOK_ERRORS else "dependency" if code in DEPENDENCY_ERRORS else "configuration"
        out.setdefault(cls, []).append(code)
    return out


def max_reason_class(status: str, reason) -> str:
    """Why the MAX subscription is not ready: pending (not attempted yet) | configuration (token/URL/conflict) | dependency (MAX API/network)."""
    if status in {"registered", "operator_managed"}: return "ok"
    if not reason: return "pending"
    if reason == "configuration_or_subscription_conflict": return "configuration"
    if reason.startswith("max_http_"):
        code = reason[9:]
        return "dependency" if code == "429" or code.startswith("5") else "configuration"
    return "dependency"


def redact_value(value: str) -> str:
    """ENV-05: a configuration value as it may appear in a journal line or doctor output.

    URL credentials and query/fragment never leave the process: https://user:pass@host/x?token=1#f →
    https://***@host/x?<redacted>#<redacted>. Comma-separated lists are redacted item by item. Whitespace is kept
    (it is part of the diagnosis) — callers print repr()."""
    if "," in value:
        return ",".join(redact_value(x) for x in value.split(","))
    head, sep, tail = value.partition("//")
    if not sep:
        head, tail = "", value
    end = min([i for i in (tail.find("/"), tail.find("?"), tail.find("#")) if i >= 0] or [len(tail)])
    authority, rest = tail[:end], tail[end:]
    if "@" in authority:
        authority = "***@" + authority.rsplit("@", 1)[1]
    frag = ""
    if "#" in rest:
        rest, frag = rest.split("#", 1)[0], "#<redacted>"
    if "?" in rest:
        rest = rest.split("?", 1)[0] + "?<redacted>"
    return head + sep + authority + rest + frag

def origin_flaw(value: str):
    """ENV-01: why a value is not an exact HTTPS origin (None — valid). A code, never the value."""
    if https_origin(value): return None
    if value != value.strip() or any(c.isspace() for c in value): return "whitespace"
    try:
        u = urlsplit(value)
        port = u.port
    except ValueError:
        return "unparsable"
    if u.scheme != "https": return "not_https"
    if not u.hostname: return "no_host"
    if u.username or u.password: return "userinfo"
    if u.path: return "trailing_slash" if u.path == "/" else "has_path"
    if u.query or u.fragment: return "query_or_fragment"
    if port == 0: return "bad_port"
    return "forbidden_characters"

class DeploymentPolicy:
    def __init__(self, env=None, env_file=None):
        self.env = dict(os.environ if env is None else env)
        self.env_file = env_file          # app.envfile.EnvFileReport of the process (None for explicit env dicts)
        self.profile = self.env.get("SFERUM_ENV", "production").strip().lower()
        self.production = self.profile not in {"demo", "test"}
        raw = self.env.get("CORS_ORIGINS", "" if self.production else "*")
        self.cors = [s.strip() for s in raw.split(",") if s.strip()]
        if self.production:
            origin = self.env.get("SFERUM_PUBLIC_ORIGIN", "")
            self.cors = [origin] if https_origin(origin) and self.cors == [origin] else []

    def errors(self):
        e = self.env; errors = []
        if self.profile not in {"production", "demo", "test"}: errors.append("invalid_environment_profile")
        if not self.production: return errors
        if e.get("PLATFORM_AUTH_ENABLED", "").lower() in _TRUE:
            if len(e.get("SESSION_SIGNING_KEY", "").encode()) < 32: errors.append("session_signing_key_required")
            # This deployment is a MAX Mini App. PlatformAuthMiddleware constructs a strict
            # MaxAuthMiddleware with MAX_BOT_TOKEN specifically; TELEGRAM_BOT_TOKEN cannot
            # validate X-Max-Init-Data. Do not report production READY when only Telegram is set.
            if not e.get("MAX_BOT_TOKEN", "").strip(): errors.append("max_bot_token_required")
            try:
                from cryptography.fernet import Fernet
                Fernet(e.get("DIARY_ENCRYPTION_KEY", "").encode())
            except (ValueError,TypeError): errors.append("diary_encryption_key_required")
        else:
            if e.get("MAX_REQUIRE_AUTH", "").strip().lower() not in _TRUE: errors.append("signed_max_auth_required")
            if not e.get("MAX_BOT_TOKEN", "").strip(): errors.append("max_bot_token_required")
        if e.get("TEACHER_TOKEN", "").strip():
            # The shared teacher token was removed (one-time invitations replace it). Refuse to run
            # silently with an operator believing a removed second factor still protects teachers.
            errors.append("teacher_token_removed_use_invitations")
        for name in ("SFERUM_USE_MOCK", "SCHEDULE_DEMO"):
            if e.get(name, "").strip().lower() not in _FALSE: errors.append(name.lower() + "_must_be_false")
        if not self.cors: errors.append(ORIGIN_ERROR)
        if e.get("SFERUM_WORKERS") != "1" or e.get("SFERUM_REPLICAS") != "1": errors.append("single_worker_single_replica_required")
        if os.name != "posix" or e.get("SFERUM_STORAGE_KIND") != "local-posix": errors.append("verified_local_posix_storage_required")
        data = e.get("SFERUM_DATA_DIR", "")
        if not data or not Path(data).is_absolute(): errors.append("absolute_data_dir_required")
        elif not Path(data).is_dir() or not os.access(data, os.R_OK | os.W_OK | os.X_OK): errors.append("data_dir_not_accessible")
        return errors

    def hints(self):
        """ENV-01: the exact reason behind ORIGIN_ERROR — codes only (no values, no line numbers)."""
        e, out = self.env, []
        o = e.get("SFERUM_PUBLIC_ORIGIN")
        if o is None: out.append("public_origin_missing")
        elif o == "": out.append("public_origin_empty")
        elif origin_flaw(o): out.append("public_origin_" + origin_flaw(o))
        c = e.get("CORS_ORIGINS")
        items = [x.strip() for x in (c or "").split(",") if x.strip()]
        if c is None: out.append("cors_origins_missing")
        elif not items: out.append("cors_origins_empty")
        elif "*" in items: out.append("cors_origins_wildcard")
        elif len(items) > 1: out.append("cors_origins_multiple")
        elif o and items[0] != o: out.append("cors_origins_differs_from_public_origin")
        r = self.env_file
        if r is not None:
            if r.error: out.append("env_file_" + r.error)
            if any(k in r.conflicts for k in ORIGIN_KEYS): out.append("env_file_conflicting_duplicates")
            if any(k in r.shadowed for k in ORIGIN_KEYS): out.append("env_file_value_overridden_by_process_environment")
            if r.bom: out.append("env_file_starts_with_bom")
            if any(k in r.version_dependent_keys for k in ORIGIN_KEYS): out.append("env_file_value_depends_on_systemd_version")
        return out

    def readiness(self):
        errors = self.errors()
        out = {"status": "not_ready" if errors else "configuration_ready", "profile": self.profile,
               "errors": errors, "deployment_approved": False}
        if ORIGIN_ERROR in errors: out["hints"] = self.hints()
        if errors: out["error_classes"] = classify_errors(errors)
        return out

    def startup_line(self):
        """One journal line at startup: what the app REALLY got (journalctl -u sferumfocus | grep deployment_config).
        Only non-secret values (origins, profile) are shown, as repr() of redact_value() (no URL credentials, no
        query/fragment — ENV-05); for the .env file — line numbers."""
        e, r = self.env, self.env_file
        show = lambda k: "<unset>" if e.get(k) is None else repr(redact_value(e[k]))[:200]
        parts = ["deployment_config", f"profile={self.profile}"]
        for k in ORIGIN_KEYS:
            src = "unset" if k not in e else "process_env"
            if r is not None and k in e:
                last = r.last_line(k)
                if k in r.applied: src = f"env_file:{last}"
                elif k in r.shadowed: src = f"process_env(differs_from_env_file:{last})"
                elif last is not None: src = f"process_env(=env_file:{last})"
            lines = ",".join(map(str, r.lines.get(k, []))) if r is not None else ""
            parts.append(f"{k}={show(k)} src={src}" + (f" env_file_lines={lines}" if lines else ""))
        parts.append(f"effective_cors={[redact_value(x) for x in self.cors]!r}")
        if r is not None:
            parts.append(f"env_file={r.path if r.exists else 'absent'}" + (f" env_file_error={r.error}" if r.error else ""))
            if r.duplicates: parts.append("env_file_duplicates=" + ",".join(r.duplicates))
            if r.conflicts: parts.append("env_file_conflicts=" + ",".join(r.conflicts))
            if r.invalid_lines: parts.append("env_file_ignored_lines=" + ",".join(map(str, r.invalid_lines)))
            if r.bom: parts.append("env_file_bom=yes")
            if r.comment_continuations: parts.append("env_file_comment_continuation_lines=" + ",".join(map(str, r.comment_continuations)))
            if r.version_dependent_keys: parts.append("env_file_systemd_version_dependent=" + ",".join(r.version_dependent_keys))
        errors = self.errors()
        parts.append("errors=" + (",".join(errors) or "none"))
        if ORIGIN_ERROR in errors: parts.append("hints=" + ",".join(self.hints()))
        return " ".join(parts)

class DeploymentGate:
    def __init__(self, app, policy): self.app, self.policy = app, policy
    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and scope["path"].startswith("/api/") and self.policy.errors():
            body = json.dumps({"detail": "Deployment configuration is not ready", "errors": self.policy.errors()}).encode()
            await send({"type": "http.response.start", "status": 503, "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
            return await send({"type": "http.response.body", "body": body})
        return await self.app(scope, receive, send)
