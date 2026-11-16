import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_DOC_BYTES, handleDocDelete, handleDocGet, handleDocUpload, isDocUrl, safeDocName } from "../lib/doc-upload.js";
import { docProblem, docSrc } from "../js/doc.js";
import { MAX_DOCS, addDoc, initialState, parse, removeDoc } from "../js/store.js";

const URL1 = "https://abc123.public.blob.vercel-storage.com/docs/점검표-xyz.pdf";
const AT = "2026-11-16T01:00:00.000Z";
const pdf = (n = 100) => Buffer.concat([Buffer.from("%PDF-1.7\n", "latin1"), Buffer.alloc(n)]);
const doc = (id, extra = {}) => ({ id, url: URL1, at: AT, name: "점검표", size: 1234, folder: "", parent: "", ...extra });

test("handleDocUpload stores a PDF under docs/ with a random suffix", async () => {
  const calls = [];
  const put = async (path, body, opts) => { calls.push({ path, opts }); return { url: URL1 }; };
  const out = await handleDocUpload({ method: "POST", query: { name: "점검표.pdf" }, body: pdf() }, { put });
  assert.deepEqual(out, { status: 200, json: { url: URL1 } });
  assert.equal(calls[0].path, "docs/점검표.pdf");
  assert.equal(calls[0].opts.contentType, "application/pdf");
  assert.equal(calls[0].opts.addRandomSuffix, true);
});

test("handleDocUpload refuses wrong method, key, empty, too large and non-PDF", async () => {
  const put = async () => ({ url: URL1 });
  assert.equal((await handleDocUpload({ method: "GET" }, { put })).status, 405);
  assert.equal((await handleDocUpload({ method: "POST", query: {}, body: pdf() }, { put, key: "k" })).status, 401);
  assert.equal((await handleDocUpload({ method: "POST", body: pdf() }, { put: null })).status, 503);
  assert.equal((await handleDocUpload({ method: "POST", body: Buffer.alloc(0) }, { put })).status, 400);
  assert.equal((await handleDocUpload({ method: "POST", body: pdf(MAX_DOC_BYTES) }, { put })).status, 413);
  assert.equal((await handleDocUpload({ method: "POST", body: Buffer.from("hello world") }, { put })).status, 415);
});

test("handleDocDelete only accepts our own docs/ URLs", async () => {
  let deleted = null;
  const del = async (urls) => { deleted = urls; };
  assert.equal((await handleDocDelete({ method: "DELETE", body: { urls: [URL1] } }, { del })).status, 200);
  assert.deepEqual(deleted, [URL1]);
  const photo = "https://abc123.public.blob.vercel-storage.com/photos/t1/a.jpg";
  assert.equal((await handleDocDelete({ method: "DELETE", body: { urls: [photo] } }, { del })).status, 400);
  assert.equal((await handleDocDelete({ method: "DELETE", body: { urls: [] } }, { del })).status, 400);
  assert.equal(isDocUrl("https://evil.example.com/docs/a.pdf"), false);
});

test("handleDocGet proxies only our own PDFs", async () => {
  const fetchImpl = async () => ({ ok: true, arrayBuffer: async () => pdf(3).buffer });
  const out = await handleDocGet({ method: "GET", query: { u: URL1 } }, { fetchImpl });
  assert.equal(out.status, 200);
  assert.equal((await handleDocGet({ method: "GET", query: { u: "https://x.com/a.pdf" } }, { fetchImpl })).status, 400);
  assert.equal((await handleDocGet({ method: "GET", query: { u: URL1 } }, { fetchImpl: async () => ({ ok: false, status: 404 }) })).status, 404);
});

test("safeDocName drops .pdf and unsafe characters", () => {
  assert.equal(safeDocName("점검표 (11월).pdf"), "점검표 (11월)");
  assert.equal(safeDocName("a/b\\c?.PDF"), "a_b_c_");
  assert.equal(safeDocName(""), "document");
});

test("docProblem and docSrc", () => {
  assert.equal(docProblem({ name: "a.pdf", type: "application/pdf", size: 10 }), "");
  assert.match(docProblem({ name: "a.jpg", type: "image/jpeg", size: 10 }), /PDF/);
  assert.match(docProblem({ name: "a.pdf", type: "", size: MAX_DOC_BYTES + 1 }), /4MB/);
  assert.equal(docSrc(URL1, "점검표", "k"), `api/doc?u=${encodeURIComponent(URL1)}&name=${encodeURIComponent("점검표")}&key=k`);
});

test("addDoc / removeDoc keep a board-wide list and survive parse", () => {
  assert.deepEqual(initialState().docs, []);
  let s = addDoc(initialState(), doc("d1"));
  s = addDoc(s, doc("d1")); // same id twice: ignored (a retried op)
  s = addDoc(s, doc("d2", { url: "https://evil.example.com/docs/a.pdf" })); // not our Blob: ignored
  assert.equal(s.docs.length, 1);
  assert.deepEqual(parse(JSON.stringify(s)).docs, [doc("d1")]);
  assert.deepEqual(removeDoc(s, "d1").docs, []);
  assert.equal(removeDoc(s, "nope"), s);
  const old = JSON.stringify({ version: 1, people: initialState().people, tasks: [] });
  assert.deepEqual(parse(old).docs, []); // boards saved before the 문서함 existed
  const full = { ...initialState(), docs: Array.from({ length: MAX_DOCS }, (_, i) => doc(`d${i}`)) };
  assert.equal(addDoc(full, doc("extra")), full);
});
