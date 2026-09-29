"""Server-side PDF report for an approved inspection (reportlab)."""
from __future__ import annotations

import io
from datetime import datetime
from pathlib import Path
from typing import Any

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Image, KeepTogether, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
from xml.sax.saxutils import escape

from ..config import PDF_FONT_CANDIDATES, Settings
from . import files

_FONT_NAME: str | None = None
MAX_PHOTOS = 8
INK = colors.HexColor("#15191e")
MUTED = colors.HexColor("#5b6570")
LINE = colors.HexColor("#d5dbe1")
HEAD_BG = colors.HexColor("#eef2f5")
RESULT_TEXT = {"good": "양호", "bad": "불량", "na": "해당없음", None: "미판정"}


def _font(settings: Settings) -> str:
    """Embed a Hangul TrueType font when one is available; otherwise use the
    Adobe-Korea1 CID font, which PDF viewers render with their own Korean font."""
    global _FONT_NAME
    if _FONT_NAME:
        return _FONT_NAME
    candidates = [settings.pdf_font_path] if settings.pdf_font_path else []
    candidates += list(PDF_FONT_CANDIDATES)
    for path in candidates:
        if path and Path(path).is_file():
            try:
                pdfmetrics.registerFont(TTFont("ReportKR", path))
                _FONT_NAME = "ReportKR"
                return _FONT_NAME
            except Exception:  # unsupported outline format (e.g. CFF) -> try next
                continue
    pdfmetrics.registerFont(UnicodeCIDFont("HYGothic-Medium"))
    _FONT_NAME = "HYGothic-Medium"
    return _FONT_NAME


def _local(ts: str | None, settings: Settings) -> str:
    if not ts:
        return "-"
    return datetime.fromisoformat(ts).astimezone(settings.tz).strftime("%Y-%m-%d %H:%M")


def _p(text: Any, style: ParagraphStyle) -> Paragraph:
    return Paragraph(escape(str(text if text not in (None, "") else "-")).replace("\n", "<br/>"), style)


def build_report(settings: Settings, detail: dict[str, Any], report: dict[str, Any]) -> bytes:
    font = _font(settings)
    base = ParagraphStyle("base", fontName=font, fontSize=9.5, leading=13.5, textColor=INK, alignment=TA_LEFT)
    small = ParagraphStyle("small", parent=base, fontSize=8, leading=11, textColor=MUTED)
    h1 = ParagraphStyle("h1", parent=base, fontSize=17, leading=22, spaceAfter=2)
    h2 = ParagraphStyle("h2", parent=base, fontSize=11.5, leading=16, spaceBefore=10, spaceAfter=5)

    approved_at = _local(report["approved_at"], settings)
    footer_text = (f"보고서 v{report['version']} · 생성 {approved_at} · 승인 {report['approver_name']}"
                   f" · 점검 #{detail['id']}")

    def on_page(canvas, doc):
        canvas.saveState()
        canvas.setFont(font, 7.5)
        canvas.setFillColor(MUTED)
        canvas.drawString(18 * mm, 10 * mm, footer_text)
        canvas.drawRightString(A4[0] - 18 * mm, 10 * mm, f"{doc.page} 쪽")
        canvas.restoreState()

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm,
                            topMargin=16 * mm, bottomMargin=18 * mm,
                            title=f"점검 보고서 #{detail['id']} v{report['version']}",
                            author=report["approver_name"])
    story: list[Any] = [
        _p("전기설비 점검 보고서", h1),
        _p(f"{detail['site_name']} · {detail['asset_name']}", small),
        Spacer(1, 6),
    ]

    reviewer = next((r["reviewer_name"] for r in reversed(detail["reviews"]) if r["decision"] == "reviewed"), "-")
    asset = detail["asset"] or {}
    template = detail["template"] or {}
    gps = "-"
    if detail.get("gps_lat") is not None:
        gps = f"{detail['gps_lat']:.6f}, {detail['gps_lng']:.6f} (±{detail.get('gps_accuracy') or 0:.0f}m)"
    meta = [
        ("보고서 버전", f"v{report['version']}"), ("생성·승인 시각", approved_at),
        ("승인자", report["approver_name"]), ("검토자", reviewer),
        ("점검자", detail["inspector_name"]), ("제출 시각", _local(detail["submitted_at"], settings)),
        ("현장", detail["site_name"]), ("설비", f"{asset.get('name', '-')} ({asset.get('asset_type', '-')})"),
        ("설치 위치", asset.get("location") or "-"), ("위치 기록(GPS)", gps),
        ("점검 서식", f"{template.get('name', '-')} v{template.get('version', '-')}"
                      + (" · 예시 서식" if template.get("is_sample") else "")),
        ("정정 대상", f"점검 #{detail['corrects_id']}" if detail.get("corrects_id") else "없음 (원본)"),
    ]
    meta_rows = []
    for i in range(0, len(meta), 2):
        left, right = meta[i], meta[i + 1]
        meta_rows.append([_p(left[0], small), _p(left[1], base), _p(right[0], small), _p(right[1], base)])
    meta_table = Table(meta_rows, colWidths=[24 * mm, 63 * mm, 24 * mm, 63 * mm])
    meta_table.setStyle(TableStyle([
        ("GRID", (0, 0), (-1, -1), 0.5, LINE),
        ("BACKGROUND", (0, 0), (0, -1), HEAD_BG),
        ("BACKGROUND", (2, 0), (2, -1), HEAD_BG),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    story.append(meta_table)

    counts = {k: sum(1 for it in detail["items"] if it["result"] == k) for k in ("good", "bad", "na")}
    story.append(_p(f"판정 결과 — 양호 {counts['good']} · 불량 {counts['bad']} · 해당없음 {counts['na']}"
                    f" (전체 {len(detail['items'])}항목)", h2))
    rows = [[_p("No", small), _p("구분", small), _p("점검 항목", small), _p("판정", small), _p("메모", small)]]
    for n, it in enumerate(detail["items"], start=1):
        rows.append([_p(n, base), _p(it["section"], base), _p(it["label"], base),
                     _p(RESULT_TEXT[it["result"]], base), _p(it["memo"], base)])
    items_table = Table(rows, colWidths=[10 * mm, 26 * mm, 62 * mm, 18 * mm, 58 * mm], repeatRows=1)
    style = [
        ("GRID", (0, 0), (-1, -1), 0.5, LINE),
        ("BACKGROUND", (0, 0), (-1, 0), HEAD_BG),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]
    for n, it in enumerate(detail["items"], start=1):
        if it["result"] == "bad":
            style.append(("BACKGROUND", (3, n), (3, n), colors.HexColor("#fbe3e5")))
    items_table.setStyle(TableStyle(style))
    story.append(items_table)

    if detail["findings"]:
        story.append(_p("지적사항 및 후속 조치", h2))
        f_rows = [[_p("항목", small), _p("내용", small), _p("담당", small), _p("기한", small), _p("상태", small)]]
        for f in detail["findings"]:
            f_rows.append([_p(f.get("item_label") or f["item_key"], base), _p(f["description"], base),
                           _p(f["assignee_name"], base), _p(f["due_date"], base),
                           _p("조치 완료" if f["status"] == "resolved" else "미조치", base)])
        f_table = Table(f_rows, colWidths=[36 * mm, 70 * mm, 24 * mm, 22 * mm, 22 * mm], repeatRows=1)
        f_table.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.5, LINE),
                                     ("BACKGROUND", (0, 0), (-1, 0), HEAD_BG),
                                     ("VALIGN", (0, 0), (-1, -1), "TOP")]))
        story.append(f_table)

    labels = {it["item_key"]: it["label"] for it in detail["items"]}
    photos = [a for a in detail["attachments"]
              if a["owner_type"] != "signature" and a["mime"].startswith("image/")][:MAX_PHOTOS]
    others = [a for a in detail["attachments"]
              if a["owner_type"] != "signature" and not a["mime"].startswith("image/")]
    if photos or others:
        story.append(_p("증빙 자료", h2))
    cells = []
    for a in photos:
        try:
            img = Image(str(files.absolute_path(settings, a)))
            ratio = img.imageHeight / float(img.imageWidth or 1)
            img.drawWidth = 78 * mm
            img.drawHeight = min(78 * mm * ratio, 70 * mm)
            img.drawWidth = img.drawHeight / ratio if ratio else img.drawWidth
            cells.append([img, _p(labels.get(a["item_key"], "점검 전체"), small)])
        except Exception:
            cells.append([_p(f"(이미지를 읽을 수 없음: {a['filename']})", small), _p("", small)])
    grid = []
    for i in range(0, len(cells), 2):
        pair = cells[i:i + 2] + ([["", ""]] if len(cells[i:i + 2]) == 1 else [])
        grid.append([pair[0][0], pair[1][0]])
        grid.append([pair[0][1], pair[1][1]])
    if grid:
        story.append(Table(grid, colWidths=[87 * mm, 87 * mm]))
    if others:
        story.append(_p("그 밖의 첨부: " + ", ".join(f"{a['filename']} ({a['mime']})" for a in others), small))

    sig_block: list[Any] = [_p("전자서명", h2)]
    sig = next((a for a in detail["attachments"] if a["owner_type"] == "signature"), None)
    if sig is not None:
        try:
            img = Image(str(files.absolute_path(settings, sig)))
            ratio = img.imageHeight / float(img.imageWidth or 1)
            img.drawWidth = 60 * mm
            img.drawHeight = 60 * mm * ratio
            sig_block.append(img)
        except Exception:
            sig_block.append(_p("(서명 이미지를 읽을 수 없음)", small))
    sig_block.append(_p(f"서명자: {detail['signer_name']}", base))
    story.append(KeepTogether(sig_block))

    story.append(_p("무결성", h2))
    story.append(_p(f"제출 원본 SHA-256: {detail['content_hash']}", small))
    story.append(_p("이 보고서는 제출된 점검 원본으로 생성되었습니다. 원본은 수정할 수 없으며 정정은 새 기록으로 연결됩니다.",
                    small))
    doc.build(story, onFirstPage=on_page, onLaterPages=on_page)
    return buf.getvalue()
