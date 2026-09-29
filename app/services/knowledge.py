"""Law / KEC / KS reference items: title, short summary, source link, check date.
Full legal texts are never stored; the official source is always primary."""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlparse

from .. import audit
from ..db import bump_rev, local_today, many, now_iso, one
from ..deps import Actor
from ..errors import bad_request, not_found

CATEGORIES = {"law": "법령", "kec": "KEC", "ks": "KS", "inspection": "검사", "education": "교육"}
DISCLAIMER = "요약은 찾아보기용입니다. 법률 자문이 아니며, 적용 판단은 반드시 공식 원문으로 확인하세요."
RECENT_LIMIT = 5

# Seeded for every organization. URLs were checked to respond on SEED_VERIFIED_ON.
SEED_VERIFIED_ON = date(2026, 9, 29)
DEFAULT_ITEMS: list[dict[str, Any]] = [
    {
        "title": "전기안전관리법", "category": "law", "standard_no": "",
        "summary": "전기설비의 안전관리, 사용전검사·정기검사, 전기안전관리자 선임 등을 다루는 법률. 조문·시행령·시행규칙과 연혁은 원문에서 확인합니다.",
        "keywords": "정기검사,사용전검사,안전관리자,선임",
        "source_name": "국가법령정보센터", "source_url": "https://www.law.go.kr/법령/전기안전관리법",
    },
    {
        "title": "전기사업법", "category": "law", "standard_no": "",
        "summary": "전기사업의 허가·운영과 전력 수급 등 전기사업 전반의 기본 법률. 원문·연혁 링크입니다.",
        "keywords": "전기사업,허가",
        "source_name": "국가법령정보센터", "source_url": "https://www.law.go.kr/법령/전기사업법",
    },
    {
        "title": "전기공사업법", "category": "law", "standard_no": "",
        "summary": "전기공사업 등록, 전기공사의 도급·시공·시공관리에 관한 법률. 원문·연혁 링크입니다.",
        "keywords": "공사업,시공,도급,등록",
        "source_name": "국가법령정보센터", "source_url": "https://www.law.go.kr/법령/전기공사업법",
    },
    {
        "title": "전력기술관리법", "category": "law", "standard_no": "",
        "summary": "전력시설물의 설계·감리 등 전력기술 관리에 관한 법률. 원문·연혁 링크입니다.",
        "keywords": "설계,감리,전력시설물",
        "source_name": "국가법령정보센터", "source_url": "https://www.law.go.kr/법령/전력기술관리법",
    },
    {
        "title": "전기설비 검사 (사용전검사·정기검사) 생활법령 해설", "category": "inspection", "standard_no": "",
        "summary": "사용전검사·정기검사의 대상과 시기를 쉬운 말로 풀어 쓴 해설 PDF. 세부 주기와 예외는 법령 원문으로 확인합니다.",
        "keywords": "사용전검사,정기검사,검사 주기,해설",
        "source_name": "찾기쉬운 생활법령정보",
        "source_url": "https://www.easylaw.go.kr/CSP/FileDownload.laf?flType=pdf&onhunqnaYn=N&csmSeq=1169",
    },
    {
        "title": "한국전기설비규정(KEC)", "category": "kec", "standard_no": "KEC",
        "summary": "KEC 제·개정 정보와 조항 조회. 현장 적용 근거는 해당 조항 번호와 함께 기록합니다.",
        "keywords": "KEC,전기설비기술기준,접지,배선",
        "source_name": "전기설비기술기준 포털(kec.kea.kr)", "source_url": "http://kec.kea.kr",
    },
    {
        "title": "한국전기안전공사 검사·점검", "category": "inspection", "standard_no": "",
        "summary": "검사 신청, 검사 확인증, 전기안전 정보 조회.",
        "keywords": "검사 신청,확인증,전기안전공사",
        "source_name": "한국전기안전공사", "source_url": "https://www.kesco.or.kr",
    },
    {
        "title": "KS 규격 검색 (e나라표준인증)", "category": "ks", "standard_no": "",
        "summary": "KS 규격 번호·이름으로 전선·차단기·분전반 등 제품 규격을 검색합니다.",
        "keywords": "KS,규격,전선,차단기,분전반",
        "source_name": "e나라표준인증", "source_url": "https://standard.go.kr",
    },
    {
        "title": "한국전기기술인협회 교육·대행", "category": "education", "standard_no": "",
        "summary": "전기안전관리 대행업 등록, 경력 확인, 법정 교육 정보.",
        "keywords": "교육,경력확인,대행,법정교육",
        "source_name": "한국전기기술인협회", "source_url": "https://www.keea.or.kr",
    },
]


def _validate(data: dict[str, Any]) -> dict[str, Any]:
    title = (data.get("title") or "").strip()
    if not title:
        raise bad_request("제목을 입력하세요.", "title_required")
    if data.get("category") not in CATEGORIES:
        raise bad_request("분류를 고르세요.", "bad_category")
    url = (data.get("source_url") or "").strip()
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise bad_request("원문 링크는 http(s) 주소여야 합니다.", "bad_url")
    if not (data.get("source_name") or "").strip():
        raise bad_request("출처 이름을 입력하세요.", "source_required")
    keywords = data.get("keywords") or ""
    if isinstance(keywords, list):
        keywords = ",".join(keywords)
    return {
        "title": title,
        "category": data["category"],
        "summary": (data.get("summary") or "").strip(),
        "keywords": ",".join(k.strip() for k in keywords.split(",") if k.strip()),
        "standard_no": (data.get("standard_no") or "").strip(),
        "source_name": data["source_name"].strip(),
        "source_url": url,
    }


def _shape(item: dict[str, Any], today: str) -> dict[str, Any]:
    item["keywords"] = [k for k in item["keywords"].split(",") if k]
    item["category_label"] = CATEGORIES[item["category"]]
    item["stale"] = item["review_due_at"] < today
    return item


def seed_defaults(conn, org_id: int, review_days: int) -> None:
    if one(conn, "SELECT 1 FROM knowledge_items WHERE org_id = ? LIMIT 1", (org_id,)):
        return
    due = (SEED_VERIFIED_ON + timedelta(days=review_days)).isoformat()
    for it in DEFAULT_ITEMS:
        conn.execute(
            "INSERT INTO knowledge_items (org_id, title, category, summary, keywords, standard_no, source_name,"
            " source_url, verified_at, review_due_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (org_id, it["title"], it["category"], it["summary"], it["keywords"], it["standard_no"],
             it["source_name"], it["source_url"], SEED_VERIFIED_ON.isoformat(), due, now_iso()),
        )


def search(conn, org_id: int, *, q: str | None, category: str | None, tz,
           include_archived: bool = False) -> list[dict[str, Any]]:
    clauses, params = ["org_id = ?"], [org_id]
    if not include_archived:
        clauses.append("status = 'active'")
    if category:
        if category not in CATEGORIES:
            raise bad_request("알 수 없는 분류입니다.", "bad_category")
        clauses.append("category = ?")
        params.append(category)
    for term in (q or "").split():
        like = f"%{term}%"
        clauses.append("(title LIKE ? OR summary LIKE ? OR keywords LIKE ? OR standard_no LIKE ?"
                       " OR source_name LIKE ?)")
        params.extend([like] * 5)
    today = local_today(tz).isoformat()
    rs = many(conn, f"SELECT * FROM knowledge_items WHERE {' AND '.join(clauses)}"
                    " ORDER BY CASE category WHEN 'law' THEN 0 WHEN 'kec' THEN 1 WHEN 'ks' THEN 2"
                    " WHEN 'inspection' THEN 3 ELSE 4 END, title", params)
    return [_shape(r, today) for r in rs]


def get_item(conn, org_id: int, item_id: int, tz) -> dict[str, Any]:
    r = one(conn, "SELECT * FROM knowledge_items WHERE id = ? AND org_id = ?", (item_id, org_id))
    if r is None:
        raise not_found("지식 항목")
    return _shape(r, local_today(tz).isoformat())


def record_view(conn, actor: Actor, item_id: int, tz) -> None:
    get_item(conn, actor.org_id, item_id, tz)
    # Microseconds: two views within one second must still order correctly.
    viewed_at = datetime.now(timezone.utc).isoformat(timespec="microseconds")
    conn.execute(
        "INSERT INTO knowledge_views (user_id, item_id, viewed_at) VALUES (?, ?, ?)"
        " ON CONFLICT(user_id, item_id) DO UPDATE SET viewed_at = excluded.viewed_at",
        (actor.user_id, item_id, viewed_at),
    )


def recent(conn, actor: Actor, tz) -> list[dict[str, Any]]:
    today = local_today(tz).isoformat()
    rs = many(
        conn,
        "SELECT k.*, v.viewed_at FROM knowledge_views v JOIN knowledge_items k ON k.id = v.item_id"
        " WHERE v.user_id = ? AND k.org_id = ? AND k.status = 'active' ORDER BY v.viewed_at DESC LIMIT ?",
        (actor.user_id, actor.org_id, RECENT_LIMIT),
    )
    return [_shape(r, today) for r in rs]


def create(conn, actor: Actor, data: dict[str, Any], review_days: int, tz) -> dict[str, Any]:
    actor.require("admin")
    clean = _validate(data)
    today = local_today(tz)
    cur = conn.execute(
        "INSERT INTO knowledge_items (org_id, title, category, summary, keywords, standard_no, source_name,"
        " source_url, verified_at, review_due_at, updated_by, updated_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (actor.org_id, clean["title"], clean["category"], clean["summary"], clean["keywords"],
         clean["standard_no"], clean["source_name"], clean["source_url"], today.isoformat(),
         (today + timedelta(days=review_days)).isoformat(), actor.user_id, now_iso()),
    )
    audit.record(conn, actor.org_id, actor.user_id, "knowledge.create", "knowledge_item", cur.lastrowid,
                 {"title": clean["title"], "source_url": clean["source_url"]})
    bump_rev(conn, actor.org_id)
    return get_item(conn, actor.org_id, cur.lastrowid, tz)


def update(conn, actor: Actor, item_id: int, data: dict[str, Any], tz) -> dict[str, Any]:
    actor.require("admin")
    get_item(conn, actor.org_id, item_id, tz)
    clean = _validate(data)
    status = data.get("status", "active")
    if status not in ("active", "archived"):
        raise bad_request("상태는 active 또는 archived 입니다.", "bad_status")
    conn.execute(
        "UPDATE knowledge_items SET title = ?, category = ?, summary = ?, keywords = ?, standard_no = ?,"
        " source_name = ?, source_url = ?, status = ?, updated_by = ?, updated_at = ? WHERE id = ?",
        (clean["title"], clean["category"], clean["summary"], clean["keywords"], clean["standard_no"],
         clean["source_name"], clean["source_url"], status, actor.user_id, now_iso(), item_id),
    )
    audit.record(conn, actor.org_id, actor.user_id, "knowledge.update", "knowledge_item", item_id,
                 {"title": clean["title"], "status": status})
    bump_rev(conn, actor.org_id)
    return get_item(conn, actor.org_id, item_id, tz)


def mark_verified(conn, actor: Actor, item_id: int, review_days: int, tz) -> dict[str, Any]:
    actor.require("admin")
    get_item(conn, actor.org_id, item_id, tz)
    today = local_today(tz)
    conn.execute(
        "UPDATE knowledge_items SET verified_at = ?, review_due_at = ?, updated_by = ?, updated_at = ? WHERE id = ?",
        (today.isoformat(), (today + timedelta(days=review_days)).isoformat(), actor.user_id, now_iso(), item_id),
    )
    audit.record(conn, actor.org_id, actor.user_id, "knowledge.verify", "knowledge_item", item_id,
                 {"verified_at": today.isoformat()})
    bump_rev(conn, actor.org_id)
    return get_item(conn, actor.org_id, item_id, tz)
