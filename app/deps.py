"""Request-scoped dependencies: settings, DB connection, authenticated actor."""
from __future__ import annotations

import hmac
import sqlite3
from dataclasses import dataclass
from typing import Iterator

from fastapi import Depends, Request

from .config import Settings
from .db import connect, now_iso, one
from .errors import forbidden, unauthorized
from .security import token_hash

SESSION_COOKIE = "eb_session"
CSRF_HEADER = "x-csrf-token"
ROLES = ("admin", "worker", "reviewer")
ROLE_LABELS = {"admin": "관리자", "worker": "작업자", "reviewer": "검토자"}
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_conn(settings: Settings = Depends(get_settings)) -> Iterator[sqlite3.Connection]:
    conn = connect(settings.db_path)
    try:
        yield conn
    finally:
        conn.close()


def parse_roles(text: str) -> frozenset[str]:
    return frozenset(r for r in (p.strip() for p in text.split(",")) if r in ROLES)


def format_roles(roles) -> str:
    return ",".join(r for r in ROLES if r in roles)


@dataclass(frozen=True)
class Actor:
    user_id: int
    org_id: int
    name: str
    email: str
    roles: frozenset[str]
    board_slot: int | None
    initials: str
    csrf: str

    def has(self, *roles: str) -> bool:
        return any(r in self.roles for r in roles)

    def require(self, *roles: str) -> None:
        if not self.has(*roles):
            labels = " 또는 ".join(ROLE_LABELS[r] for r in roles)
            raise forbidden(f"{labels} 권한이 필요합니다.")


def load_actor(conn: sqlite3.Connection, session_token: str | None) -> Actor | None:
    if not session_token:
        return None
    r = one(
        conn,
        "SELECT s.csrf, s.expires_at, u.id AS user_id, u.name, u.email,"
        " m.org_id, m.roles, m.board_slot, m.initials, m.active"
        " FROM sessions s JOIN users u ON u.id = s.user_id"
        " JOIN memberships m ON m.user_id = u.id"
        " WHERE s.token_hash = ?",
        (token_hash(session_token),),
    )
    if r is None or not r["active"] or r["expires_at"] < now_iso():
        return None
    return Actor(
        user_id=r["user_id"],
        org_id=r["org_id"],
        name=r["name"],
        email=r["email"],
        roles=parse_roles(r["roles"]),
        board_slot=r["board_slot"],
        initials=r["initials"],
        csrf=r["csrf"],
    )


def current_actor(request: Request, conn: sqlite3.Connection = Depends(get_conn)) -> Actor:
    actor = load_actor(conn, request.cookies.get(SESSION_COOKIE))
    if actor is None:
        raise unauthorized()
    if request.method not in SAFE_METHODS:
        sent = request.headers.get(CSRF_HEADER, "")
        if not hmac.compare_digest(sent, actor.csrf):
            raise forbidden("요청 확인 토큰이 맞지 않습니다. 새로고침 후 다시 시도하세요.")
    return actor
