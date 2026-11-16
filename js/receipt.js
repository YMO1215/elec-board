// 카드 영수증 (네이버페이 카드 영수증 PDF) 형광 표시 규칙 — pure, so it is unit tested without a browser.
//
// Pattern taken from a receipt the owner marked by hand (2026-11-16):
//   every page: yellow highlight on the VALUE (right column) of
//     카드번호 → only the last 4 digits · 결제일자 · 상품명 ·
//     판매자 정보의 판매자상호 · 대표자명 · 사업자등록번호 ·
//     사업장주소 → only the part equal to 판매자상호 · 공급가액 · 부가세액
//   first page only: "구매자 : <이름>" in red, 20pt, top-left (x 40, baseline 64pt below the top edge).
// Not marked: 승인번호, 거래종류, 주문번호, 전화번호, 가맹점 정보 전체, 승인금액, 봉사료, 합계.
//
// Input items come from pdf.js getTextContent: { str, x, y (baseline), w (width), fs (font size) } in PDF points.

export const BUYER = { x: 40.2, fromTop: 64.0, size: 20, color: [1, 0, 0] }; // measured on the hand-marked receipt (595pt-wide page)
export const HIGHLIGHT_COLOR = [1, 1, 0];
const ROW_TOLERANCE = 1.5; // items whose baselines differ by less than this are on one line
const LABEL_START_MAX_X = 100; // a label starts at the left margin (57.7pt on these receipts)
const LABEL_GAP_EM = 1.2; // label pieces ("카드번호" "(" "유효기간" ")") touch; the value starts after a wide gap
// (a fixed "label column ends at x" fails: a long 상품명 starts as far left as 146pt)

/** Split a line into its label (the tight run of pieces at the left margin) and the rest (the value). */
export function splitRow(items) {
  const label = [];
  if (items[0] && items[0].x < LABEL_START_MAX_X) {
    label.push(items[0]);
    for (let k = 1; k < items.length; k += 1) {
      const prev = items[k - 1];
      if (items[k].x - (prev.x + prev.w) > prev.fs * LABEL_GAP_EM) break;
      label.push(items[k]);
    }
  }
  return { label, value: items.slice(label.length) };
}

/** Group text items into lines (top to bottom), each line's items left to right. */
export function rowsOf(items) {
  const rows = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const row = rows.find((r) => Math.abs(r.y - it.y) < ROW_TOLERANCE);
    if (row) row.items.push(it);
    else rows.push({ y: it.y, items: [it] });
  }
  for (const r of rows) r.items.sort((a, b) => a.x - b.x);
  return rows.sort((a, b) => b.y - a.y); // PDF y grows upwards
}

/**
 * Characters of some items with their x range. Each item's width is shared out by `measure`
 * (relative glyph widths, e.g. canvas measureText) so a part of an item can be marked.
 * A gap between two items becomes one space, so "주식회사" + "동승" reads "주식회사 동승".
 */
export function charsOf(items, measure) {
  const chars = [];
  items.forEach((it, n) => {
    const prev = items[n - 1];
    if (prev && it.x - (prev.x + prev.w) > it.fs * 0.15) chars.push({ c: " ", x0: prev.x + prev.w, x1: it.x, fs: it.fs, y: it.y });
    const total = measure(it.str, it.fs) || it.str.length;
    let before = 0;
    for (let k = 0; k < it.str.length; k += 1) {
      const upto = measure(it.str.slice(0, k + 1), it.fs) || k + 1;
      chars.push({ c: it.str[k], x0: it.x + (it.w * before) / total, x1: it.x + (it.w * upto) / total, fs: it.fs, y: it.y });
      before = upto;
    }
  });
  return chars;
}

const textOf = (chars) => chars.map((c) => c.c).join("");

/** One highlight: x range of chars[from, to) on their line. */
function quadOf(chars, from, to) {
  const part = chars.slice(from, to).filter((c) => c.c !== " ");
  if (!part.length) return null;
  const fs = Math.max(...part.map((c) => c.fs));
  return { x0: part[0].x0, x1: part[part.length - 1].x1, y: part[0].y, fs };
}

/** Find `needle` in a line (spaces ignored on both sides, so "주식회사동승" still matches "주식회사 동승"). */
function findIn(chars, needle) {
  const want = needle.replace(/\s+/g, "");
  if (!want) return null;
  const idx = [];
  let flat = "";
  chars.forEach((c, i) => { if (c.c !== " ") { flat += c.c; idx.push(i); } });
  const at = flat.indexOf(want);
  return at < 0 ? null : quadOf(chars, idx[at], idx[at + want.length - 1] + 1);
}

const LABELS = [
  { key: "card", label: "카드번호" },
  { key: "date", label: "결제일자" },
  { key: "product", label: "상품명", lines: true }, // a long product name wraps: mark every line
  { key: "seller", label: "판매자상호", section: "seller" },
  { key: "ceo", label: "대표자명", section: "seller" },
  { key: "bizno", label: "사업자등록번호", section: "seller" },
  { key: "address", label: "사업장주소", section: "seller", lines: true },
  { key: "supply", label: "공급가액" },
  { key: "vat", label: "부가세액" },
];

/**
 * Highlights for one receipt page, plus whether it already carries a 구매자 line.
 * Returns { quads: [{ key, x0, x1, y, fs }], found: number of labels found, hasBuyer }.
 */
export function receiptMarks(items, measure) {
  const rows = rowsOf(items).map((r) => {
    const { label, value } = splitRow(r.items);
    return { y: r.y, label: label.map((it) => it.str).join("").replace(/\s+/g, ""), value: charsOf(value, measure), all: r.items };
  });
  const hasBuyer = rows.some((r) => r.label.startsWith("구매자:"));

  // 판매자 정보 runs from its heading to the 가맹점 정보 heading; 대표자명 / 사업자등록번호 also appear under 가맹점 정보
  const headingAt = (word) => rows.findIndex((r) => r.label.startsWith(word) && r.label.endsWith("정보"));
  const sellerFrom = headingAt("판매자");
  const merchantFrom = headingAt("가맹점");
  const inSeller = (i) => (sellerFrom < 0 || i > sellerFrom) && (merchantFrom < 0 || i < merchantFrom);

  const quads = [];
  let found = 0;
  let sellerName = "";
  const labelRows = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.label);
  for (const spec of LABELS) {
    const hit = labelRows.find(({ r, i }) => r.label.startsWith(spec.label) && (spec.section !== "seller" || inSeller(i)));
    if (!hit) continue;
    found += 1;
    // the value's lines: this row, and for wrapping fields the label-less rows under it
    const lines = [hit.r];
    if (spec.lines) {
      for (let j = hit.i + 1; j < rows.length && !rows[j].label && rows[j].value.length; j += 1) lines.push(rows[j]);
    }
    for (const line of lines) {
      const chars = line.value;
      if (!chars.length) continue;
      const text = textOf(chars);
      let q = null;
      if (spec.key === "card") {
        const m = text.match(/(\d{4})(?=\s*\(|\s*$)/) ?? [...text.matchAll(/\d{4}/g)].pop();
        if (m) q = quadOf(chars, m.index, m.index + 4);
      } else if (spec.key === "address") {
        q = sellerName ? findIn(chars, sellerName) : null;
      } else {
        q = quadOf(chars, 0, chars.length);
        if (spec.key === "seller") sellerName = text.trim();
      }
      if (q) quads.push({ key: spec.key, ...q });
    }
  }
  return { quads, found, hasBuyer };
}

/** Highlight geometry the way the hand-marked file has it: quad hugs the glyphs, rect is ~3pt wider. */
export function highlightBox(q) {
  const bottom = q.y - 0.21 * q.fs;
  const top = q.y + 0.91 * q.fs;
  return {
    quad: [q.x0, top, q.x1, top, q.x0, bottom, q.x1, bottom],
    rect: [q.x0 - 3, bottom - 0.8, q.x1 + 3, top + 0.8],
  };
}

/** Where "구매자 : 이름" goes on a page of this size (scaled from the 595pt page it was measured on). */
export function buyerSpot(pageWidth, pageHeight) {
  const k = pageWidth / 595;
  return { x: BUYER.x * k, baseline: pageHeight - BUYER.fromTop * k, size: BUYER.size * k };
}

export const buyerText = (name) => `구매자 : ${String(name ?? "").trim()}`;
