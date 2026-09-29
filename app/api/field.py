"""/api/assets, /api/templates, /api/inspections, /api/attachments, /api/findings, /api/reports."""
from __future__ import annotations

import io
from typing import Literal
from urllib.parse import urlparse

import segno
from fastapi import APIRouter, Depends, File, Form, Response, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from ..db import bump_rev, many, one, tx
from ..deps import Actor, current_actor, get_conn, get_settings
from ..errors import bad_request, conflict, forbidden, not_found
from ..services import files, inspections, org
from .common import parse_date

router = APIRouter(prefix="/api")

UPLOAD_OWNER_TYPES = ("inspection", "inspection_item", "signature", "finding", "task", "site")
BLOCKED_MIME = ("image/svg+xml",)  # scriptable; never stored as evidence


class AssetBody(BaseModel):
    site_id: int
    name: str = Field(max_length=80)
    asset_type: str = Field(max_length=40)
    location: str = Field(default="", max_length=120)
    template_id: int | None = None
    installed_on: str | None = None
    service_life_years: int | None = Field(default=None, ge=1, le=100)
    inspection_interval_days: int | None = Field(default=None, ge=1, le=3650)
    archived: bool = False


class TemplateItem(BaseModel):
    section: str = Field(default="", max_length=40)
    label: str = Field(max_length=120)


class TemplateBody(BaseModel):
    name: str = Field(max_length=80)
    asset_type: str = Field(default="", max_length=40)
    items: list[TemplateItem] = Field(max_length=200)


class DraftCreate(BaseModel):
    client_id: str = Field(min_length=8, max_length=64)
    asset_id: int | None = None
    task_id: int | None = None


class CorrectionCreate(BaseModel):
    client_id: str = Field(min_length=8, max_length=64)


class ItemInput(BaseModel):
    item_key: str = Field(max_length=20)
    result: Literal["good", "bad", "na"] | None = None
    memo: str = Field(default="", max_length=2000)
    gps_lat: float | None = Field(default=None, ge=-90, le=90)
    gps_lng: float | None = Field(default=None, ge=-180, le=180)


class DraftSave(BaseModel):
    base_version: int
    items: list[ItemInput] = Field(max_length=500)
    summary_note: str | None = Field(default=None, max_length=4000)
    force: bool = False


class Gps(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    accuracy: float | None = Field(default=None, ge=0)


class FindingOption(BaseModel):
    item_key: str
    assignee_id: int | None = None
    due_date: str | None = None


class SubmitBody(BaseModel):
    submit_key: str = Field(min_length=8, max_length=64)
    base_version: int | None = None
    force: bool = False
    items: list[ItemInput] = Field(default_factory=list, max_length=500)
    summary_note: str | None = Field(default=None, max_length=4000)
    gps: Gps | None = None
    signer_name: str = Field(max_length=40)
    signature_attachment_id: int | None = None
    findings: list[FindingOption] = Field(default_factory=list)


class ReviewBody(BaseModel):
    decision: Literal["reviewed", "rejected"]
    comment: str = Field(default="", max_length=2000)
    item_comments: dict[str, str] = Field(default_factory=dict)


class DecisionBody(BaseModel):
    decision: Literal["approve", "reject"] = "approve"
    comment: str = Field(default="", max_length=2000)


class ResolveBody(BaseModel):
    note: str = Field(max_length=2000)


# --- templates -----------------------------------------------------------------

@router.get("/templates")
def templates(actor: Actor = Depends(current_actor), conn=Depends(get_conn)):
    return {"items": org.list_templates(conn, actor.org_id)}


@router.post("/templates")
def create_template(body: TemplateBody, actor: Actor = Depends(current_actor), conn=Depends(get_conn)):
    with tx(conn):
        return org.create_template(conn, actor, body.model_dump())


@router.post("/templates/{template_id}/revise")
def revise_template(template_id: int, body: TemplateBody, actor: Actor = Depends(current_actor),
                    conn=Depends(get_conn)):
    with tx(conn):
        return org.revise_template(conn, actor, template_id, body.model_dump())


# --- assets --------------------------------------------------------------------

@router.get("/assets")
def assets(site_id: int | None = None, q: str | None = None, include_archived: bool = False,
           actor: Actor = Depends(current_actor), conn=Depends(get_conn), settings=Depends(get_settings)):
    return {"items": org.list_assets(conn, actor.org_id, settings.tz, site_id=site_id, q=q,
                                     include_archived=include_archived and actor.has("admin"))}


@router.post("/assets")
def create_asset(body: AssetBody, actor: Actor = Depends(current_actor), conn=Depends(get_conn),
                 settings=Depends(get_settings)):
    with tx(conn):
        return org.create_asset(conn, actor, body.model_dump(), settings.tz)


@router.get("/assets/by-qr/{token}")
def asset_by_qr(token: str, actor: Actor = Depends(current_actor), conn=Depends(get_conn),
                settings=Depends(get_settings)):
    return org.asset_by_token(conn, actor.org_id, token, settings.tz)


@router.get("/assets/{asset_id}")
def asset(asset_id: int, actor: Actor = Depends(current_actor), conn=Depends(get_conn),
          settings=Depends(get_settings)):
    a = org.get_asset(conn, actor.org_id, asset_id, settings.tz)
    a["inspections"] = inspections.list_inspections(conn, actor.org_id, asset_id=asset_id, limit=20)
    return a


@router.patch("/assets/{asset_id}")
def update_asset(asset_id: int, body: AssetBody, actor: Actor = Depends(current_actor), conn=Depends(get_conn),
                 settings=Depends(get_settings)):
    with tx(conn):
        return org.update_asset(conn, actor, asset_id, body.model_dump(), settings.tz)


@router.post("/assets/{asset_id}/rotate-token")
def rotate_token(asset_id: int, actor: Actor = Depends(current_actor), conn=Depends(get_conn),
                 settings=Depends(get_settings)):
    with tx(conn):
        return org.rotate_asset_token(conn, actor, asset_id, settings.tz)


@router.get("/assets/{asset_id}/qr.svg")
def asset_qr(asset_id: int, base: str, actor: Actor = Depends(current_actor), conn=Depends(get_conn),
             settings=Depends(get_settings)):
    """QR payload = <app base URL>#/q/<random token>. The phone's own camera
    opens it directly; the app base is supplied by the browser that prints it."""
    parsed = urlparse(base)
    if parsed.scheme not in ("http", "https") or not parsed.netloc or parsed.fragment:
        raise bad_request("base 는 앱의 http(s) 주소여야 합니다.", "bad_base")
    a = org.get_asset(conn, actor.org_id, asset_id, settings.tz)
    buf = io.BytesIO()
    segno.make(f"{base}#/q/{a['public_token']}", error="m").save(
        buf, kind="svg", scale=6, border=2, xmldecl=False, svgns=True, dark="#000", light="#fff")
    return Response(buf.getvalue(), media_type="image/svg+xml", headers={"Cache-Control": "private, no-store"})


# --- inspections ---------------------------------------------------------------

@router.get("/inspections")
def list_inspections(status: str | None = None, site_id: int | None = None, asset_id: int | None = None,
                     mine: bool = False, actor: Actor = Depends(current_actor), conn=Depends(get_conn)):
    return {"items": inspections.list_inspections(conn, actor.org_id, status=status, site_id=site_id,
                                                  asset_id=asset_id,
                                                  inspector_id=actor.user_id if mine else None)}


@router.post("/inspections/drafts")
def create_draft(body: DraftCreate, actor: Actor = Depends(current_actor), conn=Depends(get_conn),
                 settings=Depends(get_settings)):
    with tx(conn):
        insp = inspections.create_draft(conn, actor, client_id=body.client_id, asset_id=body.asset_id,
                                        task_id=body.task_id, corrects_id=None, tz=settings.tz)
    return inspections.inspection_detail(conn, settings, actor.org_id, insp["id"])


@router.get("/inspections/{inspection_id}")
def inspection(inspection_id: int, actor: Actor = Depends(current_actor), conn=Depends(get_conn),
               settings=Depends(get_settings)):
    return inspections.inspection_detail(conn, settings, actor.org_id, inspection_id)


@router.get("/inspections/{inspection_id}/integrity")
def integrity(inspection_id: int, actor: Actor = Depends(current_actor), conn=Depends(get_conn)):
    return inspections.verify_integrity(conn, actor.org_id, inspection_id)


@router.put("/inspections/{inspection_id}/draft")
def save_draft(inspection_id: int, body: DraftSave, actor: Actor = Depends(current_actor), conn=Depends(get_conn)):
    with tx(conn):
        return inspections.save_draft(conn, actor, inspection_id, base_version=body.base_version,
                                      items=[i.model_dump() for i in body.items], summary_note=body.summary_note,
                                      force=body.force)


@router.delete("/inspections/{inspection_id}")
def delete_draft(inspection_id: int, actor: Actor = Depends(current_actor), conn=Depends(get_conn),
                 settings=Depends(get_settings)):
    with tx(conn):
        inspections.delete_draft(conn, settings, actor, inspection_id)
    return {"ok": True}


@router.post("/inspections/{inspection_id}/submit")
def submit(inspection_id: int, body: SubmitBody, actor: Actor = Depends(current_actor), conn=Depends(get_conn),
           settings=Depends(get_settings)):
    payload = body.model_dump()
    payload["items"] = [i.model_dump() for i in body.items]
    for f in payload["findings"]:
        if f.get("due_date"):
            f["due_date"] = parse_date(f["due_date"], "due_date").isoformat()
    with tx(conn):
        inspections.submit(conn, actor, inspection_id, payload, settings.tz)
    return inspections.inspection_detail(conn, settings, actor.org_id, inspection_id)


@router.post("/inspections/{inspection_id}/review")
def review(inspection_id: int, body: ReviewBody, actor: Actor = Depends(current_actor), conn=Depends(get_conn),
           settings=Depends(get_settings)):
    with tx(conn):
        inspections.review(conn, actor, inspection_id, decision=body.decision, comment=body.comment,
                           item_comments=body.item_comments)
    return inspections.inspection_detail(conn, settings, actor.org_id, inspection_id)


@router.post("/inspections/{inspection_id}/corrections")
def correction(inspection_id: int, body: CorrectionCreate, actor: Actor = Depends(current_actor),
               conn=Depends(get_conn), settings=Depends(get_settings)):
    with tx(conn):
        insp = inspections.create_draft(conn, actor, client_id=body.client_id, asset_id=None, task_id=None,
                                        corrects_id=inspection_id, tz=settings.tz)
    return inspections.inspection_detail(conn, settings, actor.org_id, insp["id"])


# --- attachments ---------------------------------------------------------------

def _check_upload_owner(conn, actor: Actor, owner_type: str, owner_id: int) -> None:
    if owner_type in ("inspection", "inspection_item", "signature"):
        insp = inspections.get_inspection(conn, actor.org_id, owner_id)
        if insp["inspector_id"] != actor.user_id:
            raise forbidden("작성자만 증빙을 올릴 수 있습니다.")
        if insp["status"] != "draft":
            raise conflict("제출된 점검에는 증빙을 더할 수 없습니다. 정정본을 작성하세요.", "immutable")
    elif owner_type == "finding":
        actor.require("admin", "worker")
        if one(conn, "SELECT 1 FROM findings WHERE id = ? AND org_id = ?", (owner_id, actor.org_id)) is None:
            raise not_found("지적사항")
    elif owner_type == "task":
        actor.require("admin", "worker")
        if one(conn, "SELECT 1 FROM tasks WHERE id = ? AND org_id = ?", (owner_id, actor.org_id)) is None:
            raise not_found("업무")
    elif owner_type == "site":
        actor.require("admin", "worker")
        org.get_site(conn, actor.org_id, owner_id)
    else:
        raise bad_request("첨부 대상이 올바르지 않습니다.", "bad_owner")


@router.post("/attachments")
async def upload(file: UploadFile = File(...), owner_type: str = Form(...), owner_id: int = Form(...),
                 item_key: str | None = Form(default=None), client_id: str | None = Form(default=None),
                 actor: Actor = Depends(current_actor), conn=Depends(get_conn), settings=Depends(get_settings)):
    if owner_type not in UPLOAD_OWNER_TYPES:
        raise bad_request("첨부 대상이 올바르지 않습니다.", "bad_owner")
    mime = files.guess_mime(file.filename or "", file.content_type)
    if mime in BLOCKED_MIME or not mime.startswith(settings.allowed_upload_prefixes):
        raise bad_request("사진·동영상·음성 파일만 올릴 수 있습니다.", "bad_type", {"mime": mime})
    if owner_type == "signature" and mime != "image/png":
        raise bad_request("서명은 PNG 이미지여야 합니다.", "bad_signature")
    data = await file.read(settings.max_upload_bytes + 1)
    with tx(conn):
        _check_upload_owner(conn, actor, owner_type, owner_id)
        if owner_type == "inspection_item":
            if not item_key or one(conn, "SELECT 1 FROM inspection_items WHERE inspection_id = ? AND item_key = ?",
                                   (owner_id, item_key)) is None:
                raise bad_request("점검 항목을 찾을 수 없습니다.", "unknown_item")
        att = files.store(conn, settings, org_id=actor.org_id, owner_type=owner_type, owner_id=owner_id,
                          item_key=item_key if owner_type == "inspection_item" else None,
                          filename=file.filename or "upload", mime=mime, data=data,
                          uploaded_by=actor.user_id, client_id=client_id)
        bump_rev(conn, actor.org_id)
    return files.public_view(settings, att)


@router.delete("/attachments/{attachment_id}")
def delete_attachment(attachment_id: int, actor: Actor = Depends(current_actor), conn=Depends(get_conn),
                      settings=Depends(get_settings)):
    with tx(conn):
        att = one(conn, "SELECT * FROM attachments WHERE id = ? AND org_id = ?", (attachment_id, actor.org_id))
        if att is None:
            raise not_found("첨부파일")
        if att["owner_type"] not in inspections.EVIDENCE_OWNER_TYPES or att["uploaded_by"] != actor.user_id:
            raise forbidden("작성 중인 점검의 본인 첨부만 지울 수 있습니다.")
        _check_upload_owner(conn, actor, att["owner_type"], att["owner_id"])
        conn.execute("DELETE FROM attachments WHERE id = ?", (attachment_id,))
        bump_rev(conn, actor.org_id)
    files.absolute_path(settings, att).unlink(missing_ok=True)
    return {"ok": True}


@router.get("/attachments")
def list_attachments(owner_type: str, owner_id: int, actor: Actor = Depends(current_actor), conn=Depends(get_conn),
                     settings=Depends(get_settings)):
    if owner_type not in UPLOAD_OWNER_TYPES:
        raise bad_request("첨부 대상이 올바르지 않습니다.", "bad_owner")
    rs = many(conn, "SELECT * FROM attachments WHERE org_id = ? AND owner_type = ? AND owner_id = ? ORDER BY id",
              (actor.org_id, owner_type, owner_id))
    return {"items": [files.public_view(settings, a) for a in rs]}


# --- findings ------------------------------------------------------------------

@router.get("/findings")
def findings(status: Literal["open", "resolved"] | None = None, site_id: int | None = None,
             mine: bool = False, actor: Actor = Depends(current_actor), conn=Depends(get_conn)):
    return {"items": inspections.list_findings(conn, actor.org_id, status=status, site_id=site_id,
                                               assignee_id=actor.user_id if mine else None)}


@router.post("/findings/{finding_id}/resolve")
def resolve(finding_id: int, body: ResolveBody, actor: Actor = Depends(current_actor), conn=Depends(get_conn)):
    with tx(conn):
        return inspections.resolve_finding(conn, actor, finding_id, body.note)


# --- reports -------------------------------------------------------------------

@router.get("/reports")
def reports(status: Literal["pending", "approved", "rejected"] | None = None,
            actor: Actor = Depends(current_actor), conn=Depends(get_conn)):
    clauses, params = ["r.org_id = ?"], [actor.org_id]
    if status:
        clauses.append("r.status = ?")
        params.append(status)
    return {"items": many(
        conn,
        "SELECT r.*, a.name AS asset_name, s.name AS site_name, u.name AS inspector_name,"
        " rq.name AS requested_by_name, d.name AS decided_by_name"
        " FROM reports r JOIN inspections i ON i.id = r.inspection_id JOIN assets a ON a.id = i.asset_id"
        " JOIN sites s ON s.id = i.site_id JOIN users u ON u.id = i.inspector_id"
        " JOIN users rq ON rq.id = r.requested_by LEFT JOIN users d ON d.id = r.decided_by"
        f" WHERE {' AND '.join(clauses)} ORDER BY r.requested_at DESC LIMIT 100",
        params,
    )}


@router.post("/reports/{report_id}/approve")
def decide(report_id: int, body: DecisionBody, actor: Actor = Depends(current_actor), conn=Depends(get_conn),
           settings=Depends(get_settings)):
    with tx(conn):
        return inspections.decide_report(conn, settings, actor, report_id, approve=body.decision == "approve",
                                         comment=body.comment)


@router.get("/reports/{report_id}/pdf")
def report_pdf(report_id: int, actor: Actor = Depends(current_actor), conn=Depends(get_conn),
               settings=Depends(get_settings)):
    r = one(conn, "SELECT * FROM reports WHERE id = ? AND org_id = ?", (report_id, actor.org_id))
    if r is None or not r["pdf_attachment_id"]:
        raise not_found("승인된 보고서 PDF")
    att = one(conn, "SELECT * FROM attachments WHERE id = ?", (r["pdf_attachment_id"],))
    return FileResponse(files.absolute_path(settings, att), media_type="application/pdf",
                        filename=att["filename"], content_disposition_type="inline",
                        headers={"Cache-Control": "private, no-store"})
