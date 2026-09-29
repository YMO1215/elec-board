from app.main import create_app

from .conftest import PASSWORD, Api, login, make_settings, ok


def test_setup_runs_once_and_logs_in(app):
    anon = Api(app)
    assert ok(anon.get("/api/auth/state"))["needs_setup"] is True
    me = ok(anon.post("/api/auth/setup", {"org_name": "팀", "name": "관리자", "email": "a@x.kr",
                                          "password": PASSWORD}))["me"]
    assert set(me["user"]["roles"]) == {"admin", "worker"}
    assert me["user"]["board_slot"] == 1
    again = anon.post("/api/auth/setup", {"org_name": "팀2", "name": "b", "email": "b@x.kr", "password": PASSWORD})
    assert again.status_code == 409


def test_setup_token_is_enforced_when_configured(tmp_path):
    app = create_app(make_settings(tmp_path, setup_token="let-me-in"))
    body = {"org_name": "팀", "name": "관리자", "email": "a@x.kr", "password": PASSWORD}
    assert Api(app).post("/api/auth/setup", body).status_code == 403
    ok(Api(app).post("/api/auth/setup", {**body, "setup_token": "let-me-in"}))


def test_login_rejects_bad_password_and_locks_out(team):
    anon = Api(team.app)
    for _ in range(5):
        r = anon.post("/api/auth/login", {"email": "worker@t.local", "password": "wrong-password"})
        assert r.status_code == 401
        assert r.json()["error"]["code"] == "bad_credentials"
    r = anon.post("/api/auth/login", {"email": "worker@t.local", "password": PASSWORD})
    assert r.status_code == 429


def test_writes_require_csrf_header(team):
    no_csrf = Api(team.app, client=team.worker.client)  # same cookies, no header
    r = no_csrf.post("/api/tasks", {"site_id": team.site["id"], "title": "x",
                                    "primary_assignee_id": team.worker.id})
    assert r.status_code == 403
    assert Api(team.app).get("/api/tasks/board").status_code == 401


def test_invite_rules(team):
    r = team.worker.post("/api/auth/invite", {"email": "n@t.local", "name": "새", "roles": ["worker"]})
    assert r.status_code == 403  # only admins invite
    r = team.admin.post("/api/auth/invite", {"email": "n@t.local", "name": "새", "roles": ["worker"],
                                             "board_slot": 2})
    assert r.status_code == 409 and r.json()["error"]["code"] == "slot_taken"
    inv = ok(team.admin.post("/api/auth/invite", {"email": "n@t.local", "name": "새사람", "roles": ["worker"]}))
    preview = ok(Api(team.app).get(f"/api/auth/invite/{inv['token']}"))
    assert preview["email"] == "n@t.local"
    ok(Api(team.app).post(f"/api/auth/invite/{inv['token']}/accept", {"password": PASSWORD}))
    # A token works once.
    assert Api(team.app).post(f"/api/auth/invite/{inv['token']}/accept", {"password": PASSWORD}).status_code == 404


def test_deactivation_requires_reassignment_and_blocks_login(team):
    t = ok(team.admin.post("/api/tasks", {"site_id": team.site["id"], "title": "일",
                                          "primary_assignee_id": team.worker2.id}))
    r = team.admin.post(f"/api/team/{team.worker2.id}/deactivate", {})
    assert r.status_code == 409 and r.json()["error"]["code"] == "reassign_required"
    ok(team.admin.post(f"/api/team/{team.worker2.id}/deactivate", {"reassign_to": team.worker.id}))
    moved = ok(team.admin.get(f"/api/tasks/{t['id']}"))
    assert moved["primary_assignee_id"] == team.worker.id
    assert moved["events"][0]["type"] == "assignee"
    assert team.worker2.get("/api/auth/me").status_code == 401  # sessions revoked
    r = Api(team.app).post("/api/auth/login", {"email": "worker2@t.local", "password": PASSWORD})
    assert r.status_code == 401


def test_role_change_is_audited_and_last_admin_protected(team):
    r = team.admin.patch(f"/api/team/{team.admin.id}", {"roles": ["worker"]})
    assert r.status_code == 409 and r.json()["error"]["code"] == "last_admin"
    ok(team.admin.patch(f"/api/team/{team.worker.id}", {"roles": ["worker", "reviewer"]}))
    log = ok(team.admin.get("/api/audit", params={"entity_type": "user", "entity_id": team.worker.id}))["items"]
    assert any(e["action"] == "member.update" for e in log)


def test_slot_swap_keeps_board_consistent(team):
    ok(team.admin.patch(f"/api/team/{team.worker.id}", {"board_slot": 4}))
    team_list = ok(team.admin.get("/api/team"))["items"]
    slots = {m["id"]: m["board_slot"] for m in team_list}
    assert slots[team.worker.id] == 4 and slots[team.worker2.id] == 2


def test_password_change(team):
    r = team.worker.post("/api/auth/password", {"current": "nope-nope", "new": "another-pass-1"})
    assert r.status_code == 400
    ok(team.worker.post("/api/auth/password", {"current": PASSWORD, "new": "another-pass-1"}))
    login(team.app, "worker@t.local", "another-pass-1")
