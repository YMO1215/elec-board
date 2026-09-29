"""Demo data for trying the app locally (python -m app.cli demo).

Everything goes through the same service functions the API uses, so the demo
exercises the real rules (slots, findings, reviews, PDF approval)."""
from __future__ import annotations

import io
import uuid
from datetime import timedelta

from PIL import Image, ImageDraw

from .config import Settings
from .db import connect, local_today, migrate, one, tx
from .deps import Actor, parse_roles
from .services import files, inspections, org, tasks

DEMO_PASSWORD = "demo-pass-1234"
DEMO_USERS = [
    ("김관리", "admin@demo.local", "admin,worker", 1),
    ("이현장", "field1@demo.local", "worker", 2),
    ("박검토", "reviewer@demo.local", "reviewer,worker", 3),
    ("최설비", "field2@demo.local", "worker", 4),
]


def _actor(conn, user_id: int) -> Actor:
    r = one(conn, "SELECT u.id, u.name, u.email, m.org_id, m.roles, m.board_slot, m.initials FROM users u"
                  " JOIN memberships m ON m.user_id = u.id WHERE u.id = ?", (user_id,))
    return Actor(user_id=r["id"], org_id=r["org_id"], name=r["name"], email=r["email"],
                 roles=parse_roles(r["roles"]), board_slot=r["board_slot"], initials=r["initials"], csrf="")


def signature_png(seed: int) -> bytes:
    img = Image.new("RGBA", (360, 120), (255, 255, 255, 0))
    d = ImageDraw.Draw(img)
    pts = [(20 + i * 16, 60 + ((i * (seed + 3)) % 7 - 3) * 9) for i in range(20)]
    d.line(pts, fill=(20, 30, 40, 255), width=4, joint="curve")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _inspect(conn, settings: Settings, actor: Actor, asset_id: int, task_id: int | None,
             results: dict[str, tuple[str, str]], seed: int) -> int:
    insp = inspections.create_draft(conn, actor, client_id=str(uuid.uuid4()), asset_id=asset_id, task_id=task_id,
                                    corrects_id=None, tz=settings.tz)
    items = []
    for it in conn.execute("SELECT item_key FROM inspection_items WHERE inspection_id = ?", (insp["id"],)):
        result, memo = results.get(it["item_key"], ("good", ""))
        items.append({"item_key": it["item_key"], "result": result, "memo": memo})
    sig = files.store(conn, settings, org_id=actor.org_id, owner_type="signature", owner_id=insp["id"],
                      item_key=None, filename="signature.png", mime="image/png", data=signature_png(seed),
                      uploaded_by=actor.user_id)
    inspections.submit(conn, actor, insp["id"], {
        "submit_key": str(uuid.uuid4()), "items": items, "signer_name": actor.name,
        "signature_attachment_id": sig["id"], "gps": {"lat": 37.5665, "lng": 126.9780, "accuracy": 12},
    }, settings.tz)
    return insp["id"]


def seed_demo(settings: Settings) -> None:
    migrate(settings.db_path)
    conn = connect(settings.db_path)
    try:
        with tx(conn):
            first = DEMO_USERS[0]
            admin_id = org.bootstrap(conn, settings, org_name="전기팀 (데모)", name=first[0], email=first[1],
                                     password=DEMO_PASSWORD)
            admin = _actor(conn, admin_id)
            ids = {first[1]: admin_id}
            for name, email, roles, slot in DEMO_USERS[1:]:
                inv = org.invite(conn, settings, admin, email=email, name=name, roles=roles.split(","),
                                 board_slot=slot)
                ids[email] = org.accept_invitation(conn, inv["token"], DEMO_PASSWORD)
            field1, reviewer, field2 = (_actor(conn, ids[e]) for e in
                                        ("field1@demo.local", "reviewer@demo.local", "field2@demo.local"))
            everyone = list(ids.values())

            templates = {t["asset_type"]: t["id"] for t in org.list_templates(conn, admin.org_id)}
            site_a = org.create_site(conn, admin, {"name": "A동 본관 수변전실", "code": "A-MAIN",
                                                   "retention_years": 4, "member_ids": everyone})
            site_b = org.create_site(conn, admin, {"name": "B동 물류센터", "code": "B-LOG", "retention_years": 4,
                                                   "member_ids": everyone})
            site_c = org.create_site(conn, admin, {"name": "C동 연구동", "code": "C-LAB", "retention_years": 5,
                                                   "member_ids": everyone})

            def asset(site, name, kind, location, installed, life, interval):
                return org.create_asset(conn, admin, {
                    "site_id": site["id"], "name": name, "asset_type": kind, "location": location,
                    "template_id": templates.get(kind), "installed_on": installed, "service_life_years": life,
                    "inspection_interval_days": interval,
                }, settings.tz)

            a_main = asset(site_a, "특고압 수배전반 #1", "수배전반", "지하 1층 전기실", "2012-05-10", 15, 30)
            a_pnl1 = asset(site_a, "3층 분전반 L-3A", "분전반", "3층 EPS실", "2018-03-02", 20, 90)
            a_gnd = asset(site_a, "주접지 단자함", "접지", "지하 1층 전기실", "2012-05-10", 30, 365)
            b_pnl = asset(site_b, "하역장 분전반 L-1", "분전반", "1층 하역장 기둥 B-4", "2011-09-20", 15, 90)
            b_gen = asset(site_b, "비상발전기 G-1", "발전기", "옥외 발전기실", "2016-07-01", 20, 30)
            c_pnl = asset(site_c, "실험동 분전반 L-2B", "분전반", "2층 복도 EPS", "2021-11-15", 20, 90)

            today = local_today(settings.tz)

            def d(days):
                return (today + timedelta(days=days)).isoformat()

            def task(actor_, site, title, assignee, status="scheduled", priority="normal", due=None, kind="general",
                     asset_=None, checks=()):
                return tasks.create_task(conn, actor_, {
                    "site_id": site["id"], "title": title, "primary_assignee_id": assignee.user_id, "status": status,
                    "priority": priority, "due_date": due, "kind": kind,
                    "asset_id": asset_["id"] if asset_ else None, "check_items": list(checks),
                }, settings.tz)

            t_main = task(admin, site_a, "수배전반 월차 점검", field1, "scheduled", "high", d(0), "inspection", a_main)
            task(admin, site_a, "3층 분전반 분기 점검", field2, "scheduled", "normal", d(3), "inspection",
                          a_pnl1)
            task(admin, site_a, "접지저항 측정", reviewer, "scheduled", "high", d(-2), "inspection", a_gnd,
                         ("측정기 교정성적서 확인", "측정 위치 사진"))
            t_bpnl = task(admin, site_b, "하역장 분전반 점검", field1, "scheduled", "urgent", d(-1), "inspection",
                          b_pnl)
            t_bgen = task(admin, site_b, "비상발전기 월간 시운전", field2, "scheduled", "normal", d(0), "inspection",
                          b_gen)
            task(admin, site_c, "실험동 분전반 점검", reviewer, "scheduled", "low", d(10), "inspection",
                          c_pnl)
            task(admin, site_a, "열화상 카메라 촬영 (수변전실)", field1, "in_progress", "normal", d(1),
                 checks=("변압기 상부", "VCB 단자", "케이블 헤드"))
            task(admin, site_b, "누전차단기 교체 견적 요청", admin, "scheduled", "normal", d(5))
            task(admin, site_c, "전기안전관리 월간 보고 초안", admin, "in_progress", "high", d(2),
                 checks=("점검 결과 취합", "지적사항 현황", "사진 첨부"))
            task(admin, site_a, "비상조명 배터리 교체", field2, "review", "normal", d(-1))
            task(admin, site_b, "분전반 회로 명판 정비", field1, "done", "low", d(-3))
            task(admin, site_c, "정기검사 준비 서류 정리", reviewer, "scheduled", "normal", d(14),
                 checks=("단선결선도 최신화", "안전관리규정", "점검 기록 출력"))

            # Approved end to end: submitted -> reviewed -> approved (PDF generated).
            i1 = _inspect(conn, settings, field2, b_gen["id"], t_bgen["id"], {}, 1)
            inspections.review(conn, reviewer, i1, decision="reviewed", comment="이상 없음", item_comments={})
            rep = one(conn, "SELECT id FROM reports WHERE inspection_id = ?", (i1,))
            inspections.decide_report(conn, settings, admin, rep["id"], approve=True, comment="")

            # Submitted with a defect -> finding + follow-up task, waiting for review.
            _inspect(conn, settings, field1, b_pnl["id"], t_bpnl["id"], {
                "i06": ("bad", "L-1 분기 3번 차단기 단자 변색. 조임 토크 확인 및 단자 교체 필요."),
                "i09": ("na", ""),
            }, 2)

            # Rejected by review -> task back to in progress.
            i3 = _inspect(conn, settings, field1, a_main["id"], t_main["id"], {"i02": ("good", "68℃")}, 3)
            inspections.review(conn, reviewer, i3, decision="rejected",
                               comment="변압기 온도 지시값 사진이 없습니다. 증빙을 붙여 정정본을 올려 주세요.",
                               item_comments={"i02": "지시계 사진 필요"})
    finally:
        conn.close()
