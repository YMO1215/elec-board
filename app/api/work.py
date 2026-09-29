"""/api/sites, /api/tasks — sites and the magnet board."""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from ..db import tx
from ..deps import Actor, current_actor, get_conn, get_settings
from ..services import org, tasks
from ..services.inspections import list_findings, list_inspections
from .common import parse_date, task_filter

router = APIRouter(prefix="/api")

Status = Literal["scheduled", "in_progress", "review", "done"]
Priority = Literal["urgent", "high", "normal", "low"]


class SiteBody(BaseModel):
    name: str = Field(max_length=80)
    code: str = Field(default="", max_length=30)
    description: str = Field(default="", max_length=1000)
    retention_years: int = 4
    archived: bool = False
    member_ids: list[int] | None = None


class TaskCreate(BaseModel):
    site_id: int
    title: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=4000)
    kind: Literal["general", "inspection"] = "general"
    asset_id: int | None = None
    primary_assignee_id: int
    status: Status = "scheduled"
    priority: Priority = "normal"
    due_date: str | None = None
    check_items: list[str] = Field(default_factory=list, max_length=50)


class TaskPatch(BaseModel):
    version: int
    title: str | None = Field(default=None, max_length=120)
    description: str | None = Field(default=None, max_length=4000)
    site_id: int | None = None
    asset_id: int | None = None
    priority: Priority | None = None
    due_date: str | None = None
    clear_due_date: bool = False


class AssigneeBody(BaseModel):
    assignee_id: int
    version: int | None = None


class StatusBody(BaseModel):
    status: Status
    version: int | None = None


class CheckItemBody(BaseModel):
    label: str = Field(min_length=1, max_length=120)


class CheckItemPatch(BaseModel):
    done: bool


class CollaboratorsBody(BaseModel):
    user_ids: list[int] = Field(max_length=10)


# --- sites -------------------------------------------------------------------

@router.get("/sites")
def sites(include_archived: bool = False, actor: Actor = Depends(current_actor), conn=Depends(get_conn)):
    return {"items": org.list_sites(conn, actor.org_id, include_archived)}


@router.post("/sites")
def create_site(body: SiteBody, actor: Actor = Depends(current_actor), conn=Depends(get_conn)):
    with tx(conn):
        return org.create_site(conn, actor, body.model_dump())


@router.get("/sites/{site_id}")
def site(site_id: int, actor: Actor = Depends(current_actor), conn=Depends(get_conn), settings=Depends(get_settings)):
    return org.site_detail(conn, actor.org_id, site_id, settings.tz)


@router.patch("/sites/{site_id}")
def update_site(site_id: int, body: SiteBody, actor: Actor = Depends(current_actor), conn=Depends(get_conn)):
    data = body.model_dump()
    if body.member_ids is None:
        data.pop("member_ids")
    with tx(conn):
        return org.update_site(conn, actor, site_id, data)


@router.get("/sites/{site_id}/tasks")
def site_tasks(site_id: int, actor: Actor = Depends(current_actor), conn=Depends(get_conn),
               settings=Depends(get_settings)):
    org.get_site(conn, actor.org_id, site_id)
    f = tasks.TaskFilter(site_id=site_id)
    return {"items": tasks.list_tasks(conn, actor.org_id, f, settings.tz),
            "summary": tasks.board_summary(conn, actor.org_id, f, settings.tz)}


@router.get("/sites/{site_id}/events")
def site_events(site_id: int, actor: Actor = Depends(current_actor), conn=Depends(get_conn)):
    return {"items": org.site_events(conn, actor.org_id, site_id)}


@router.get("/sites/{site_id}/overview")
def site_overview(site_id: int, actor: Actor = Depends(current_actor), conn=Depends(get_conn),
                  settings=Depends(get_settings)):
    """Everything the site detail tabs need, in one round trip."""
    org.get_site(conn, actor.org_id, site_id)
    return {
        "site": org.site_detail(conn, actor.org_id, site_id, settings.tz),
        "assets": org.list_assets(conn, actor.org_id, settings.tz, site_id=site_id),
        # Drafts belong to their author's device until submitted; not site records yet.
        "inspections": list_inspections(conn, actor.org_id, site_id=site_id,
                                        status="submitted,reviewed,approved,rejected"),
        "findings": list_findings(conn, actor.org_id, site_id=site_id),
    }


# --- tasks / board -------------------------------------------------------------

@router.get("/tasks/board-summary")
def board_summary(site_id: int | None = None, assignee_id: int | None = None, priority: str | None = None,
                  due_from: str | None = None, due_to: str | None = None, kind: str | None = None,
                  actor: Actor = Depends(current_actor), conn=Depends(get_conn), settings=Depends(get_settings)):
    """The single aggregate behind board column counts AND dashboard task numbers."""
    f = task_filter(site_id, assignee_id, priority, due_from, due_to, kind)
    return tasks.board_summary(conn, actor.org_id, f, settings.tz)


@router.get("/tasks/board")
def board(site_id: int | None = None, assignee_id: int | None = None, priority: str | None = None,
          due_from: str | None = None, due_to: str | None = None, kind: str | None = None,
          actor: Actor = Depends(current_actor), conn=Depends(get_conn), settings=Depends(get_settings)):
    f = task_filter(site_id, assignee_id, priority, due_from, due_to, kind)
    items = tasks.list_tasks(conn, actor.org_id, f, settings.tz)
    for t in items:
        t["can_move_status"] = tasks.can_change_status(actor, t)
        t["can_reassign"] = tasks.can_reassign(actor, t)
    return {"items": items, "summary": tasks.board_summary(conn, actor.org_id, f, settings.tz)}


@router.post("/tasks")
def create_task(body: TaskCreate, actor: Actor = Depends(current_actor), conn=Depends(get_conn),
                settings=Depends(get_settings)):
    data = body.model_dump()
    if data["due_date"]:
        data["due_date"] = parse_date(data["due_date"], "due_date").isoformat()
    with tx(conn):
        return tasks.create_task(conn, actor, data, settings.tz)


@router.get("/tasks/{task_id}")
def task(task_id: int, actor: Actor = Depends(current_actor), conn=Depends(get_conn), settings=Depends(get_settings)):
    t = tasks.task_detail(conn, actor.org_id, task_id, settings.tz)
    t["can_move_status"] = tasks.can_change_status(actor, t)
    t["can_reassign"] = tasks.can_reassign(actor, t)
    return t


@router.patch("/tasks/{task_id}")
def update_task(task_id: int, body: TaskPatch, actor: Actor = Depends(current_actor), conn=Depends(get_conn),
                settings=Depends(get_settings)):
    changes = body.model_dump(exclude_unset=True, exclude={"version", "clear_due_date"})
    if changes.get("due_date"):
        changes["due_date"] = parse_date(changes["due_date"], "due_date").isoformat()
    if body.clear_due_date:
        changes["due_date"] = None
    with tx(conn):
        return tasks.update_task(conn, actor, task_id, changes, body.version, settings.tz)


@router.patch("/tasks/{task_id}/assignee")
def change_assignee(task_id: int, body: AssigneeBody, actor: Actor = Depends(current_actor),
                    conn=Depends(get_conn), settings=Depends(get_settings)):
    with tx(conn):
        return tasks.change_assignee(conn, actor, task_id, body.assignee_id, body.version, settings.tz)


@router.patch("/tasks/{task_id}/status")
def change_status(task_id: int, body: StatusBody, actor: Actor = Depends(current_actor),
                  conn=Depends(get_conn), settings=Depends(get_settings)):
    with tx(conn):
        return tasks.change_status(conn, actor, task_id, body.status, body.version, settings.tz)


@router.post("/tasks/{task_id}/check-items")
def add_check_item(task_id: int, body: CheckItemBody, actor: Actor = Depends(current_actor),
                   conn=Depends(get_conn), settings=Depends(get_settings)):
    with tx(conn):
        return tasks.add_check_item(conn, actor, task_id, body.label, settings.tz)


@router.patch("/tasks/{task_id}/check-items/{item_id}")
def set_check_item(task_id: int, item_id: int, body: CheckItemPatch, actor: Actor = Depends(current_actor),
                   conn=Depends(get_conn), settings=Depends(get_settings)):
    with tx(conn):
        return tasks.set_check_item(conn, actor, task_id, item_id, body.done, settings.tz)


@router.put("/tasks/{task_id}/collaborators")
def set_collaborators(task_id: int, body: CollaboratorsBody, actor: Actor = Depends(current_actor),
                      conn=Depends(get_conn), settings=Depends(get_settings)):
    with tx(conn):
        return tasks.set_collaborators(conn, actor, task_id, body.user_ids, settings.tz)
