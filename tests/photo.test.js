import assert from "node:assert/strict";
import { test } from "node:test";

import { exifDateTime } from "../js/exif.js";
import { MAX_PHOTO_BYTES, handleDelete, handlePhoto, handleUpload, safeName } from "../lib/photo-upload.js";
import { fitSize, formatName } from "../js/photo.js";
import {
  MAX_PHOTOS, addPhoto, addTask, doneFolderCutoff, doneFolderDaysLeft, dropPhotos, expiredPhotos, initialState,
  parse, photoCutoff, photoUrlsOf, removePhoto, updateTask,
} from "../js/store.js";

const URL1 = "https://abc123.public.blob.vercel-storage.com/photos/t1/2026-10-03 14.05.32-xyz.jpg";
const AT = "2026-10-03T04:00:00.000Z";
const NAME = "2026-10-03 14.05.32";
const jpeg = (n = 100) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n)]);
const photo = (id, extra = {}) => ({ id, url: URL1, at: AT, name: NAME, ...extra });

/** A minimal JPEG whose EXIF holds DateTimeOriginal (little or big endian). */
function jpegWithExif(text, le = true) {
  const w16 = (n) => { const b = Buffer.alloc(2); le ? b.writeUInt16LE(n) : b.writeUInt16BE(n); return b; };
  const w32 = (n) => { const b = Buffer.alloc(4); le ? b.writeUInt32LE(n) : b.writeUInt32BE(n); return b; };
  const entry = (tag, type, count, value) => Buffer.concat([w16(tag), w16(type), w32(count), value]);
  const str = Buffer.from(`${text}\0`, "latin1");
  // TIFF: header (8) | IFD0: 1 entry -> ExifIFD @ 26 | ExifIFD: 1 entry -> string @ 44
  const ifd0 = Buffer.concat([w16(1), entry(0x8769, 4, 1, w32(26)), w32(0)]);
  const exif = Buffer.concat([w16(1), entry(0x9003, 2, str.length, w32(44)), w32(0)]);
  const tiff = Buffer.concat([Buffer.from(le ? "II" : "MM"), w16(42), w32(8), ifd0, exif, str]);
  const app1 = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(app1.length + 2);
  const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), len, app1, Buffer.from([0xff, 0xd9])]);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
}

test("EXIF shooting time is read from the original JPEG (both byte orders)", () => {
  assert.equal(exifDateTime(jpegWithExif("2026:10:03 14:05:32", true)), "2026-10-03 14.05.32");
  assert.equal(exifDateTime(jpegWithExif("2025:01:09 07:08:09", false)), "2025-01-09 07.08.09");
});

test("no EXIF / garbage / zero date -> null (caller falls back to the file time)", () => {
  assert.equal(exifDateTime(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer), null);
  assert.equal(exifDateTime(new Uint8Array([1, 2, 3, 4, 5]).buffer), null);
  assert.equal(exifDateTime(jpegWithExif("0000:00:00 00:00:00")), null);
  assert.equal(exifDateTime(jpegWithExif("not a date at all!!")), null);
});

test("formatName gives YYYY-MM-DD HH.MM.SS in local time", () => {
  assert.equal(formatName(new Date(2026, 9, 3, 14, 5, 32)), "2026-10-03 14.05.32");
  assert.equal(formatName(new Date(2026, 0, 9, 7, 8, 9)), "2026-01-09 07.08.09");
});

test("fitSize shrinks the long side to 640 and never enlarges", () => {
  assert.deepEqual(fitSize(4000, 3000), { width: 640, height: 480 });
  assert.deepEqual(fitSize(3000, 4000), { width: 480, height: 640 });
  assert.deepEqual(fitSize(300, 200), { width: 300, height: 200 });
  assert.deepEqual(fitSize(10000, 1), { width: 640, height: 1 });
});

test("upload goes into the card's folder and is named by the taken date", async () => {
  const seen = [];
  const put = async (path, body, opts) => { seen.push({ path, opts }); return { url: `https://s.public.blob.vercel-storage.com/${path}` }; };
  const out = await handleUpload({ method: "POST", query: { folder: "tabc12", name: NAME }, body: jpeg() }, { put });
  assert.equal(out.status, 200);
  assert.equal(seen[0].path, `photos/tabc12/${NAME}.jpg`);
  assert.equal(seen[0].opts.addRandomSuffix, true);
});

test("upload rejects non-POST, bad key, bad folder, empty, oversize, non-JPEG, no storage", async () => {
  const put = async (p) => ({ url: p });
  const q = { folder: "t1", name: NAME };
  assert.equal((await handleUpload({ method: "GET", query: q }, { put })).status, 405);
  assert.equal((await handleUpload({ method: "POST", query: q, body: jpeg() }, { put, key: "k" })).status, 401);
  assert.equal((await handleUpload({ method: "POST", query: { ...q, key: "k" }, body: jpeg() }, { put, key: "k" })).status, 200);
  assert.equal((await handleUpload({ method: "POST", query: { name: NAME }, body: jpeg() }, { put })).status, 400);
  assert.equal((await handleUpload({ method: "POST", query: { folder: "../x", name: NAME }, body: jpeg() }, { put })).status, 400);
  assert.equal((await handleUpload({ method: "POST", query: q, body: Buffer.alloc(0) }, { put })).status, 400);
  assert.equal((await handleUpload({ method: "POST", query: q, body: jpeg(MAX_PHOTO_BYTES) }, { put })).status, 413);
  assert.equal((await handleUpload({ method: "POST", query: q, body: Buffer.from("<html>") }, { put })).status, 415);
  assert.equal((await handleUpload({ method: "POST", query: q, body: jpeg() }, { put: null })).status, 503);
});

test("safeName strips path tricks but keeps Hangul and the date shape", () => {
  assert.equal(safeName(NAME), NAME);
  assert.equal(safeName("../../etc/passwd"), ".._.._etc_passwd");
  assert.equal(safeName("점검 사진"), "점검 사진");
  assert.equal(safeName(""), "photo");
});

test("delete removes only our own photo urls from Blob", async () => {
  const gone = [];
  const del = async (urls) => { gone.push(...urls); };
  assert.equal((await handleDelete({ method: "DELETE", body: { urls: [URL1] } }, { del })).status, 200);
  assert.deepEqual(gone, [URL1]);
  assert.equal((await handleDelete({ method: "DELETE", body: { urls: ["https://evil.example/photos/x.jpg"] } }, { del })).status, 400);
  assert.equal((await handleDelete({ method: "DELETE", body: { urls: ["https://abc.public.blob.vercel-storage.com/other/x.jpg"] } }, { del })).status, 400);
  assert.equal((await handleDelete({ method: "DELETE", body: { urls: [] } }, { del })).status, 400);
  assert.equal((await handleDelete({ method: "DELETE", body: { urls: [URL1] } }, { del, key: "k" })).status, 401);
  assert.equal((await handleDelete({ method: "POST", body: { urls: [URL1] } }, { del })).status, 405);
  assert.equal(gone.length, 1);
});

test("photo proxy serves only our own photo urls, honours the key, and reports upstream failures", async () => {
  const bytes = jpeg(10);
  const ok = async () => ({ ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) });
  const out = await handlePhoto({ method: "GET", query: { u: URL1 } }, { fetchImpl: ok });
  assert.equal(out.status, 200);
  assert.deepEqual([...out.body], [...bytes]);
  let called = false;
  const spy = async () => { called = true; return ok(); };
  assert.equal((await handlePhoto({ method: "GET", query: { u: "https://evil.example/photos/x.jpg" } }, { fetchImpl: spy })).status, 400);
  assert.equal((await handlePhoto({ method: "GET", query: { u: "http://abc.public.blob.vercel-storage.com/photos/x.jpg" } }, { fetchImpl: spy })).status, 400);
  assert.equal((await handlePhoto({ method: "GET", query: { u: URL1 } }, { fetchImpl: spy, key: "k" })).status, 401);
  assert.equal((await handlePhoto({ method: "POST", query: { u: URL1 } }, { fetchImpl: spy })).status, 405);
  assert.equal(called, false); // nothing outside our photos is ever fetched
  assert.equal((await handlePhoto({ method: "GET", query: { u: URL1 } }, { fetchImpl: async () => ({ ok: false, status: 404 }) })).status, 404);
  assert.equal((await handlePhoto({ method: "GET", query: { u: URL1 } }, { fetchImpl: async () => ({ ok: false, status: 500 }) })).status, 502);
});

test("addPhoto / removePhoto are idempotent and only take blob urls", () => {
  let s = addTask(initialState(), "p1", "점검", "t1");
  s = addPhoto(s, "t1", photo("f1"));
  assert.deepEqual(s.tasks[0].photos, [photo("f1")]);
  assert.equal(addPhoto(s, "t1", photo("f1")), s); // retried op
  assert.equal(addPhoto(s, "t1", photo("f2", { url: "https://evil.example/x.jpg" })), s);
  assert.equal(addPhoto(s, "nope", photo("f3")), s);
  assert.deepEqual(removePhoto(s, "t1", "f1").tasks[0].photos, []);
  assert.equal(removePhoto(s, "t1", "zzz"), s);
});

test("a task has no photo limit (MAX_PHOTOS is Infinity)", () => {
  assert.equal(MAX_PHOTOS, Infinity);
  let s = addTask(initialState(), "p1", "점검", "t1");
  for (let i = 0; i < 25; i += 1) s = addPhoto(s, "t1", photo(`f${i}`));
  assert.equal(s.tasks[0].photos.length, 25);
  assert.equal(parse(JSON.stringify(s)).tasks[0].photos.length, 25);
});

test("parse keeps valid photos and drops malformed ones; old boards get an empty list", () => {
  const raw = JSON.stringify({
    version: 1,
    people: [1, 2, 3, 4].map((n) => ({ id: `p${n}`, name: `담당자 ${n}` })),
    tasks: [
      { id: "a", text: "x", owner: "p1", photos: [photo("f1"), photo("f2", { url: "http://x/y.jpg" }), { id: 3 }] },
      { id: "b", text: "y", owner: "p1" },
    ],
  });
  const s = parse(raw);
  assert.deepEqual(s.tasks[0].photos, [photo("f1")]);
  assert.deepEqual(s.tasks[1].photos, []);
});

test("photos expire 6 months after upload", () => {
  const now = Date.parse("2026-10-03T12:00:00.000Z");
  const cutoff = photoCutoff(now);
  assert.equal(cutoff.slice(0, 10), "2026-04-03");
  let s = addTask(initialState(), "p1", "점검", "t1");
  s = addPhoto(s, "t1", photo("old", { at: "2026-04-02T23:00:00.000Z" }));
  s = addPhoto(s, "t1", photo("new", { at: "2026-04-04T00:00:00.000Z" }));
  assert.deepEqual(expiredPhotos(s, cutoff, doneFolderCutoff(now)).map((p) => p.id), ["old"]);
});

test("a completed task's folder is removed 30 days after completion, whatever the photo age", () => {
  const now = new Date(2026, 9, 3, 12).getTime(); // 2026-10-03 local
  assert.equal(doneFolderCutoff(now), "2026-09-03");
  let s = addTask(initialState(), "p1", "끝난 일", "t1");
  s = addTask(s, "p1", "방금 끝낸 일", "t2");
  s = addTask(s, "p1", "진행 중", "t3");
  for (const id of ["t1", "t2", "t3"]) s = addPhoto(s, id, photo(`f-${id}`, { at: "2026-10-01T00:00:00.000Z" }));
  s = updateTask(s, "t1", { done: true, doneAt: "2026-09-03" }); // exactly 30 days ago
  s = updateTask(s, "t2", { done: true, doneAt: "2026-09-04" }); // 29 days ago
  assert.deepEqual(expiredPhotos(s, photoCutoff(now), doneFolderCutoff(now)).map((p) => p.id), ["f-t1"]);
  assert.equal(doneFolderDaysLeft("2026-09-04", now), 1);
  assert.equal(doneFolderDaysLeft("2026-08-01", now), 0);
});

test("dropPhotos removes only the named photos; photoUrlsOf lists a task's files", () => {
  let s = addTask(initialState(), "p1", "점검", "t1");
  s = addPhoto(s, "t1", photo("f1"));
  s = addPhoto(s, "t1", photo("f2"));
  assert.deepEqual(dropPhotos(s, ["f1"]).tasks[0].photos.map((p) => p.id), ["f2"]);
  assert.equal(dropPhotos(s, ["zzz"]), s);
  assert.deepEqual(photoUrlsOf(s.tasks), [URL1, URL1]);
});
