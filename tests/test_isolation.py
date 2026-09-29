"""Rows of another organization must be invisible: 404, never 403, never data."""
from app.db import connect, now_iso
from app.security import hash_password
from app.services.org import seed_org_defaults

from .conftest import PASSWORD, create_task, login, ok, submit_inspection


def _second_org(settings) -> None:
    conn = connect(settings.db_path)
    try:
        ts = now_iso()
        org_id = conn.execute("INSERT INTO organizations (name, created_at) VALUES ('다른 팀', ?)", (ts,)).lastrowid
        uid = conn.execute("INSERT INTO users (email, name, password_hash, created_at) VALUES (?, ?, ?, ?)",
                           ("other@x.local", "외부인", hash_password(PASSWORD), ts)).lastrowid
        conn.execute("INSERT INTO memberships (org_id, user_id, roles, board_slot, initials, created_at)"
                     " VALUES (?, ?, 'admin,worker,reviewer', 1, '외부', ?)", (org_id, uid, ts))
        seed_org_defaults(conn, settings, org_id, uid)
    finally:
        conn.close()


def test_other_org_cannot_see_or_touch_data(team, settings):
    task = create_task(team.admin, team, team.worker)
    insp = submit_inspection(team, team.worker)
    _second_org(settings)
    outsider = login(team.app, "other@x.local")

    assert ok(outsider.get("/api/tasks/board"))["items"] == []
    assert ok(outsider.get("/api/tasks/board-summary"))["total"] == 0
    assert ok(outsider.get("/api/sites"))["items"] == []
    assert ok(outsider.get("/api/assets"))["items"] == []
    for url in (f"/api/tasks/{task['id']}", f"/api/sites/{team.site['id']}", f"/api/inspections/{insp['id']}",
                f"/api/assets/{team.asset['id']}", f"/api/assets/by-qr/{team.asset['public_token']}"):
        assert outsider.get(url).status_code == 404, url
    assert outsider.patch(f"/api/tasks/{task['id']}/status", {"status": "done"}).status_code == 404
    assert outsider.post(f"/api/inspections/{insp['id']}/review", {"decision": "reviewed"}).status_code == 404
    assert outsider.post("/api/tasks", {"site_id": team.site["id"], "title": "x",
                                        "primary_assignee_id": outsider.id}).status_code == 404
    assert ok(outsider.get("/api/kpi/summary"))["metrics"][0]["denominator"] == 0
    assert ok(outsider.get("/api/audit/verify"))["checked"] == 0
