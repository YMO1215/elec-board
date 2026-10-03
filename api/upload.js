// Vercel function for the photo album, stored in Vercel Blob (store connected to the project).
//   POST   ?folder=<taskId>&name=<taken date>  body = one already-shrunk JPEG (application/octet-stream) -> { url }
//   DELETE { urls: [...] }                      removes those files from Blob
// Optional BOARD_KEY as in api/board.js.
import { handleDelete, handleUpload } from "../lib/photo-upload.js";

async function readBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    const { put, del } = await import("@vercel/blob");
    const key = process.env.BOARD_KEY || null;
    const query = req.query || {};
    const out = req.method === "DELETE"
      ? await handleDelete({ method: "DELETE", query, body: req.body }, { del, key })
      : await handleUpload({ method: req.method, query, body: req.method === "POST" ? await readBody(req) : null }, { put, key });
    return res.status(out.status).json(out.json);
  } catch (err) {
    return res.status(502).json({ error: "storage_error", message: String(err?.message || err) });
  }
}
