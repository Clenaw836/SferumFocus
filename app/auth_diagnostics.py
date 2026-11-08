"""Fixed-code diagnostics: never log credentials, request headers or exceptions."""
import logging

logger = logging.getLogger('sferumfocus.auth')
_CODES = {'missing_telegram_token', 'identity_store_unavailable',
          'web_session_store_unavailable', 'platform_mode_disabled',
          'legacy_max_selected_for_telegram'}


def report(reason: str, exc: Exception | None = None) -> None:
    if reason not in _CODES:
        raise ValueError('Unknown diagnostic code')
    # Class names of expected built-in errors are safe; never format the instance.
    category = 'none' if exc is None else (
        'storage' if isinstance(exc, OSError) else
        'configuration' if isinstance(exc, ValueError) else 'database')
    logger.warning('auth_configuration_error reason_code=%s category=%s', reason, category)
