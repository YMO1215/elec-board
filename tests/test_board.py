import pytest

from app.db import connect

from .conftest import create_task, ok


def _summary(api, **params):
    return ok(api.get("/api/tasks/board-summary", params=params))


def _assert_projection_invariant(summary):
    by_assignee = sum(c["count"] for c in summary["by_assignee"])
    by_status = sum(c["count"] for c in summary["by_status"])
    assert by_assignee == by_status == summary["total"]
    assert summary["outside_board"] == 0
    assert len(summary["by_assignee"]) == 4 and len(summary["by_status"]) == 4


def test_moving_in_assignee_view_changes_only_assignee(team):
    t = create_task(team.admin, team, team.worker, status="in_progress", priority="high")
    moved = ok(team.admin.patch(f"/api/tasks/{t['id']}/assignee",
                                {"assignee_id": team.worker2.id, "version": t["version"]}))
    assert moved["primary_assignee_id"] == team.worker2.id
    assert moved["status"] == "in_progress"
    assert moved["priority"] == "high"
    assert moved["version"] == t["version"] + 1
    events = ok(team.admin.get(f"/api/tasks/{t['id']}"))["events"]
    assert events[0]["type"] == "assignee"
    assert (events[0]["from_value"], events[0]["to_value"]) == (str(team.worker.id), str(team.worker2.id))
    assert events[0]["actor_id"] == team.admin.id


def test_moving_in_status_view_changes_only_status(team):
    t = create_task(team.worker, team, team.worker)
    moved = ok(team.worker.patch(f"/api/tasks/{t['id']}/status", {"status": "done", "version": t["version"]}))
    assert moved["status"] == "done" and moved["completed_at"]
    assert moved["primary_assignee_id"] == team.worker.id
    back = ok(team.worker.patch(f"/api/tasks/{t['id']}/status", {"status": "review", "version": moved["version"]}))
    assert back["completed_at"] is None


def test_stale_version_is_rejected_with_server_copy(team):
    t = create_task(team.admin, team, team.worker)
    ok(team.admin.patch(f"/api/tasks/{t['id']}/status", {"status": "in_progress", "version": t["version"]}))
    r = team.worker.patch(f"/api/tasks/{t['id']}/status", {"status": "review", "version": t["version"]})
    assert r.status_code == 409
    err = r.json()["error"]
    assert err["code"] == "version_conflict"
    assert err["detail"]["server"]["status"] == "in_progress"


def test_move_permissions(team):
    t = create_task(team.admin, team, team.worker)
    # Another worker cannot move someone else's task; a pure reviewer cannot move at all.
    assert team.worker2.patch(f"/api/tasks/{t['id']}/status", {"status": "done"}).status_code == 403
    assert team.worker2.patch(f"/api/tasks/{t['id']}/assignee",
                              {"assignee_id": team.worker2.id}).status_code == 403
    board = ok(team.worker2.get("/api/tasks/board"))["items"]
    card = next(c for c in board if c["id"] == t["id"])
    assert card["can_move_status"] is False and card["can_reassign"] is False
    # The owner can hand the task over.
    ok(team.worker.patch(f"/api/tasks/{t['id']}/assignee", {"assignee_id": team.worker2.id}))


def test_assignee_must_hold_a_board_slot(team):
    ok(team.admin.patch(f"/api/team/{team.reviewer.id}", {"clear_slot": True}))
    r = team.admin.post("/api/tasks", {"site_id": team.site["id"], "title": "x",
                                       "primary_assignee_id": team.reviewer.id})
    assert r.status_code == 400 and r.json()["error"]["code"] == "assignee_without_slot"


def test_clearing_slot_with_tasks_is_blocked(team):
    create_task(team.admin, team, team.reviewer)
    r = team.admin.patch(f"/api/team/{team.reviewer.id}", {"clear_slot": True})
    assert r.status_code == 409 and r.json()["error"]["code"] == "member_has_tasks"


def test_board_summary_projection_matches_under_filters(team):
    other_site = ok(team.admin.post("/api/sites", {"name": "B동"}))
    specs = [
        (team.worker, "scheduled", "high", "2026-10-01", team.site["id"]),
        (team.worker, "in_progress", "normal", "2026-10-05", team.site["id"]),
        (team.worker2, "review", "urgent", None, team.site["id"]),
        (team.reviewer, "done", "low", "2026-09-01", other_site["id"]),
        (team.admin, "scheduled", "high", "2026-10-02", other_site["id"]),
        (team.admin, "done", "normal", "2026-10-03", team.site["id"]),
    ]
    for who, status, prio, due, site_id in specs:
        ok(team.admin.post("/api/tasks", {"site_id": site_id, "title": "t", "primary_assignee_id": who.id,
                                          "status": status, "priority": prio, "due_date": due}))
    full = _summary(team.admin)
    _assert_projection_invariant(full)
    assert full["total"] == 6
    for params in ({"site_id": other_site["id"]}, {"priority": "high"}, {"assignee_id": team.worker.id},
                   {"due_from": "2026-10-01", "due_to": "2026-10-03"}, {"priority": "low", "site_id": team.site["id"]}):
        s = _summary(team.admin, **params)
        _assert_projection_invariant(s)
        board = ok(team.admin.get("/api/tasks/board", params=params))
        assert len(board["items"]) == s["total"]
        assert board["summary"]["by_status"] == s["by_status"]
        ids = [c["id"] for c in board["items"]]
        assert len(ids) == len(set(ids))  # no card rendered twice
    zero = _summary(team.admin, priority="low", site_id=team.site["id"])
    assert zero["total"] == 0 and zero["filtered"] is True


def test_summary_counts_by_column(team):
    create_task(team.admin, team, team.worker, status="review")
    create_task(team.admin, team, team.worker, status="review")
    create_task(team.admin, team, team.worker2)
    s = _summary(team.admin)
    counts = {c["user_id"]: c["count"] for c in s["by_assignee"]}
    assert counts[team.worker.id] == 2 and counts[team.worker2.id] == 1
    assert {c["status"]: c["count"] for c in s["by_status"]}["review"] == 2


def test_edit_check_items_and_collaborators(team):
    t = create_task(team.admin, team, team.worker, check_items=["외함 확인", "사진"])
    detail = ok(team.worker.get(f"/api/tasks/{t['id']}"))
    assert [c["label"] for c in detail["check_items"]] == ["외함 확인", "사진"]
    item = detail["check_items"][0]
    detail = ok(team.worker.patch(f"/api/tasks/{t['id']}/check-items/{item['id']}", {"done": True}))
    assert detail["check_done"] == 1 and detail["check_total"] == 2
    detail = ok(team.worker.put(f"/api/tasks/{t['id']}/collaborators", {"user_ids": [team.worker2.id]}))
    assert [c["id"] for c in detail["collaborators"]] == [team.worker2.id]
    # Collaborators never change which column the card sits in.
    s = _summary(team.admin)
    assert {c["user_id"]: c["count"] for c in s["by_assignee"]}[team.worker2.id] == 0
    edited = ok(team.worker.patch(f"/api/tasks/{t['id']}", {"version": detail["version"], "title": "새 제목",
                                                             "priority": "urgent"}))
    assert edited["title"] == "새 제목" and edited["priority"] == "urgent"
    ok(team.admin.patch(f"/api/team/{team.reviewer.id}", {"roles": ["reviewer"]}))
    pure_reviewer = team.reviewer.patch(f"/api/tasks/{t['id']}", {"version": edited["version"], "title": "x"})
    assert pure_reviewer.status_code == 403  # reviewers read the board but do not edit tasks


def test_task_events_are_append_only(team, settings):
    t = create_task(team.admin, team, team.worker)
    conn = connect(settings.db_path)
    try:
        with pytest.raises(Exception):
            conn.execute("DELETE FROM task_events WHERE task_id = ?", (t["id"],))
    finally:
        conn.close()


def test_rev_bumps_on_writes(team):
    before = ok(team.worker.get("/api/sync/rev"))["rev"]
    create_task(team.admin, team, team.worker)
    assert ok(team.worker.get("/api/sync/rev"))["rev"] > before
