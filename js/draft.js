// 기안문(결재 문서)의 「구매내역」 표 읽기 — pure. Input: the page's text lines, each line = its text pieces left to right
// (receipt.rowsOf(items).map((r) => r.items.map((i) => i.str))).
//
// 표: 품명 · 규격 · 단가 · 수량 · 금액. A line that was changed after ordering is laid out over three lines:
//     [기존 단가·금액]  /  [품명 … 수량 · 「금액 변동」]  /  [변경 단가·금액]   (배송비·합계도 같은 모양)
// so a 「금액 변동」 line takes its neighbours: the line below = new values, the line above = old values.

const NUM = /^\d{1,3}(?:,\d{3})+$|^\d+$/;
const num = (t) => Number(String(t).replace(/,/g, ""));
const compact = (r) => r.join("").replace(/\s+/g, "");
const isPair = (r) => Array.isArray(r) && r.length === 2 && r.every((t) => NUM.test(t));
const isSingle = (r) => Array.isArray(r) && r.length === 1 && NUM.test(r[0]);
const pairOf = (r) => (isPair(r) ? { unit: num(r[0]), amount: num(r[1]) } : null);
const singleOf = (r) => (isSingle(r) ? num(r[0]) : null);

/**
 * Returns { items, shipping, total, skipped } or null when these lines have no 구매내역 table.
 * items: [{ name, unit, qty, amount, prevAmount, changed }] in table order (amount = the final one);
 * shipping / total: { amount, prev } or null; skipped: lines of the table that could not be read.
 */
export function parseDraft(rows) {
  const start = rows.findIndex((r) => ["품명", "단가", "수량", "금액"].every((w) => compact(r).includes(w)));
  if (start < 0) return null;
  let end = rows.findIndex((r, i) => i > start && /구매비용/.test(compact(r)));
  if (end < 0) end = rows.length;
  const body = rows.slice(start + 1, end);
  const items = [];
  const skipped = [];
  let shipping = null;
  let total = null;
  for (let i = 0; i < body.length; i += 1) {
    const r = body[i];
    if (isPair(r) || isSingle(r)) continue; // old/new values: taken by the neighbouring 「금액 변동」 line
    const text = compact(r);
    const changed = text.includes("금액변동");
    const nums = r.filter((t) => NUM.test(t));
    if (/^합계/.test(text)) {
      if (changed) total = { amount: singleOf(body[i + 1]), prev: singleOf(body[i - 1]) };
      else if (nums.length) total = { amount: num(nums.at(-1)), prev: null };
      else skipped.push(r.join(" "));
      continue;
    }
    if (/^배송비/.test(text)) {
      if (changed) shipping = { amount: pairOf(body[i + 1])?.amount ?? null, prev: pairOf(body[i - 1])?.amount ?? null };
      else if (nums.length) shipping = { amount: num(nums.at(-1)), prev: null };
      else skipped.push(r.join(" "));
      continue;
    }
    if (changed) {
      const parts = r.filter((t) => !/금액\s*변동/.test(t));
      const qty = parts.length && NUM.test(parts.at(-1)) ? num(parts.at(-1)) : null;
      const now = pairOf(body[i + 1]);
      const before = pairOf(body[i - 1]);
      if (!now) { skipped.push(r.join(" ")); continue; }
      items.push({ name: parts.slice(0, qty === null ? parts.length : -1).join(" "), unit: now.unit, qty, amount: now.amount, prevAmount: before?.amount ?? null, changed: true });
      continue;
    }
    let k = r.length;
    while (k > 0 && NUM.test(r[k - 1])) k -= 1;
    if (r.length - k >= 3) {
      const [unit, qty, amount] = r.slice(-3).map(num);
      items.push({ name: r.slice(0, -3).join(" "), unit, qty, amount, prevAmount: null, changed: false });
    } else skipped.push(r.join(" "));
  }
  return items.length ? { items, shipping, total, skipped } : null;
}
