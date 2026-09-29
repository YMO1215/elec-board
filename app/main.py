"""FastAPI application factory."""
from __future__ import annotations

import mimetypes
import sqlite3

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .api import auth, field, insight, work
from .api.auth import LoginThrottle
from .config import WEB_DIR, Settings
from .db import migrate
from .errors import AppError

# Windows registries sometimes map .js to text/plain, which browsers refuse
# for module scripts. Pin the types we serve.
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("image/svg+xml", ".svg")

CSP = ("default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self';"
       " script-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self';"
       " frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'")


class WebFiles(StaticFiles):
    """Static shell. The service worker does network-first, so revalidate always."""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    migrate(settings.db_path)
    settings.files_dir.mkdir(parents=True, exist_ok=True)

    app = FastAPI(title="elec-board", version="1.0.0", docs_url="/api/docs", redoc_url=None,
                  openapi_url="/api/openapi.json")
    app.state.settings = settings
    app.state.login_throttle = LoginThrottle(settings.login_max_failures, settings.login_lock_seconds)

    @app.exception_handler(AppError)
    async def app_error(_: Request, exc: AppError):
        return JSONResponse(exc.payload(), status_code=exc.status)

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, exc: RequestValidationError):
        fields = [".".join(str(p) for p in e["loc"][1:]) for e in exc.errors()]
        return JSONResponse({"error": {"code": "validation", "message": "입력값을 확인하세요.",
                                       "detail": {"fields": fields}}}, status_code=422)

    @app.exception_handler(sqlite3.IntegrityError)
    async def integrity_error(_: Request, exc: sqlite3.IntegrityError):
        # DB triggers are the last line of defence for append-only records.
        return JSONResponse({"error": {"code": "integrity", "message": "기록 무결성 규칙에 막혔습니다.",
                                       "detail": {"reason": str(exc)}}}, status_code=409)

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "same-origin")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Permissions-Policy", "camera=(self), geolocation=(self), microphone=(self)")
        if not request.url.path.startswith("/files/"):
            response.headers.setdefault("Content-Security-Policy", CSP)
        if request.url.path.startswith("/api/"):
            response.headers.setdefault("Cache-Control", "no-store")
        return response

    app.include_router(auth.router)
    app.include_router(work.router)
    app.include_router(field.router)
    app.include_router(insight.router)
    app.mount("/", WebFiles(directory=WEB_DIR, html=True), name="web")
    return app
