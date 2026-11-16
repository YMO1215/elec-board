import assert from "node:assert/strict";
import { test } from "node:test";

import * as lib from "pdf-lib";
import { editPdf, mergePdfs, normAngle, planChanged } from "../js/pdfops.js";
import {
  MAX_DOC_FOLDERS, addDoc, addDocFolder, initialState, moveDocs, parse, removeDocFolder, removeDocs, renameDoc,
  renameDocFolder, replaceDocFile,
} from "../js/store.js";

/** A PDF whose pages have the given widths (so the order can be checked after a rebuild). */
async function makePdf(widths) {
  const doc = await lib.PDFDocument.create();
  for (const w of widths) doc.addPage([w, 800]);
  return doc.save();
}
const widthsOf = async (bytes) => (await lib.PDFDocument.load(bytes)).getPages().map((p) => p.getWidth());
const anglesOf = async (bytes) => (await lib.PDFDocument.load(bytes)).getPages().map((p) => p.getRotation().angle);

test("mergePdfs joins the files in the given order", async () => {
  const out = await mergePdfs(lib, [await makePdf([100, 200]), await makePdf([300]), await makePdf([400, 500])]);
  assert.deepEqual(await widthsOf(out), [100, 200, 300, 400, 500]);
  await assert.rejects(mergePdfs(lib, [await makePdf([100])]), /2개 이상/);
  await assert.rejects(mergePdfs(lib, [new Uint8Array([1, 2, 3]), await makePdf([100])]), /읽지 못했어요/);
});

test("editPdf reorders, deletes and rotates pages", async () => {
  const src = await makePdf([100, 200, 300]);
  const out = await editPdf(lib, src, [{ index: 2, rotate: 90 }, { index: 0, rotate: 0 }]); // page 2 (200) deleted
  assert.deepEqual(await widthsOf(out), [300, 100]);
  assert.deepEqual(await anglesOf(out), [90, 0]);
  const again = await editPdf(lib, out, [{ index: 0, rotate: 270 }, { index: 1, rotate: -90 }]); // adds to the page's own rotation
  assert.deepEqual(await anglesOf(again), [0, 270]);
  await assert.rejects(editPdf(lib, src, []), /하나는/);
  await assert.rejects(editPdf(lib, src, [{ index: 3, rotate: 0 }]), /번호/);
});

test("normAngle and planChanged", () => {
  assert.equal(normAngle(450), 90);
  assert.equal(normAngle(-90), 270);
  assert.equal(normAngle(360), 0);
  assert.equal(planChanged([{ index: 0, rotate: 0 }, { index: 1, rotate: 360 }], 2), false);
  assert.equal(planChanged([{ index: 1, rotate: 0 }, { index: 0, rotate: 0 }], 2), true);
  assert.equal(planChanged([{ index: 0, rotate: 0 }], 2), true);
  assert.equal(planChanged([{ index: 0, rotate: 90 }], 1), true);
});

const URL1 = "https://abc123.public.blob.vercel-storage.com/docs/a-xyz.pdf";
const URL2 = "https://abc123.public.blob.vercel-storage.com/docs/b-xyz.pdf";
const AT = "2026-11-16T01:00:00.000Z";
const doc = (id, extra = {}) => ({ id, url: URL1, at: AT, name: "점검표", size: 10, ...extra });

test("문서함 folders: add, rename, delete keeps the PDFs as 미분류", () => {
  let s = addDocFolder(initialState(), { id: "f1", name: "  점검표  " });
  s = addDocFolder(s, { id: "f2", name: "점검표" }); // name taken
  assert.deepEqual(s.docFolders, [{ id: "f1", name: "점검표" }]);
  s = addDoc(s, doc("d1", { folder: "f1" }));
  s = addDoc(s, doc("d2", { folder: "nope" })); // unknown folder -> 미분류
  assert.deepEqual(s.docs.map((d) => d.folder), ["f1", ""]);
  s = renameDocFolder(s, "f1", "도면");
  assert.equal(s.docFolders[0].name, "도면");
  s = removeDocFolder(s, "f1");
  assert.deepEqual(s.docFolders, []);
  assert.deepEqual(s.docs.map((d) => [d.id, d.folder]), [["d1", ""], ["d2", ""]]);
  const full = { ...initialState(), docFolders: Array.from({ length: MAX_DOC_FOLDERS }, (_, i) => ({ id: `f${i}`, name: `폴더${i}` })) };
  assert.equal(addDocFolder(full, { id: "x", name: "새" }), full);
});

test("moveDocs, removeDocs, renameDoc, replaceDocFile", () => {
  let s = addDocFolder(initialState(), { id: "f1", name: "도면" });
  s = addDoc(addDoc(s, doc("d1")), doc("d2"));
  s = moveDocs(s, ["d1", "d2"], "f1");
  assert.deepEqual(s.docs.map((d) => d.folder), ["f1", "f1"]);
  assert.equal(moveDocs(s, ["d1"], "f1"), s); // nothing to change
  assert.deepEqual(moveDocs(s, ["d1"], "gone").docs.map((d) => d.folder), ["", "f1"]); // unknown target -> 미분류
  s = renameDoc(s, "d1", "  새 이름 ");
  assert.equal(s.docs[0].name, "새 이름");
  assert.equal(renameDoc(s, "d1", "   "), s);
  s = replaceDocFile(s, "d1", { url: URL2, size: 99 });
  assert.deepEqual([s.docs[0].url, s.docs[0].size], [URL2, 99]);
  assert.equal(replaceDocFile(s, "d1", { url: "https://evil.example.com/docs/x.pdf", size: 1 }), s);
  s = removeDocs(s, ["d1", "d2"]);
  assert.deepEqual(s.docs, []);
});

test("parse keeps folders and drops links to folders that no longer exist", () => {
  const raw = {
    ...initialState(),
    docFolders: [{ id: "f1", name: "도면" }, { id: "f1", name: "중복" }, { id: "", name: "빈 id" }],
    docs: [doc("d1", { folder: "f1" }), doc("d2", { folder: "gone" })],
  };
  const s = parse(JSON.stringify(raw));
  assert.deepEqual(s.docFolders, [{ id: "f1", name: "도면" }]);
  assert.deepEqual(s.docs.map((d) => d.folder), ["f1", ""]);
  const old = JSON.stringify({ version: 1, people: initialState().people, tasks: [] });
  assert.deepEqual(parse(old).docFolders, []);
});
