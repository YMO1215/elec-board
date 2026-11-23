import assert from "node:assert/strict";
import { test } from "node:test";
import * as lib from "pdf-lib";

import { parseDraft } from "../js/draft.js";
import { matchDraft, similarity } from "../js/draftmatch.js";
import { mergePlan } from "../js/pdfops.js";

// 기안문 구매내역 표의 줄(왼쪽→오른쪽 조각). 변경된 항목은 [기존] / [품명 … 수량 금액 변동] / [변경] 세 줄.
const TABLE = [
  ["품명", "규격", "단가", "수량", "금액", "비고"],
  ["LED", "방습등", "40W", "46,800", "27", "1,263,600"],
  ["LED", "공장등", "AC", "타입", "100W", "24,900", "30", "747,000"],
  ["LED", "공장등", "AC", "타입", "연결부속", "500", "50", "25,000"],
  ["LED", "직부등", "15W", "8,900", "10", "89,000"],
  ["LED", "직부등", "10“ 20W", "8,600", "20", "172,000"],
  ["LED", "직하 평판등", "50W", "17,500", "30", "525,000"],
  ["59,200", "1,480,000"],
  ["LED", "사각 평판조명", "50W", "25", "금액 변동"],
  ["57,200", "1,430,000"],
  ["LED", "매입 다운라이트", "6“ 15W", "3,000", "30", "90,000"],
  ["27,500", "550,000"],
  ["LED", "사각 투광등", "100W", "20", "금액 변동"],
  ["29,000", "580,000"],
  ["58,000", "58,000"],
  ["배송비", "-", "-", "금액 변동"],
  ["60,000", "60,000"],
  ["4,999,600"],
  ["합계", "금액 변동"],
  ["4,981,600"],
  ["나", ".", "구매비용", ":", "4,981,600", "원"],
];

test("parseDraft: 9 items; changed ones take the new values from the line below and the old from above", () => {
  const d = parseDraft(TABLE);
  assert.deepEqual(d.items.map((i) => i.amount), [1263600, 747000, 25000, 89000, 172000, 525000, 1430000, 90000, 580000]);
  const flat = d.items.find((i) => i.name.includes("사각 평판"));
  assert.deepEqual([flat.unit, flat.qty, flat.amount, flat.prevAmount, flat.changed], [57200, 25, 1430000, 1480000, true]);
  const lamp = d.items.find((i) => i.name.includes("투광등"));
  assert.deepEqual([lamp.amount, lamp.prevAmount], [580000, 550000]); // the pair above it is ITS old value, not the 다운라이트's
  assert.equal(d.items[0].name, "LED 방습등 40W");
  assert.deepEqual(d.shipping, { amount: 60000, prev: 58000 });
  assert.deepEqual(d.total, { amount: 4981600, prev: 4999600 });
  assert.deepEqual(d.skipped, []);
});

test("parseDraft: unchanged 합계 line, and text without a table", () => {
  const plain = [TABLE[0], TABLE[1], ["배송비", "-", "-", "3,000"], ["합계", "1,266,600"], TABLE.at(-1)];
  const d = parseDraft(plain);
  assert.equal(d.shipping.amount, 3000);
  assert.equal(d.total.amount, 1266600);
  assert.equal(parseDraft([["수신자", ":", "내부 결재"], ["카드", "영수증"]]), null);
});

// ---- matching against the 15 card-receipt pages (same real values as receiptaudit.test.js), pages in the order the shop printed them
const A = "49893088";
const rcpt = (page, product, seller, order, approved, supply, vat) => ({
  file: "카드 영수증", doc: 1, page, approvalNo: A, date: "2026-11-06 16:01:00", product, orderNo: order, shipping: /^DF/.test(order),
  seller, approved, supply, vat, total: approved,
});
const REAL = () => [
  rcpt(1, "알프스21 LED 방습 주차장등 40W 1280mm", "(주)일월전기조명", "DF1", 4000, 3637, 363),
  rcpt(2, "알프스21 LED 방습 주차장등 40W 1280mm", "(주)일월전기조명", "PD1", 1263600, 1148728, 114872),
  rcpt(3, "솔라루체 더엣지플러스 640x640 평판조명 50W", "(주)솔라루체", "DF2", 3000, 2728, 272),
  rcpt(4, "솔라루체 더엣지플러스 640x640 평판조명 50W", "(주)솔라루체", "PD2", 1430000, 1300000, 130000),
  rcpt(5, "씨티오 LED 직하 S평판 1280X320 50W", "밝은조명", "DF3", 5000, 4546, 454),
  rcpt(6, "씨티오 LED 직하 S평판 1280X320 50W", "밝은조명", "PD3", 525000, 477273, 47727),
  rcpt(7, "비츠온 LED 직부등 15W 주광색 원형", "주식회사 동방엘이디", "DF4", 9000, 8182, 818),
  rcpt(8, "비츠온 LED 직부등 15W 주광색 원형", "주식회사 동방엘이디", "PD4", 89000, 80910, 8090),
  rcpt(9, "비츠온 LED 직부등 평면형 20W 주광색 10인치", "주식회사 동방엘이디", "PD5", 172000, 156364, 15636),
  rcpt(10, "비츠온 AC타입 방수 LED 공장등 150W", "주식회사 동방엘이디", "DF6", 24000, 21819, 2181),
  rcpt(11, "비츠온 AC타입 방수 LED 공장등 150W", "주식회사 동방엘이디", "PD6", 747000, 679091, 67909),
  rcpt(12, "(2)니플", "주식회사 동방엘이디", "PD7", 25000, 22728, 2272),
  rcpt(13, "장수램프 LED 15cm(6인치) 다운라이트 15W", "월드조명 주식회사", "DF8", 15000, 13637, 1363),
  rcpt(14, "장수램프 LED 15cm(6인치) 다운라이트 15W", "월드조명 주식회사", "PD8", 90000, 81819, 8181),
  rcpt(15, "장수램프 LED 사각투광등 100W 화이트", "월드조명 주식회사", "PD9", 580000, 527273, 52727),
];
const pages = (m) => m.order.map((r) => r.page);

test("matchDraft: every item pairs by amount; pages follow the 기안문 order, 상품 before 배송비", () => {
  const m = matchDraft(parseDraft(TABLE), REAL());
  assert.equal(m.ok, true);
  assert.deepEqual(m.issues, []);
  assert.deepEqual(m.rows.map((r) => r.status), Array(9).fill("ok"));
  assert.deepEqual(pages(m), [2, 1, 11, 10, 12, 8, 7, 9, 6, 5, 4, 3, 14, 13, 15]);
  assert.equal(m.extra.length, 0);
});

test("matchDraft: the order does not depend on how the receipts were shuffled", () => {
  const shuffled = REAL().reverse();
  assert.deepEqual(pages(matchDraft(parseDraft(TABLE), shuffled)), [2, 1, 11, 10, 12, 8, 7, 9, 6, 5, 4, 3, 14, 13, 15]);
});

test("matchDraft: a wrong receipt amount is reported on both sides and the total differs", () => {
  const r = REAL();
  r[3] = { ...r[3], approved: 1429000, supply: 1299091, vat: 129909, total: 1429000 }; // 평판조명 1,430,000 -> 1,429,000
  const m = matchDraft(parseDraft(TABLE), r);
  assert.equal(m.ok, false);
  assert.ok(m.issues.some((i) => /1,430,000원 에 맞는 영수증이 없어요/.test(i.msg)));
  assert.ok(m.issues.some((i) => /1,429,000원 에 맞는 기안문 품목이 없어요/.test(i.msg)));
  assert.ok(m.issues.some((i) => i.where === "합계" && /−1,000원|-1,000원|\+1,000원|1,000원/.test(i.msg)));
  assert.equal(pages(m).at(-2), 4); // the unpaired receipt goes last
});

test("matchDraft: a receipt still at the pre-change amount is called out", () => {
  const r = REAL();
  r[3] = { ...r[3], approved: 1480000, supply: 1345455, vat: 134545, total: 1480000 };
  const m = matchDraft(parseDraft(TABLE), r);
  assert.equal(m.rows.find((x) => x.name.includes("사각 평판")).status, "old");
  assert.ok(m.issues.some((i) => /변경 전 금액 1,480,000원/.test(i.msg)));
});

test("matchDraft: equal amounts are told apart by name; wrong 단가×수량 in the draft is an error", () => {
  const draft = { items: [{ name: "LED 방습등 40W", unit: 10, qty: 10, amount: 100, prevAmount: null }, { name: "니플", unit: 10, qty: 11, amount: 100, prevAmount: null }], shipping: null, total: null, skipped: [] };
  const mk = (page, product, order) => ({ file: "f", doc: 0, page, approvalNo: "1", date: "2026-11-06", product, orderNo: order, shipping: false, seller: "s", approved: 100, supply: 91, vat: 9, total: 100 });
  const m = matchDraft(draft, [mk(1, "(2)니플", "PD1"), mk(2, "방습 주차장등 40W", "PD2")]);
  assert.deepEqual(pages(m), [2, 1]); // 방습등 first although the 니플 receipt was page 1
  assert.ok(m.issues.some((i) => /단가 10 × 수량 11 = 110원 인데 금액은 100원/.test(i.msg)));
  assert.ok(similarity("방습등 40W", "방습 주차장등 40W") > similarity("방습등 40W", "(2)니플"));
});

test("mergePlan: pages from several PDFs in the planned order", async () => {
  const make = async (widths) => {
    const d = await lib.PDFDocument.create();
    for (const w of widths) d.addPage([w, 800]);
    return d.save();
  };
  const a = await make([100, 110]);
  const b = await make([200, 210, 220]);
  const out = await mergePlan(lib, [a, b], [{ src: 0, index: 0 }, { src: 1, index: 2 }, { src: 1, index: 0 }, { src: 0, index: 1 }]);
  assert.deepEqual((await lib.PDFDocument.load(out)).getPages().map((p) => p.getWidth()), [100, 220, 200, 110]);
  await assert.rejects(() => mergePlan(lib, [a], [{ src: 0, index: 5 }]), /맞지 않아요/);
  await assert.rejects(() => mergePlan(lib, [a], []), /페이지가 없어요/);
});
