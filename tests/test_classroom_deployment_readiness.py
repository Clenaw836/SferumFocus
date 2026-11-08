from cryptography.fernet import Fernet

from app.deployment import DeploymentPolicy


def base_env(tmp_path):
    return {
        "SFERUM_ENV": "production",
        "PLATFORM_AUTH_ENABLED": "1",
        "MAX_REQUIRE_AUTH": "0",
        "MAX_BOT_TOKEN": "max-bot-token",
        "TELEGRAM_BOT_TOKEN": "",
        "SESSION_SIGNING_KEY": "s" * 48,
        "DIARY_ENCRYPTION_KEY": Fernet.generate_key().decode(),
        "SFERUM_PUBLIC_ORIGIN": "https://app.example.test",
        "CORS_ORIGINS": "https://app.example.test",
        "SFERUM_USE_MOCK": "false",
        "SCHEDULE_DEMO": "false",
        "SFERUM_WORKERS": "1",
        "SFERUM_REPLICAS": "1",
        "SFERUM_STORAGE_KIND": "local-posix",
        "SFERUM_DATA_DIR": str(tmp_path),
        "TEACHER_TOKEN": "",
    }


def test_platform_mode_requires_max_token_even_when_telegram_token_exists(tmp_path):
    env = base_env(tmp_path)
    env["MAX_BOT_TOKEN"] = ""
    env["TELEGRAM_BOT_TOKEN"] = "telegram-token-is-not-a-max-token"

    assert "max_bot_token_required" in DeploymentPolicy(env).errors()


def test_platform_mode_rejects_missing_persistent_session_key(tmp_path):
    env = base_env(tmp_path)
    env["SESSION_SIGNING_KEY"] = "short"

    assert "session_signing_key_required" in DeploymentPolicy(env).errors()


def test_platform_mode_rejects_missing_diary_encryption_key(tmp_path):
    env = base_env(tmp_path)
    env["DIARY_ENCRYPTION_KEY"] = ""

    assert "diary_encryption_key_required" in DeploymentPolicy(env).errors()


def test_complete_platform_configuration_passes_policy(tmp_path):
    assert DeploymentPolicy(base_env(tmp_path)).errors() == []


def test_missing_school_portal_seed_does_not_break_platform_identity(monkeypatch, tmp_path):
    from app import school_registry

    monkeypatch.setattr(school_registry, "_CATALOG_PATH", tmp_path / "missing-school-portals.json")
    school_registry.catalog.cache_clear()
    try:
        value = school_registry.catalog()
        assert value["_available"] is False
        assert value["portals"] == []
        assert value["national"] == []
        assert value["catalog_version"] == "unavailable"
        assert school_registry.native_candidates() == []
        assert school_registry.public_services("Волгоградская область") == []
    finally:
        school_registry.catalog.cache_clear()


def test_missing_optional_region_alias_seed_does_not_break_canonical_regions(monkeypatch, tmp_path):
    from app import school_regions

    monkeypatch.setattr(school_regions, "_SEARCH_ALIASES_PATH", tmp_path / "missing-aliases.json")
    assert school_regions.canonical_region("Волгоградская область") == "Волгоградская область"
    assert school_regions.search_aliases("Волгоградская область") == []
