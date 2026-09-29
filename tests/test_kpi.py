from datetime import date, timedelta

from app.db import local_today
from app.services.kpi import achievement, judgement, weighted

from .conftest import create_task, ok, submit_inspection


def _period(team):
    today = local_today(team.settings.tz)
    return {"start": (today - timedelta(days=6)).isoformat(), "end": today.isoformat()}


def _metric(summary, key):
    return next(m for m in summary["metrics"] if m["key"] == key)


def test_empty_period_shows_no_data_not_zero(team):
    s = ok(team.admin.get("/api/kpi/summary", params={"start": "2020-01-01", "end": "2020-01-31"}))
    for m in s["metrics"]:
        assert m["denominator"] == 0 and m["value"] is None and m["judgement"] == "no_data"
    assert s["weighted"] is None
    assert s["baseline"]["label"] == "직전 동일 기간"
    assert s["baseline"]["end"] == "2019-12-31"


def test_metrics_follow_records_and_drilldown_matches(team):
    today = local_today(team.settings.tz)
    p = _period(team)
    # Two inspection tasks due in the period; one gets an inspection submitted.
    t1 = create_task(team.admin, team, team.worker, kind="inspection", asset_id=team.asset["id"],
                     due_date=today.isoformat())
    create_task(team.admin, team, team.worker, kind="inspection", asset_id=team.asset["id"],
                due_date=today.isoformat())
    items = ok(team.worker.post("/api/inspections/drafts", {"client_id": "k" * 12,
                                                            "asset_id": team.asset["id"]}))["items"]
    bad = items[0]["item_key"]
    insp = submit_inspection(team, team.worker, task_id=t1["id"], results={bad: "bad"})
    # On-time: one done before its due date, one done late (due yesterday), one without due date (excluded).
    early = create_task(team.admin, team, team.worker2, due_date=(today + timedelta(days=3)).isoformat())
    late = create_task(team.admin, team, team.worker2, due_date=(today - timedelta(days=1)).isoformat())
    nodue = create_task(team.admin, team, team.worker2)
    for t in (early, late, nodue):
        ok(team.admin.patch(f"/api/tasks/{t['id']}/status", {"status": "done"}))
    ok(team.reviewer.post(f"/api/inspections/{insp['id']}/review", {"decision": "reviewed"}))

    s = ok(team.admin.get("/api/kpi/summary", params=p))
    comp = _metric(s, "inspection_completion")
    assert (comp["numerator"], comp["denominator"], comp["value"]) == (1, 2, 50.0)
    on_time = _metric(s, "on_time")
    assert (on_time["numerator"], on_time["denominator"]) == (1, 2)
    fix = _metric(s, "finding_resolution")
    assert (fix["numerator"], fix["denominator"], fix["value"]) == (0, 1, 0.0)
    rep = _metric(s, "report_approval")
    assert (rep["numerator"], rep["denominator"]) == (0, 1)
    for m in s["metrics"]:
        assert len(m["trend"]) == 6 and m["trend"][-1]["value"] == m["value"]
        dd = ok(team.admin.get("/api/kpi/drilldown", params={**p, "metric": m["key"]}))
        assert len(dd["items"]) == m["denominator"]
        assert sum(1 for i in dd["items"] if i["in_numerator"]) == m["numerator"]

    personal = ok(team.admin.get("/api/kpi/summary", params={**p, "scope": "user", "user_id": team.worker2.id}))
    assert _metric(personal, "inspection_completion")["denominator"] == 0
    assert _metric(personal, "on_time")["denominator"] == 2


def test_weighted_average_and_achievement_rules():
    assert achievement(None, 90, "up") is None
    assert achievement(45, 90, "up") == 50.0
    assert achievement(99, 90, "up") == 100.0  # capped
    assert achievement(5, 10, "down") == 100.0
    assert judgement(85, 90, "up") == "near" and judgement(70, 90, "up") == "below"
    metrics = [{"achievement": 100.0, "weight": 30}, {"achievement": 50.0, "weight": 10},
               {"achievement": None, "weight": 60}]
    assert weighted(metrics) == 87.5  # metrics without data are excluded from both sums


def test_weight_changes_are_validated_and_logged(team):
    defs = ok(team.admin.get("/api/kpi/definitions"))["items"]
    body = {"items": [{"key": d["key"], "target": d["target"], "weight": 10} for d in defs]}
    r = team.admin.put("/api/kpi/definitions", body)
    assert r.status_code == 400 and r.json()["error"]["code"] == "weights_sum"
    body["items"][0]["weight"] = 70
    assert team.worker.put("/api/kpi/definitions", body).status_code == 403
    ok(team.admin.put("/api/kpi/definitions", body))
    history = ok(team.admin.get("/api/kpi/definitions"))["history"]
    assert len(history) == 1 and history[0]["actor_name"] == "김관리"


def test_snapshot_freezes_period(team):
    p = _period(team)
    ok(team.admin.post("/api/kpi/snapshots", {**p, "scope": "team"}))
    snaps = ok(team.admin.get("/api/kpi/snapshots"))["items"]
    assert snaps[0]["period_start"] == p["start"]
    assert team.worker.post("/api/kpi/snapshots", {**p, "scope": "team"}).status_code == 403


def test_period_validation(team):
    assert team.admin.get("/api/kpi/summary", params={"start": "2026-02-01", "end": "2026-01-01"}).status_code == 400
    assert team.admin.get("/api/kpi/summary", params={"start": "2024-01-01", "end": "2026-01-01"}).status_code == 400
    default = ok(team.admin.get("/api/kpi/summary"))
    today = local_today(team.settings.tz)
    assert default["period"]["start"] == today.replace(day=1).isoformat()
    assert date.fromisoformat(default["period"]["end"]).month == today.month
