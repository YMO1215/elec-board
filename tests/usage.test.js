import assert from "node:assert/strict";
import { test } from "node:test";

import { BLOB_FREE_BYTES, handleUsage } from "../lib/usage.js";
import { formatBytes, usageSummary } from "../js/usage.js";

const fakeList = (pages) => {
  let i = 0;
  return async () => pages[i++];
};

test("handleUsage adds up every page of photos", async () => {
  const list = fakeList([
    { blobs: [{ size: 100 }, { size: 250 }], hasMore: true, cursor: "c1" },
    { blobs: [{ size: 50 }], hasMore: false },
  ]);
  const out = await handleUsage({ method: "GET" }, { list });
  assert.deepEqual(out, { status: 200, json: { used: 400, count: 3, limit: BLOB_FREE_BYTES } });
});

test("handleUsage checks method, key and configuration", async () => {
  assert.equal((await handleUsage({ method: "POST" }, { list: async () => ({}) })).status, 405);
  assert.equal((await handleUsage({ method: "GET", query: {} }, { list: async () => ({}), key: "k" })).status, 401);
  assert.equal((await handleUsage({ method: "GET", query: { key: "k" } }, { list: async () => ({ blobs: [] }), key: "k" })).status, 200);
  assert.equal((await handleUsage({ method: "GET" }, { list: null })).status, 503);
});

test("formatBytes and usageSummary", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(2048), "2 KB");
  assert.equal(formatBytes(5 * 1024 ** 2), "5.0 MB");
  assert.equal(formatBytes(1024 ** 3), "1.00 GB");
  const s = usageSummary({ used: 0.75 * 1024 ** 3 });
  assert.equal(s.tone, "mid");
  assert.equal(s.left, 0.25 * 1024 ** 3);
  assert.equal(usageSummary({ used: 2 * 1024 ** 3 }).left, 0);
  assert.equal(usageSummary({ used: 10 }).tone, "ok");
});
