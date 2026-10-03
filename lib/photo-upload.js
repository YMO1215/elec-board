// Photo upload / delete rules shared by the Vercel function and its tests (framework-free).
export const MAX_PHOTO_BYTES = 400 * 1024; // a 640px / q0.5 JPEG is ~30-60 KB; this is a generous ceiling
export const PHOTO_DIR = "photos";
export const MAX_DELETE_URLS = 50;
const BLOB_PHOTO_URL = /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\/photos\//;
const FOLDER_OK = /^[A-Za-z0-9]{1,40}$/; // a task id

/** JPEG magic bytes: FF D8 FF. */
export function isJpeg(buf) {
  return Boolean(buf) && buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

/** Keep a photo name safe as a file name (letters, digits, Hangul, space . _ -). */
export function safeName(name) {
  const clean = String(name ?? "").replace(/[^0-9A-Za-z가-힣 ._-]/g, "_").trim().slice(0, 40);
  return clean || "photo";
}

function gate({ query, key, dep, depName }) {
  if (key && query.key !== key) return { status: 401, json: { error: "key_required", message: "보드 링크의 키가 맞지 않습니다." } };
  if (!dep) return { status: 503, json: { error: "not_configured", message: `${depName} 저장소가 연결되지 않았습니다.` } };
  return null;
}

/** POST one JPEG into the card's folder: photos/<taskId>/<taken date>.jpg. `put` is injected (Vercel Blob / a fake in tests). */
export async function handleUpload({ method, query = {}, body }, { put, key = null }) {
  if (method !== "POST") return { status: 405, json: { error: "method_not_allowed" } };
  const refused = gate({ query, key, dep: put, depName: "사진" });
  if (refused) return refused;
  if (!FOLDER_OK.test(query.folder ?? "")) return { status: 400, json: { error: "bad_folder", message: "업무 폴더가 필요합니다." } };
  if (!body || !body.length) return { status: 400, json: { error: "empty", message: "사진이 비어 있습니다." } };
  if (body.length > MAX_PHOTO_BYTES) return { status: 413, json: { error: "too_large", message: "사진이 너무 큽니다." } };
  if (!isJpeg(body)) return { status: 415, json: { error: "not_jpeg", message: "JPEG 사진만 올릴 수 있습니다." } };
  const path = `${PHOTO_DIR}/${query.folder}/${safeName(query.name)}.jpg`;
  // same-second photos must not overwrite each other, so Blob adds its random suffix
  const blob = await put(path, body, { access: "public", contentType: "image/jpeg", addRandomSuffix: true });
  return { status: 200, json: { url: blob.url } };
}

/** DELETE { urls: [...] }: remove those photo files from Blob. Only our own photo URLs are accepted. */
export async function handleDelete({ method, query = {}, body }, { del, key = null }) {
  if (method !== "DELETE") return { status: 405, json: { error: "method_not_allowed" } };
  const refused = gate({ query, key, dep: del, depName: "사진" });
  if (refused) return refused;
  const urls = body?.urls;
  if (!Array.isArray(urls) || !urls.length || urls.length > MAX_DELETE_URLS || !urls.every((u) => typeof u === "string" && BLOB_PHOTO_URL.test(u))) {
    return { status: 400, json: { error: "bad_urls", message: "지울 사진 주소가 올바르지 않습니다." } };
  }
  await del(urls);
  return { status: 200, json: { deleted: urls.length } };
}
