// PDF 문서함 helpers: upload / open / download / delete through api/doc.
export const MAX_DOC_BYTES = 4 * 1024 * 1024; // keep in step with lib/doc-upload.js

function endpoint(params, key) {
  const sp = new URLSearchParams(params);
  if (key) sp.set("key", key);
  const q = sp.toString();
  return `api/doc${q ? `?${q}` : ""}`;
}

/** Address the browser opens a PDF from: our own domain, not the Blob host. */
export function docSrc(url, name = "", key = null) {
  return endpoint({ u: url, ...(name ? { name } : {}) }, key);
}

/** Is this file a PDF we can take? Returns an error message, or "" when it is fine. */
export function docProblem(file) {
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name ?? "");
  if (!isPdf) return "PDF 파일만 올릴 수 있어요";
  if (file.size > MAX_DOC_BYTES) return "PDF 는 4MB 까지 올릴 수 있어요";
  if (!file.size) return "빈 파일이에요";
  return "";
}

/** Upload one PDF; resolves to the public Blob URL. */
export async function uploadDoc(file, { name, key = null, fetchImpl = (...a) => fetch(...a) }) {
  const res = await fetchImpl(endpoint({ name }, key), {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: file,
    cache: "no-store",
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.url) throw new Error(json?.message || `업로드 실패 (${res.status})`);
  return json.url;
}

/** Fetch one stored PDF as a Blob (through our own domain). */
export async function fetchDoc(url, key = null) {
  const res = await fetch(docSrc(url, "", key));
  if (!res.ok) throw new Error(`문서를 가져오지 못했어요 (${res.status})`);
  return res.blob();
}

/** Delete PDF files from Blob (throws on failure so the caller keeps the record). */
export async function deleteDocFiles(urls, { key = null, fetchImpl = (...a) => fetch(...a) } = {}) {
  if (!urls.length) return;
  const res = await fetchImpl(endpoint({}, key), {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ urls }),
    cache: "no-store",
  });
  if (!res.ok) {
    const json = await res.json().catch(() => null);
    throw new Error(json?.message || `삭제 실패 (${res.status})`);
  }
}
