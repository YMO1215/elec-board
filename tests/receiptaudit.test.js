import assert from "node:assert/strict";
import { test } from "node:test";

import { auditReceipts } from "../js/receiptaudit.js";

// 2026-11-06 전등 구매 「카드 영수증」 15쪽 (승인번호 49893088 한 건) — 실제 파일에서 읽은 값.
const A = "49893088";
const D = "2026-11-06 16:01:00";
const row = (page, product, seller, order, approved, supply, vat) => ({
  file: "카드 영수증", page, approvalNo: A, date: D, product, orderNo: order, shipping: /^DF/.test(order),
  seller, approved, supply, vat, total: approved,
});
const REAL = [
  row(1, "주차장등", "(주)일월전기조명", "DF20261106109520258892", 4000, 3637, 363),
  row(2, "주차장등", "(주)일월전기조명", "PD2026110623683141", 1263600, 1148728, 114872),
  row(3, "평판조명", "(주)솔라루체", "DF20261106109520258891", 3000, 2728, 272),
  row(4, "평판조명", "(주)솔라루체", "PD2026110623683201", 1430000, 1300000, 130000),
  row(5, "S평판", "밝은조명", "DF20261106109520258890", 5000, 4546, 454),
  row(6, "S평판", "밝은조명", "PD2026110623683191", 525000, 477273, 47727),
  row(7, "직부등15W", "주식회사 동방엘이디", "DF20261106109520258889", 9000, 8182, 818),
  row(8, "직부등15W", "주식회사 동방엘이디", "PD2026110623683171", 89000, 80910, 8090),
  row(9, "직부등20W", "주식회사 동방엘이디", "PD2026110623683181", 172000, 156364, 15636),
  row(10, "공장등", "주식회사 동방엘이디", "DF20261106109520258887", 24000, 21819, 2181),
  row(11, "공장등", "주식회사 동방엘이디", "PD2026110623683151", 747000, 679091, 67909),
  row(12, "니플", "주식회사 동방엘이디", "PD2026110623683161", 25000, 22728, 2272),
  row(13, "다운라이트", "월드조명 주식회사", "DF20261106109520258888", 15000, 13637, 1363),
  row(14, "다운라이트", "월드조명 주식회사", "PD2026110623683211", 90000, 81819, 8181),
  row(15, "투광등", "월드조명 주식회사", "PD2026110623683221", 580000, 527273, 52727),
];
const copy = () => REAL.map((r) => ({ ...r }));

test("real 15-page receipt: 9 items, 4,981,600 in one approval, no issues", () => {
  const out = auditReceipts(copy());
  assert.equal(out.items.length, 9);
  assert.equal(out.approvals.length, 1);
  assert.equal(out.approvals[0].approved, 4981600);
  assert.equal(out.approvals[0].supply, 4528735);
  assert.equal(out.approvals[0].vat, 452865);
  assert.equal(out.approvals[0].ship, 60000);
  assert.deepEqual(out.issues, []);
  assert.equal(out.ok, true);
  const lamp = out.items.find((i) => i.product === "주차장등");
  assert.deepEqual([lamp.itemAmt, lamp.shipAmt, lamp.total], [1263600, 4000, 1267600]);
  assert.equal(out.items.find((i) => i.product === "니플").shipAmt, 0);
});

test("expected total: equal passes, different shows the signed difference", () => {
  assert.equal(auditReceipts(copy(), { expectedTotal: 4981600 }).ok, true);
  const bad = auditReceipts(copy(), { expectedTotal: 4981000 });
  assert.equal(bad.ok, false);
  assert.equal(bad.compare.diff, 600);
  assert.match(bad.issues.at(-1).msg, /\+600원/);
});

test("supply + vat off by one is an error", () => {
  const r = copy();
  r[1].supply += 1;
  const out = auditReceipts(r);
  assert.equal(out.ok, false);
  assert.ok(out.issues.some((i) => i.level === "error" && /공급가액/.test(i.msg)));
});

test("vat one won off the ÷11 floor rule is only a warning", () => {
  const r = copy();
  r[0].vat = 364; // 4000/11 = 363.6 -> floor 363, rounding gives 364
  r[0].supply = 3636;
  const out = auditReceipts(r);
  assert.equal(out.ok, true);
  assert.ok(out.issues.some((i) => i.level === "warn" && /1원 차이/.test(i.msg)));
});

test("vat far from ÷11 is an error", () => {
  const r = copy();
  r[1].vat += 100;
  r[1].supply -= 100;
  assert.equal(auditReceipts(r).ok, false);
});

test("a shipping-only group warns; duplicate order number is an error", () => {
  const only = auditReceipts(copy().filter((r) => r.page !== 2));
  assert.ok(only.issues.some((i) => i.level === "warn" && /배송비 영수증만/.test(i.msg)));
  const dup = copy();
  dup.push({ ...dup[1], page: 16 });
  const out = auditReceipts(dup);
  assert.equal(out.ok, false);
  assert.ok(out.issues.some((i) => /겹쳐요/.test(i.msg)));
});

test("unreadable amount and mixed dates are reported", () => {
  const r = copy();
  r[2].vat = null;
  assert.ok(auditReceipts(r).issues.some((i) => /읽지 못했어요/.test(i.msg)));
  const mixed = copy();
  mixed.push({ ...mixed[1], page: 16, approvalNo: "47218269", date: "2025-07-03 14:38:00", orderNo: "PD2025070331630121" });
  assert.ok(auditReceipts(mixed).issues.some((i) => /결제일이 2가지/.test(i.msg)));
  assert.equal(auditReceipts([]).ok, false);
});
