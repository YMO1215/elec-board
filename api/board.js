// Vercel function: GET/PUT the shared board. Storage = Upstash Redis
// (Vercel Marketplace integration env vars). Optional BOARD_KEY protects writes and reads.
import { MAX_BODY_BYTES, handle, storageEnvNames, storeFromEnv } from "../lib/shared-board.js";

export default async function handler(req, res) {
  let body = req.body;
  if (typeof body === "string") {
    if (body.length > MAX_BODY_BYTES) return res.status(413).json({ error: "too_large" });
    try { body = JSON.parse(body); } catch { body = null; }
  } else if (body && JSON.stringify(body).length > MAX_BODY_BYTES) {
    return res.status(413).json({ error: "too_large" });
  }
  res.setHeader("Cache-Control", "no-store");
  try {
    const store = storeFromEnv(process.env);
    const out = await handle({ method: req.method, query: req.query || {}, body },
      { store, key: process.env.BOARD_KEY || null });
    if (!store) out.json.env_seen = storageEnvNames(process.env); // names only, to diagnose
    return res.status(out.status).json(out.json);
  } catch (err) {
    return res.status(502).json({ error: "storage_error", message: String(err?.message || err) });
  }
}
