"""/api/kpi, /api/knowledge, /api/dashboard, /api/sync, /api/offline, /api/audit, /files."""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from .. import audit
from ..db import local_today, many, one, scalar, tx
from ..deps import Actor, current_actor, get_conn, get_settings
from ..errors import AppError, forbidden, not_found
from ..security import verify_file_signature
from ..services import files, kpi, knowledge, org, tasks
from ..services.inspections import list_findings, list_inspections
from ..services.team import list_members
from .common import period

router = APIRouter()


class KpiDefinitionInput(BaseModel):
    key: str
    target: float
    weight: float


class KpiDefinitionsBody(BaseModel):
    items: list[KpiDefinitionInput]


class SnapshotBody(BaseModel):
    scope: Literal["team", "user"] = "team"
    user_id: int | None = None
    start: str
    end: str


class KnowledgeBody(BaseModel):
    title: str = Field(max_length=120)
    category: Literal["law", "kec", "ks", "inspection", "education"]
    summary: str = Field(default="", max_length=1000)
    keywords: list[str] | str = ""
    standard_no: str = Field(default="", max_length=60)
    source_name: str = Field(max_length=80)
    source_url: str = Field(max_length=500)
    status: Literal["active", "archived"] = "active"


def _scope_user(actor: Actor, conn, scope: str, user_id: int | None) -> int | None:
    if scope == "team":
        return None
    uid = user_id or actor.user_id
    if one(conn, "SELECT 1 FROM memberships WHERE org_id = ? AND user_id = ?", (actor.org_id, uid)) is None:
        raise not_found("팀원")
    return uid


# --- KPI -----------------------------------------------------------------------

@router.get("/api/kpi/summary")
def kpi_summary(scope: Literal["team", "user"] = "team", user_id: int | None = None, start: str | None = None,
                end: str | None = None, actor: Actor = Depends(current_actor), conn=Depends(get_conn),
                settings=Depends(get_settings)):
    p = period(start, end, settings.tz)
    return kpi.summary(conn, actor.org_id, p, _scope_user(actor, conn, scope, user_id), settings.tz)


@router.get("/api/kpi/drilldown")
def kpi_drilldown(metric: str, scope: Literal["team", "user"] = "team", user_id: int | None = None,
                  start: str | None = None, end: str | None = None, actor: Actor = Depends(current_actor),
                  conn=Depends(get_conn), settings=Depends(get_settings)):
    p = period(start, end, settings.tz)
    return kpi.drilldown(conn, actor.org_id, metric, p, _scope_user(actor, conn, scope, user_id), settings.tz)


@router.get("/api/kpi/definitions")
def kpi_definitions(actor: Actor = Depends(current_actor), conn=Depends(get_conn)):
    history = many(conn, "SELECT a.created_at, a.detail_json, u.name AS actor_name FROM audit_logs a"
                         " LEFT JOIN users u ON u.id = a.actor_id WHERE a.org_id = ? AND a.action = 'kpi.definitions'"
                         " ORDER BY a.id DESC LIMIT 20", (actor.org_id,))
    return {"items": kpi.definitions(conn, actor.org_id), "weight_total": kpi.WEIGHT_TOTAL, "history": history}


@router.put("/api/kpi/definitions")
def update_kpi_definitions(body: KpiDefinitionsBody, actor: Actor = Depends(current_actor), conn=Depends(get_conn)):
    with tx(conn):
        return {"items": kpi.update_definitions(conn, actor, [i.model_dump() for i in body.items])}


@router.get("/api/kpi/snapshots")
def kpi_snapshots(actor: Actor = Depends(current_actor), conn=Depends(get_conn)):
    return {"items": kpi.list_snapshots(conn, actor.org_id)}


@router.post("/api/kpi/snapshots")
def save_kpi_snapshot(body: SnapshotBody, actor: Actor = Depends(current_actor), conn=Depends(get_conn),
                      settings=Depends(get_settings)):
    p = period(body.start, body.end, settings.tz)
    with tx(conn):
        payload = kpi.summary(conn, actor.org_id, p, _scope_user(actor, conn, body.scope, body.user_id), settings.tz)
        return kpi.save_snapshot(conn, actor, payload)


# --- knowledge -----------------------------------------------------------------

@router.get("/api/knowledge")
def knowledge_list(q: str | None = None, category: str | None = None, include_archived: bool = False,
                   actor: Actor = Depends(current_actor), conn=Depends(get_conn), settings=Depends(get_settings)):
    items = knowledge.search(conn, actor.org_id, q=q, category=category, tz=settings.tz,
                             include_archived=include_archived and actor.has("admin"))
    return {"items": items, "categories": knowledge.CATEGORIES, "disclaimer": knowledge.DISCLAIMER}


@router.get("/api/knowledge/recent")
def knowledge_recent(actor: Actor = Depends(current_actor), conn=Depends(get_conn), settings=Depends(get_settings)):
    return {"items": knowledge.recent(conn, actor, settings.tz)}


@router.get("/api/knowledge/{item_id}")
def knowledge_item(item_id: int, actor: Actor = Depends(current_actor), conn=Depends(get_conn),
                   settings=Depends(get_settings)):
    return knowledge.get_item(conn, actor.org_id, item_id, settings.tz)


@router.post("/api/knowledge/{item_id}/view")
def knowledge_view(item_id: int, actor: Actor = Depends(current_actor), conn=Depends(get_conn),
                   settings=Depends(get_settings)):
    with tx(conn):
        knowledge.record_view(conn, actor, item_id, settings.tz)
    return {"ok": True}


@router.post("/api/knowledge")
def knowledge_create(body: KnowledgeBody, actor: Actor = Depends(current_actor), conn=Depends(get_conn),
                     settings=Depends(get_settings)):
    with tx(conn):
        return knowledge.create(conn, actor, body.model_dump(), settings.knowledge_review_days, settings.tz)


@router.patch("/api/knowledge/{item_id}")
def knowledge_update(item_id: int, body: KnowledgeBody, actor: Actor = Depends(current_actor),
                     conn=Depends(get_conn), settings=Depends(get_settings)):
    with tx(conn):
        return knowledge.update(conn, actor, item_id, body.model_dump(), settings.tz)


@router.post("/api/knowledge/{item_id}/verify")
def knowledge_verify(item_id: int, actor: Actor = Depends(current_actor), conn=Depends(get_conn),
                     settings=Depends(get_settings)):
    with tx(conn):
        return knowledge.mark_verified(conn, actor, item_id, settings.knowledge_review_days, settings.tz)


# --- dashboard / sync / offline --------------------------------------------------

@router.get("/api/dashboard")
def dashboard(actor: Actor = Depends(current_actor), conn=Depends(get_conn), settings=Depends(get_settings)):
    """Everything on the dashboard except task counts, which the client reads
    from /api/tasks/board-summary — the same response the board headers use."""
    tz = settings.tz
    today = local_today(tz).isoformat()
    open_tasks = [t for t in tasks.list_tasks(conn, actor.org_id, tasks.TaskFilter(), tz) if t["status"] != "done"]
    today_tasks = [t for t in open_tasks if t["due_date"] == today or t["status"] == "in_progress"]
    members = [m for m in list_members(conn, actor.org_id) if m["board_slot"]]
    return {
        "today": today,
        "today_by_assignee": [
            {"slot": m["board_slot"], "user_id": m["id"], "name": m["name"], "initials": m["initials"],
             "tasks": [t for t in today_tasks if t["primary_assignee_id"] == m["id"]]}
            for m in sorted(members, key=lambda m: m["board_slot"])
        ],
        "overdue": [t for t in open_tasks if t["overdue"]],
        "open_findings": list_findings(conn, actor.org_id, status="open", limit=20),
        "awaiting_review": list_inspections(conn, actor.org_id, status="submitted", limit=20),
        "awaiting_approval": many(
            conn,
            "SELECT r.id, r.version, r.requested_at, r.inspection_id, a.name AS asset_name, s.name AS site_name"
            " FROM reports r JOIN inspections i ON i.id = r.inspection_id JOIN assets a ON a.id = i.asset_id"
            " JOIN sites s ON s.id = i.site_id WHERE r.org_id = ? AND r.status = 'pending'"
            " ORDER BY r.requested_at LIMIT 20",
            (actor.org_id,),
        ),
        "recent_inspections": list_inspections(conn, actor.org_id, status="submitted,reviewed,approved,rejected",
                                               limit=8),
    }


@router.get("/api/sync/rev")
def sync_rev(actor: Actor = Depends(current_actor), conn=Depends(get_conn)):
    return {"rev": scalar(conn, "SELECT rev FROM organizations WHERE id = ?", (actor.org_id,))}


@router.get("/api/offline/bundle")
def offline_bundle(actor: Actor = Depends(current_actor), conn=Depends(get_conn), settings=Depends(get_settings)):
    """What a phone needs to open an asset by QR and inspect it with no signal."""
    assets = org.list_assets(conn, actor.org_id, settings.tz)
    used = {a["template_id"] for a in assets if a["template_id"]}
    templates = [t for t in org.list_templates(conn, actor.org_id, include_inactive=True)
                 if t["active"] or t["id"] in used]
    return {
        "generated_at": scalar(conn, "SELECT strftime('%Y-%m-%dT%H:%M:%S+00:00', 'now')"),
        "sites": org.list_sites(conn, actor.org_id),
        "assets": assets,
        "templates": templates,
        "members": [{k: m[k] for k in ("id", "name", "initials", "board_slot", "roles")}
                    for m in list_members(conn, actor.org_id)],
    }


# --- audit ---------------------------------------------------------------------

@router.get("/api/audit")
def audit_log(entity_type: str | None = None, entity_id: int | None = None, limit: int = 100,
              actor: Actor = Depends(current_actor), conn=Depends(get_conn)):
    if not actor.has("admin", "reviewer"):
        raise forbidden("관리자 또는 검토자만 감사 로그를 볼 수 있습니다.")
    clauses, params = ["a.org_id = ?"], [actor.org_id]
    if entity_type:
        clauses.append("a.entity_type = ?")
        params.append(entity_type)
    if entity_id is not None:
        clauses.append("a.entity_id = ?")
        params.append(entity_id)
    return {"items": many(conn, "SELECT a.*, u.name AS actor_name FROM audit_logs a LEFT JOIN users u"
                                f" ON u.id = a.actor_id WHERE {' AND '.join(clauses)} ORDER BY a.id DESC LIMIT ?",
                          [*params, min(max(limit, 1), 500)])}


@router.get("/api/audit/verify")
def audit_verify(actor: Actor = Depends(current_actor), conn=Depends(get_conn)):
    actor.require("admin")
    return audit.verify_chain(conn, actor.org_id)


# --- signed files ----------------------------------------------------------------

@router.get("/files/{file_id}")
def serve_file(file_id: int, exp: int, sig: str, conn=Depends(get_conn), settings=Depends(get_settings)):
    if not verify_file_signature(settings.secret_key, file_id, exp, sig):
        raise AppError(403, "link_expired", "파일 링크가 만료되었거나 올바르지 않습니다. 화면을 새로고침하세요.")
    att = one(conn, "SELECT * FROM attachments WHERE id = ?", (file_id,))
    if att is None:
        raise not_found("파일")
    inline = att["mime"].startswith(files.INLINE_PREFIXES)
    headers = {"Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff"}
    if att["mime"] != "application/pdf":
        headers["Content-Security-Policy"] = "default-src 'none'; img-src 'self'; media-src 'self'; sandbox"
    return FileResponse(files.absolute_path(settings, att), media_type=att["mime"], filename=att["filename"],
                        content_disposition_type="inline" if inline else "attachment", headers=headers)
