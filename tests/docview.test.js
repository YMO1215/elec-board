import assert from "node:assert/strict";
import { test } from "node:test";

import { selectableIds, toggleAll, viewDocs } from "../js/docview.js";

const d = (id, name, at, extra = {}) => ({ id, name, at, size: 1000, folder: "", parent: "", ...extra });
const DOCS = [
  d("a", "방송설비 자재", "2026-11-05T01:00:00Z", { folder: "f1", size: 500 }),
  d("b", "전등 구매 카드 영수증", "2026-11-06T01:00:00Z", { folder: "f2", size: 3000 }),
  d("c", "전등 구매 카드 영수증 - 구매자 박영모", "2026-11-07T01:00:00Z", { folder: "f2", parent: "b", size: 3100 }),
  d("e", "간판 자재", "2026-11-04T01:00:00Z", { folder: "f2", size: 100 }),
  d("g", "문서출력", "2026-11-08T01:00:00Z", { size: 330 }),
];
const ids = (v) => v.map((x) => x.id);

test("default: originals newest first, each followed by its copies", () => {
  assert.deepEqual(ids(viewDocs(DOCS)), ["g", "b", "c", "a", "e"]);
});

test("folder filter: all / none / a folder (copies follow their original)", () => {
  assert.deepEqual(ids(viewDocs(DOCS, { folder: "f2" })), ["b", "c", "e"]);
  assert.deepEqual(ids(viewDocs(DOCS, { folder: "none" })), ["g"]);
  assert.deepEqual(ids(viewDocs(DOCS, { folder: "f1" })), ["a"]);
});

test("search: name substring, case/space-insensitive, combines with the folder", () => {
  assert.deepEqual(ids(viewDocs(DOCS, { query: "  자재 " })), ["a", "e"]);
  assert.deepEqual(ids(viewDocs(DOCS, { query: "자재", folder: "f2" })), ["e"]);
  assert.deepEqual(ids(viewDocs(DOCS, { query: "없는이름" })), []);
});

test("a search hit on a copy shows its original and all copies", () => {
  assert.deepEqual(ids(viewDocs(DOCS, { query: "박영모" })), ["b", "c"]);
});

test("sort by name and by size", () => {
  assert.deepEqual(ids(viewDocs(DOCS, { sort: "name", folder: "f2" })), ["e", "b", "c"]);
  assert.deepEqual(ids(viewDocs(DOCS, { sort: "size" })).filter((x) => x !== "c"), ["b", "a", "g", "e"]);
  assert.deepEqual(ids(viewDocs(DOCS, { sort: "bogus" })), ["g", "b", "c", "a", "e"]); // unknown key = newest first
});

test("전체 선택 picks the originals on screen only", () => {
  const view = viewDocs(DOCS, { folder: "f2" });
  assert.deepEqual(selectableIds(view), ["b", "e"]);
});

test("toggleAll: adds the missing ones, then clears them; other picks stay", () => {
  assert.deepEqual(toggleAll([], ["b", "e"]), ["b", "e"]);
  assert.deepEqual(toggleAll(["e", "z"], ["b", "e"]), ["e", "z", "b"]); // pick order kept, only missing appended
  assert.deepEqual(toggleAll(["b", "e", "z"], ["b", "e"]), ["z"]);
  assert.deepEqual(toggleAll(["z"], []), ["z"]); // nothing on screen: unchanged
});
