// Vercel function for the PDF 문서함, stored in Vercel Blob (same store as the photo album).
//   GET    ?u=<blob url>[&name=]   serve the PDF from the app's own domain (opens in the browser's viewer)
//   POST   ?name=<file name>       body = one PDF (application/octet-stream, <= 4 MB) -> { url }
//   DELETE { urls: [...] }         removes those files from Blob
// Optional BOARD_KEY as in api/board.js.
import { handleDocDelete, handleDocGet, handleDocUpload } from "../lib/doc-upload.js";

async function readBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  try {
    const key = process.env.BOARD_KEY || null;
    const query = req.query || {};
    if (req.method === "GET") {
      const out = await handleDocGet({ method: "GET", query }, { key });
      if (out.status !== 200) {
        res.setHeader("Cache-Control", "no-store");
        return res.status(out.status).json(out.json);
      }
      const name = `${String(query.name || "document").replace(/\.pdf$/i, "")}.pdf`;
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(name)}`);
      // the file name carries a random suffix, so the response can be cached for good
      res.setHeader("Cache-Control", "public, max-age=31536000, s-maxage=31536000, immutable");
      return res.status(200).send(out.body);
    }
    res.setHeader("Cache-Control", "no-store");
    const { put, del } = await import("@vercel/blob");
    const out = req.method === "DELETE"
      ? await handleDocDelete({ method: "DELETE", query, body: req.body }, { del, key })
      : await handleDocUpload({ method: req.method, query, body: req.method === "POST" ? await readBody(req) : null }, { put, key });
    return res.status(out.status).json(out.json);
  } catch (err) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(502).json({ error: "storage_error", message: String(err?.message || err) });
  }
}
