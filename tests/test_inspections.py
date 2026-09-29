import sqlite3
import time

import pytest

from app.db import connect
from app.security import signed_file_url

from .conftest import Api, create_task, new_key, ok, png_bytes, submit_inspection


def test_draft_creation_is_idempotent(team):
    key = new_key()
    body = {"client_id": key, "asset_id": team.asset["id"]}
    a = ok(team.worker.post("/api/inspections/drafts", body))
    b = ok(team.worker.post("/api/inspections/drafts", body))
    assert a["id"] == b["id"]
    assert len(a["items"]) == 10 and a["status"] == "draft"
    # Another user replaying the same key must not hijack the draft.
    assert team.worker2.post("/api/inspections/drafts", body).status_code == 409


def test_draft_save_detects_conflicting_versions(team):
    d = ok(team.worker.post("/api/inspections/drafts", {"client_id": new_key(), "asset_id": team.asset["id"]}))
    key = d["items"][0]["item_key"]
    saved = ok(team.worker.put(f"/api/inspections/{d['id']}/draft",
                               {"base_version": 1, "items": [{"item_key": key, "result": "good"}]}))
    assert saved["draft_version"] == 2
    stale = team.worker.put(f"/api/inspections/{d['id']}/draft",
                            {"base_version": 1, "items": [{"item_key": key, "result": "bad", "memo": "x"}]})
    assert stale.status_code == 409
    server = stale.json()["error"]["detail"]["server"]
    assert server["items"][0]["result"] == "good"
    forced = ok(team.worker.put(f"/api/inspections/{d['id']}/draft",
                                {"base_version": 1, "force": True,
                                 "items": [{"item_key": key, "result": "bad", "memo": "x"}]}))
    assert forced["items"][0]["result"] == "bad"


def test_submit_validates_completeness_and_signature(team):
    d = ok(team.worker.post("/api/inspections/drafts", {"client_id": new_key(), "asset_id": team.asset["id"]}))
    r = team.worker.post(f"/api/inspections/{d['id']}/submit", {"submit_key": new_key(), "signer_name": "이작업"})
    assert r.status_code == 400 and r.json()["error"]["code"] == "items_incomplete"
    items = [{"item_key": it["item_key"], "result": "bad"} for it in d["items"]]
    r = team.worker.post(f"/api/inspections/{d['id']}/submit",
                         {"submit_key": new_key(), "signer_name": "이작업", "items": items})
    assert r.json()["error"]["code"] == "bad_memo_required"
    items = [{"item_key": it["item_key"], "result": "good"} for it in d["items"]]
    r = team.worker.post(f"/api/inspections/{d['id']}/submit",
                         {"submit_key": new_key(), "signer_name": "이작업", "items": items})
    assert r.json()["error"]["code"] == "signature_required"


def test_submit_is_idempotent_and_freezes_record(team, settings):
    task = create_task(team.admin, team, team.worker, kind="inspection", asset_id=team.asset["id"])
    d = ok(team.worker.post("/api/inspections/drafts", {"client_id": new_key(), "asset_id": team.asset["id"],
                                                        "task_id": task["id"]}))
    assert ok(team.worker.get(f"/api/tasks/{task['id']}"))["status"] == "in_progress"
    sig = ok(team.worker.post("/api/attachments", files={"file": ("s.png", png_bytes(), "image/png")},
                              data={"owner_type": "signature", "owner_id": str(d["id"]), "client_id": new_key()}))
    photo_key = new_key()
    photo_form = {"owner_type": "inspection_item", "owner_id": str(d["id"]), "item_key": d["items"][0]["item_key"],
                  "client_id": photo_key}
    p1 = ok(team.worker.post("/api/attachments", files={"file": ("p.png", png_bytes(), "image/png")},
                             data=photo_form))
    p2 = ok(team.worker.post("/api/attachments", files={"file": ("p.png", png_bytes(), "image/png")},
                             data=photo_form))
    assert p1["id"] == p2["id"]  # upload replay from the offline queue is deduplicated
    body = {"submit_key": new_key(), "signer_name": "이작업", "signature_attachment_id": sig["id"],
            "items": [{"item_key": it["item_key"], "result": "good"} for it in d["items"]]}
    first = ok(team.worker.post(f"/api/inspections/{d['id']}/submit", body))
    replay = ok(team.worker.post(f"/api/inspections/{d['id']}/submit", body))
    assert first["status"] == replay["status"] == "submitted"
    assert first["content_hash"] == replay["content_hash"] and len(first["content_hash"]) == 64
    assert ok(team.worker.get(f"/api/tasks/{task['id']}"))["status"] == "review"
    # Different key after submission is a conflict, not a second record.
    assert team.worker.post(f"/api/inspections/{d['id']}/submit",
                            {**body, "submit_key": new_key()}).status_code == 409
    # API refuses edits and new evidence.
    assert team.worker.put(f"/api/inspections/{d['id']}/draft",
                           {"base_version": 99, "items": [], "force": True}).status_code == 409
    assert team.worker.post("/api/attachments", files={"file": ("p.png", png_bytes(), "image/png")},
                            data={"owner_type": "inspection", "owner_id": str(d["id"])}).status_code == 409
    assert team.worker.delete(f"/api/inspections/{d['id']}").status_code == 409
    assert team.worker.delete(f"/api/attachments/{p1['id']}").status_code == 409
    # And the database itself refuses, even for direct SQL.
    conn = connect(settings.db_path)
    try:
        for sql in ("UPDATE inspection_items SET result = 'bad' WHERE inspection_id = ?",
                    "UPDATE inspections SET summary_note = 'x' WHERE id = ?",
                    "DELETE FROM inspections WHERE id = ?",
                    "UPDATE inspections SET status = 'draft' WHERE id = ?"):
            with pytest.raises(sqlite3.IntegrityError):
                conn.execute(sql, (d["id"],))
    finally:
        conn.close()
    assert ok(team.worker.get(f"/api/inspections/{d['id']}/integrity"))["ok"] is True


def test_bad_item_creates_finding_and_follow_up_task(team):
    items = ok(team.worker.post("/api/inspections/drafts",
                                {"client_id": new_key(), "asset_id": team.asset["id"]}))["items"]
    bad_key = items[5]["item_key"]
    insp = submit_inspection(team, team.worker, results={bad_key: "bad"},
                             findings=[{"item_key": bad_key, "assignee_id": team.worker2.id,
                                        "due_date": "2026-10-10"}])
    assert len(insp["findings"]) == 1
    f = insp["findings"][0]
    assert f["assignee_id"] == team.worker2.id and f["due_date"] == "2026-10-10" and f["status"] == "open"
    follow_up = ok(team.worker2.get(f"/api/tasks/{f['task_id']}"))
    assert follow_up["kind"] == "finding" and follow_up["primary_assignee_id"] == team.worker2.id
    assert follow_up["due_date"] == "2026-10-10"
    # Only the assignee (or an admin) records the fix; a note is required.
    assert team.worker.post(f"/api/findings/{f['id']}/resolve", {"note": "교체"}).status_code == 403
    assert team.worker2.post(f"/api/findings/{f['id']}/resolve", {"note": " "}).status_code == 400
    resolved = ok(team.worker2.post(f"/api/findings/{f['id']}/resolve", {"note": "단자 교체 완료"}))
    assert resolved["status"] == "resolved"
    assert ok(team.worker2.get(f"/api/tasks/{f['task_id']}"))["status"] == "done"


def test_review_and_report_approval_generate_pdf(team):
    task = create_task(team.admin, team, team.worker, kind="inspection", asset_id=team.asset["id"],
                       due_date="2026-12-31")
    insp = submit_inspection(team, team.worker, task_id=task["id"])
    iid = insp["id"]
    assert team.worker.post(f"/api/inspections/{iid}/review", {"decision": "reviewed"}).status_code == 403
    assert team.reviewer.post(f"/api/inspections/{iid}/review", {"decision": "rejected"}).status_code == 400
    reviewed = ok(team.reviewer.post(f"/api/inspections/{iid}/review", {"decision": "reviewed", "comment": "OK"}))
    assert reviewed["status"] == "reviewed"
    report = reviewed["reports"][0]
    assert report["status"] == "pending" and report["version"] == 1
    assert team.reviewer.post(f"/api/reports/{report['id']}/approve", {}).status_code == 403
    approved = ok(team.admin.post(f"/api/reports/{report['id']}/approve", {"decision": "approve"}))
    assert approved["status"] == "approved" and approved["decided_by"] == team.admin.id
    pdf = team.worker.get(f"/api/reports/{report['id']}/pdf")
    assert pdf.status_code == 200 and pdf.content.startswith(b"%PDF") and len(pdf.content) > 2000
    assert ok(team.worker.get(f"/api/tasks/{task['id']}"))["status"] == "done"
    assert ok(team.worker.get(f"/api/inspections/{iid}"))["status"] == "approved"
    assert team.admin.post(f"/api/reports/{report['id']}/approve", {}).status_code == 409
    log = ok(team.admin.get("/api/audit", params={"entity_type": "report", "entity_id": report["id"]}))["items"]
    assert log[0]["action"] == "report.approve" and insp["content_hash"] in log[0]["detail_json"]


def test_self_review_is_forbidden(team):
    insp = submit_inspection(team, team.reviewer)
    r = team.reviewer.post(f"/api/inspections/{insp['id']}/review", {"decision": "reviewed"})
    assert r.status_code == 403


def test_rejection_then_correction_links_to_original(team):
    task = create_task(team.admin, team, team.worker, kind="inspection", asset_id=team.asset["id"])
    original = submit_inspection(team, team.worker, task_id=task["id"])
    ok(team.reviewer.post(f"/api/inspections/{original['id']}/review",
                          {"decision": "rejected", "comment": "사진 누락", "item_comments": {"i01": "사진"}}))
    assert ok(team.worker.get(f"/api/tasks/{task['id']}"))["status"] == "in_progress"
    corr = ok(team.worker.post(f"/api/inspections/{original['id']}/corrections", {"client_id": new_key()}))
    assert corr["corrects_id"] == original["id"] and corr["status"] == "draft"
    assert all(it["result"] == "good" for it in corr["items"])  # starts from the original answers
    sig = ok(team.worker.post("/api/attachments", files={"file": ("s.png", png_bytes(), "image/png")},
                              data={"owner_type": "signature", "owner_id": str(corr["id"])}))
    submitted = ok(team.worker.post(f"/api/inspections/{corr['id']}/submit",
                                    {"submit_key": new_key(), "signer_name": "이작업",
                                     "signature_attachment_id": sig["id"]}))
    assert [c["id"] for c in submitted["chain"]] == [original["id"], corr["id"]]
    still = ok(team.worker.get(f"/api/inspections/{original['id']}"))
    assert still["status"] == "rejected" and still["content_hash"] == original["content_hash"]
    assert still["corrected_by_id"] == corr["id"]
    reviewed = ok(team.reviewer.post(f"/api/inspections/{corr['id']}/review", {"decision": "reviewed"}))
    assert reviewed["reports"][0]["version"] == 1


def test_signed_file_urls_expire_and_are_org_scoped(team, settings):
    insp = submit_inspection(team, team.worker)
    att = insp["attachments"][0]
    anon = Api(team.app)
    good = anon.get("/" + att["url"])
    assert good.status_code == 200 and good.headers["content-type"] == "image/png"
    past = signed_file_url(settings.secret_key, att["id"], -10, now=time.time())
    assert anon.get("/" + past).status_code == 403
    tampered = att["url"].replace(f"files/{att['id']}", f"files/{att['id'] + 1}")
    assert anon.get("/" + tampered).status_code == 403


def test_upload_rejects_scriptable_and_foreign_types(team):
    d = ok(team.worker.post("/api/inspections/drafts", {"client_id": new_key(), "asset_id": team.asset["id"]}))
    svg = b"<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"
    r = team.worker.post("/api/attachments", files={"file": ("x.svg", svg, "image/svg+xml")},
                         data={"owner_type": "inspection", "owner_id": str(d["id"])})
    assert r.status_code == 400
    r = team.worker.post("/api/attachments", files={"file": ("x.html", b"<b>", "text/html")},
                         data={"owner_type": "inspection", "owner_id": str(d["id"])})
    assert r.status_code == 400
    r = team.worker2.post("/api/attachments", files={"file": ("p.png", png_bytes(), "image/png")},
                          data={"owner_type": "inspection", "owner_id": str(d["id"])})
    assert r.status_code == 403  # not the author


def test_qr_lookup_uses_random_token(team):
    token = team.asset["public_token"]
    assert len(token) >= 16 and str(team.asset["id"]) != token
    found = ok(team.worker.get(f"/api/assets/by-qr/{token}"))
    assert found["id"] == team.asset["id"]
    assert team.worker.get("/api/assets/by-qr/guess-1").status_code == 404
    svg = team.worker.get(f"/api/assets/{team.asset['id']}/qr.svg", params={"base": "https://example.org/app/"})
    assert svg.status_code == 200 and svg.headers["content-type"].startswith("image/svg+xml")
    assert team.worker.get(f"/api/assets/{team.asset['id']}/qr.svg",
                           params={"base": "javascript:alert(1)"}).status_code == 400
    rotated = ok(team.admin.post(f"/api/assets/{team.asset['id']}/rotate-token"))
    assert rotated["public_token"] != token
    assert team.worker.get(f"/api/assets/by-qr/{token}").status_code == 404


def test_offline_bundle_contains_what_a_phone_needs(team):
    bundle = ok(team.worker.get("/api/offline/bundle"))
    asset = next(a for a in bundle["assets"] if a["id"] == team.asset["id"])
    assert asset["public_token"] == team.asset["public_token"]
    assert any(t["id"] == asset["template_id"] for t in bundle["templates"])
    assert {m["board_slot"] for m in bundle["members"]} == {1, 2, 3, 4}


def test_audit_chain_verifies_and_is_append_only(team, settings):
    submit_inspection(team, team.worker)
    result = ok(team.admin.get("/api/audit/verify"))
    assert result["ok"] is True and result["checked"] > 3
    conn = connect(settings.db_path)
    try:
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute("UPDATE audit_logs SET action = 'x'")
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute("DELETE FROM audit_logs")
    finally:
        conn.close()
    assert team.worker.get("/api/audit/verify").status_code == 403
