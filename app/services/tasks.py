"""Tasks, the magnet board projection and the single board aggregate.

board_summary() is the only place task counts are computed. The board column
headers and the dashboard both render its output, so they cannot disagree.
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import date
from typing import Any

from ..db import bump_rev, local_date_of, local_today, many, now_iso, one, scalar
from ..deps import Actor
from ..errors import bad_request, conflict, forbidden, not_found
from .team import BOARD_SLOTS, board_members, require_assignable

STATUSES = ("scheduled", "in_progress", "review", "done")
STATUS_LABELS = {"scheduled": "예정", "in_progress": "진행", "review": "검토", "done": "완료"}
PRIORITIES = ("urgent", "high", "normal", "low")
PRIORITY_LABELS = {"urgent": "긴급", "high": "높음", "normal": "보통", "low": "낮음"}
KINDS = ("general", "inspection", "finding")
EDITABLE_FIELDS = ("title", "description", "site_id", "priority", "due_date", "asset_id")


@dataclass(frozen=True)
class TaskFilter:
    site_id: int | None = None
    assignee_id: int | None = None
    priority: str | None = None
    due_from: date | None = None
    due_to: date | None = None
    kind: str | None = None

    def is_active(self) -> bool:
        return any(v is not None for v in (self.site_id, self.assignee_id, self.priority,
                                           self.due_from, self.due_to, self.kind))

    def describe(self) -> dict[str, Any]:
        return {
            "site_id": self.site_id,
            "assignee_id": self.assignee_id,
            "priority": self.priority,
            "due_from": self.due_from.isoformat() if self.due_from else None,
            "due_to": self.due_to.isoformat() if self.due_to else None,
            "kind": self.kind,
        }


def _where(org_id: int, f: TaskFilter) -> tuple[str, list[Any]]:
    clauses = ["t.org_id = ?"]
    params: list[Any] = [org_id]
    if f.site_id is not None:
        clauses.append("t.site_id = ?")
        params.append(f.site_id)
    if f.assignee_id is not None:
        clauses.append("t.primary_assignee_id = ?")
        params.append(f.assignee_id)
    if f.priority is not None:
        clauses.append("t.priority = ?")
        params.append(f.priority)
    if f.kind is not None:
        clauses.append("t.kind = ?")
        params.append(f.kind)
    if f.due_from is not None:
        clauses.append("t.due_date >= ?")
        params.append(f.due_from.isoformat())
    if f.due_to is not None:
        clauses.append("t.due_date <= ?")
        params.append(f.due_to.isoformat())
    return " AND ".join(clauses), params


def board_summary(conn: sqlite3.Connection, org_id: int, f: TaskFilter, tz) -> dict[str, Any]:
    where, params = _where(org_id, f)
    grouped = many(
        conn,
        f"SELECT t.primary_assignee_id AS user_id, t.status, COUNT(*) AS n FROM tasks t"
        f" WHERE {where} GROUP BY t.primary_assignee_id, t.status",
        params,
    )
    today = local_today(tz).isoformat()
    overdue = scalar(
        conn,
        f"SELECT COUNT(*) FROM tasks t WHERE {where} AND t.status <> 'done'"
        f" AND t.due_date IS NOT NULL AND t.due_date < ?",
        [*params, today],
    )
    due_today = scalar(
        conn,
        f"SELECT COUNT(*) FROM tasks t WHERE {where} AND t.status <> 'done' AND t.due_date = ?",
        [*params, today],
    )
    slots = board_members(conn, org_id)
    per_user: dict[int, int] = {}
    per_status = {s: 0 for s in STATUSES}
    total = 0
    for g in grouped:
        per_user[g["user_id"]] = per_user.get(g["user_id"], 0) + g["n"]
        per_status[g["status"]] += g["n"]
        total += g["n"]
    by_assignee = []
    slotted_total = 0
    for slot in BOARD_SLOTS:
        m = slots.get(slot)
        count = per_user.get(m["id"], 0) if m else 0
        slotted_total += count
        by_assignee.append({
            "slot": slot,
            "user_id": m["id"] if m else None,
            "name": m["name"] if m else None,
            "initials": m["initials"] if m else None,
            "count": count,
        })
    return {
        "total": total,
        "by_assignee": by_assignee,
        "by_status": [{"status": s, "label": STATUS_LABELS[s], "count": per_status[s]} for s in STATUSES],
        # Non-zero only if data drifted (e.g. edited outside the app). Surfaced, never hidden.
        "outside_board": total - slotted_total,
        "overdue": overdue,
        "due_today": due_today,
        "filters": f.describe(),
        "filtered": f.is_active(),
        "computed_at": now_iso(),
    }


_TASK_SELECT = (
    "SELECT t.*, s.name AS site_name, u.name AS assignee_name, m.initials AS assignee_initials,"
    " m.board_slot AS assignee_slot, a.name AS asset_name,"
    " (SELECT COUNT(*) FROM task_check_items c WHERE c.task_id = t.id) AS check_total,"
    " (SELECT COUNT(*) FROM task_check_items c WHERE c.task_id = t.id AND c.done = 1) AS check_done,"
    " (SELECT COUNT(*) FROM task_collaborators tc WHERE tc.task_id = t.id) AS collaborator_count"
    " FROM tasks t JOIN sites s ON s.id = t.site_id JOIN users u ON u.id = t.primary_assignee_id"
    " JOIN memberships m ON m.user_id = u.id LEFT JOIN assets a ON a.id = t.asset_id"
)
_TASK_ORDER = (
    " ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,"
    " t.due_date IS NULL, t.due_date, t.id"
)


def _decorate(t: dict[str, Any], today: str) -> dict[str, Any]:
    t["status_label"] = STATUS_LABELS[t["status"]]
    t["priority_label"] = PRIORITY_LABELS[t["priority"]]
    t["overdue"] = bool(t["due_date"] and t["status"] != "done" and t["due_date"] < today)
    return t


def list_tasks(conn: sqlite3.Connection, org_id: int, f: TaskFilter, tz) -> list[dict[str, Any]]:
    where, params = _where(org_id, f)
    today = local_today(tz).isoformat()
    return [_decorate(t, today) for t in many(conn, f"{_TASK_SELECT} WHERE {where}{_TASK_ORDER}", params)]


def get_task(conn: sqlite3.Connection, org_id: int, task_id: int, tz) -> dict[str, Any]:
    t = one(conn, f"{_TASK_SELECT} WHERE t.org_id = ? AND t.id = ?", (org_id, task_id))
    if t is None:
        raise not_found("업무")
    return _decorate(t, local_today(tz).isoformat())


def task_detail(conn: sqlite3.Connection, org_id: int, task_id: int, tz) -> dict[str, Any]:
    t = get_task(conn, org_id, task_id, tz)
    t["check_items"] = many(
        conn,
        "SELECT c.*, u.name AS done_by_name FROM task_check_items c LEFT JOIN users u ON u.id = c.done_by"
        " WHERE c.task_id = ? ORDER BY c.position, c.id",
        (task_id,),
    )
    t["collaborators"] = many(
        conn,
        "SELECT u.id, u.name, m.initials, m.board_slot FROM task_collaborators tc"
        " JOIN users u ON u.id = tc.user_id JOIN memberships m ON m.user_id = u.id"
        " WHERE tc.task_id = ? ORDER BY u.name",
        (task_id,),
    )
    t["events"] = many(
        conn,
        "SELECT e.*, u.name AS actor_name FROM task_events e JOIN users u ON u.id = e.actor_id"
        " WHERE e.task_id = ? ORDER BY e.id DESC",
        (task_id,),
    )
    t["inspections"] = many(
        conn,
        "SELECT id, status, submitted_at, inspector_id FROM inspections WHERE task_id = ? AND org_id = ?"
        " ORDER BY id DESC",
        (task_id, org_id),
    )
    t["finding"] = one(conn, "SELECT id, status, inspection_id FROM findings WHERE task_id = ?", (task_id,))
    return t


def add_event(conn, org_id: int, task_id: int, actor_id: int, type_: str,
              from_value: Any = None, to_value: Any = None, note: str = "") -> None:
    conn.execute(
        "INSERT INTO task_events (org_id, task_id, actor_id, type, from_value, to_value, note, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (org_id, task_id, actor_id, type_,
         None if from_value is None else str(from_value),
         None if to_value is None else str(to_value), note, now_iso()),
    )


def _require_site(conn, org_id: int, site_id: int) -> dict[str, Any]:
    s = one(conn, "SELECT * FROM sites WHERE id = ? AND org_id = ?", (site_id, org_id))
    if s is None:
        raise not_found("현장")
    return s


def _require_asset(conn, org_id: int, asset_id: int, site_id: int) -> dict[str, Any]:
    a = one(conn, "SELECT * FROM assets WHERE id = ? AND org_id = ?", (asset_id, org_id))
    if a is None:
        raise not_found("설비")
    if a["site_id"] != site_id:
        raise bad_request("설비가 선택한 현장에 속하지 않습니다.", "asset_site_mismatch")
    return a


def _check_version(task: dict[str, Any], version: int | None) -> None:
    if version is not None and version != task["version"]:
        raise conflict(
            "다른 사용자가 먼저 이 업무를 변경했습니다.",
            "version_conflict",
            {"server": task},
        )


def can_change_status(actor: Actor, task: dict[str, Any]) -> bool:
    return actor.has("admin") or (actor.has("worker") and task["primary_assignee_id"] == actor.user_id)


def can_reassign(actor: Actor, task: dict[str, Any]) -> bool:
    # Admins dispatch; a worker may hand over a task they currently own.
    return actor.has("admin") or (actor.has("worker") and task["primary_assignee_id"] == actor.user_id)


def create_task(conn, actor: Actor, data: dict[str, Any], tz) -> dict[str, Any]:
    actor.require("admin", "worker")
    _require_site(conn, actor.org_id, data["site_id"])
    require_assignable(conn, actor.org_id, data["primary_assignee_id"])
    kind = data.get("kind") or "general"
    asset_id = data.get("asset_id")
    if kind == "inspection" and not asset_id:
        raise bad_request("점검 업무에는 설비를 지정해야 합니다.", "asset_required")
    if asset_id:
        _require_asset(conn, actor.org_id, asset_id, data["site_id"])
    status = data.get("status") or "scheduled"
    ts = now_iso()
    cur = conn.execute(
        "INSERT INTO tasks (org_id, site_id, title, description, kind, asset_id, primary_assignee_id,"
        " status, priority, due_date, completed_at, created_by, created_at, updated_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (actor.org_id, data["site_id"], data["title"].strip(), (data.get("description") or "").strip(),
         kind, asset_id, data["primary_assignee_id"], status, data.get("priority") or "normal",
         data.get("due_date"), ts if status == "done" else None, actor.user_id, ts, ts),
    )
    task_id = cur.lastrowid
    add_event(conn, actor.org_id, task_id, actor.user_id, "created", None, status)
    for pos, label in enumerate(data.get("check_items") or []):
        if label.strip():
            conn.execute("INSERT INTO task_check_items (task_id, label, position) VALUES (?, ?, ?)",
                         (task_id, label.strip(), pos))
    bump_rev(conn, actor.org_id)
    return get_task(conn, actor.org_id, task_id, tz)


def change_assignee(conn, actor: Actor, task_id: int, assignee_id: int, version: int | None, tz) -> dict[str, Any]:
    task = get_task(conn, actor.org_id, task_id, tz)
    if not can_reassign(actor, task):
        raise forbidden("관리자 또는 현재 주 담당자만 담당자를 바꿀 수 있습니다.")
    _check_version(task, version)
    if task["primary_assignee_id"] == assignee_id:
        return task
    require_assignable(conn, actor.org_id, assignee_id)
    conn.execute(
        "UPDATE tasks SET primary_assignee_id = ?, version = version + 1, updated_at = ? WHERE id = ?",
        (assignee_id, now_iso(), task_id),
    )
    add_event(conn, actor.org_id, task_id, actor.user_id, "assignee", task["primary_assignee_id"], assignee_id)
    bump_rev(conn, actor.org_id)
    return get_task(conn, actor.org_id, task_id, tz)


def _apply_status(conn, org_id: int, task: dict[str, Any], status: str, actor_id: int, note: str = "") -> None:
    completed_at = task["completed_at"]
    if status == "done" and task["status"] != "done":
        completed_at = now_iso()
    elif status != "done":
        completed_at = None
    conn.execute(
        "UPDATE tasks SET status = ?, completed_at = ?, version = version + 1, updated_at = ? WHERE id = ?",
        (status, completed_at, now_iso(), task["id"]),
    )
    add_event(conn, org_id, task["id"], actor_id, "status", task["status"], status, note)


def change_status(conn, actor: Actor, task_id: int, status: str, version: int | None, tz) -> dict[str, Any]:
    task = get_task(conn, actor.org_id, task_id, tz)
    if not can_change_status(actor, task):
        raise forbidden("관리자 또는 주 담당자만 진행 상태를 바꿀 수 있습니다.")
    _check_version(task, version)
    if task["status"] == status:
        return task
    _apply_status(conn, actor.org_id, task, status, actor.user_id)
    bump_rev(conn, actor.org_id)
    return get_task(conn, actor.org_id, task_id, tz)


def system_status(conn, org_id: int, task_id: int | None, status: str, actor_id: int, note: str) -> None:
    """Workflow-driven transition (inspection submitted / rejected / approved)."""
    if task_id is None:
        return
    task = one(conn, "SELECT * FROM tasks WHERE id = ? AND org_id = ?", (task_id, org_id))
    if task is None or task["status"] == status:
        return
    _apply_status(conn, org_id, task, status, actor_id, note)


def update_task(conn, actor: Actor, task_id: int, changes: dict[str, Any], version: int | None, tz) -> dict[str, Any]:
    actor.require("admin", "worker")
    task = get_task(conn, actor.org_id, task_id, tz)
    _check_version(task, version)
    changes = {k: v for k, v in changes.items() if k in EDITABLE_FIELDS}
    if "title" in changes:
        changes["title"] = (changes["title"] or "").strip()
        if not changes["title"]:
            raise bad_request("제목을 입력하세요.", "title_required")
    site_id = changes.get("site_id", task["site_id"])
    if "site_id" in changes:
        _require_site(conn, actor.org_id, site_id)
    asset_id = changes.get("asset_id", task["asset_id"])
    if asset_id:
        _require_asset(conn, actor.org_id, asset_id, site_id)
    elif task["kind"] == "inspection":
        raise bad_request("점검 업무에는 설비를 지정해야 합니다.", "asset_required")
    diff = {k: v for k, v in changes.items() if task.get(k) != v}
    if not diff:
        return task
    sets = ", ".join(f"{k} = ?" for k in diff)
    conn.execute(
        f"UPDATE tasks SET {sets}, version = version + 1, updated_at = ? WHERE id = ?",
        (*diff.values(), now_iso(), task_id),
    )
    add_event(conn, actor.org_id, task_id, actor.user_id, "edited", None, None, ", ".join(sorted(diff)))
    bump_rev(conn, actor.org_id)
    return get_task(conn, actor.org_id, task_id, tz)


def add_check_item(conn, actor: Actor, task_id: int, label: str, tz) -> dict[str, Any]:
    actor.require("admin", "worker")
    get_task(conn, actor.org_id, task_id, tz)
    label = label.strip()
    if not label:
        raise bad_request("항목 이름을 입력하세요.", "label_required")
    pos = scalar(conn, "SELECT COALESCE(MAX(position), -1) + 1 FROM task_check_items WHERE task_id = ?", (task_id,))
    conn.execute("INSERT INTO task_check_items (task_id, label, position) VALUES (?, ?, ?)", (task_id, label, pos))
    add_event(conn, actor.org_id, task_id, actor.user_id, "check_item", None, label, "추가")
    bump_rev(conn, actor.org_id)
    return task_detail(conn, actor.org_id, task_id, tz)


def set_check_item(conn, actor: Actor, task_id: int, item_id: int, done: bool, tz) -> dict[str, Any]:
    actor.require("admin", "worker")
    get_task(conn, actor.org_id, task_id, tz)
    item = one(conn, "SELECT * FROM task_check_items WHERE id = ? AND task_id = ?", (item_id, task_id))
    if item is None:
        raise not_found("체크 항목")
    if bool(item["done"]) != done:
        conn.execute(
            "UPDATE task_check_items SET done = ?, done_by = ?, done_at = ? WHERE id = ?",
            (int(done), actor.user_id if done else None, now_iso() if done else None, item_id),
        )
        add_event(conn, actor.org_id, task_id, actor.user_id, "check_item", item["label"],
                  "완료" if done else "미완료")
        bump_rev(conn, actor.org_id)
    return task_detail(conn, actor.org_id, task_id, tz)


def set_collaborators(conn, actor: Actor, task_id: int, user_ids: list[int], tz) -> dict[str, Any]:
    actor.require("admin", "worker")
    task = get_task(conn, actor.org_id, task_id, tz)
    wanted = {u for u in user_ids if u != task["primary_assignee_id"]}
    for uid in wanted:
        if one(conn, "SELECT 1 FROM memberships WHERE org_id = ? AND user_id = ? AND active = 1",
               (actor.org_id, uid)) is None:
            raise bad_request("협업자는 활성 팀원이어야 합니다.", "invalid_collaborator")
    conn.execute("DELETE FROM task_collaborators WHERE task_id = ?", (task_id,))
    for uid in sorted(wanted):
        conn.execute("INSERT INTO task_collaborators (task_id, user_id) VALUES (?, ?)", (task_id, uid))
    add_event(conn, actor.org_id, task_id, actor.user_id, "collaborators", None,
              ",".join(str(u) for u in sorted(wanted)))
    bump_rev(conn, actor.org_id)
    return task_detail(conn, actor.org_id, task_id, tz)


def completed_on_time(task: dict[str, Any], tz) -> bool | None:
    if task["status"] != "done" or not task["completed_at"] or not task["due_date"]:
        return None
    return local_date_of(task["completed_at"], tz).isoformat() <= task["due_date"]
