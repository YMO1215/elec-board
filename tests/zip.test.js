import assert from "node:assert/strict";
import { crc32 as nodeCrc32 } from "node:zlib";
import { test } from "node:test";

import { crc32, makeZip, uniqueNames } from "../js/zip.js";

/** Read a stored zip back: [{ name, data }] using the central directory. */
function readZip(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  assert.equal(v.getUint32(end, true), 0x06054b50);
  const count = v.getUint16(end + 10, true);
  let p = v.getUint32(end + 16, true);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    assert.equal(v.getUint32(p, true), 0x02014b50);
    const crc = v.getUint32(p + 16, true);
    const size = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const localAt = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    assert.equal(v.getUint32(localAt, true), 0x04034b50);
    const dataAt = localAt + 30 + v.getUint16(localAt + 26, true);
    const data = bytes.subarray(dataAt, dataAt + size);
    assert.equal(nodeCrc32(Buffer.from(data)), crc);
    out.push({ name, data });
    p += 46 + nameLen;
  }
  return out;
}

test("crc32 matches zlib", () => {
  for (const s of ["", "a", "hello world", "사진첩"]) assert.equal(crc32(Buffer.from(s)), nodeCrc32(Buffer.from(s)));
});

test("makeZip stores files with Hangul names and reads back identically", () => {
  const a = Uint8Array.from([0xff, 0xd8, 0xff, 1, 2, 3]);
  const b = new Uint8Array(1000).map((_, i) => i % 251);
  const files = readZip(makeZip([{ name: "2026-10-02 14.28.02.jpg", data: a }, { name: "사진 2.jpg", data: b }]));
  assert.deepEqual(files.map((f) => f.name), ["2026-10-02 14.28.02.jpg", "사진 2.jpg"]);
  assert.deepEqual([...files[0].data], [...a]);
  assert.deepEqual([...files[1].data], [...b]);
});

test("an empty archive is still a valid zip", () => {
  assert.deepEqual(readZip(makeZip([])), []);
});

test("duplicate names get (2), (3) before the extension", () => {
  assert.deepEqual(uniqueNames(["a.jpg", "a.jpg", "b.jpg", "a.jpg"]), ["a.jpg", "a (2).jpg", "b.jpg", "a (3).jpg"]);
});
