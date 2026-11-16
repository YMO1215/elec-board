// PDF 문서함 rules shared by the Vercel function and its tests (framework-free).
// Files live in Vercel Blob under docs/; the board JSON keeps only { id, url, at, name, size }.
export const MAX_DOC_BYTES = 4 * 1024 * 1024; // a Vercel function body stops at 4.5 MB
export const DOC_DIR = "docs";
export const MAX_DELETE_URLS = 50;
const BLOB_DOC_URL = /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\/docs\//;

/** Is this one of our own PDF files in Vercel Blob? (the only URLs the proxy and delete accept) */
export function isDocUrl(url) {
  return typeof url === "string" && BLOB_DOC_URL.test(url);
}

/** PDF magic bytes: "%PDF-". */
export function isPdf(buf) {
  return Boolean(buf) && buf.length > 5 && buf.subarray(0, 5).toString("latin1") === "%PDF-";
}

/** Keep a document name safe as a file name (letters, digits, Hangul, space . _ - ( )), without ".pdf". */
export function safeDocName(name) {
  const clean = String(name ?? "").replace(/\.pdf$/i, "").replace(/[^0-9A-Za-z가-힣 ._()-]/g, "_").trim().slice(0, 60);
  return clean || "document";
}

function gate({ query, key, dep }) {
  if (key && query.key !== key) return { status: 401, json: { error: "key_required", message: "보드 링크의 키가 맞지 않습니다." } };
  if (!dep) return { status: 503, json: { error: "not_configured", message: "문서 저장소가 연결되지 않았습니다." } };
  return null;
}

/** POST one PDF: docs/<name>.pdf. `put` is injected (Vercel Blob / a fake in tests). */
export async function handleDocUpload({ method, query = {}, body }, { put, key = null }) {
  if (method !== "POST") return { status: 405, json: { error: "method_not_allowed" } };
  const refused = gate({ query, key, dep: put });
  if (refused) return refused;
  if (!body || !body.length) return { status: 400, json: { error: "empty", message: "파일이 비어 있습니다." } };
  if (body.length > MAX_DOC_BYTES) return { status: 413, json: { error: "too_large", message: "PDF 는 4MB 까지 올릴 수 있습니다." } };
  if (!isPdf(body)) return { status: 415, json: { error: "not_pdf", message: "PDF 파일만 올릴 수 있습니다." } };
  const path = `${DOC_DIR}/${safeDocName(query.name)}.pdf`;
  // two files with the same name must not overwrite each other, so Blob adds its random suffix
  const blob = await put(path, body, { access: "public", contentType: "application/pdf", addRandomSuffix: true });
  return { status: 200, json: { url: blob.url } };
}

/** DELETE { urls: [...] }: remove those PDF files from Blob. Only our own document URLs are accepted. */
export async function handleDocDelete({ method, query = {}, body }, { del, key = null }) {
  if (method !== "DELETE") return { status: 405, json: { error: "method_not_allowed" } };
  const refused = gate({ query, key, dep: del });
  if (refused) return refused;
  const urls = body?.urls;
  if (!Array.isArray(urls) || !urls.length || urls.length > MAX_DELETE_URLS || !urls.every(isDocUrl)) {
    return { status: 400, json: { error: "bad_urls", message: "지울 문서 주소가 올바르지 않습니다." } };
  }
  await del(urls);
  return { status: 200, json: { deleted: urls.length } };
}

/**
 * GET ?u=<blob url>: fetch the PDF and hand it back from our own domain
 * (some office networks block *.public.blob.vercel-storage.com). Returns { status, body?, json? }.
 */
export async function handleDocGet({ method, query = {} }, { key = null, fetchImpl = fetch }) {
  if (method !== "GET") return { status: 405, json: { error: "method_not_allowed" } };
  if (key && query.key !== key) return { status: 401, json: { error: "key_required" } };
  if (!isDocUrl(query.u)) return { status: 400, json: { error: "bad_url" } };
  const res = await fetchImpl(query.u);
  if (!res.ok) return { status: res.status === 404 ? 404 : 502, json: { error: "upstream", message: `문서를 가져오지 못했습니다 (${res.status})` } };
  return { status: 200, body: Buffer.from(await res.arrayBuffer()) };
}
