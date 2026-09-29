// Device-side inspection drafts and the upload queue.
//
// A draft is written to IndexedDB on every change. Submitting marks it
// "queued"; the queue then (1) creates the server draft, (2) uploads each
// photo / video / signature, (3) submits. Every step carries an idempotency
// key, so a retry after a dropped connection never creates duplicates. A draft
// is removed from the device only after the server confirms the submission.
import { api } from "../api.js";
import { emit, store } from "../store.js";
import { idb } from "./idb.js";

const RETRY_MS = 30000;
let running = false;
let retryTimer = null;
const state = { lastSyncAt: null, lastError: null };

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---------------------------------------------------------------- drafts

export const drafts = {
  async list() {
    const all = await idb.all("drafts");
    return all.filter((d) => !store.user || d.owner_id === store.user.id).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  },
  get: (localId) => idb.get("drafts", localId),
  async save(d) {
    d.updated_at = new Date().toISOString();
    await idb.put("drafts", d);
    emit("drafts", null);
    return d;
  },
  async remove(d) {
    for (const ev of d.evidence) if (ev.blob_key) await idb.del("blobs", ev.blob_key);
    if (d.signature?.blob_key) await idb.del("blobs", d.signature.blob_key);
    await idb.del("drafts", d.local_id);
    emit("drafts", null);
  },
  putBlob: (key, blob) => idb.put("blobs", { key, blob }),
  async getBlob(key) {
    const rec = await idb.get("blobs", key);
    return rec ? rec.blob : null;
  },

  /** New local draft from an asset + its template (works offline from the bundle). */
  async create({ asset, template, taskId = null }) {
    const id = uuid();
    const d = {
      local_id: id,
      client_id: id,
      owner_id: store.user.id,
      server_id: null,
      base_version: null,
      corrects_id: null,
      asset: pickAsset(asset),
      template: { id: template.id, name: template.name, version: template.version, is_sample: template.is_sample },
      task_id: taskId,
      items: template.items.map((it) => ({ item_key: it.key, section: it.section || "", label: it.label, result: null,
        memo: "", gps_lat: null, gps_lng: null })),
      evidence: [],
      signature: null,
      signer_name: store.user.name,
      gps: null,
      findings: {},
      summary_note: "",
      review_notes: null,
      status: "editing",
      error: null,
      conflict: null,
      force: false,
      submit_key: null,
      created_at: new Date().toISOString(),
    };
    return drafts.save(d);
  },

  /** Local copy of a server draft (another device, or a correction). */
  async fromServer(detail, extra = {}) {
    const d = {
      local_id: detail.client_id,
      client_id: detail.client_id,
      owner_id: store.user.id,
      server_id: detail.id,
      base_version: detail.draft_version,
      corrects_id: detail.corrects_id,
      asset: pickAsset({ ...detail.asset, site_name: detail.site_name }),
      template: detail.template,
      task_id: detail.task_id,
      items: detail.items.map((it) => ({ item_key: it.item_key, section: it.section, label: it.label, result: it.result,
        memo: it.memo || "", gps_lat: it.gps_lat, gps_lng: it.gps_lng })),
      evidence: detail.attachments.filter((a) => a.owner_type !== "signature").map((a) => ({
        client_id: `server-${a.id}`, item_key: a.item_key, name: a.filename, type: a.mime, size: a.size,
        blob_key: null, uploaded_id: a.id, remote_url: a.url })),
      signature: null,
      signer_name: store.user.name,
      gps: null,
      findings: {},
      summary_note: detail.summary_note || "",
      review_notes: extra.review_notes || null,
      status: "editing",
      error: null,
      conflict: null,
      force: false,
      submit_key: null,
      created_at: new Date().toISOString(),
    };
    return drafts.save(d);
  },
};

function pickAsset(a) {
  return {
    id: a.id, name: a.name, asset_type: a.asset_type, location: a.location, site_id: a.site_id,
    site_name: a.site_name, last_inspected_at: a.last_inspected_at || null, life: a.life || null,
  };
}

// ---------------------------------------------------------------- offline bundle

export async function refreshBundle() {
  const bundle = await api.get("api/offline/bundle");
  await idb.put("meta", { key: "bundle", value: bundle, fetched_at: Date.now() });
  return bundle;
}

export async function getBundle({ refresh = false } = {}) {
  if (refresh && store.online) {
    try {
      return await refreshBundle();
    } catch {
      /* fall back to the device copy below */
    }
  }
  const rec = await idb.get("meta", "bundle");
  if (rec) return rec.value;
  return store.online ? refreshBundle() : null;
}

export async function bundleAge() {
  const rec = await idb.get("meta", "bundle");
  return rec ? rec.fetched_at : null;
}

// ---------------------------------------------------------------- queue

export function syncState() {
  return { ...state, running };
}

async function ensureServerDraft(d) {
  if (d.server_id) return d;
  const res = d.corrects_id
    ? await api.post(`api/inspections/${d.corrects_id}/corrections`, { client_id: d.client_id })
    : await api.post("api/inspections/drafts", { client_id: d.client_id, asset_id: d.asset.id, task_id: d.task_id });
  d.server_id = res.id;
  d.base_version = res.draft_version;
  return drafts.save(d);
}

async function upload(d, { ownerType, itemKey, clientId, blobKey, name, type }) {
  const blob = await drafts.getBlob(blobKey);
  if (!blob) throw Object.assign(new Error("기기에 저장된 파일을 찾을 수 없습니다. 다시 첨부하세요."), { status: 400 });
  const form = new FormData();
  form.append("file", new File([blob], name, { type }));
  form.append("owner_type", ownerType);
  form.append("owner_id", String(d.server_id));
  form.append("client_id", clientId);
  if (itemKey) form.append("item_key", itemKey);
  const res = await api.upload("api/attachments", form);
  return res.id;
}

function submitBody(d) {
  return {
    submit_key: d.submit_key,
    base_version: d.base_version,
    force: d.force,
    items: d.items.map(({ item_key, result, memo, gps_lat, gps_lng }) => ({ item_key, result, memo, gps_lat, gps_lng })),
    summary_note: d.summary_note,
    gps: d.gps,
    signer_name: d.signer_name,
    signature_attachment_id: d.signature?.uploaded_id,
    findings: Object.entries(d.findings).map(([item_key, f]) => ({ item_key, assignee_id: f.assignee_id || null,
      due_date: f.due_date || null })),
  };
}

async function push(d) {
  d.status = "syncing";
  await drafts.save(d);
  await ensureServerDraft(d);
  for (const ev of d.evidence) {
    if (ev.uploaded_id) continue;
    ev.uploaded_id = await upload(d, { ownerType: ev.item_key ? "inspection_item" : "inspection", itemKey: ev.item_key,
      clientId: ev.client_id, blobKey: ev.blob_key, name: ev.name, type: ev.type });
    await drafts.save(d);
  }
  if (d.signature && !d.signature.uploaded_id) {
    d.signature.uploaded_id = await upload(d, { ownerType: "signature", clientId: d.signature.client_id,
      blobKey: d.signature.blob_key, name: "signature.png", type: "image/png" });
    await drafts.save(d);
  }
  const result = await api.post(`api/inspections/${d.server_id}/submit`, submitBody(d));
  await drafts.remove(d);
  emit("synced", { local_id: d.local_id, server_id: result.id });
}

export async function queueSubmit(d) {
  d.submit_key = d.submit_key || uuid();
  d.status = "queued";
  d.error = null;
  await drafts.save(d);
  return kick();
}

/** Process queued drafts in order. Safe to call repeatedly. */
export async function kick() {
  if (running) return;
  running = true;
  emit("sync", syncState());
  try {
    const queue = (await drafts.list()).filter((d) => d.status === "queued" || d.status === "syncing").reverse();
    for (const d of queue) {
      try {
        await push(d);
        state.lastSyncAt = Date.now();
        state.lastError = null;
      } catch (err) {
        if (err.status === 0 || err.status === 401 || err.status >= 500) {
          d.status = "queued"; // transient: keep it queued and retry later
          d.error = err.message;
          await drafts.save(d);
          state.lastError = err.message;
          scheduleRetry();
          break;
        }
        if (err.code === "draft_conflict") {
          d.status = "conflict";
          d.conflict = err.detail?.server || null;
        } else {
          d.status = "error"; // needs the inspector: fix and submit again
        }
        d.error = err.message;
        await drafts.save(d);
      }
    }
  } finally {
    running = false;
    emit("sync", syncState());
  }
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => { if (store.online) kick(); }, RETRY_MS);
}

/** Keep a server copy of an in-progress draft so it can be resumed elsewhere. */
export async function saveRemote(d) {
  if (!store.online || d.status !== "editing") return d;
  await ensureServerDraft(d);
  try {
    const res = await api.put(`api/inspections/${d.server_id}/draft`, {
      base_version: d.base_version, force: d.force, summary_note: d.summary_note,
      items: d.items.map(({ item_key, result, memo, gps_lat, gps_lng }) => ({ item_key, result, memo, gps_lat, gps_lng })),
    });
    d.base_version = res.draft_version;
    d.force = false;
  } catch (err) {
    if (err.code !== "draft_conflict") throw err;
    d.status = "conflict";
    d.conflict = err.detail?.server || null;
    d.error = err.message;
  }
  return drafts.save(d);
}

/** Conflict resolution: keep this device's answers (overwrite the server copy). */
export async function keepLocal(d) {
  d.base_version = d.conflict?.draft_version ?? d.base_version;
  d.force = true;
  d.conflict = null;
  d.status = "editing";
  d.error = null;
  return drafts.save(d);
}

/** Conflict resolution: take the server's answers. */
export async function takeServer(d) {
  const server = d.conflict;
  if (server) {
    const byKey = Object.fromEntries(server.items.map((i) => [i.item_key, i]));
    d.items = d.items.map((it) => ({ ...it, ...(byKey[it.item_key] || {}) }));
    d.summary_note = server.summary_note || "";
    d.base_version = server.draft_version;
  }
  d.conflict = null;
  d.force = false;
  d.status = "editing";
  d.error = null;
  return drafts.save(d);
}

export function watchConnectivity() {
  const update = () => {
    store.online = navigator.onLine;
    emit("online", store.online);
    if (store.online) kick();
  };
  window.addEventListener("online", update);
  window.addEventListener("offline", update);
}
