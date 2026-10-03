// Vercel function: serve a stored photo from the app's own domain (GET ?u=<blob url>[&key=...]).
// The file name carries a random suffix, so the response can be cached for good by the browser and the CDN.
import { handlePhoto } from "../lib/photo-upload.js";

export default async function handler(req, res) {
  try {
    const out = await handlePhoto({ method: req.method, query: req.query || {} }, { key: process.env.BOARD_KEY || null });
    if (out.status !== 200) {
      res.setHeader("Cache-Control", "no-store");
      return res.status(out.status).json(out.json);
    }
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=31536000, s-maxage=31536000, immutable");
    return res.status(200).send(out.body);
  } catch (err) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(502).json({ error: "storage_error", message: String(err?.message || err) });
  }
}
