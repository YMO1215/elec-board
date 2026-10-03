// Read the shooting time from a JPEG's EXIF (the canvas resize drops EXIF, so this runs on the original file).
// Returns "YYYY-MM-DD HH.MM.SS" or null. Pure — unit tested with a hand-built JPEG.
const EXIF_IFD = 0x8769;
const DATETIME_ORIGINAL = 0x9003;
const DATETIME_DIGITIZED = 0x9004;
const DATETIME = 0x0132;
const TYPE_ASCII = 2;

export function exifDateTime(buffer) {
  try {
    const v = new DataView(buffer);
    if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return null;
    let p = 2;
    while (p + 4 <= v.byteLength) {
      if (v.getUint8(p) !== 0xff) return null;
      const marker = v.getUint8(p + 1);
      if (marker === 0xda || marker === 0xd9) return null; // image data starts: no EXIF
      const len = v.getUint16(p + 2);
      if (marker === 0xe1 && v.getUint32(p + 4) === 0x45786966 && v.getUint16(p + 8) === 0) { // "Exif\0\0"
        return readTiff(v, p + 10, Math.min(p + 2 + len, v.byteLength));
      }
      p += 2 + len;
    }
  } catch { /* truncated or malformed: no date */ }
  return null;
}

function readTiff(v, base, end) {
  const le = v.getUint16(base) === 0x4949; // "II" little endian, "MM" big endian
  const u16 = (o) => v.getUint16(o, le);
  const u32 = (o) => v.getUint32(o, le);
  const ifd = (offset) => {
    const entries = new Map();
    const at = base + offset;
    const n = u16(at);
    for (let i = 0; i < n; i += 1) {
      const e = at + 2 + i * 12;
      if (e + 12 > end) break;
      entries.set(u16(e), { type: u16(e + 2), count: u32(e + 4), valueAt: e + 8 });
    }
    return entries;
  };
  const ascii = (entry) => {
    const o = entry.count > 4 ? base + u32(entry.valueAt) : entry.valueAt;
    if (o + entry.count > end) return null;
    let s = "";
    for (let i = 0; i < entry.count - 1; i += 1) s += String.fromCharCode(v.getUint8(o + i));
    return s;
  };
  const ifd0 = ifd(u32(base + 4));
  const exifPtr = ifd0.get(EXIF_IFD);
  const sub = exifPtr ? ifd(u32(exifPtr.valueAt)) : new Map();
  for (const entry of [sub.get(DATETIME_ORIGINAL), sub.get(DATETIME_DIGITIZED), ifd0.get(DATETIME)]) {
    if (!entry || entry.type !== TYPE_ASCII) continue;
    const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(ascii(entry) ?? "");
    if (m && m[1] !== "0000") return `${m[1]}-${m[2]}-${m[3]} ${m[4]}.${m[5]}.${m[6]}`;
  }
  return null;
}
