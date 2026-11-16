import assert from "node:assert/strict";
import { test } from "node:test";
import zlib from "node:zlib";

import * as lib from "pdf-lib";
import { buyerSpot, buyerText, charsOf, highlightBox, receiptMarks, rowsOf, splitRow } from "../js/receipt.js";
import { markReceipt } from "../js/pdfops.js";
import { addDoc, childDocs, initialState, moveDocs, addDocFolder, parse, removeDocs } from "../js/store.js";

// every glyph 0.5em wide: easy arithmetic for partial marks
const measure = (s, fs) => s.length * fs * 0.5;
const it = (str, x, y, fs = 11.2) => ({ str, x, y, w: str.length * fs * 0.5, fs });

/** A receipt page shaped like the 네이버페이 카드 영수증 (labels at x 57.7, values right-aligned to ~538). */
function receiptItems({ longProduct = false, addressHasSeller = true, buyer = false } = {}) {
  const right = (str, y, fs) => it(str, 538.7 - str.length * (fs ?? 11.2) * 0.5, y, fs);
  const items = [
    it("카드 영수증", 262, 784, 15),
    it("카드사", 57.7, 727), it("/", 88.8, 727), it("승인번호", 91.7, 727), right("수협 / 12345678", 727),
    it("카드번호", 57.7, 704), it("(", 99.1, 704), it("유효기간", 102.7, 704), it(")", 144.1, 704), right("1234-****-****-9876(**/**)", 704),
    it("거래종류", 57.7, 681), right("신용(법인) / 일시불", 681),
    it("결제일자", 57.7, 657), right("2026-11-06 16:01:00", 657),
    it("상품명", 57.7, 634),
    ...(longProduct ? [it("아주 긴 상품 이름 첫 줄입니다 정말 길어서", 146, 634), it("둘째", 300, 634)] : [right("차단기 50A", 634)]),
    it("상품", 57.7, 611), it("주문번호", 81.3, 611), right("PD2026", 611),
    it("판매자", 57.7, 563, 13.5), it("정보", 98.1, 563, 13.5),
    it("판매자상호", 57.7, 535), it("(주)가나상사", 473.5, 535),
    it("대표자명", 57.7, 512), right("홍길동", 512),
    it("사업자등록번호", 57.7, 489), right("111-22-33333", 489),
    it("전화번호", 57.7, 465), right("010-0000-0000", 465),
    it("사업장주소", 57.7, 442), it("서울시", 214, 442), it("종로구", 260, 442), ...(addressHasSeller ? [it("(주)가나상사", 300, 442)] : []), it("(우 : 12345)", 380, 442),
    it("가맹점", 57.7, 394, 13.5), it("정보", 98.1, 394, 13.5),
    it("가맹점명", 57.7, 366), right("네이버파이낸셜 주식회사", 366),
    it("대표자명", 57.7, 343), right("박상진", 343),
    it("사업자등록번호", 57.7, 297), right("524-86-01528", 297),
    it("금액", 57.7, 225, 13.5),
    it("승인금액", 57.7, 198), right("4,000", 198),
    it("공급가액", 57.7, 174), right("3,637", 174),
    it("부가세액", 57.7, 151), right("363", 151),
    it("봉사료", 57.7, 128), right("0", 128),
    it("합계", 57.7, 96), right("4,000", 94, 15),
  ];
  if (buyer) items.push(it("구매자 : 홍길동", 40.2, 778, 20));
  return items;
}

test("rowsOf groups by baseline, splitRow takes the tight left run as the label", () => {
  const rows = rowsOf([it("b", 200, 100), it("a", 57.7, 100.6), it("top", 57.7, 700)]);
  assert.deepEqual(rows.map((r) => r.items.map((i) => i.str)), [["top"], ["a", "b"]]);
  // touching pieces (0.5em glyphs here: "카드번호" ends at 80.1, "(" at 85.7)
  const { label, value } = splitRow([it("카드번호", 57.7, 0), it("(", 80.1, 0), it("유효기간", 85.7, 0), it("x", 400, 0)]);
  assert.deepEqual(label.map((i) => i.str), ["카드번호", "(", "유효기간"]);
  assert.deepEqual(value.map((i) => i.str), ["x"]);
});

test("charsOf shares an item's width over its characters and puts a space between items", () => {
  const chars = charsOf([it("ab", 10, 0, 10), it("cd", 30, 0, 10)], measure);
  assert.equal(chars.map((c) => c.c).join(""), "ab cd");
  assert.deepEqual([chars[1].x0, chars[1].x1], [15, 20]);
});

test("receiptMarks finds the nine values the hand-marked receipt highlights", () => {
  const m = receiptMarks(receiptItems(), measure);
  assert.equal(m.found, 9);
  assert.deepEqual(m.quads.map((q) => q.key), ["card", "date", "product", "seller", "ceo", "bizno", "address", "supply", "vat"]);
  const by = Object.fromEntries(m.quads.map((q) => [q.key, q]));
  // card: only the last 4 digits ("9876" sits 15..19 in "1234-****-****-9876(**/**)")
  const cardText = "1234-****-****-9876(**/**)";
  const x0 = 538.7 - cardText.length * 5.6;
  assert.ok(Math.abs(by.card.x0 - (x0 + 15 * 5.6)) < 0.01 && Math.abs(by.card.x1 - (x0 + 19 * 5.6)) < 0.01);
  // 대표자명 / 사업자등록번호 of the SELLER (y 512 / 489), not of 가맹점 (y 343 / 297)
  assert.equal(by.ceo.y, 512);
  assert.equal(by.bizno.y, 489);
  // the address mark is only the seller name inside it
  assert.equal(by.address.x0, 300);
  assert.ok(Math.abs(by.address.x1 - (300 + "(주)가나상사".length * 5.6)) < 0.01);
  assert.equal(m.hasBuyer, false);
});

test("a long product name is marked from its first character; no seller name in the address = no address mark", () => {
  const m = receiptMarks(receiptItems({ longProduct: true, addressHasSeller: false }), measure);
  const product = m.quads.find((q) => q.key === "product");
  assert.equal(product.x0, 146);
  assert.equal(m.quads.some((q) => q.key === "address"), false);
  assert.equal(m.found, 9);
});

test("receiptMarks notices an existing 구매자 line and finds nothing on a non-receipt page", () => {
  assert.equal(receiptMarks(receiptItems({ buyer: true }), measure).hasBuyer, true);
  assert.equal(receiptMarks([it("Hello", 57.7, 700), it("world", 300, 700)], measure).found, 0);
});

test("highlightBox, buyerSpot, buyerText", () => {
  const { quad, rect } = highlightBox({ x0: 100, x1: 150, y: 500, fs: 10 });
  assert.deepEqual(quad, [100, 509.1, 150, 509.1, 100, 497.9, 150, 497.9]);
  assert.deepEqual(rect, [97, 497.09999999999997, 153, 509.90000000000003]);
  assert.deepEqual(buyerSpot(595, 842), { x: 40.2, baseline: 778, size: 20 });
  assert.equal(buyerText("  박영모 "), "구매자 : 박영모");
});

/** Smallest valid PNG (1x1 red) for embedPng. */
function tinyPng() {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.from([0, 255, 0, 0]))), chunk("IEND", Buffer.alloc(0))]));
}

const highlightsOf = (doc, page) => {
  const arr = page.node.lookup(lib.PDFName.of("Annots"));
  return arr ? arr.asArray().map((r) => doc.context.lookup(r)).filter((a) => a.get(lib.PDFName.of("Subtype")).toString() === "/Highlight") : [];
};

test("markReceipt writes Highlight annotations with an appearance, replaces old ones, and stamps the buyer on page 1", async () => {
  const src = await lib.PDFDocument.create();
  src.addPage([595, 842]);
  src.addPage([595, 842]);
  const box = highlightBox({ x0: 100, x1: 150, y: 500, fs: 10 });
  const once = await markReceipt(lib, await src.save(), [[box, box], [box]], { png: tinyPng(), x: 40, y: 774, width: 140, height: 26 });
  const twice = await markReceipt(lib, once, [[box], [box]], null); // marking again replaces, never stacks
  for (const [bytes, counts] of [[once, [2, 1]], [twice, [1, 1]]]) {
    const doc = await lib.PDFDocument.load(bytes);
    const pages = doc.getPages();
    assert.deepEqual(pages.map((p) => highlightsOf(doc, p).length), counts);
    const a = highlightsOf(doc, pages[0])[0];
    assert.deepEqual(a.get(lib.PDFName.of("C")).asArray().map((n) => n.asNumber()), [1, 1, 0]);
    assert.deepEqual(a.get(lib.PDFName.of("QuadPoints")).asArray().map((n) => n.asNumber()), box.quad);
    assert.ok(a.lookup(lib.PDFName.of("AP")).lookup(lib.PDFName.of("N")), "has a normal appearance stream");
  }
  const stamped = await lib.PDFDocument.load(once);
  const xo = stamped.getPages()[0].node.Resources().lookup(lib.PDFName.of("XObject"));
  assert.ok(xo && xo.keys().length === 1, "page 1 carries the buyer picture");
  assert.equal(stamped.getPages()[1].node.Resources().lookup(lib.PDFName.of("XObject")), undefined);
});

const URL1 = "https://abc123.public.blob.vercel-storage.com/docs/a-xyz.pdf";
const AT = "2026-11-16T01:00:00.000Z";
const doc = (id, extra = {}) => ({ id, url: URL1, at: AT, name: id, size: 1, ...extra });

test("child PDFs: listed under the parent, follow its folder, stay when the parent is deleted", () => {
  let s = addDocFolder(initialState(), { id: "f1", name: "영수증" });
  s = addDoc(s, doc("p", { folder: "f1" }));
  s = addDoc(s, doc("c", { parent: "p", folder: "" })); // a child takes its parent's folder
  assert.deepEqual(childDocs(s, "p").map((d) => [d.id, d.folder]), [["c", "f1"]]);
  s = addDoc(s, doc("gc", { parent: "c" })); // one level only: a child of a child becomes top-level
  assert.equal(s.docs.find((d) => d.id === "gc").parent, "");
  // moving the parent takes the child along
  assert.deepEqual(moveDocs(s, ["p"], "").docs.filter((d) => d.id !== "gc").map((d) => [d.id, d.folder, d.parent]), [["p", "", ""], ["c", "", "p"]]);
  // moving only the child detaches it
  assert.equal(moveDocs(s, ["c"], "").docs.find((d) => d.id === "c").parent, "");
  // deleting the parent keeps the child as a top-level PDF
  assert.deepEqual(removeDocs(s, ["p"]).docs.map((d) => [d.id, d.parent]), [["c", ""], ["gc", ""]]);
  // parse keeps the link and drops broken ones
  assert.equal(parse(JSON.stringify(s)).docs.find((d) => d.id === "c").parent, "p");
  const broken = { ...s, docs: [...s.docs, doc("orphan", { parent: "missing" })] };
  assert.equal(parse(JSON.stringify(broken)).docs.find((d) => d.id === "orphan").parent, "");
});
