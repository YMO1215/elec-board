"""Inspection lifecycle: draft -> submitted -> (rejected | reviewed) -> approved.

Once submitted, an inspection's content is frozen (enforced again by SQLite
triggers in schema.sql). A correction is a new inspection whose corrects_id
points at the original; the original is never merged or edited.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import timedelta
from typing import Any

from .. import audit
from ..config import Settings
from ..db import bump_rev, local_today, many, now_iso, one, scalar
from ..deps import Actor
from ..errors import bad_request, conflict, forbidden, not_found
from . import files, tasks
from .team import require_assignable

RESULTS = ("good", "bad", "na")
RESULT_LABELS = {"good": "양호", "bad": "불량", "na": "해당없음"}
STATUS_LABELS = {
    "draft": "작성 중",
    "submitted": "제출됨",
    "rejected": "반려",
    "reviewed": "검토 완료",
    "approved": "승인",
}
EVIDENCE_OWNER_TYPES = ("inspection", "inspection_item", "signature")
DEFAULT_FINDING_DAYS = 7


def template_items(template: dict[str, Any]) -> list[dict[str, Any]]:
    return json.loads(template["items_json"])


def get_inspection(conn: sqlite3.Connection, org_id: int, inspection_id: int) -> dict[str, Any]:
    r = one(conn, "SELECT * FROM inspections WHERE id = ? AND org_id = ?", (inspection_id, org_id))
    if r is None:
        raise not_found("점검")
    return r


def _items(conn, inspection_id: int) -> list[dict[str, Any]]:
    return many(conn, "SELECT * FROM inspection_items WHERE inspection_id = ? ORDER BY position",
                (inspection_id,))


def chain_root(conn, inspection: dict[str, Any]) -> int:
    current = inspection
    seen = set()
    while current["corrects_id"] and current["id"] not in seen:
        seen.add(current["id"])
        current = one(conn, "SELECT id, corrects_id FROM inspections WHERE id = ?", (current["corrects_id"],))
    return current["id"]


def _chain_ids(conn, root_id: int) -> list[int]:
    return [r["id"] for r in many(
        conn,
        "WITH RECURSIVE chain(id) AS (SELECT ? UNION ALL SELECT i.id FROM inspections i"
        " JOIN chain c ON i.corrects_id = c.id) SELECT id FROM chain",
        (root_id,),
    )]


# ---------------------------------------------------------------------------
# Drafts
# ---------------------------------------------------------------------------

def create_draft(conn, actor: Actor, *, client_id: str, asset_id: int | None, task_id: int | None,
                 corrects_id: int | None, tz) -> dict[str, Any]:
    actor.require("admin", "worker")
    existing = one(conn, "SELECT * FROM inspections WHERE client_id = ?", (client_id,))
    if existing is not None:
        if existing["org_id"] != actor.org_id or existing["inspector_id"] != actor.user_id:
            raise conflict("같은 작성 키가 이미 다른 점검에 쓰였습니다.", "client_id_reused")
        return existing  # idempotent replay from the offline queue

    source_items: list[dict[str, Any]]
    if corrects_id is not None:
        original = get_inspection(conn, actor.org_id, corrects_id)
        if original["status"] == "draft":
            raise bad_request("제출되지 않은 점검은 정정할 수 없습니다.", "not_submitted")
        asset_id = original["asset_id"]
        task_id = original["task_id"]
        template_id = original["template_id"]
        source_items = _items(conn, original["id"])
    else:
        if asset_id is None:
            raise bad_request("설비를 선택하세요.", "asset_required")
        asset = one(conn, "SELECT * FROM assets WHERE id = ? AND org_id = ?", (asset_id, actor.org_id))
        if asset is None:
            raise not_found("설비")
        if not asset["template_id"]:
            raise bad_request("이 설비에 점검 서식이 지정되지 않았습니다.", "template_missing")
        template_id = asset["template_id"]
        template = one(conn, "SELECT * FROM inspection_templates WHERE id = ? AND org_id = ?",
                       (template_id, actor.org_id))
        source_items = [
            {"item_key": it["key"], "section": it.get("section", ""), "label": it["label"],
             "result": None, "memo": "", "gps_lat": None, "gps_lng": None}
            for it in template_items(template)
        ]
    asset = one(conn, "SELECT * FROM assets WHERE id = ? AND org_id = ?", (asset_id, actor.org_id))
    if task_id is not None:
        task = one(conn, "SELECT * FROM tasks WHERE id = ? AND org_id = ?", (task_id, actor.org_id))
        if task is None:
            raise not_found("업무")
        if task["asset_id"] and task["asset_id"] != asset_id:
            raise bad_request("업무의 설비와 점검 설비가 다릅니다.", "asset_task_mismatch")

    ts = now_iso()
    cur = conn.execute(
        "INSERT INTO inspections (org_id, site_id, asset_id, template_id, task_id, client_id, inspector_id,"
        " corrects_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (actor.org_id, asset["site_id"], asset_id, template_id, task_id, client_id, actor.user_id,
         corrects_id, ts, ts),
    )
    inspection_id = cur.lastrowid
    for pos, it in enumerate(source_items):
        conn.execute(
            "INSERT INTO inspection_items (inspection_id, item_key, section, label, position, result, memo,"
            " gps_lat, gps_lng) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (inspection_id, it["item_key"], it.get("section", ""), it["label"], pos, it.get("result"),
             it.get("memo") or "", it.get("gps_lat"), it.get("gps_lng")),
        )
    if task_id is not None:
        task = one(conn, "SELECT * FROM tasks WHERE id = ?", (task_id,))
        if task["status"] == "scheduled":
            tasks.system_status(conn, actor.org_id, task_id, "in_progress", actor.user_id, "점검 시작")
    if corrects_id is not None:
        audit.record(conn, actor.org_id, actor.user_id, "inspection.correction_started", "inspection",
                     inspection_id, {"corrects_id": corrects_id})
    bump_rev(conn, actor.org_id)
    return get_inspection(conn, actor.org_id, inspection_id)


def _require_own_draft(actor: Actor, insp: dict[str, Any]) -> None:
    if insp["inspector_id"] != actor.user_id:
        raise forbidden("작성자만 이 점검을 수정할 수 있습니다.")
    if insp["status"] != "draft":
        raise conflict("제출된 점검은 수정할 수 없습니다. 정정본을 작성하세요.", "immutable")


def _apply_items(conn, inspection_id: int, items: list[dict[str, Any]]) -> None:
    known = {r["item_key"] for r in _items(conn, inspection_id)}
    for it in items:
        key = it.get("item_key")
        if key not in known:
            raise bad_request(f"서식에 없는 항목입니다: {key}", "unknown_item")
        result = it.get("result")
        if result is not None and result not in RESULTS:
            raise bad_request("판정은 양호/불량/해당없음 중 하나입니다.", "bad_result")
        conn.execute(
            "UPDATE inspection_items SET result = ?, memo = ?, gps_lat = ?, gps_lng = ?"
            " WHERE inspection_id = ? AND item_key = ?",
            (result, (it.get("memo") or "").strip(), it.get("gps_lat"), it.get("gps_lng"),
             inspection_id, key),
        )


def _draft_view(conn, insp: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": insp["id"],
        "client_id": insp["client_id"],
        "draft_version": insp["draft_version"],
        "summary_note": insp["summary_note"],
        "items": [{k: r[k] for k in ("item_key", "result", "memo", "gps_lat", "gps_lng")}
                  for r in _items(conn, insp["id"])],
        "updated_at": insp["updated_at"],
    }


def save_draft(conn, actor: Actor, inspection_id: int, *, base_version: int, items: list[dict[str, Any]],
               summary_note: str | None, force: bool) -> dict[str, Any]:
    insp = get_inspection(conn, actor.org_id, inspection_id)
    _require_own_draft(actor, insp)
    if base_version != insp["draft_version"] and not force:
        raise conflict("다른 기기에서 저장한 내용과 다릅니다. 어느 쪽을 남길지 고르세요.",
                       "draft_conflict", {"server": _draft_view(conn, insp)})
    _apply_items(conn, inspection_id, items)
    conn.execute(
        "UPDATE inspections SET summary_note = ?, draft_version = draft_version + 1, updated_at = ?"
        " WHERE id = ?",
        ((summary_note or "").strip(), now_iso(), inspection_id),
    )
    return _draft_view(conn, get_inspection(conn, actor.org_id, inspection_id))


def delete_draft(conn, settings: Settings, actor: Actor, inspection_id: int) -> None:
    insp = get_inspection(conn, actor.org_id, inspection_id)
    _require_own_draft(actor, insp)
    for att in many(conn, "SELECT * FROM attachments WHERE owner_type IN ('inspection','inspection_item',"
                          "'signature') AND owner_id = ?", (inspection_id,)):
        conn.execute("DELETE FROM attachments WHERE id = ?", (att["id"],))
        files.absolute_path(settings, att).unlink(missing_ok=True)
    conn.execute("DELETE FROM inspection_items WHERE inspection_id = ?", (inspection_id,))
    conn.execute("DELETE FROM inspections WHERE id = ?", (inspection_id,))
    bump_rev(conn, actor.org_id)


# ---------------------------------------------------------------------------
# Submission
# ---------------------------------------------------------------------------

def _evidence(conn, inspection_id: int) -> list[dict[str, Any]]:
    return many(
        conn,
        "SELECT * FROM attachments WHERE owner_id = ? AND owner_type IN ('inspection','inspection_item',"
        "'signature') ORDER BY id",
        (inspection_id,),
    )


def content_hash(conn, insp: dict[str, Any]) -> str:
    """SHA-256 over the canonical submitted content, including evidence file hashes."""
    payload = {
        "inspection_id": insp["id"],
        "client_id": insp["client_id"],
        "asset_id": insp["asset_id"],
        "template_id": insp["template_id"],
        "inspector_id": insp["inspector_id"],
        "corrects_id": insp["corrects_id"],
        "submitted_at": insp["submitted_at"],
        "gps": [insp["gps_lat"], insp["gps_lng"], insp["gps_accuracy"]],
        "signer_name": insp["signer_name"],
        "summary_note": insp["summary_note"],
        "items": [{k: r[k] for k in ("item_key", "section", "label", "result", "memo", "gps_lat", "gps_lng")}
                  for r in _items(conn, insp["id"])],
        "evidence": sorted(
            [{"owner_type": a["owner_type"], "item_key": a["item_key"], "sha256": a["sha256"]}
             for a in _evidence(conn, insp["id"])],
            key=lambda a: (a["owner_type"], a["item_key"] or "", a["sha256"]),
        ),
    }
    return hashlib.sha256(audit.canonical_json(payload).encode("utf-8")).hexdigest()


def submit(conn, actor: Actor, inspection_id: int, body: dict[str, Any], tz) -> dict[str, Any]:
    insp = get_inspection(conn, actor.org_id, inspection_id)
    submit_key = body["submit_key"]
    if insp["status"] != "draft":
        if insp["submit_key"] == submit_key:
            return insp  # idempotent replay: already stored, do nothing twice
        raise conflict("이미 제출된 점검입니다.", "already_submitted")
    _require_own_draft(actor, insp)
    base_version = body.get("base_version")
    if base_version is not None and base_version != insp["draft_version"] and not body.get("force"):
        raise conflict("다른 기기에서 저장한 내용과 다릅니다. 어느 쪽을 남길지 고르세요.",
                       "draft_conflict", {"server": _draft_view(conn, insp)})
    if one(conn, "SELECT 1 FROM inspections WHERE submit_key = ?", (submit_key,)):
        raise conflict("제출 키가 이미 사용되었습니다.", "submit_key_reused")

    _apply_items(conn, inspection_id, body.get("items") or [])
    items = _items(conn, inspection_id)
    missing = [r["item_key"] for r in items if r["result"] is None]
    if missing:
        raise bad_request("판정하지 않은 항목이 있습니다.", "items_incomplete", {"items": missing})
    bad_without_memo = [r["item_key"] for r in items if r["result"] == "bad" and not r["memo"]]
    if bad_without_memo:
        raise bad_request("불량 항목에는 메모(지적 내용)를 남겨야 합니다.", "bad_memo_required",
                          {"items": bad_without_memo})
    signer_name = (body.get("signer_name") or "").strip()
    signature_id = body.get("signature_attachment_id")
    signature = one(conn, "SELECT * FROM attachments WHERE id = ? AND owner_type = 'signature' AND owner_id = ?",
                    (signature_id, inspection_id)) if signature_id else None
    if not signer_name or signature is None:
        raise bad_request("서명자 이름과 전자서명이 필요합니다.", "signature_required")

    gps = body.get("gps") or {}
    ts = now_iso()
    conn.execute(
        "UPDATE inspections SET gps_lat = ?, gps_lng = ?, gps_accuracy = ?, signer_name = ?,"
        " signature_attachment_id = ?, summary_note = ?, updated_at = ? WHERE id = ?",
        (gps.get("lat"), gps.get("lng"), gps.get("accuracy"), signer_name, signature_id,
         (body.get("summary_note") or insp["summary_note"] or "").strip(), ts, inspection_id),
    )
    conn.execute("UPDATE inspections SET submitted_at = ?, submit_key = ? WHERE id = ?",
                 (ts, submit_key, inspection_id))
    frozen = get_inspection(conn, actor.org_id, inspection_id)
    digest = content_hash(conn, frozen)
    # Single UPDATE flips status and stores the hash; from here the triggers freeze the row.
    conn.execute("UPDATE inspections SET content_hash = ?, status = 'submitted' WHERE id = ?",
                 (digest, inspection_id))

    asset = one(conn, "SELECT * FROM assets WHERE id = ?", (insp["asset_id"],))
    finding_options = {f["item_key"]: f for f in body.get("findings") or []}
    today = local_today(tz)
    created_findings = []
    for r in items:
        if r["result"] != "bad":
            continue
        opt = finding_options.get(r["item_key"], {})
        assignee_id = opt.get("assignee_id") or actor.user_id
        require_assignable(conn, actor.org_id, assignee_id)
        due = opt.get("due_date") or (today + timedelta(days=DEFAULT_FINDING_DAYS)).isoformat()
        cur = conn.execute(
            "INSERT INTO findings (org_id, site_id, inspection_id, item_key, description, assignee_id, due_date,"
            " created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (actor.org_id, insp["site_id"], inspection_id, r["item_key"], r["memo"], assignee_id, due, ts),
        )
        finding_id = cur.lastrowid
        follow_up = tasks.create_task(conn, actor, {
            "site_id": insp["site_id"],
            "title": f"[지적 조치] {asset['name']} · {r['label']}",
            "description": r["memo"],
            "kind": "finding",
            "asset_id": insp["asset_id"],
            "primary_assignee_id": assignee_id,
            "priority": "high",
            "due_date": due,
        }, tz)
        conn.execute("UPDATE findings SET task_id = ? WHERE id = ?", (follow_up["id"], finding_id))
        created_findings.append(finding_id)

    tasks.system_status(conn, actor.org_id, insp["task_id"], "review", actor.user_id, "점검 제출")
    audit.record(conn, actor.org_id, actor.user_id, "inspection.submit", "inspection", inspection_id,
                 {"content_hash": digest, "corrects_id": insp["corrects_id"], "findings": created_findings})
    bump_rev(conn, actor.org_id)
    return get_inspection(conn, actor.org_id, inspection_id)


# ---------------------------------------------------------------------------
# Review and report approval
# ---------------------------------------------------------------------------

def review(conn, actor: Actor, inspection_id: int, *, decision: str, comment: str,
           item_comments: dict[str, str]) -> dict[str, Any]:
    actor.require("reviewer")
    insp = get_inspection(conn, actor.org_id, inspection_id)
    if insp["status"] != "submitted":
        raise conflict("검토 대기 중인 점검이 아닙니다.", "not_reviewable")
    if insp["inspector_id"] == actor.user_id:
        raise forbidden("자신이 작성한 점검은 검토할 수 없습니다.")
    comment = (comment or "").strip()
    if decision == "rejected" and not comment:
        raise bad_request("반려 사유를 입력하세요.", "reason_required")
    known = {r["item_key"] for r in _items(conn, inspection_id)}
    item_comments = {k: v.strip() for k, v in (item_comments or {}).items() if k in known and v.strip()}
    ts = now_iso()
    conn.execute(
        "INSERT INTO inspection_reviews (inspection_id, reviewer_id, decision, comment, item_comments_json,"
        " created_at) VALUES (?, ?, ?, ?, ?, ?)",
        (inspection_id, actor.user_id, decision, comment, json.dumps(item_comments, ensure_ascii=False), ts),
    )
    conn.execute("UPDATE inspections SET status = ? WHERE id = ?", (decision, inspection_id))
    if decision == "reviewed":
        root = chain_root(conn, insp)
        chain = _chain_ids(conn, root)
        version = scalar(
            conn,
            f"SELECT COUNT(*) FROM reports WHERE inspection_id IN ({','.join('?' * len(chain))})",
            chain,
        ) + 1
        conn.execute(
            "INSERT INTO reports (org_id, inspection_id, version, requested_by, requested_at, content_hash)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (actor.org_id, inspection_id, version, actor.user_id, ts, insp["content_hash"]),
        )
    else:
        tasks.system_status(conn, actor.org_id, insp["task_id"], "in_progress", actor.user_id, "점검 반려")
    audit.record(conn, actor.org_id, actor.user_id, f"inspection.{decision}", "inspection", inspection_id,
                 {"comment": comment, "content_hash": insp["content_hash"]})
    bump_rev(conn, actor.org_id)
    return get_inspection(conn, actor.org_id, inspection_id)


def decide_report(conn, settings: Settings, actor: Actor, report_id: int, *, approve: bool,
                  comment: str) -> dict[str, Any]:
    from . import pdf  # local import: reportlab is only needed here

    actor.require("admin")
    report = one(conn, "SELECT * FROM reports WHERE id = ? AND org_id = ?", (report_id, actor.org_id))
    if report is None:
        raise not_found("보고서")
    if report["status"] != "pending":
        raise conflict("이미 처리된 보고서입니다.", "already_decided")
    insp = get_inspection(conn, actor.org_id, report["inspection_id"])
    comment = (comment or "").strip()
    ts = now_iso()
    if not approve:
        if not comment:
            raise bad_request("반려 사유를 입력하세요.", "reason_required")
        conn.execute(
            "UPDATE reports SET status = 'rejected', decided_by = ?, decided_at = ?, decision_comment = ?"
            " WHERE id = ?",
            (actor.user_id, ts, comment, report_id),
        )
        conn.execute("UPDATE inspections SET status = 'rejected' WHERE id = ?", (insp["id"],))
        tasks.system_status(conn, actor.org_id, insp["task_id"], "in_progress", actor.user_id, "보고서 반려")
        audit.record(conn, actor.org_id, actor.user_id, "report.reject", "report", report_id,
                     {"inspection_id": insp["id"], "comment": comment, "content_hash": report["content_hash"]})
        bump_rev(conn, actor.org_id)
        return one(conn, "SELECT * FROM reports WHERE id = ?", (report_id,))

    detail = inspection_detail(conn, settings, actor.org_id, insp["id"], sign_urls=False)
    pdf_bytes = pdf.build_report(settings, detail, {
        **report,
        "approver_name": actor.name,
        "approved_at": ts,
    })
    att = files.store(
        conn, settings, org_id=actor.org_id, owner_type="report", owner_id=report_id, item_key=None,
        filename=f"inspection-{insp['id']}-report-v{report['version']}.pdf", mime="application/pdf",
        data=pdf_bytes, uploaded_by=actor.user_id,
    )
    conn.execute(
        "UPDATE reports SET status = 'approved', decided_by = ?, decided_at = ?, decision_comment = ?,"
        " pdf_attachment_id = ? WHERE id = ?",
        (actor.user_id, ts, comment, att["id"], report_id),
    )
    conn.execute("UPDATE inspections SET status = 'approved' WHERE id = ?", (insp["id"],))
    tasks.system_status(conn, actor.org_id, insp["task_id"], "done", actor.user_id, "보고서 승인")
    audit.record(conn, actor.org_id, actor.user_id, "report.approve", "report", report_id, {
        "inspection_id": insp["id"],
        "version": report["version"],
        "content_hash": report["content_hash"],
        "pdf_sha256": att["sha256"],
    })
    bump_rev(conn, actor.org_id)
    return one(conn, "SELECT * FROM reports WHERE id = ?", (report_id,))


# ---------------------------------------------------------------------------
# Findings
# ---------------------------------------------------------------------------

def resolve_finding(conn, actor: Actor, finding_id: int, note: str) -> dict[str, Any]:
    actor.require("admin", "worker")
    f = one(conn, "SELECT * FROM findings WHERE id = ? AND org_id = ?", (finding_id, actor.org_id))
    if f is None:
        raise not_found("지적사항")
    if f["status"] == "resolved":
        raise conflict("이미 조치 완료된 지적입니다.", "already_resolved")
    if not actor.has("admin") and f["assignee_id"] != actor.user_id:
        raise forbidden("관리자 또는 지적 담당자만 조치를 등록할 수 있습니다.")
    note = (note or "").strip()
    if not note:
        raise bad_request("조치 내용을 입력하세요.", "note_required")
    ts = now_iso()
    conn.execute(
        "UPDATE findings SET status = 'resolved', resolution_note = ?, resolved_by = ?, resolved_at = ?"
        " WHERE id = ?",
        (note, actor.user_id, ts, finding_id),
    )
    tasks.system_status(conn, actor.org_id, f["task_id"], "done", actor.user_id, "지적 조치 완료")
    audit.record(conn, actor.org_id, actor.user_id, "finding.resolve", "finding", finding_id, {"note": note})
    bump_rev(conn, actor.org_id)
    return one(conn, "SELECT * FROM findings WHERE id = ?", (finding_id,))


def list_findings(conn, org_id: int, *, status: str | None = None, site_id: int | None = None,
                  assignee_id: int | None = None, inspection_id: int | None = None,
                  limit: int = 200) -> list[dict[str, Any]]:
    clauses, params = ["f.org_id = ?"], [org_id]
    if inspection_id:
        clauses.append("f.inspection_id = ?")
        params.append(inspection_id)
    if status:
        clauses.append("f.status = ?")
        params.append(status)
    if site_id:
        clauses.append("f.site_id = ?")
        params.append(site_id)
    if assignee_id:
        clauses.append("f.assignee_id = ?")
        params.append(assignee_id)
    return many(
        conn,
        "SELECT f.*, s.name AS site_name, u.name AS assignee_name, m.initials AS assignee_initials,"
        " m.board_slot AS assignee_slot, a.name AS asset_name, ii.label AS item_label"
        " FROM findings f JOIN sites s ON s.id = f.site_id JOIN users u ON u.id = f.assignee_id"
        " JOIN memberships m ON m.user_id = u.id JOIN inspections i ON i.id = f.inspection_id"
        " JOIN assets a ON a.id = i.asset_id"
        " LEFT JOIN inspection_items ii ON ii.inspection_id = f.inspection_id AND ii.item_key = f.item_key"
        f" WHERE {' AND '.join(clauses)}"
        " ORDER BY f.status = 'resolved', f.due_date IS NULL, f.due_date, f.id DESC LIMIT ?",
        [*params, limit],
    )


# ---------------------------------------------------------------------------
# Read models
# ---------------------------------------------------------------------------

_LIST_SELECT = (
    "SELECT i.id, i.status, i.client_id, i.submitted_at, i.created_at, i.updated_at, i.corrects_id,"
    " i.task_id, i.site_id, i.asset_id, i.inspector_id, i.content_hash,"
    " a.name AS asset_name, a.location AS asset_location, s.name AS site_name, u.name AS inspector_name,"
    " (SELECT COUNT(*) FROM inspection_items x WHERE x.inspection_id = i.id AND x.result = 'bad') AS bad_count,"
    " (SELECT COUNT(*) FROM inspection_items x WHERE x.inspection_id = i.id) AS item_count,"
    " (SELECT r.id FROM reports r WHERE r.inspection_id = i.id ORDER BY r.version DESC LIMIT 1) AS report_id,"
    " (SELECT r.status FROM reports r WHERE r.inspection_id = i.id ORDER BY r.version DESC LIMIT 1)"
    "   AS report_status,"
    " (SELECT c.id FROM inspections c WHERE c.corrects_id = i.id ORDER BY c.id DESC LIMIT 1) AS corrected_by_id"
    " FROM inspections i JOIN assets a ON a.id = i.asset_id JOIN sites s ON s.id = i.site_id"
    " JOIN users u ON u.id = i.inspector_id"
)


def list_inspections(conn, org_id: int, *, status: str | None = None, site_id: int | None = None,
                     asset_id: int | None = None, inspector_id: int | None = None,
                     limit: int = 100) -> list[dict[str, Any]]:
    clauses, params = ["i.org_id = ?"], [org_id]
    if status:
        statuses = [s for s in status.split(",") if s in STATUS_LABELS]
        clauses.append(f"i.status IN ({','.join('?' * len(statuses))})")
        params.extend(statuses)
    if site_id:
        clauses.append("i.site_id = ?")
        params.append(site_id)
    if asset_id:
        clauses.append("i.asset_id = ?")
        params.append(asset_id)
    if inspector_id:
        clauses.append("i.inspector_id = ?")
        params.append(inspector_id)
    out = many(conn, f"{_LIST_SELECT} WHERE {' AND '.join(clauses)}"
                     " ORDER BY COALESCE(i.submitted_at, i.updated_at) DESC LIMIT ?", [*params, limit])
    for r in out:
        r["status_label"] = STATUS_LABELS[r["status"]]
    return out


def inspection_detail(conn, settings: Settings, org_id: int, inspection_id: int,
                      sign_urls: bool = True) -> dict[str, Any]:
    insp = one(conn, f"{_LIST_SELECT} WHERE i.org_id = ? AND i.id = ?", (org_id, inspection_id))
    if insp is None:
        raise not_found("점검")
    full = get_inspection(conn, org_id, inspection_id)
    insp.update({k: full[k] for k in ("gps_lat", "gps_lng", "gps_accuracy", "signer_name",
                                       "signature_attachment_id", "summary_note", "draft_version",
                                       "template_id")})
    insp["status_label"] = STATUS_LABELS[insp["status"]]
    insp["asset"] = one(conn, "SELECT id, name, asset_type, location, installed_on, service_life_years,"
                              " public_token FROM assets WHERE id = ?", (insp["asset_id"],))
    insp["template"] = one(conn, "SELECT id, name, version, is_sample FROM inspection_templates WHERE id = ?",
                           (insp["template_id"],))
    insp["items"] = _items(conn, inspection_id)
    for it in insp["items"]:
        it["result_label"] = RESULT_LABELS.get(it["result"], "미판정")
    evidence = _evidence(conn, inspection_id)
    view = (lambda a: files.public_view(settings, a)) if sign_urls else (lambda a: dict(a))
    insp["attachments"] = [view(a) for a in evidence]
    insp["reviews"] = many(
        conn,
        "SELECT r.*, u.name AS reviewer_name FROM inspection_reviews r JOIN users u ON u.id = r.reviewer_id"
        " WHERE r.inspection_id = ? ORDER BY r.id",
        (inspection_id,),
    )
    for r in insp["reviews"]:
        r["item_comments"] = json.loads(r.pop("item_comments_json"))
    insp["reports"] = many(
        conn,
        "SELECT r.*, rq.name AS requested_by_name, d.name AS decided_by_name FROM reports r"
        " JOIN users rq ON rq.id = r.requested_by LEFT JOIN users d ON d.id = r.decided_by"
        " WHERE r.inspection_id = ? ORDER BY r.version",
        (inspection_id,),
    )
    insp["findings"] = list_findings(conn, org_id, inspection_id=inspection_id)
    root = chain_root(conn, full)
    chain = _chain_ids(conn, root)
    insp["chain"] = many(
        conn,
        f"SELECT id, status, submitted_at, corrects_id FROM inspections WHERE id IN ({','.join('?' * len(chain))})"
        " ORDER BY id",
        chain,
    )
    return insp


def verify_integrity(conn, org_id: int, inspection_id: int) -> dict[str, Any]:
    insp = get_inspection(conn, org_id, inspection_id)
    if insp["status"] == "draft":
        return {"ok": None, "reason": "draft"}
    recomputed = content_hash(conn, insp)
    return {"ok": recomputed == insp["content_hash"], "stored": insp["content_hash"], "recomputed": recomputed}
