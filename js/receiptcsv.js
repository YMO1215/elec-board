// 카드 영수증 → CSV (opens in Excel with live formulas). Pure: takes receiptFields() rows, returns the CSV text.
//
// Layout (one sheet, top to bottom):
//   1  title · when · files
//   요약       승인금액 / 배송비 / 승인금액-배송비 / 공급가액 / 부가세액(부가세대급금) / 대변금액(미지급비용(기타)) / 검산 / 상품명 / 건수
//   판매자별   one row per seller: 상호 · 사업자등록번호 · 대표자 · 전화 · 주소 · 건수 · 승인 · 공급 · 부가세 (COUNTIF/SUMIF)
//   상세       one row per receipt page, then a 합계 row
// Every total is a formula over the 상세 rows, so editing a number in Excel updates the summary —
// the same sums the owner keeps by hand (승인금액 143,000 · 배송비 6,000 · 공급가액 130,003 · 부가세액 12,997 · 대변 143,000).

export const DETAIL_HEADERS = [
  "번호", "구분", "결제일자", "카드사", "승인번호", "카드번호(끝4자리)", "거래종류", "상품명", "상품주문번호",
  "판매자상호", "대표자명", "사업자등록번호", "전화번호", "사업장주소",
  "승인금액", "공급가액", "부가세액", "공급가액+부가세액", "차이(승인-공급-부가)", "원본 파일", "쪽",
];
const COL = Object.fromEntries(DETAIL_HEADERS.map((name, i) => [name, String.fromCharCode(65 + i)])); // A..U

/** A formula cell (written as is). */
const f = (text) => ({ formula: text });
/** A code that must stay text in Excel (leading zeros, long digit runs): ="0123". */
const code = (text) => (text ? { formula: `="${String(text).replace(/"/g, "")}"` } : "");

/** One CSV field. Text starting with = + - @ is prefixed with ' so Excel never runs it as a formula. */
export function cell(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  let s = typeof v === "object" && "formula" in v ? v.formula : String(v);
  if (!(typeof v === "object") && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const line = (cells) => cells.map(cell).join(",");

/**
 * receipts: [{ file, page, ...receiptFields }] in order. meta: { madeAt: "2026-11-16 20:10", files: [names] }.
 * Returns the CSV text (CRLF, no BOM — the caller adds "﻿" so Excel reads UTF-8).
 */
export function receiptCsv(receipts, { madeAt = "", files = [] } = {}) {
  if (!receipts.length) throw new Error("영수증 내용을 찾지 못했어요");
  const sellers = [];
  for (const r of receipts) if (r.seller && !sellers.some((s) => s.seller === r.seller)) sellers.push(r);

  // row numbers (1-based, as Excel sees them) — the formulas need them before anything is written
  const SUMMARY_ROWS = 9;
  const summaryTop = 4; // row 1 title, 2 blank, 3 요약 header
  const sellerHead = summaryTop + SUMMARY_ROWS + 1; // one blank row between sections
  const sellerTop = sellerHead + 1;
  const detailHead = sellerTop + sellers.length + 1;
  const d0 = detailHead + 1;
  const d1 = d0 + receipts.length - 1;
  const totalRow = d1 + 1;
  const rng = (name) => `${COL[name]}${d0}:${COL[name]}${d1}`;
  const abs = (name) => `$${COL[name]}$${d0}:$${COL[name]}$${d1}`;

  const products = receipts.filter((r) => !r.shipping && r.product);
  const productText = products.length ? `${products[0].product}${products.length > 1 ? ` 외 ${products.length - 1}건` : ""}` : "";
  const B = (n) => `B${summaryTop + n}`;

  const out = [
    ["카드 영수증 정리", madeAt ? `추출 ${madeAt}` : "", files.length ? `파일: ${files.join(" · ")}` : ""],
    [],
    ["요약", "금액", "계정과목 / 비고"],
    ["승인금액", f(`=SUM(${rng("승인금액")})`), "영수증 승인금액 합계"],
    ["배송비", f(`=SUMIF(${rng("구분")},"배송비",${rng("승인금액")})`), "상품주문번호가 DF로 시작하는 영수증"],
    ["승인금액-배송비", f(`=${B(0)}-${B(1)}`), "상품 금액"],
    ["공급가액", f(`=SUM(${rng("공급가액")})`), ""],
    ["부가세액", f(`=SUM(${rng("부가세액")})`), "부가세대급금"],
    ["대변금액", f(`=${B(3)}+${B(4)}`), "미지급비용(기타)"],
    ["검산(승인금액-대변금액)", f(`=${B(0)}-${B(5)}`), "0 이면 정상"],
    ["상품명", productText, ""],
    ["영수증 수", f(`=COUNT(${rng("번호")})`), "장"],
    [],
    ["판매자상호", "사업자등록번호", "대표자명", "전화번호", "사업장주소", "건수", "승인금액", "공급가액", "부가세액"],
    ...sellers.map((s, i) => {
      const row = sellerTop + i;
      const sumIf = (name) => f(`=SUMIF(${abs("판매자상호")},$A${row},${abs(name)})`);
      return [s.seller, s.bizNo, s.ceo, s.phone, s.address, f(`=COUNTIF(${abs("판매자상호")},$A${row})`), sumIf("승인금액"), sumIf("공급가액"), sumIf("부가세액")];
    }),
    [],
    DETAIL_HEADERS,
    ...receipts.map((r, i) => {
      const row = d0 + i;
      return [
        i + 1, r.shipping ? "배송비" : "상품", r.date, r.issuer, code(r.approvalNo), code(r.cardLast4), r.kind, r.product, r.orderNo,
        r.seller, r.ceo, r.bizNo, r.phone, r.address,
        r.approved, r.supply, r.vat,
        f(`=${COL["공급가액"]}${row}+${COL["부가세액"]}${row}`),
        f(`=${COL["승인금액"]}${row}-${COL["공급가액+부가세액"]}${row}`),
        r.file ?? "", r.page ?? "",
      ];
    }),
    ["합계", "", "", "", "", "", "", "", "", "", "", "", "", "",
      f(`=SUM(${rng("승인금액")})`), f(`=SUM(${rng("공급가액")})`), f(`=SUM(${rng("부가세액")})`),
      f(`=SUM(${rng("공급가액+부가세액")})`), f(`=SUM(${rng("차이(승인-공급-부가)")})`)],
  ];
  // the layout above must agree with the row numbers the formulas use
  if (out.length !== totalRow) throw new Error(`CSV 배치 계산 오류 (${out.length} ≠ ${totalRow})`);
  return out.map(line).join("\r\n") + "\r\n";
}

/** File name for the download. */
export function csvName(docNames, now = new Date()) {
  const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  return docNames.length === 1 ? `${docNames[0]}_정리.csv` : `카드영수증_정리_${ymd}.csv`;
}
