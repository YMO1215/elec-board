// 기안문 ↔ 카드 영수증 짝짓기 · 검산 · 페이지 순서 — pure.
// Each 기안문 item is paired with the receipt item (상품 + 배송비 영수증, see receiptaudit) whose 상품 amount equals the
// item's 금액; names only break ties (they differ: 「LED 방습등 40W」 vs the shop's long product title).
// The resulting page order follows the 기안문 table: item 1 상품 → item 1 배송비, item 2 …, then anything unpaired.

import { auditReceipts } from "./receiptaudit.js";

const won = (n) => `${n.toLocaleString("ko-KR")}원`;
const bigrams = (s) => {
  const t = String(s ?? "").toLowerCase().replace(/\s+/g, "");
  const out = new Map();
  for (let i = 0; i < t.length - 1; i += 1) out.set(t.slice(i, i + 2), (out.get(t.slice(i, i + 2)) ?? 0) + 1);
  return out;
};
/** 0..1, how alike two names look (shared character pairs). Only used to choose between equal amounts. */
export function similarity(a, b) {
  const x = bigrams(a);
  const y = bigrams(b);
  let shared = 0;
  for (const [k, n] of x) shared += Math.min(n, y.get(k) ?? 0);
  const all = [...x.values()].reduce((s, n) => s + n, 0) + [...y.values()].reduce((s, n) => s + n, 0);
  return all ? (2 * shared) / all : 0;
}

/**
 * draft: parseDraft() result. receipts: receiptFields rows + { file, page, doc } (doc = position of the file).
 * Returns { rows, order, issues, ok, audit } —
 *   rows:  per draft item { name, amount, prevAmount, status: "ok"|"old"|"missing", group, receiptAmount }
 *   order: the receipt rows in the new page order (paired groups in 기안문 order, then unpaired)
 *   extra: receipt items no 기안문 item claimed
 */
export function matchDraft(draft, receipts) {
  const audit = auditReceipts(receipts);
  const issues = audit.issues.filter((i) => i.level === "error").map((i) => ({ ...i, level: "error" }));
  const add = (level, where, msg) => issues.push({ level, where, msg });
  const free = audit.items.map((g, i) => ({ g, i, taken: false }));
  const take = (amount, name) => {
    const cands = free.filter((f) => !f.taken && f.g.itemAmt === amount);
    if (!cands.length) return null;
    cands.sort((p, q) => similarity(name, q.g.product) - similarity(name, p.g.product) || p.i - q.i);
    cands[0].taken = true;
    return cands[0].g;
  };

  const rows = draft.items.map((it) => {
    let group = take(it.amount, it.name);
    let status = group ? "ok" : "missing";
    if (!group && it.prevAmount != null) { // the receipt still shows the amount from before the change
      group = take(it.prevAmount, it.name);
      if (group) status = "old";
    }
    const row = { name: it.name, unit: it.unit, qty: it.qty, amount: it.amount, prevAmount: it.prevAmount, changed: it.changed, status, group, receiptAmount: group ? group.itemAmt : null };
    if (status === "missing") add("error", it.name, `기안문 ${won(it.amount)} 에 맞는 영수증이 없어요`);
    if (status === "old") add("error", it.name, `영수증은 변경 전 금액 ${won(it.prevAmount)} 이에요 (기안문은 ${won(it.amount)})`);
    if (Number.isInteger(it.unit) && Number.isInteger(it.qty) && it.unit * it.qty !== it.amount) {
      add("error", it.name, `기안문 단가 ${it.unit.toLocaleString("ko-KR")} × 수량 ${it.qty} = ${won(it.unit * it.qty)} 인데 금액은 ${won(it.amount)}`);
    }
    return row;
  });
  const extra = free.filter((f) => !f.taken).map((f) => f.g);
  for (const g of extra) add("error", g.product || "(상품명 없음)", `영수증 ${won(g.itemAmt)} 에 맞는 기안문 품목이 없어요`);

  // 합계 · 배송비 — draft table against itself, then against the receipts
  const receiptShip = audit.items.reduce((n, g) => n + g.shipAmt, 0);
  const itemsSum = draft.items.reduce((n, it) => n + it.amount, 0);
  if (draft.total?.amount != null) {
    const sum = itemsSum + (draft.shipping?.amount ?? 0);
    if (sum !== draft.total.amount) add("error", "기안문 합계", `품목 합 ${won(itemsSum)} + 배송비 ${won(draft.shipping?.amount ?? 0)} = ${won(sum)} 인데 합계는 ${won(draft.total.amount)}`);
    if (audit.total !== draft.total.amount) add("error", "합계", `영수증 합계 ${won(audit.total)} 와 기안문 합계 ${won(draft.total.amount)} 의 차이 ${audit.total > draft.total.amount ? "+" : "−"}${won(Math.abs(audit.total - draft.total.amount))}`);
  } else add("warn", "기안문 합계", "합계를 읽지 못했어요");
  if (draft.shipping?.amount != null) {
    if (receiptShip !== draft.shipping.amount) add("error", "배송비", `영수증 배송비 합 ${won(receiptShip)} 와 기안문 배송비 ${won(draft.shipping.amount)} 가 달라요`);
  } else if (receiptShip) add("warn", "배송비", `영수증에는 배송비 ${won(receiptShip)} 가 있는데 기안문에서 배송비를 읽지 못했어요`);

  // page order: 상품 receipt(s) then 배송비 receipt(s) of each paired group, in 기안문 order; unpaired groups last
  const bySource = (a, b) => a.doc - b.doc || a.page - b.page;
  const sorted = (g) => [...g.rows.filter((r) => !r.shipping).sort(bySource), ...g.rows.filter((r) => r.shipping).sort(bySource)];
  const order = [...rows.filter((r) => r.group).flatMap((r) => sorted(r.group)), ...extra.flatMap(sorted)];
  return { rows, order, extra, issues, ok: !issues.some((i) => i.level === "error"), audit };
}
