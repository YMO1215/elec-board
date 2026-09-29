"""Team members and the four board slots."""
from __future__ import annotations

import sqlite3
from typing import Any

from ..db import many, one
from ..deps import parse_roles
from ..errors import bad_request

BOARD_SLOTS = (1, 2, 3, 4)

_MEMBER_SQL = (
    "SELECT u.id, u.name, u.email, m.roles, m.board_slot, m.initials, m.active,"
    " m.created_at, m.deactivated_at"
    " FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ?"
)


def _shape(r: dict[str, Any]) -> dict[str, Any]:
    r = dict(r)
    r["roles"] = sorted(parse_roles(r["roles"]))
    r["active"] = bool(r["active"])
    return r


def list_members(conn: sqlite3.Connection, org_id: int, include_inactive: bool = False) -> list[dict[str, Any]]:
    sql = _MEMBER_SQL + ("" if include_inactive else " AND m.active = 1")
    sql += " ORDER BY m.active DESC, COALESCE(m.board_slot, 99), u.name"
    return [_shape(r) for r in many(conn, sql, (org_id,))]


def get_member(conn: sqlite3.Connection, org_id: int, user_id: int) -> dict[str, Any] | None:
    r = one(conn, _MEMBER_SQL + " AND u.id = ?", (org_id, user_id))
    return _shape(r) if r else None


def board_members(conn: sqlite3.Connection, org_id: int) -> dict[int, dict[str, Any]]:
    """slot -> active member occupying it."""
    return {m["board_slot"]: m for m in list_members(conn, org_id) if m["board_slot"]}


def require_assignable(conn: sqlite3.Connection, org_id: int, user_id: int) -> dict[str, Any]:
    """Primary assignees must hold a board slot, so every task lands in exactly
    one assignee column and the per-assignee sum always equals the total."""
    m = get_member(conn, org_id, user_id)
    if m is None or not m["active"]:
        raise bad_request("담당자는 활성 팀원이어야 합니다.", "invalid_assignee")
    if not m["board_slot"]:
        raise bad_request("보드 열(1~4)에 배치된 팀원만 주 담당자가 될 수 있습니다.", "assignee_without_slot")
    return m


def default_initials(name: str) -> str:
    name = name.strip()
    if not name:
        return "?"
    # Korean names: the given name (last two syllables) reads naturally on a magnet.
    if all("가" <= ch <= "힣" for ch in name) and len(name) >= 2:
        return name[-2:]
    parts = [p for p in name.split() if p]
    return "".join(p[0] for p in parts[:2]).upper() or name[:2]
