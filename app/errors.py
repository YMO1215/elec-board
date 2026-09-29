"""Explicit API errors with a stable JSON shape: {"error": {code, message, detail}}."""
from __future__ import annotations

from typing import Any


class AppError(Exception):
    def __init__(self, status: int, code: str, message: str, detail: Any = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.detail = detail

    def payload(self) -> dict[str, Any]:
        body: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.detail is not None:
            body["detail"] = self.detail
        return {"error": body}


def bad_request(message: str, code: str = "bad_request", detail: Any = None) -> AppError:
    return AppError(400, code, message, detail)


def unauthorized(message: str = "로그인이 필요합니다.") -> AppError:
    return AppError(401, "unauthorized", message)


def forbidden(message: str = "이 작업을 할 권한이 없습니다.") -> AppError:
    return AppError(403, "forbidden", message)


def not_found(what: str = "항목") -> AppError:
    # Also used for rows of other organizations, so their existence never leaks.
    return AppError(404, "not_found", f"{what}을(를) 찾을 수 없습니다.")


def conflict(message: str, code: str = "conflict", detail: Any = None) -> AppError:
    return AppError(409, code, message, detail)
