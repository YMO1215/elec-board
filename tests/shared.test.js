import assert from "node:assert/strict";
import { test } from "node:test";

import { handle, memoryStore, redisConfig, redisStore, storageEnvNames } from "../lib/shared-board.js";

test("storage env detection covers the Vercel integrations", () => {
  assert.deepEqual(redisConfig({ KV_REST_API_URL: "https://a", KV_REST_API_TOKEN: "t" }), { kind: "rest", url: "https://a", token: "t" });
  assert.deepEqual(redisConfig({ UPSTASH_REDIS_REST_URL: "https://b", UPSTASH_REDIS_REST_TOKEN: "u" }), { kind: "rest", url: "https://b", token: "u" });
  assert.deepEqual(redisConfig({ BOARD_REST_API_URL: "https://c", BOARD_REST_API_TOKEN: "v" }).url, "https://c"); // custom prefix
  assert.deepEqual(redisConfig({ REDIS_URL: "redis://d:6379" }), { kind: "tcp", url: "redis://d:6379" });
  assert.deepEqual(redisConfig({ STORAGE_REDIS_URL: "rediss://e" }), { kind: "tcp", url: "rediss://e" });
  assert.equal(redisConfig({ PATH: "/bin" }), null);
  assert.deepEqual(storageEnvNames({ KV_REST_API_URL: "x", PATH: "y", REDIS_URL: "z" }), ["KV_REST_API_URL", "REDIS_URL"]);
});
import { COMMON, addTask, initialState, moveTask, tasksOf, updateTask } from "../js/store.js";
import { createSync } from "../js/sync.js";

/** fetch() that routes api/board calls to handle() with a shared store. */
function fakeFetch(store, { key = null, down = () => false } = {}) {
  return async (url, opts = {}) => {
    if (down()) throw new TypeError("Failed to fetch");
    const u = new URL(url, "http://x/");
    const out = await handle({
      method: opts.method || "GET",
      query: Object.fromEntries(u.searchParams),
      body: opts.body ? JSON.parse(opts.body) : undefined,
    }, { store, key });
    return { status: out.status, json: async () => out.json };
  };
}

test("server: not configured, CAS versions, conflicts, key", async () => {
  assert.equal((await handle({ method: "GET" }, { store: null })).status, 503);
  const store = memoryStore();
  let r = await handle({ method: "GET" }, { store });
  assert.deepEqual(r.json, { version: 0, state: null });
  const s1 = addTask(initialState(), "p1", "a", "a");
  r = await handle({ method: "PUT", body: { baseVersion: 0, state: s1 } }, { store });
  assert.equal(r.status, 200);
  assert.equal(r.json.version, 1);
  r = await handle({ method: "PUT", body: { baseVersion: 0, state: initialState() } }, { store });
  assert.equal(r.status, 409);
  assert.equal(r.json.version, 1);
  assert.equal(r.json.state.tasks[0].id, "a");
  assert.deepEqual((await handle({ method: "GET", query: { v: "1" } }, { store })).json, { unchanged: true, version: 1 });
  assert.equal((await handle({ method: "GET" }, { store, key: "secret" })).status, 401);
  assert.equal((await handle({ method: "GET", query: { key: "secret" } }, { store, key: "secret" })).status, 200);
});

test("server: stored state is sanitised", async () => {
  const store = memoryStore();
  const dirty = { ...initialState(), tasks: [{ id: "x", text: "ok", owner: "p2" }, { id: "y", text: "bad", owner: "hacker" }] };
  const r = await handle({ method: "PUT", body: { baseVersion: 0, state: dirty } }, { store });
  assert.deepEqual(r.json.state.tasks.map((t) => t.id), ["x"]);
  assert.equal((await handle({ method: "PUT", body: { state: dirty } }, { store })).status, 400);
});

test("redis store speaks the Upstash REST protocol", async () => {
  const db = new Map();
  const calls = [];
  const fetchImpl = async (_url, opts) => {
    const args = JSON.parse(opts.body);
    calls.push(args[0]);
    let result;
    if (args[0] === "GET") result = db.get(args[1]) ?? null;
    else if (args[0] === "MGET") result = args.slice(1).map((k) => db.get(k) ?? null);
    else if (args[0] === "EVAL") {
      const [, , , kv, ks, expected, next] = args;
      const v = Number(db.get(kv) ?? 0);
      if (v !== Number(expected)) result = [0, v, db.get(ks) ?? ""];
      else { db.set(ks, next); db.set(kv, String(v + 1)); result = [1, v + 1, ""]; }
    }
    return { ok: true, json: async () => ({ result }) };
  };
  const store = redisStore("https://redis.example", "tok", fetchImpl);
  const s = addTask(initialState(), "p3", "c", "c");
  assert.deepEqual(await store.cas(0, s), { ok: true, version: 1, state: s });
  const lost = await store.cas(0, initialState());
  assert.equal(lost.ok, false);
  assert.equal(lost.state.tasks[0].id, "c");
  assert.deepEqual(await store.read(), { version: 1, state: s });
  assert.equal(await store.version(), 1);
  assert.ok(calls.includes("EVAL"));
});

test("two teammates editing at once both keep their change", async () => {
  const store = memoryStore();
  const a = createSync({ fetchImpl: fakeFetch(store) });
  const b = createSync({ fetchImpl: fakeFetch(store) });
  assert.equal(await a.start(initialState()), true);
  assert.equal(await b.start(initialState()), true);
  a.commit((s) => addTask(s, "p1", "A의 일", "ta"));
  b.commit((s) => addTask(s, "p2", "B의 일", "tb")); // b still thinks version is 0
  await a.flush();
  await b.flush(); // 409 -> re-applied on top of A's board
  await a.poll();
  for (const client of [a, b]) {
    const v = client.view();
    assert.deepEqual(tasksOf(v, "p1").map((t) => t.id), ["ta"]);
    assert.deepEqual(tasksOf(v, "p2").map((t) => t.id), ["tb"]);
  }
  // B moves A's task into the common strip; A sees it after polling.
  b.commit((s) => moveTask(s, "ta", COMMON, 0));
  await b.flush();
  await a.poll();
  assert.deepEqual(tasksOf(a.view(), COMMON).map((t) => t.id), ["ta"]);
});

test("offline writes stay pending and are sent later", async () => {
  const store = memoryStore();
  let offline = false;
  const statuses = [];
  const a = createSync({ fetchImpl: fakeFetch(store, { down: () => offline }), onStatus: (s) => statuses.push(s) });
  await a.start(initialState());
  offline = true;
  a.commit((s) => addTask(s, "p4", "지하 점검", "t1"));
  await a.flush();
  assert.equal(a.pendingCount, 1);
  assert.equal(tasksOf(a.view(), "p4").length, 1); // still shown locally
  assert.equal(statuses.at(-1).detail, "offline");
  offline = false;
  await a.flush();
  assert.equal(a.pendingCount, 0);
  assert.equal((await store.read()).state.tasks[0].id, "t1");
});

test("first connection seeds an empty shared board; unconfigured falls back to local", async () => {
  const store = memoryStore();
  const mine = updateTask(addTask(initialState(), "p1", "기존 일", "old"), "old", { done: true });
  const a = createSync({ fetchImpl: fakeFetch(store) });
  await a.start(mine);
  await a.flush();
  assert.equal((await store.read()).state.tasks[0].id, "old");
  const lonely = createSync({ fetchImpl: fakeFetch(null) });
  assert.equal(await lonely.start(initialState()), false);
  assert.equal(lonely.mode, "local");
});
