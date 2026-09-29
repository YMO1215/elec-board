"""/api/auth — setup, login, invitations, team management."""
from __future__ import annotations

import hmac
import sqlite3
import time

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, Field

from ..config import Settings
from ..db import one, tx
from ..deps import ROLE_LABELS, SESSION_COOKIE, Actor, current_actor, get_conn, get_settings, load_actor
from ..errors import AppError, forbidden
from ..security import hash_password, verify_password
from ..services import org
from ..services.team import list_members

router = APIRouter(prefix="/api")
_DUMMY_HASH = hash_password("timing-equalizer")


class SetupBody(BaseModel):
    org_name: str = Field(max_length=80)
    name: str = Field(max_length=40)
    email: str = Field(max_length=120)
    password: str = Field(max_length=200)
    setup_token: str | None = Field(default=None, max_length=200)


class LoginBody(BaseModel):
    email: str = Field(max_length=120)
    password: str = Field(max_length=200)


class PasswordBody(BaseModel):
    current: str = Field(max_length=200)
    new: str = Field(max_length=200)


class InviteBody(BaseModel):
    email: str = Field(max_length=120)
    name: str = Field(max_length=40)
    roles: list[str]
    board_slot: int | None = None


class AcceptBody(BaseModel):
    password: str = Field(max_length=200)


class MemberPatch(BaseModel):
    roles: list[str] | None = None
    board_slot: int | None = None
    clear_slot: bool = False
    initials: str | None = Field(default=None, max_length=3)


class DeactivateBody(BaseModel):
    reassign_to: int | None = None


def _set_cookie(response: Response, settings: Settings, token: str) -> None:
    response.set_cookie(SESSION_COOKIE, token, max_age=settings.session_days * 86400, httponly=True,
                        samesite="lax", secure=settings.cookie_secure, path="/")


def _me(conn: sqlite3.Connection, actor: Actor) -> dict:
    org_row = one(conn, "SELECT id, name FROM organizations WHERE id = ?", (actor.org_id,))
    return {
        "user": {"id": actor.user_id, "name": actor.name, "email": actor.email, "initials": actor.initials,
                 "board_slot": actor.board_slot, "roles": sorted(actor.roles)},
        "org": org_row,
        "csrf": actor.csrf,
        "role_labels": ROLE_LABELS,
    }


class LoginThrottle:
    """In-memory lockout after repeated failures (per email + client address)."""

    def __init__(self, max_failures: int, lock_seconds: int):
        self.max_failures, self.lock_seconds = max_failures, lock_seconds
        self.state: dict[str, tuple[int, float]] = {}

    def check(self, key: str) -> None:
        count, since = self.state.get(key, (0, 0.0))
        if count >= self.max_failures and time.time() - since < self.lock_seconds:
            wait = int(self.lock_seconds - (time.time() - since))
            raise AppError(429, "locked", f"로그인 시도가 많습니다. {wait}초 뒤에 다시 시도하세요.")
        if count >= self.max_failures:
            self.state.pop(key, None)

    def fail(self, key: str) -> None:
        count, since = self.state.get(key, (0, time.time()))
        self.state[key] = (count + 1, since if count else time.time())

    def ok(self, key: str) -> None:
        self.state.pop(key, None)


@router.get("/auth/state")
def auth_state(request: Request, conn=Depends(get_conn), settings=Depends(get_settings)):
    actor = load_actor(conn, request.cookies.get(SESSION_COOKIE))
    return {"needs_setup": org.needs_setup(conn), "me": _me(conn, actor) if actor else None,
            "demo": settings.demo_mode}


@router.post("/auth/setup")
def setup(body: SetupBody, response: Response, conn=Depends(get_conn), settings=Depends(get_settings)):
    if settings.setup_token and not hmac.compare_digest(body.setup_token or "", settings.setup_token):
        raise forbidden("초기 설정 토큰이 맞지 않습니다. 서버 관리자에게 ELEC_SETUP_TOKEN 값을 확인하세요.")
    with tx(conn):
        user_id = org.bootstrap(conn, settings, org_name=body.org_name, name=body.name, email=body.email,
                                password=body.password)
        token, _ = org.create_session(conn, settings, user_id)
    _set_cookie(response, settings, token)
    return {"me": _me(conn, load_actor(conn, token))}


@router.post("/auth/login")
def login(body: LoginBody, request: Request, response: Response, conn=Depends(get_conn),
          settings=Depends(get_settings)):
    throttle: LoginThrottle = request.app.state.login_throttle
    key = f"{body.email.strip().lower()}|{request.client.host if request.client else '-'}"
    throttle.check(key)
    u = one(conn, "SELECT u.id, u.password_hash, m.active FROM users u JOIN memberships m ON m.user_id = u.id"
                  " WHERE u.email = ?", (body.email.strip(),))
    # Always run one scrypt so response time does not reveal whether the email exists.
    valid = verify_password(body.password, u["password_hash"] if u else _DUMMY_HASH)
    if u is None or not valid or not u["active"]:
        throttle.fail(key)
        raise AppError(401, "bad_credentials", "이메일 또는 비밀번호가 맞지 않습니다.")
    throttle.ok(key)
    with tx(conn):
        token, _ = org.create_session(conn, settings, u["id"])
    _set_cookie(response, settings, token)
    return {"me": _me(conn, load_actor(conn, token))}


@router.post("/auth/logout")
def logout(request: Request, response: Response, actor: Actor = Depends(current_actor), conn=Depends(get_conn)):
    with tx(conn):
        org.destroy_session(conn, request.cookies.get(SESSION_COOKIE))
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"ok": True}


@router.get("/auth/me")
def me(actor: Actor = Depends(current_actor), conn=Depends(get_conn)):
    return _me(conn, actor)


@router.post("/auth/password")
def change_password(body: PasswordBody, actor: Actor = Depends(current_actor), conn=Depends(get_conn)):
    with tx(conn):
        org.change_password(conn, actor, body.current, body.new)
    return {"ok": True}


@router.post("/auth/invite")
def invite(body: InviteBody, actor: Actor = Depends(current_actor), conn=Depends(get_conn),
           settings=Depends(get_settings)):
    with tx(conn):
        return org.invite(conn, settings, actor, email=body.email, name=body.name, roles=body.roles,
                          board_slot=body.board_slot)


@router.get("/auth/invitations")
def invitations(actor: Actor = Depends(current_actor), conn=Depends(get_conn)):
    return {"items": org.list_invitations(conn, actor)}


@router.delete("/auth/invitations/{invitation_id}")
def revoke(invitation_id: int, actor: Actor = Depends(current_actor), conn=Depends(get_conn)):
    with tx(conn):
        org.revoke_invitation(conn, actor, invitation_id)
    return {"ok": True}


@router.get("/auth/invite/{token}")
def invitation(token: str, conn=Depends(get_conn)):
    return org.invitation_preview(conn, token)


@router.post("/auth/invite/{token}/accept")
def accept(token: str, body: AcceptBody, response: Response, conn=Depends(get_conn),
           settings=Depends(get_settings)):
    with tx(conn):
        user_id = org.accept_invitation(conn, token, body.password)
        session, _ = org.create_session(conn, settings, user_id)
    _set_cookie(response, settings, session)
    return {"me": _me(conn, load_actor(conn, session))}


@router.get("/team")
def team(include_inactive: bool = False, actor: Actor = Depends(current_actor), conn=Depends(get_conn)):
    members = list_members(conn, actor.org_id, include_inactive=include_inactive and actor.has("admin"))
    if not actor.has("admin"):
        for m in members:
            m.pop("email", None)
    return {"items": members}


@router.patch("/team/{user_id}")
def update_member(user_id: int, body: MemberPatch, actor: Actor = Depends(current_actor), conn=Depends(get_conn)):
    slot = None if body.clear_slot else (body.board_slot if body.board_slot is not None else "keep")
    with tx(conn):
        return org.update_member(conn, actor, user_id, roles=body.roles, board_slot=slot, initials=body.initials)


@router.post("/team/{user_id}/deactivate")
def deactivate(user_id: int, body: DeactivateBody, actor: Actor = Depends(current_actor), conn=Depends(get_conn)):
    with tx(conn):
        return org.deactivate_member(conn, actor, user_id, body.reassign_to)
