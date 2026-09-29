from app.db import connect

from .conftest import ok


def test_seeded_official_sources_with_disclaimer(team):
    res = ok(team.worker.get("/api/knowledge"))
    assert "법률 자문이 아니" in res["disclaimer"]
    titles = {i["title"] for i in res["items"]}
    assert {"전기안전관리법", "전기사업법", "전기공사업법", "전력기술관리법", "한국전기설비규정(KEC)"} <= titles
    for item in res["items"]:
        assert item["source_url"].startswith(("http://", "https://"))
        assert item["verified_at"] and item["review_due_at"] > item["verified_at"]
    assert not any("전기공사협회" in i["source_name"] for i in res["items"])  # unverified URL: not added


def test_search_by_keyword_category_and_standard(team):
    by_kw = ok(team.worker.get("/api/knowledge", params={"q": "정기검사"}))["items"]
    assert any(i["title"] == "전기안전관리법" for i in by_kw)
    ks = ok(team.worker.get("/api/knowledge", params={"category": "ks"}))["items"]
    assert ks and all(i["category"] == "ks" for i in ks)
    assert team.worker.get("/api/knowledge", params={"category": "nope"}).status_code == 400


def test_stale_items_are_flagged(team, settings):
    item = ok(team.worker.get("/api/knowledge"))["items"][0]
    conn = connect(settings.db_path)
    try:
        conn.execute("UPDATE knowledge_items SET review_due_at = '2020-01-01' WHERE id = ?", (item["id"],))
    finally:
        conn.close()
    stale = ok(team.worker.get(f"/api/knowledge/{item['id']}"))
    assert stale["stale"] is True
    assert team.worker.post(f"/api/knowledge/{item['id']}/verify").status_code == 403
    fresh = ok(team.admin.post(f"/api/knowledge/{item['id']}/verify"))
    assert fresh["stale"] is False


def test_recent_views_are_per_user(team):
    items = ok(team.worker.get("/api/knowledge"))["items"]
    ok(team.worker.post(f"/api/knowledge/{items[2]['id']}/view"))
    ok(team.worker.post(f"/api/knowledge/{items[0]['id']}/view"))
    recent = ok(team.worker.get("/api/knowledge/recent"))["items"]
    assert [r["id"] for r in recent] == [items[0]["id"], items[2]["id"]]
    assert ok(team.worker2.get("/api/knowledge/recent"))["items"] == []


def test_admin_manages_items_with_valid_links(team):
    body = {"title": "KS C IEC 60898-1 배선용 차단기", "category": "ks", "summary": "가정용 차단기 규격",
            "keywords": ["차단기", "MCB"], "standard_no": "KS C IEC 60898-1", "source_name": "e나라표준인증",
            "source_url": "https://standard.go.kr"}
    assert team.worker.post("/api/knowledge", body).status_code == 403
    bad = team.admin.post("/api/knowledge", {**body, "source_url": "javascript:alert(1)"})
    assert bad.status_code == 400
    created = ok(team.admin.post("/api/knowledge", body))
    assert created["keywords"] == ["차단기", "MCB"]
    found = ok(team.worker.get("/api/knowledge", params={"q": "60898"}))["items"]
    assert [i["id"] for i in found] == [created["id"]]
    ok(team.admin.patch(f"/api/knowledge/{created['id']}", {**body, "status": "archived"}))
    assert ok(team.worker.get("/api/knowledge", params={"q": "60898"}))["items"] == []
