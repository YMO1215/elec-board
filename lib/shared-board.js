// Shared board storage: one JSON document + a version number.
// Writes are compare-and-set on the version, so two people saving at the
// same moment cannot silently overwrite each other (the loser gets 409 and
// re-applies their change on top of the latest board).
import { parse } from "../js/store.js";

export const KEY_VERSION = "board:version";
export const KEY_STATE = "board:state";
export const MAX_TASKS = 1000;
export const MAX_BODY_BYTES = 256 * 1024;

// KEYS[1]=version KEYS[2]=state ARGV[1]=expected version ARGV[2]=new state JSON
const CAS_SCRIPT = `
local v = tonumber(redis.call('GET', KEYS[1]) or '0')
if v ~= tonumber(ARGV[1]) then
  return {0, v, redis.call('GET', KEYS[2]) or ''}
end
redis.call('SET', KEYS[2], ARGV[2])
v = redis.call('INCR', KEYS[1])
return {1, v, ''}
`;

export function memoryStore() {
  let version = 0;
  let state = null;
  return {
    async version() { return version; },
    async read() { return { version, state }; },
    async cas(expected, next) {
      if (expected !== version) return { ok: false, version, state };
      version += 1;
      state = next;
      return { ok: true, version, state };
    },
  };
}

/** Upstash Redis over its REST API (what Vercel's Redis integration provides). */
export function redisStore(url, token, fetchImpl = fetch) {
  const cmd = async (args) => {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(`redis: ${data.error || res.status}`);
    return data.result;
  };
  return {
    async version() { return Number((await cmd(["GET", KEY_VERSION])) ?? 0); },
    async read() {
      const [v, s] = await cmd(["MGET", KEY_VERSION, KEY_STATE]);
      return { version: Number(v ?? 0), state: s ? JSON.parse(s) : null };
    },
    async cas(expected, next) {
      const [ok, v, current] = await cmd(["EVAL", CAS_SCRIPT, "2", KEY_VERSION, KEY_STATE, String(expected), JSON.stringify(next)]);
      return ok === 1
        ? { ok: true, version: Number(v), state: next }
        : { ok: false, version: Number(v), state: current ? JSON.parse(current) : null };
    },
  };
}

export function storeFromEnv(env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? redisStore(url, token) : null;
}

/** Framework-free request handling (unit tested). Returns { status, json }. */
export async function handle({ method, query = {}, body }, { store, key = null }) {
  if (!store) return { status: 503, json: { error: "not_configured", message: "공유 저장소가 연결되지 않았습니다." } };
  if (key && query.key !== key) return { status: 401, json: { error: "key_required", message: "보드 링크의 키가 맞지 않습니다." } };
  if (method === "GET") {
    const known = query.v === undefined ? null : Number(query.v);
    if (known !== null && Number.isFinite(known) && known === (await store.version())) {
      return { status: 200, json: { unchanged: true, version: known } };
    }
    const { version, state } = await store.read();
    return { status: 200, json: { version, state: state ? parse(JSON.stringify(state)) : null } };
  }
  if (method === "PUT") {
    if (!body || !Number.isInteger(body.baseVersion) || typeof body.state !== "object" || body.state === null) {
      return { status: 400, json: { error: "bad_request", message: "baseVersion 과 state 가 필요합니다." } };
    }
    if (!Array.isArray(body.state.tasks) || body.state.tasks.length > MAX_TASKS) {
      return { status: 413, json: { error: "too_many_tasks", message: `업무는 ${MAX_TASKS}개까지입니다.` } };
    }
    const clean = parse(JSON.stringify(body.state));
    const result = await store.cas(body.baseVersion, clean);
    return result.ok
      ? { status: 200, json: { version: result.version, state: clean } }
      : { status: 409, json: { error: "version_conflict", version: result.version, state: result.state } };
  }
  return { status: 405, json: { error: "method_not_allowed" } };
}
