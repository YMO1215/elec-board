"""Headless smoke test (mechanical checks only; visual review is done by a person).

Run with a Python that has Playwright + Chromium installed:
    python scripts/smoke_e2e.py --base http://127.0.0.1:8810/

Expects the demo data (python -m app.cli demo). Checks:
  - every route renders without uncaught JS errors or console errors
  - no horizontal overflow at 360px and 1280px
  - a mouse drag on the board moves the card and the server agrees
  - the mobile move flow (tap -> 이동 -> target -> 확정) changes the status
  - an inspection submitted offline stays "동기화 대기" and syncs after reconnecting
"""
from __future__ import annotations

import argparse
import json
import sys

from playwright.sync_api import sync_playwright

ROUTES = ["#/", "#/board", "#/board?view=status", "#/inspect", "#/inspect?tab=drafts", "#/inspect?tab=review",
          "#/inspect?tab=findings", "#/kpi", "#/kpi?scope=user", "#/knowledge", "#/settings", "#/sites/1",
          "#/inspections/1"]
WIDTHS = (360, 1280)


def login(page, base, email):
    page.goto(base)
    page.fill("input[name=email]", email)
    page.fill("input[name=password]", "demo-pass-1234")
    page.click("button[type=submit]")
    page.wait_for_selector("body[data-auth=in]")


def api(page, path):
    return page.evaluate("p => fetch(p, {credentials:'same-origin'}).then(r => r.json())", path)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8810/")
    args = ap.parse_args()
    base = args.base
    failures: list[str] = []

    with sync_playwright() as p:
        browser = p.chromium.launch()
        for width in WIDTHS:
            ctx = browser.new_context(viewport={"width": width, "height": 900}, has_touch=width < 720,
                                      is_mobile=width < 720)
            page = ctx.new_page()
            errors: list[str] = []
            page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
            page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
            login(page, base, "admin@demo.local")
            for route in ROUTES:
                errors.clear()
                page.goto(base + route)
                page.wait_for_timeout(900)
                overflow = page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
                if overflow > 0:
                    failures.append(f"{width}px {route}: horizontal overflow {overflow}px")
                if errors:
                    failures.append(f"{width}px {route}: " + " | ".join(errors))
                if page.locator(".state-error").count():
                    failures.append(f"{width}px {route}: error state shown: {page.locator('.state-error').first.inner_text()}")
            ctx.close()

        # Desktop drag: first card in column 1 -> column 2 (assignee view).
        ctx = browser.new_context(viewport={"width": 1280, "height": 900})
        page = ctx.new_page()
        login(page, base, "admin@demo.local")
        page.goto(base + "#/board")
        page.wait_for_selector(".magnet")
        card = page.locator(".magnet.can-drag").first
        task_id = card.get_attribute("data-id")
        own_col = card.locator("xpath=ancestor::section[1]").get_attribute("data-col")
        target_col = page.locator(f".board-col:not([data-col='{own_col}']):not([data-col^='slot'])").first
        before = api(page, f"api/tasks/{task_id}")
        box = card.bounding_box()
        tbox = target_col.bounding_box()
        page.mouse.move(box["x"] + 20, box["y"] + 20)
        page.mouse.down()
        page.mouse.move(box["x"] + 60, box["y"] + 40, steps=5)
        page.mouse.move(tbox["x"] + tbox["width"] / 2, tbox["y"] + 60, steps=10)
        page.mouse.up()
        page.wait_for_timeout(1200)
        after = api(page, f"api/tasks/{task_id}")
        if after["primary_assignee_id"] == before["primary_assignee_id"]:
            failures.append(f"drag: assignee did not change ({json.dumps(before['primary_assignee_id'])})")
        if after["status"] != before["status"]:
            failures.append("drag: status changed in assignee view")
        moved_col = page.locator(f".magnet[data-id='{task_id}']").locator("xpath=ancestor::section[1]").get_attribute("data-col")
        if moved_col != f"u{after['primary_assignee_id']}":
            failures.append(f"drag: card rendered in {moved_col}, server says u{after['primary_assignee_id']}")
        summary = api(page, "api/tasks/board-summary")
        heads = page.locator(".col-count").all_inner_texts()
        expected = [f"{c['count']}건" for c in summary["by_assignee"]]
        if heads != expected:
            failures.append(f"drag: column counts {heads} != board-summary {expected}")
        ctx.close()

        # Mobile move flow: tap card -> 이동 -> pick 완료 -> 확정 (status view).
        ctx = browser.new_context(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True)
        page = ctx.new_page()
        login(page, base, "admin@demo.local")
        page.goto(base + "#/board?view=status")
        page.wait_for_selector(".magnet")
        card = page.locator(".board-col:not([data-col=done]) .magnet").first
        task_id = card.get_attribute("data-id")
        card.locator(".magnet-open").tap()
        sheet = page.locator("dialog[open]")
        sheet.get_by_role("button", name="이동", exact=True).click()
        sheet.locator(".pick label", has_text="완료").click()
        sheet.get_by_role("button", name="확정", exact=True).click()
        page.wait_for_timeout(1200)
        after = api(page, f"api/tasks/{task_id}")
        if after["status"] != "done":
            failures.append(f"mobile move: status is {after['status']}, expected done")
        ctx.close()

        # Offline inspection: fill the checklist, sign, submit while offline, reconnect -> synced.
        ctx = browser.new_context(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True)
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        login(page, base, "field2@demo.local")
        page.goto(base + "#/inspect")
        page.get_by_role("button", name="점검 시작").first.click()
        page.wait_for_selector(".judge")
        for label in page.locator("label.j-good").all():
            label.click()
        page.get_by_role("button", name="요약 확인 →").click()
        pad = page.locator(".sig-pad")
        pad.scroll_into_view_if_needed()
        b = pad.bounding_box()
        page.mouse.move(b["x"] + 30, b["y"] + 60)
        page.mouse.down()
        for i in range(12):
            page.mouse.move(b["x"] + 30 + i * 20, b["y"] + 60 + (i % 3) * 15)
        page.mouse.up()
        page.wait_for_timeout(500)
        ctx.set_offline(True)
        page.get_by_role("button", name="제출", exact=True).click()
        page.wait_for_timeout(1000)
        if "동기화 대기" not in page.locator("main").inner_text():
            failures.append("offline submit: no '동기화 대기' state shown")
        if "#/inspections/" in page.url:
            failures.append("offline submit: navigated as if the server had it")
        ctx.set_offline(False)
        try:
            page.wait_for_url("**#/inspections/*", timeout=15000)
            iid = page.url.rsplit("/", 1)[-1]
            detail = api(page, f"api/inspections/{iid}")
            if detail.get("status") != "submitted" or len(detail.get("content_hash") or "") != 64:
                failures.append(f"offline submit: server record {detail.get('status')}")
            if not any(a["owner_type"] == "signature" for a in detail.get("attachments", [])):
                failures.append("offline submit: signature not uploaded")
        except Exception as exc:  # noqa: BLE001 - report, keep going
            failures.append(f"offline submit: not synced after reconnect ({exc})")
        if errors:
            failures.append("inspection flow: " + " | ".join(errors))
        ctx.close()
        browser.close()

    if failures:
        print("SMOKE FAILURES:\n- " + "\n- ".join(failures))
        return 1
    print(f"smoke ok: {len(ROUTES)} routes x {len(WIDTHS)} widths, drag, mobile move, offline inspection sync")
    return 0


if __name__ == "__main__":
    sys.exit(main())
