// Vercel function: free-storage meter for the photo album (GET -> { used, count, limit } in bytes).
// Optional BOARD_KEY as in api/board.js.
import { handleUsage } from "../lib/usage.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    const { list } = await import("@vercel/blob");
    const out = await handleUsage({ method: req.method, query: req.query || {} }, { list, key: process.env.BOARD_KEY || null });
    return res.status(out.status).json(out.json);
  } catch (err) {
    return res.status(502).json({ error: "storage_error", message: String(err?.message || err) });
  }
}
