// Shared-board sync (unit tested with a fake fetch in tests/sync.test.js).
//
// The screen shows `view()` = server state + this browser's pending operations.
// Operations are functions state -> state, so after a version conflict they are
// simply re-applied on top of the newer board instead of overwriting it.
import { initialState } from "./store.js";

export const POLL_MS = 10000;
const RETRY_MS = 4000;

export function createSync({ fetchImpl = (...a) => fetch(...a), key = null, onChange = () => {}, onStatus = () => {} } = {}) {
  let server = { version: 0, state: null };
  let pending = [];
  let inflight = false;
  let running = null;
  let mode = "connecting"; // connecting | shared | local | error
  let retryTimer = null;

  const url = (params = {}) => {
    const sp = new URLSearchParams();
    if (key) sp.set("key", key);
    for (const [k, v] of Object.entries(params)) sp.set(k, String(v));
    const q = sp.toString();
    return `api/board${q ? `?${q}` : ""}`;
  };

  async function call(method, params, body) {
    const res = await fetchImpl(url(params), {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json };
  }

  function setMode(next, detail = "") {
    mode = next;
    onStatus({ mode, pending: pending.length, detail });
  }

  const api = {
    get mode() { return mode; },
    get version() { return server.version; },
    get pendingCount() { return pending.length; },

    view() {
      return pending.reduce((s, op) => op(s), server.state ?? initialState());
    },

    /** Connect. Returns true when the shared board is available. */
    async start(localState) {
      let r;
      try {
        r = await call("GET");
      } catch {
        setMode("local", "offline");
        return false;
      }
      if (r.status === 503 || r.status === 404) { setMode("local", "not_configured"); return false; }
      if (r.status === 401) { setMode("error", "key"); return false; }
      if (r.status !== 200 || !r.json) { setMode("local", "error"); return false; }
      server = { version: r.json.version, state: r.json.state };
      setMode("shared");
      // First person to connect seeds the empty shared board with what they had locally.
      if (!server.state && localState && localState.tasks.length) api.commit(() => localState);
      else onChange();
      return true;
    },

    commit(op) {
      pending.push(op);
      onChange();
      api.flush();
    },

    /** Send pending operations. Calling it while a send is running returns that same run. */
    flush() {
      if (mode !== "shared") return Promise.resolve();
      if (!running) running = sendAll().finally(() => { running = null; });
      return running;
    },

    /** Pull other people's changes. Cheap when nothing changed. */
    async poll() {
      if (mode !== "shared" || inflight || pending.length) return;
      let r;
      try {
        r = await call("GET", { v: server.version });
      } catch {
        setMode("shared", "offline");
        return;
      }
      if (r.status !== 200 || !r.json || r.json.unchanged) {
        if (r.status === 200) setMode("shared");
        return;
      }
      if (inflight || pending.length) return; // a local change started meanwhile; next poll catches up
      server = { version: r.json.version, state: r.json.state };
      setMode("shared");
      onChange();
    },
  };

  async function sendAll() {
    {
      inflight = true;
      try {
        while (pending.length) {
          const base = server.state ?? initialState();
          const next = pending[0](base);
          if (next === base) { pending.shift(); continue; }
          let r;
          try {
            r = await call("PUT", {}, { baseVersion: server.version, state: next });
          } catch {
            setMode("shared", "offline");
            clearTimeout(retryTimer);
            retryTimer = setTimeout(() => api.flush(), RETRY_MS);
            retryTimer.unref?.(); // Node (tests): do not keep the process alive
            return;
          }
          if (r.status === 200) {
            server = { version: r.json.version, state: r.json.state };
            pending.shift();
          } else if (r.status === 409) {
            server = { version: r.json.version, state: r.json.state };
            onChange(); // re-apply the same op on the newer board in the next loop turn
          } else {
            // Rejected (validation / key): drop this op so the queue cannot jam forever.
            pending.shift();
            setMode("shared", r.json?.message || `저장 실패 (${r.status})`);
            onChange();
          }
        }
        setMode("shared");
      } finally {
        inflight = false;
      }
    }
  }
  return api;
}
