"""Read-only preflight for the SferumFocus classroom production deployment.

Run inside the image/container:
    python -m app.classroom_preflight

Never prints secret values and never creates/changes the SQLite database.
Exit 0 only when production configuration and the expected classroom schema are ready.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import sqlite3
import sys


def _env_status(name: str, value: str | None = None) -> dict:
    value = os.getenv(name, "") if value is None else value
    return {"set": bool(value), "length_ok": len(value.encode()) >= 32 if name == "SESSION_SIGNING_KEY" else None}


def _fernet_ok(value: str) -> bool:
    try:
        from cryptography.fernet import Fernet
        Fernet(value.encode())
        return True
    except (ImportError, ValueError, TypeError):
        return False


def _database_check(data_dir: str) -> dict:
    path = Path(data_dir).expanduser() / "platform.sqlite3"
    out = {"path": str(path), "exists": path.is_file(), "readable": False,
           "quick_check": None, "missing_schema": [], "error": None}
    if not path.is_file():
        out["error"] = "platform_database_missing"
        return out
    try:
        uri = path.resolve().as_uri() + "?mode=ro"
        with sqlite3.connect(uri, uri=True, timeout=5) as db:
            out["readable"] = True
            result = db.execute("PRAGMA quick_check").fetchone()
            out["quick_check"] = result[0] if result else "no_result"
            required = {
                "accounts": {"uid", "data_key", "role", "view_role"},
                "identities": {"principal", "uid"},
                "sessions": {"digest", "principal", "expires"},
                "user_profiles": {"user_id", "role"},
                "student_school_binding": {"student_uid", "role"},
                "sgo_sessions": {"user_id", "role", "status"},
                "teacher_grades_journal": {
                    "id", "teacher_uid", "class_name", "subject", "student_id", "student_name",
                    "grade", "assignment_type", "comment", "lesson_date", "sync_status", "created_at",
                    "operation_id", "sync_reason", "request_json",
                },
            }
            existing = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            for table, names in required.items():
                if table not in existing:
                    out["missing_schema"].append({"table": table, "columns": sorted(names)})
                    continue
                columns = {r[1] for r in db.execute(f'PRAGMA table_info("{table}")')}
                missing = names - columns
                if missing:
                    out["missing_schema"].append({"table": table, "columns": sorted(missing)})
    except (OSError, sqlite3.Error) as exc:
        out["error"] = type(exc).__name__
    return out


def main() -> int:
    # Import the same config loader and production policy as the application.
    try:
        from app import config
        from app.deployment import DeploymentPolicy
    except Exception as exc:  # diagnostic itself must not leak exception contents
        print(json.dumps({"status": "ERROR", "reason": "application_config_import_failed",
                          "exception": type(exc).__name__}, ensure_ascii=False, indent=2))
        return 2

    env_report = getattr(config, "ENV_FILE_REPORT", None)
    env_summary = env_report.summary() if env_report else {"exists": False, "error": "no_env_report"}
    env = os.environ
    platform = env.get("PLATFORM_AUTH_ENABLED", "").strip().lower() in {"1", "true", "yes", "on"}
    policy = DeploymentPolicy(env=env, env_file=env_report)
    errors = policy.errors()

    secrets = {
        "MAX_BOT_TOKEN": _env_status("MAX_BOT_TOKEN"),
        "TELEGRAM_BOT_TOKEN": _env_status("TELEGRAM_BOT_TOKEN"),
        "SESSION_SIGNING_KEY": _env_status("SESSION_SIGNING_KEY"),
        "DIARY_ENCRYPTION_KEY": {"set": bool(env.get("DIARY_ENCRYPTION_KEY")),
                                 "valid_fernet": _fernet_ok(env.get("DIARY_ENCRYPTION_KEY", ""))},
    }
    if platform and not env.get("MAX_BOT_TOKEN", "").strip() and "max_bot_token_required" not in errors:
        errors.append("max_bot_token_required")

    db = _database_check(config.SFERUM_DATA_DIR)
    app_data = Path(__file__).resolve().parent / 'data'
    catalog_assets = {
        name: (app_data / name).is_file()
        for name in ('school_portals.json', 'region_search_aliases.json',
                     'public_schools.json', 'institutions.json', 'glyph_atlas.json')
    }
    catalog_warnings = [f'{name}_missing' for name, present in catalog_assets.items() if not present]
    db_errors = []
    if not db["exists"] or not db["readable"]:
        db_errors.append("platform_database_unavailable")
    if db["quick_check"] not in (None, "ok"):
        db_errors.append("platform_database_quick_check_failed")
    if db["missing_schema"]:
        db_errors.append("platform_database_schema_incomplete")
    all_errors = list(dict.fromkeys(errors + db_errors))

    result = {
        "status": "READY" if not all_errors else "NOT_READY",
        "profile": env.get("SFERUM_ENV", "production").strip().lower(),
        "platform_auth_enabled": platform,
        "env_file": env_summary,
        "secrets": secrets,
        "deployment_errors": errors,
        "database": db,
        "database_errors": db_errors,
        "public_data_assets": catalog_assets,
        "warnings": catalog_warnings,
        "errors": all_errors,
        "notes": [
            "No secret values, user records, row counts, or database contents are printed.",
            "The database is opened read-only; this command performs no migration or write.",
            "Preserve the existing DIARY_ENCRYPTION_KEY if encrypted diary records already exist.",
            "Missing public catalogue seeds do not block whoami after the hotfix, but school discovery is degraded and must be restored from the matching release source.",
        ],
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if not all_errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
