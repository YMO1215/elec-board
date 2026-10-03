// Photo helpers: shrink in the browser (long side 640px, JPEG quality 0.5 ~ 30-60 KB), name by shooting time, upload / delete.
import { exifDateTime } from "./exif.js";

export const PHOTO_MAX_SIDE = 640;
export const PHOTO_QUALITY = 0.5;
const EXIF_READ_BYTES = 128 * 1024; // the EXIF block sits at the very start of the file

/** Size that fits `w`x`h` inside `max` on the long side (never enlarges). Pure — unit tested. */
export function fitSize(w, h, max = PHOTO_MAX_SIDE) {
  const scale = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

const two = (n) => String(n).padStart(2, "0");

/** "2026-10-03 14.05.32" (local time) — the same shape exifDateTime returns. */
export function formatName(d) {
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}.${two(d.getMinutes())}.${two(d.getSeconds())}`;
}

/** The photo's name = when it was taken: EXIF time, else the file's modified time, else now. */
export async function photoName(file) {
  try {
    const taken = exifDateTime(await file.slice(0, EXIF_READ_BYTES).arrayBuffer());
    if (taken) return taken;
  } catch { /* unreadable: fall through */ }
  return formatName(new Date(file.lastModified || Date.now()));
}

/** File -> JPEG Blob. Honors the EXIF rotation so phone photos are not sideways. */
export async function shrinkPhoto(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const { width, height } = fitSize(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; // JPEG has no alpha: transparent PNG areas would go black
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", PHOTO_QUALITY));
    if (!blob) throw new Error("사진을 줄이지 못했어요");
    return blob;
  } finally {
    bitmap.close?.();
  }
}

function endpoint(params, key) {
  const sp = new URLSearchParams(params);
  if (key) sp.set("key", key);
  const q = sp.toString();
  return `api/upload${q ? `?${q}` : ""}`;
}

/** Address the browser loads a photo from: our own domain, not the Blob host (which some networks block). */
export function photoSrc(url, key = null) {
  return `api/photo?u=${encodeURIComponent(url)}${key ? `&key=${encodeURIComponent(key)}` : ""}`;
}

/** A string safe to use as a downloaded file's name. */
export function fileSafe(name, fallback = "사진") {
  return String(name ?? "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim().slice(0, 60) || fallback;
}

/** Fetch one stored photo as a Blob (through our own domain). */
export async function fetchPhoto(url, key = null) {
  const res = await fetch(photoSrc(url, key));
  if (!res.ok) throw new Error(`사진을 가져오지 못했어요 (${res.status})`);
  return res.blob();
}

/** Hand a Blob to the browser as a download. */
export function saveBlob(blob, filename) {
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10000);
}

/** Upload a shrunk Blob into the task's folder; resolves to the public URL. */
export async function uploadPhoto(blob, { folder, name, key = null, fetchImpl = (...a) => fetch(...a) }) {
  const res = await fetchImpl(endpoint({ folder, name }, key), {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: blob,
    cache: "no-store",
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.url) throw new Error(json?.message || `업로드 실패 (${res.status})`);
  return json.url;
}

/** Delete photo files from Blob (throws on failure so the caller keeps the record and retries later). */
export async function deletePhotoFiles(urls, { key = null, fetchImpl = (...a) => fetch(...a) } = {}) {
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
