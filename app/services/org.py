"""Organization setup, sessions, invitations, members, sites, assets, templates."""
from __future__ import annotations

import json
import re
from datetime import date, datetime, timedelta, timezone
from typing import Any

from .. import audit
from ..config import Settings
from ..db import bump_rev, local_today, many, now_iso, one, scalar
from ..deps import ROLES, Actor, format_roles, parse_roles
from ..errors import bad_request, conflict, forbidden, not_found
from ..security import MIN_PASSWORD_LENGTH, hash_password, new_public_id, new_token, sign_session, token_hash
from . import kpi, knowledge
from .team import BOARD_SLOTS, default_initials, get_member, require_assignable

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
SERVICE_LIFE_SOON_DAYS = 180


def _add_years(d: date, years: int) -> date:
    try:
        return d.replace(year=d.year + years)
    except ValueError:  # Feb 29 -> Feb 28
        return d.replace(year=d.year + years, day=28)

SAMPLE_TEMPLATES = [
    {
        "name": "저압 분전반 점검 (예시)", "asset_type": "분전반",
        "items": [
            ("외관", "외함 손상·부식·변형"), ("외관", "내부 먼지·이물질·습기"), ("외관", "회로 명칭·표시 상태"),
            ("차단기", "배선용 차단기 동작·외관"), ("차단기", "누전차단기 시험 버튼 동작"),
            ("접속·배선", "단자 조임·변색(과열 흔적)"), ("접속·배선", "전선 피복 손상·정리 상태"),
            ("접지", "접지선 연결 상태"), ("열화상", "이상 발열 여부"), ("안전", "잠금장치·안전 표지"),
        ],
    },
    {
        "name": "수변전설비 월차 점검 (예시)", "asset_type": "수배전반",
        "items": [
            ("변압기", "이상음·진동"), ("변압기", "온도 지시값"), ("변압기", "누유·절연유 상태"),
            ("차단기", "VCB/ACB 상태 표시"), ("보호계전기", "계전기 동작 표시·경보"),
            ("계기", "전압·전류 지시값"), ("케이블", "케이블 헤드·피뢰기 외관"),
            ("전기실", "환기·온도·누수"), ("전기실", "조명·비상조명"), ("안전", "소화기·절연용 보호구 비치"),
        ],
    },
    {
        "name": "접지저항 측정 (예시)", "asset_type": "접지",
        "items": [
            ("준비", "측정기 교정 유효기간"), ("접지극", "접지 단자·접속부 상태"),
            ("측정", "접지저항 측정값 기준 이내(메모에 값 기록)"), ("접지선", "단선·부식·손상"),
        ],
    },
    {
        "name": "비상발전기 점검 (예시)", "asset_type": "발전기",
        "items": [
            ("연료", "연료량·누유"), ("축전지", "배터리 전압"), ("엔진", "냉각수·윤활유 레벨"),
            ("운전", "무부하 시운전"), ("절환", "자동절환(ATS) 동작"), ("환경", "배기·환기 상태"),
        ],
    },
]


# ---------------------------------------------------------------------------
# Setup and sessions
# ---------------------------------------------------------------------------

def needs_setup(conn) -> bool:
    return scalar(conn, "SELECT COUNT(*) FROM organizations") == 0


def _check_password(password: str) -> None:
    if len(password or "") < MIN_PASSWORD_LENGTH:
        raise bad_request(f"비밀번호는 {MIN_PASSWORD_LENGTH}자 이상이어야 합니다.", "weak_password")


def _check_email(email: str) -> str:
    email = (email or "").strip()
    if not EMAIL_RE.match(email):
        raise bad_request("이메일 형식이 올바르지 않습니다.", "bad_email")
    return email


def seed_org_defaults(conn, settings: Settings, org_id: int, actor_id: int | None) -> None:
    kpi.ensure_definitions(conn, org_id)
    knowledge.seed_defaults(conn, org_id, settings.knowledge_review_days)
    if not one(conn, "SELECT 1 FROM inspection_templates WHERE org_id = ? LIMIT 1", (org_id,)):
        for t in SAMPLE_TEMPLATES:
            items = [{"key": f"i{n:02d}", "section": s, "label": label} for n, (s, label) in enumerate(t["items"], 1)]
            conn.execute(
                "INSERT INTO inspection_templates (org_id, name, asset_type, version, items_json, is_sample,"
                " created_by, created_at) VALUES (?, ?, ?, 1, ?, 1, ?, ?)",
                (org_id, t["name"], t["asset_type"], json.dumps(items, ensure_ascii=False), actor_id, now_iso()),
            )


def bootstrap(conn, settings: Settings, *, org_name: str, name: str, email: str, password: str) -> int:
    """First run: creates the organization and its first admin. Returns user id."""
    if not needs_setup(conn):
        raise conflict("이미 초기 설정이 끝났습니다.", "already_setup")
    org_name, name = (org_name or "").strip(), (name or "").strip()
    if not org_name or not name:
        raise bad_request("팀 이름과 관리자 이름을 입력하세요.", "name_required")
    email = _check_email(email)
    _check_password(password)
    ts = now_iso()
    org_id = conn.execute("INSERT INTO organizations (name, created_at) VALUES (?, ?)", (org_name, ts)).lastrowid
    user_id = conn.execute("INSERT INTO users (email, name, password_hash, created_at) VALUES (?, ?, ?, ?)",
                           (email, name, hash_password(password), ts)).lastrowid
    conn.execute(
        "INSERT INTO memberships (org_id, user_id, roles, board_slot, initials, created_at)"
        " VALUES (?, ?, ?, 1, ?, ?)",
        (org_id, user_id, "admin,worker", default_initials(name), ts),
    )
    seed_org_defaults(conn, settings, org_id, user_id)
    audit.record(conn, org_id, user_id, "org.create", "organization", org_id, {"name": org_name})
    return user_id


def create_session(conn, settings: Settings, user_id: int) -> tuple[str, str]:
    token, csrf = new_token(), new_token(24)
    expires = datetime.now(timezone.utc) + timedelta(days=settings.session_days)
    if settings.demo_mode:
        # Demo hosts may run several instances, each with its own /tmp DB.
        return sign_session(settings.secret_key, user_id, csrf, int(expires.timestamp())), csrf
    conn.execute("DELETE FROM sessions WHERE user_id = ? AND expires_at < ?", (user_id, now_iso()))
    conn.execute("INSERT INTO sessions (token_hash, user_id, csrf, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
                 (token_hash(token), user_id, csrf, now_iso(), expires.isoformat(timespec="seconds")))
    return token, csrf


def destroy_session(conn, token: str | None) -> None:
    if token:
        conn.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash(token),))


def change_password(conn, actor: Actor, current: str, new: str) -> None:
    from ..security import verify_password
    u = one(conn, "SELECT password_hash FROM users WHERE id = ?", (actor.user_id,))
    if not verify_password(current or "", u["password_hash"]):
        raise bad_request("현재 비밀번호가 맞지 않습니다.", "wrong_password")
    _check_password(new)
    conn.execute("UPDATE users SET password_hash = ? WHERE id = ?", (hash_password(new), actor.user_id))
    audit.record(conn, actor.org_id, actor.user_id, "user.password", "user", actor.user_id, {})


# ---------------------------------------------------------------------------
# Invitations and members
# ---------------------------------------------------------------------------

def _clean_roles(roles: list[str]) -> str:
    chosen = [r for r in roles if r in ROLES]
    if not chosen:
        raise bad_request("역할을 하나 이상 고르세요.", "roles_required")
    return format_roles(set(chosen))


def _slot_taken(conn, org_id: int, slot: int | None, except_user: int | None = None) -> dict[str, Any] | None:
    if slot is None:
        return None
    return one(conn, "SELECT m.user_id, u.name FROM memberships m JOIN users u ON u.id = m.user_id"
                     " WHERE m.org_id = ? AND m.board_slot = ? AND m.active = 1 AND m.user_id IS NOT ?",
               (org_id, slot, except_user))


def invite(conn, settings: Settings, actor: Actor, *, email: str, name: str, roles: list[str],
           board_slot: int | None) -> dict[str, Any]:
    actor.require("admin")
    email = _check_email(email)
    name = (name or "").strip()
    if not name:
        raise bad_request("이름을 입력하세요.", "name_required")
    if one(conn, "SELECT 1 FROM users WHERE email = ?", (email,)):
        raise conflict("이미 가입된 이메일입니다.", "email_taken")
    if board_slot is not None and board_slot not in BOARD_SLOTS:
        raise bad_request("보드 열은 1~4 입니다.", "bad_slot")
    taken = _slot_taken(conn, actor.org_id, board_slot)
    if taken:
        raise conflict(f"{board_slot}열은 {taken['name']} 님이 쓰고 있습니다.", "slot_taken")
    token = new_token()
    ts = datetime.now(timezone.utc)
    cur = conn.execute(
        "INSERT INTO invitations (org_id, email, name, roles, board_slot, token_hash, invited_by, created_at,"
        " expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (actor.org_id, email, name, _clean_roles(roles), board_slot, token_hash(token), actor.user_id,
         ts.isoformat(timespec="seconds"),
         (ts + timedelta(days=settings.invite_days)).isoformat(timespec="seconds")),
    )
    audit.record(conn, actor.org_id, actor.user_id, "member.invite", "invitation", cur.lastrowid,
                 {"email": email, "roles": roles, "board_slot": board_slot})
    bump_rev(conn, actor.org_id)
    return {"id": cur.lastrowid, "token": token, "expires_at": (ts + timedelta(days=settings.invite_days)).isoformat(
        timespec="seconds")}


def _open_invitation(conn, token: str) -> dict[str, Any]:
    inv = one(conn, "SELECT i.*, o.name AS org_name FROM invitations i JOIN organizations o ON o.id = i.org_id"
                    " WHERE i.token_hash = ?", (token_hash(token),))
    if inv is None or inv["accepted_at"] or inv["revoked_at"] or inv["expires_at"] < now_iso():
        raise not_found("유효한 초대")
    return inv


def invitation_preview(conn, token: str) -> dict[str, Any]:
    inv = _open_invitation(conn, token)
    return {"email": inv["email"], "name": inv["name"], "org_name": inv["org_name"],
            "roles": sorted(parse_roles(inv["roles"])), "expires_at": inv["expires_at"]}


def accept_invitation(conn, token: str, password: str) -> int:
    inv = _open_invitation(conn, token)
    _check_password(password)
    if one(conn, "SELECT 1 FROM users WHERE email = ?", (inv["email"],)):
        raise conflict("이미 가입된 이메일입니다.", "email_taken")
    slot = inv["board_slot"]
    if _slot_taken(conn, inv["org_id"], slot):
        slot = None  # slot was filled meanwhile; admin can place the member later
    ts = now_iso()
    user_id = conn.execute("INSERT INTO users (email, name, password_hash, created_at) VALUES (?, ?, ?, ?)",
                           (inv["email"], inv["name"], hash_password(password), ts)).lastrowid
    conn.execute(
        "INSERT INTO memberships (org_id, user_id, roles, board_slot, initials, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        (inv["org_id"], user_id, inv["roles"], slot, default_initials(inv["name"]), ts),
    )
    conn.execute("UPDATE invitations SET accepted_at = ? WHERE id = ?", (ts, inv["id"]))
    audit.record(conn, inv["org_id"], user_id, "member.join", "user", user_id,
                 {"invitation_id": inv["id"], "roles": inv["roles"], "board_slot": slot})
    bump_rev(conn, inv["org_id"])
    return user_id


def list_invitations(conn, actor: Actor) -> list[dict[str, Any]]:
    actor.require("admin")
    return many(conn, "SELECT id, email, name, roles, board_slot, created_at, expires_at FROM invitations"
                      " WHERE org_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?"
                      " ORDER BY id DESC", (actor.org_id, now_iso()))


def revoke_invitation(conn, actor: Actor, invitation_id: int) -> None:
    actor.require("admin")
    inv = one(conn, "SELECT * FROM invitations WHERE id = ? AND org_id = ?", (invitation_id, actor.org_id))
    if inv is None:
        raise not_found("초대")
    conn.execute("UPDATE invitations SET revoked_at = ? WHERE id = ?", (now_iso(), invitation_id))
    audit.record(conn, actor.org_id, actor.user_id, "member.invite_revoke", "invitation", invitation_id, {})
    bump_rev(conn, actor.org_id)


def _open_task_count(conn, org_id: int, user_id: int) -> int:
    return scalar(conn, "SELECT COUNT(*) FROM tasks WHERE org_id = ? AND primary_assignee_id = ?", (org_id, user_id))


def update_member(conn, actor: Actor, user_id: int, *, roles: list[str] | None, board_slot: int | None | str,
                  initials: str | None) -> dict[str, Any]:
    """board_slot: int 1..4, None to clear, or "keep"."""
    actor.require("admin")
    m = get_member(conn, actor.org_id, user_id)
    if m is None or not m["active"]:
        raise not_found("팀원")
    changes: dict[str, Any] = {}
    if roles is not None:
        new_roles = _clean_roles(roles)
        if "admin" in m["roles"] and "admin" not in new_roles:
            admins = scalar(conn, "SELECT COUNT(*) FROM memberships WHERE org_id = ? AND active = 1"
                                  " AND (',' || roles || ',') LIKE '%,admin,%'", (actor.org_id,))
            if admins <= 1:
                raise conflict("마지막 관리자의 관리자 역할은 뺄 수 없습니다.", "last_admin")
        if parse_roles(new_roles) != set(m["roles"]):
            conn.execute("UPDATE memberships SET roles = ? WHERE org_id = ? AND user_id = ?",
                         (new_roles, actor.org_id, user_id))
            changes["roles"] = [m["roles"], sorted(parse_roles(new_roles))]
    if board_slot != "keep" and board_slot != m["board_slot"]:
        if board_slot is None:
            n = _open_task_count(conn, actor.org_id, user_id)
            if n:
                raise conflict(f"주 담당 업무 {n}건을 다른 팀원에게 넘긴 뒤 열에서 뺄 수 있습니다.",
                               "member_has_tasks", {"tasks": n})
            conn.execute("UPDATE memberships SET board_slot = NULL WHERE org_id = ? AND user_id = ?",
                         (actor.org_id, user_id))
        else:
            if board_slot not in BOARD_SLOTS:
                raise bad_request("보드 열은 1~4 입니다.", "bad_slot")
            other = _slot_taken(conn, actor.org_id, board_slot, except_user=user_id)
            if other and m["board_slot"] is None:
                raise conflict(f"{board_slot}열은 {other['name']} 님이 쓰고 있습니다.", "slot_taken")
            old_slot = m["board_slot"]
            conn.execute("UPDATE memberships SET board_slot = NULL WHERE org_id = ? AND user_id = ?",
                         (actor.org_id, user_id))
            if other:  # swap columns: the other member takes this member's old slot
                conn.execute("UPDATE memberships SET board_slot = ? WHERE org_id = ? AND user_id = ?",
                             (old_slot, actor.org_id, other["user_id"]))
            conn.execute("UPDATE memberships SET board_slot = ? WHERE org_id = ? AND user_id = ?",
                         (board_slot, actor.org_id, user_id))
        changes["board_slot"] = [m["board_slot"], board_slot]
    if initials is not None:
        initials = initials.strip()[:3]
        if not initials:
            raise bad_request("이니셜을 입력하세요.", "initials_required")
        if initials != m["initials"]:
            conn.execute("UPDATE memberships SET initials = ? WHERE org_id = ? AND user_id = ?",
                         (initials, actor.org_id, user_id))
            changes["initials"] = [m["initials"], initials]
    if changes:
        audit.record(conn, actor.org_id, actor.user_id, "member.update", "user", user_id, changes)
        bump_rev(conn, actor.org_id)
    return get_member(conn, actor.org_id, user_id)


def deactivate_member(conn, actor: Actor, user_id: int, reassign_to: int | None) -> dict[str, Any]:
    from .tasks import add_event

    actor.require("admin")
    if user_id == actor.user_id:
        raise conflict("자기 자신은 비활성화할 수 없습니다.", "self_deactivate")
    m = get_member(conn, actor.org_id, user_id)
    if m is None or not m["active"]:
        raise not_found("팀원")
    owned = many(conn, "SELECT id FROM tasks WHERE org_id = ? AND primary_assignee_id = ?", (actor.org_id, user_id))
    open_findings = scalar(conn, "SELECT COUNT(*) FROM findings WHERE org_id = ? AND assignee_id = ?"
                                 " AND status = 'open'", (actor.org_id, user_id))
    if owned or open_findings:
        if reassign_to is None:
            raise conflict(f"주 담당 업무 {len(owned)}건과 미조치 지적 {open_findings}건을 넘겨받을 팀원을 고르세요.",
                           "reassign_required", {"tasks": len(owned), "findings": open_findings})
        if reassign_to == user_id:
            raise bad_request("비활성화할 팀원에게 넘길 수 없습니다.", "bad_reassign")
        require_assignable(conn, actor.org_id, reassign_to)
        ts = now_iso()
        for t in owned:
            conn.execute("UPDATE tasks SET primary_assignee_id = ?, version = version + 1, updated_at = ?"
                         " WHERE id = ?", (reassign_to, ts, t["id"]))
            add_event(conn, actor.org_id, t["id"], actor.user_id, "assignee", user_id, reassign_to, "팀원 비활성화")
        conn.execute("UPDATE findings SET assignee_id = ? WHERE org_id = ? AND assignee_id = ? AND status = 'open'",
                     (reassign_to, actor.org_id, user_id))
    conn.execute("UPDATE memberships SET active = 0, board_slot = NULL, deactivated_at = ?"
                 " WHERE org_id = ? AND user_id = ?", (now_iso(), actor.org_id, user_id))
    conn.execute("DELETE FROM site_members WHERE user_id = ?", (user_id,))
    conn.execute("DELETE FROM task_collaborators WHERE user_id = ?", (user_id,))
    conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
    audit.record(conn, actor.org_id, actor.user_id, "member.deactivate", "user", user_id,
                 {"reassign_to": reassign_to, "tasks": len(owned), "findings": open_findings})
    bump_rev(conn, actor.org_id)
    return get_member(conn, actor.org_id, user_id)


# ---------------------------------------------------------------------------
# Sites
# ---------------------------------------------------------------------------

def list_sites(conn, org_id: int, include_archived: bool = False) -> list[dict[str, Any]]:
    return many(
        conn,
        "SELECT s.*,"
        " (SELECT COUNT(*) FROM tasks t WHERE t.site_id = s.id AND t.status <> 'done') AS open_tasks,"
        " (SELECT COUNT(*) FROM assets a WHERE a.site_id = s.id AND a.archived = 0) AS asset_count,"
        " (SELECT COUNT(*) FROM findings f WHERE f.site_id = s.id AND f.status = 'open') AS open_findings"
        " FROM sites s WHERE s.org_id = ?" + ("" if include_archived else " AND s.archived = 0") +
        " ORDER BY s.archived, s.name",
        (org_id,),
    )


def get_site(conn, org_id: int, site_id: int) -> dict[str, Any]:
    s = one(conn, "SELECT * FROM sites WHERE id = ? AND org_id = ?", (site_id, org_id))
    if s is None:
        raise not_found("현장")
    return s


def _site_fields(data: dict[str, Any]) -> dict[str, Any]:
    name = (data.get("name") or "").strip()
    if not name:
        raise bad_request("현장 식별명을 입력하세요.", "name_required")
    years = int(data.get("retention_years") or 4)
    if not 1 <= years <= 50:
        raise bad_request("보관 기간은 1~50년입니다.", "bad_retention")
    return {"name": name, "code": (data.get("code") or "").strip(),
            "description": (data.get("description") or "").strip(), "retention_years": years}


def create_site(conn, actor: Actor, data: dict[str, Any]) -> dict[str, Any]:
    actor.require("admin")
    f = _site_fields(data)
    cur = conn.execute(
        "INSERT INTO sites (org_id, name, code, description, retention_years, created_by, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
        (actor.org_id, f["name"], f["code"], f["description"], f["retention_years"], actor.user_id, now_iso()),
    )
    _set_site_members(conn, actor.org_id, cur.lastrowid, data.get("member_ids") or [])
    audit.record(conn, actor.org_id, actor.user_id, "site.create", "site", cur.lastrowid, f)
    bump_rev(conn, actor.org_id)
    return get_site(conn, actor.org_id, cur.lastrowid)


def update_site(conn, actor: Actor, site_id: int, data: dict[str, Any]) -> dict[str, Any]:
    actor.require("admin")
    get_site(conn, actor.org_id, site_id)
    f = _site_fields(data)
    archived = 1 if data.get("archived") else 0
    conn.execute("UPDATE sites SET name = ?, code = ?, description = ?, retention_years = ?, archived = ?"
                 " WHERE id = ?", (f["name"], f["code"], f["description"], f["retention_years"], archived, site_id))
    if "member_ids" in data:
        _set_site_members(conn, actor.org_id, site_id, data["member_ids"] or [])
    audit.record(conn, actor.org_id, actor.user_id, "site.update", "site", site_id, {**f, "archived": archived})
    bump_rev(conn, actor.org_id)
    return get_site(conn, actor.org_id, site_id)


def _set_site_members(conn, org_id: int, site_id: int, member_ids: list[int]) -> None:
    conn.execute("DELETE FROM site_members WHERE site_id = ?", (site_id,))
    for uid in sorted(set(member_ids)):
        if one(conn, "SELECT 1 FROM memberships WHERE org_id = ? AND user_id = ? AND active = 1", (org_id, uid)):
            conn.execute("INSERT INTO site_members (site_id, user_id) VALUES (?, ?)", (site_id, uid))


def site_detail(conn, org_id: int, site_id: int, tz) -> dict[str, Any]:
    s = get_site(conn, org_id, site_id)
    s["members"] = many(conn, "SELECT u.id, u.name, m.initials, m.board_slot FROM site_members sm"
                              " JOIN users u ON u.id = sm.user_id JOIN memberships m ON m.user_id = u.id"
                              " WHERE sm.site_id = ? ORDER BY u.name", (site_id,))
    oldest = scalar(conn, "SELECT MIN(submitted_at) FROM inspections WHERE site_id = ? AND submitted_at IS NOT NULL",
                    (site_id,))
    s["retention"] = {
        "years": s["retention_years"],
        "oldest_record_at": oldest,
        "policy": f"제출된 점검 기록·보고서·증빙은 제출일로부터 {s['retention_years']}년 보관합니다. "
                  "기간이 지나도 자동 삭제하지 않으며, 만료가 가까운 기록은 관리자에게 표시합니다.",
    }
    if oldest:
        first = datetime.fromisoformat(oldest).astimezone(tz).date()
        s["retention"]["oldest_expires_on"] = _add_years(first, s["retention_years"]).isoformat()
    return s


def site_events(conn, org_id: int, site_id: int, limit: int = 100) -> list[dict[str, Any]]:
    get_site(conn, org_id, site_id)
    return many(
        conn,
        "SELECT e.*, t.title AS task_title, u.name AS actor_name FROM task_events e"
        " JOIN tasks t ON t.id = e.task_id JOIN users u ON u.id = e.actor_id"
        " WHERE t.site_id = ? AND e.org_id = ? ORDER BY e.id DESC LIMIT ?",
        (site_id, org_id, limit),
    )


# ---------------------------------------------------------------------------
# Templates
# ---------------------------------------------------------------------------

def list_templates(conn, org_id: int, include_inactive: bool = False) -> list[dict[str, Any]]:
    out = many(conn, "SELECT * FROM inspection_templates WHERE org_id = ?" +
               ("" if include_inactive else " AND active = 1") + " ORDER BY asset_type, name, version DESC",
               (org_id,))
    for t in out:
        t["items"] = json.loads(t.pop("items_json"))
    return out


def _template_items(items: list[dict[str, Any]]) -> list[dict[str, str]]:
    clean = []
    for n, it in enumerate(items, 1):
        label = (it.get("label") or "").strip()
        if label:
            clean.append({"key": f"i{n:02d}", "section": (it.get("section") or "").strip(), "label": label})
    if not clean:
        raise bad_request("점검 항목을 하나 이상 입력하세요.", "items_required")
    return clean


def create_template(conn, actor: Actor, data: dict[str, Any]) -> dict[str, Any]:
    actor.require("admin")
    name, asset_type = (data.get("name") or "").strip(), (data.get("asset_type") or "").strip()
    if not name or not asset_type:
        raise bad_request("서식 이름과 설비 유형을 입력하세요.", "name_required")
    items = _template_items(data.get("items") or [])
    cur = conn.execute(
        "INSERT INTO inspection_templates (org_id, name, asset_type, version, items_json, created_by, created_at)"
        " VALUES (?, ?, ?, 1, ?, ?, ?)",
        (actor.org_id, name, asset_type, json.dumps(items, ensure_ascii=False), actor.user_id, now_iso()),
    )
    audit.record(conn, actor.org_id, actor.user_id, "template.create", "inspection_template", cur.lastrowid,
                 {"name": name, "items": len(items)})
    bump_rev(conn, actor.org_id)
    return next(t for t in list_templates(conn, actor.org_id) if t["id"] == cur.lastrowid)


def revise_template(conn, actor: Actor, template_id: int, data: dict[str, Any]) -> dict[str, Any]:
    """Templates are immutable: a revision is a new row; assets move to it."""
    actor.require("admin")
    old = one(conn, "SELECT * FROM inspection_templates WHERE id = ? AND org_id = ?", (template_id, actor.org_id))
    if old is None:
        raise not_found("점검 서식")
    items = _template_items(data.get("items") or [])
    name = (data.get("name") or old["name"]).strip()
    cur = conn.execute(
        "INSERT INTO inspection_templates (org_id, name, asset_type, version, items_json, is_sample, created_by,"
        " created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
        (actor.org_id, name, old["asset_type"], old["version"] + 1, json.dumps(items, ensure_ascii=False),
         actor.user_id, now_iso()),
    )
    conn.execute("UPDATE inspection_templates SET active = 0 WHERE id = ?", (template_id,))
    conn.execute("UPDATE assets SET template_id = ? WHERE template_id = ? AND org_id = ?",
                 (cur.lastrowid, template_id, actor.org_id))
    audit.record(conn, actor.org_id, actor.user_id, "template.revise", "inspection_template", cur.lastrowid,
                 {"from": template_id, "version": old["version"] + 1})
    bump_rev(conn, actor.org_id)
    return next(t for t in list_templates(conn, actor.org_id) if t["id"] == cur.lastrowid)


# ---------------------------------------------------------------------------
# Assets
# ---------------------------------------------------------------------------

def _life_status(asset: dict[str, Any], today: date) -> dict[str, Any]:
    if not asset.get("installed_on") or not asset.get("service_life_years"):
        return {"state": "unknown", "ends_on": None, "label": "내용연수 정보 없음"}
    ends = _add_years(date.fromisoformat(asset["installed_on"]), asset["service_life_years"])
    days = (ends - today).days
    if days < 0:
        return {"state": "expired", "ends_on": ends.isoformat(), "label": f"내용연수 경과 ({-days}일)"}
    if days <= SERVICE_LIFE_SOON_DAYS:
        return {"state": "soon", "ends_on": ends.isoformat(), "label": f"내용연수 {days}일 남음"}
    return {"state": "ok", "ends_on": ends.isoformat(), "label": f"내용연수 {ends.isoformat()}까지"}


_ASSET_SELECT = (
    "SELECT a.*, s.name AS site_name, t.name AS template_name, t.version AS template_version,"
    " (SELECT MAX(i.submitted_at) FROM inspections i WHERE i.asset_id = a.id AND i.status <> 'draft')"
    "   AS last_inspected_at"
    " FROM assets a JOIN sites s ON s.id = a.site_id LEFT JOIN inspection_templates t ON t.id = a.template_id"
)


def _decorate_asset(a: dict[str, Any], tz) -> dict[str, Any]:
    today = local_today(tz)
    a["life"] = _life_status(a, today)
    a["next_due_on"] = None
    if a["last_inspected_at"] and a["inspection_interval_days"]:
        last = datetime.fromisoformat(a["last_inspected_at"]).astimezone(tz).date()
        a["next_due_on"] = (last + timedelta(days=a["inspection_interval_days"])).isoformat()
    return a


def list_assets(conn, org_id: int, tz, *, site_id: int | None = None, q: str | None = None,
                include_archived: bool = False) -> list[dict[str, Any]]:
    clauses, params = ["a.org_id = ?"], [org_id]
    if not include_archived:
        clauses.append("a.archived = 0")
    if site_id:
        clauses.append("a.site_id = ?")
        params.append(site_id)
    for term in (q or "").split():
        clauses.append("(a.name LIKE ? OR a.location LIKE ? OR a.asset_type LIKE ? OR s.name LIKE ?)")
        params.extend([f"%{term}%"] * 4)
    return [_decorate_asset(a, tz) for a in many(
        conn, f"{_ASSET_SELECT} WHERE {' AND '.join(clauses)} ORDER BY s.name, a.name", params)]


def get_asset(conn, org_id: int, asset_id: int, tz) -> dict[str, Any]:
    a = one(conn, f"{_ASSET_SELECT} WHERE a.org_id = ? AND a.id = ?", (org_id, asset_id))
    if a is None:
        raise not_found("설비")
    return _decorate_asset(a, tz)


def asset_by_token(conn, org_id: int, token: str, tz) -> dict[str, Any]:
    a = one(conn, f"{_ASSET_SELECT} WHERE a.org_id = ? AND a.public_token = ? AND a.archived = 0", (org_id, token))
    if a is None:
        raise not_found("설비")
    return _decorate_asset(a, tz)


def _asset_fields(conn, org_id: int, data: dict[str, Any]) -> dict[str, Any]:
    name, asset_type = (data.get("name") or "").strip(), (data.get("asset_type") or "").strip()
    if not name or not asset_type:
        raise bad_request("설비 이름과 유형을 입력하세요.", "name_required")
    get_site(conn, org_id, data["site_id"])
    template_id = data.get("template_id")
    if template_id and not one(conn, "SELECT 1 FROM inspection_templates WHERE id = ? AND org_id = ?",
                               (template_id, org_id)):
        raise not_found("점검 서식")
    for key in ("installed_on",):
        if data.get(key):
            date.fromisoformat(data[key])
    return {
        "site_id": data["site_id"], "name": name, "asset_type": asset_type,
        "location": (data.get("location") or "").strip(), "template_id": template_id,
        "installed_on": data.get("installed_on") or None,
        "service_life_years": data.get("service_life_years") or None,
        "inspection_interval_days": data.get("inspection_interval_days") or None,
    }


def create_asset(conn, actor: Actor, data: dict[str, Any], tz) -> dict[str, Any]:
    actor.require("admin")
    f = _asset_fields(conn, actor.org_id, data)
    cur = conn.execute(
        "INSERT INTO assets (org_id, site_id, name, asset_type, location, template_id, public_token, installed_on,"
        " service_life_years, inspection_interval_days, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (actor.org_id, f["site_id"], f["name"], f["asset_type"], f["location"], f["template_id"], new_public_id(),
         f["installed_on"], f["service_life_years"], f["inspection_interval_days"], now_iso()),
    )
    audit.record(conn, actor.org_id, actor.user_id, "asset.create", "asset", cur.lastrowid,
                 {"name": f["name"], "site_id": f["site_id"]})
    bump_rev(conn, actor.org_id)
    return get_asset(conn, actor.org_id, cur.lastrowid, tz)


def update_asset(conn, actor: Actor, asset_id: int, data: dict[str, Any], tz) -> dict[str, Any]:
    actor.require("admin")
    get_asset(conn, actor.org_id, asset_id, tz)
    f = _asset_fields(conn, actor.org_id, data)
    conn.execute(
        "UPDATE assets SET site_id = ?, name = ?, asset_type = ?, location = ?, template_id = ?, installed_on = ?,"
        " service_life_years = ?, inspection_interval_days = ?, archived = ? WHERE id = ?",
        (f["site_id"], f["name"], f["asset_type"], f["location"], f["template_id"], f["installed_on"],
         f["service_life_years"], f["inspection_interval_days"], 1 if data.get("archived") else 0, asset_id),
    )
    audit.record(conn, actor.org_id, actor.user_id, "asset.update", "asset", asset_id, {"name": f["name"]})
    bump_rev(conn, actor.org_id)
    return get_asset(conn, actor.org_id, asset_id, tz)


def rotate_asset_token(conn, actor: Actor, asset_id: int, tz) -> dict[str, Any]:
    actor.require("admin")
    get_asset(conn, actor.org_id, asset_id, tz)
    conn.execute("UPDATE assets SET public_token = ? WHERE id = ?", (new_public_id(), asset_id))
    audit.record(conn, actor.org_id, actor.user_id, "asset.rotate_qr", "asset", asset_id, {})
    bump_rev(conn, actor.org_id)
    return get_asset(conn, actor.org_id, asset_id, tz)
