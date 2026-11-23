// 카드 영수증 검산 — pure. Input: receiptFields() rows (+ file/page), output: 품목 목록 · 승인번호별 합계 · 문제 목록.
//
// Naver Pay card receipts: every item is a 상품(PD…) receipt, optionally followed by a 배송비(DF…) receipt with the
// same 상품명 and seller; all receipts of one order share one 승인번호. 부가세 = ⌊승인금액 ÷ 11⌋, 공급가액 = 승인 − 부가세.

export const VAT_DIVISOR = 11;

const won = (n) => `${n.toLocaleString("ko-KR")}원`;
const where = (r) => (r.file ? `${r.file} ${r.page}쪽` : `${r.page ?? "?"}쪽`);

/**
 * receipts: [{ file, page, approvalNo, date, product, orderNo, shipping, seller, approved, supply, vat, total }]
 * Returns { approvals, items, issues, ok, total } — ok = no "error" issue; expected = the amount to compare with, if any.
 */
export function auditReceipts(receipts, { expectedTotal = null } = {}) {
  const issues = [];
  const add = (level, at, msg) => issues.push({ level, where: at, msg });

  // ---- per receipt ----
  const seen = new Map();
  for (const r of receipts) {
    const at = where(r);
    const nums = { 승인금액: r.approved, 공급가액: r.supply, 부가세액: r.vat };
    const missing = Object.entries(nums).filter(([, v]) => !Number.isInteger(v)).map(([k]) => k);
    if (missing.length) { add("error", at, `${missing.join("·")} 을 읽지 못했어요`); continue; }
    if (r.supply + r.vat !== r.approved) add("error", at, `공급가액 ${won(r.supply)} + 부가세 ${won(r.vat)} = ${won(r.supply + r.vat)} 인데 승인금액은 ${won(r.approved)}`);
    if (Number.isInteger(r.total) && r.total !== r.approved) add("error", at, `합계 ${won(r.total)} 와 승인금액 ${won(r.approved)} 이 달라요`);
    const vatRule = Math.floor(r.approved / VAT_DIVISOR);
    const gap = Math.abs(r.vat - vatRule);
    if (gap === 1) add("warn", at, `부가세 ${won(r.vat)} — 승인금액÷11 내림(${won(vatRule)})과 1원 차이(반올림 방식)`);
    else if (gap > 1) add("error", at, `부가세 ${won(r.vat)} — 승인금액÷11 내림은 ${won(vatRule)}`);
    if (r.orderNo) {
      if (seen.has(r.orderNo)) add("error", at, `상품주문번호 ${r.orderNo} 가 ${seen.get(r.orderNo)} 와 겹쳐요 (같은 영수증이 두 번 들어갔을 수 있어요)`);
      else seen.set(r.orderNo, at);
    }
  }

  // ---- 품목: 승인번호 + 판매자 + 상품명 으로 묶는다 (상품 + 배송비) ----
  const byKey = new Map();
  for (const r of receipts) {
    if (!Number.isInteger(r.approved)) continue;
    const key = [r.approvalNo, r.seller, r.product].join("\u0001");
    let it = byKey.get(key);
    if (!it) {
      it = { approvalNo: r.approvalNo, seller: r.seller, product: r.product, itemAmt: 0, shipAmt: 0, supply: 0, vat: 0, hasItem: false, pages: [] };
      byKey.set(key, it);
    }
    if (r.shipping) it.shipAmt += r.approved; else { it.itemAmt += r.approved; it.hasItem = true; }
    it.supply += Number.isInteger(r.supply) ? r.supply : 0;
    it.vat += Number.isInteger(r.vat) ? r.vat : 0;
    it.pages.push(where(r));
  }
  const items = [...byKey.values()].map((it) => ({ ...it, total: it.itemAmt + it.shipAmt }));
  for (const it of items) {
    if (!it.hasItem) add("warn", it.pages.join(", "), `「${it.product}」 — 배송비 영수증만 있고 상품 영수증이 없어요`);
  }

  // ---- 승인번호별 ----
  const approvals = [];
  for (const r of receipts) {
    if (!Number.isInteger(r.approved)) continue;
    let a = approvals.find((x) => x.approvalNo === r.approvalNo);
    if (!a) { a = { approvalNo: r.approvalNo, date: r.date, count: 0, approved: 0, supply: 0, vat: 0, ship: 0, issues: 0 }; approvals.push(a); }
    a.count += 1;
    a.approved += r.approved;
    a.supply += Number.isInteger(r.supply) ? r.supply : 0;
    a.vat += Number.isInteger(r.vat) ? r.vat : 0;
    if (r.shipping) a.ship += r.approved;
  }
  for (const a of approvals) {
    const fromItems = items.filter((it) => it.approvalNo === a.approvalNo).reduce((n, it) => n + it.total, 0);
    if (fromItems !== a.approved) add("error", `승인번호 ${a.approvalNo}`, `품목 합계 ${won(fromItems)} 와 영수증 합계 ${won(a.approved)} 가 달라요`);
    if (a.supply + a.vat !== a.approved) add("error", `승인번호 ${a.approvalNo}`, `공급가액 합 + 부가세 합 = ${won(a.supply + a.vat)} 인데 승인금액 합은 ${won(a.approved)}`);
  }
  const dates = new Set(approvals.map((a) => (a.date ?? "").slice(0, 10)).filter(Boolean));
  if (approvals.length > 1 && dates.size > 1) add("warn", "전체", `결제일이 ${dates.size}가지예요 (${[...dates].join(" · ")}) — 다른 건이 섞이지 않았는지 확인하세요`);

  // ---- 외부 금액(카드 청구액·지출결의)과 대조 ----
  const total = approvals.reduce((n, a) => n + a.approved, 0);
  let compare = null;
  if (Number.isInteger(expectedTotal) && expectedTotal >= 0) {
    compare = { expected: expectedTotal, total, diff: total - expectedTotal };
    if (compare.diff !== 0) add("error", "총액", `영수증 합계 ${won(total)} − 입력한 금액 ${won(expectedTotal)} = ${compare.diff > 0 ? "+" : "−"}${won(Math.abs(compare.diff))}`);
  }
  if (!receipts.length) add("error", "전체", "카드 영수증 내용을 찾지 못했어요");

  return { approvals, items, issues, ok: !issues.some((i) => i.level === "error"), total, compare };
}
