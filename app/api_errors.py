"""v2.3.2 · Единый конверт ошибок с машиночитаемым кодом.

Тело: {"detail": <текст для человека>, "code": <КОД>, "error_code": <КОД>, "retry_after"?: <сек>, ...extra}.
Заголовки: Cache-Control: no-store всегда; Retry-After для 429/503 с известным ожиданием; X-Error-Domain
для ошибок дневника (фронт по нему не сбрасывает сессию приложения при 401 от СГО).

CodedError — подкласс HTTPException: даже в приложении без нашего обработчика FastAPI ответит
корректным статусом, текстом и заголовками (в т.ч. Retry-After). Полный конверт дают обработчик
install() в app.main и SafeRoute в роутерах дневника.
"""
from __future__ import annotations

from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

# Коды, которые фронт обязан различать (lib/api.ts повторяет этот список).
CODES = frozenset({
    "REGION_REQUIRED", "REGION_UNKNOWN", "CATALOG_UNAVAILABLE", "RATE_LIMITED",
    "SCHOOL_SELECTION_REQUIRED", "SCHOOL_NOT_FOUND", "SCHOOL_REMOVED", "HOST_NOT_TRUSTED",
    "AUTH_METHOD_DISABLED", "ESIA_NOT_CONFIGURED", "ESIA_MISCONFIGURED", "LOGIN_METHOD_UNSUPPORTED",
    "DIARY_ALREADY_CONNECTED",
})


class CodedError(HTTPException):
    def __init__(self, status: int, code: str, detail: str, *, retry_after: int | None = None,
                 extra: dict[str, Any] | None = None, domain: str | None = None) -> None:
        self.code = code
        self.retry_after = max(1, int(retry_after)) if retry_after else None
        self.extra = dict(extra or {})
        self.domain = domain
        headers = {"Cache-Control": "no-store"}
        if self.retry_after:
            headers["Retry-After"] = str(self.retry_after)
        if domain:
            headers["X-Error-Domain"] = domain
        super().__init__(status_code=status, detail=detail, headers=headers)

    def body(self) -> dict[str, Any]:
        body: dict[str, Any] = {"detail": self.detail, "code": self.code, "error_code": self.code}
        if self.retry_after:
            body["retry_after"] = self.retry_after
        body.update({k: v for k, v in self.extra.items() if k not in body})
        return body

    def response(self) -> JSONResponse:
        return JSONResponse(self.body(), status_code=self.status_code, headers=dict(self.headers or {}))


def install(app: FastAPI) -> None:
    @app.exception_handler(CodedError)
    async def _coded(_: Request, exc: CodedError) -> JSONResponse:  # noqa: ANN202 - FastAPI handler
        return exc.response()
