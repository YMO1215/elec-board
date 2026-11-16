// Load the PDF libraries only when the 문서함 needs them (merge / edit), from the CDN, once.
const PDF_LIB_URL = "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm";
const PDFJS_URL = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs";
const PDFJS_WORKER_URL = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";

let pdfLib = null;
let pdfjs = null;

const failed = (what) => (err) => { throw new Error(`${what}를 불러오지 못했어요 — 인터넷 연결을 확인하세요 (${err?.message || err})`); };

/** pdf-lib: builds the merged / edited files. */
export function loadPdfLib() {
  pdfLib ??= import(PDF_LIB_URL).catch((err) => { pdfLib = null; return failed("PDF 편집기")(err); });
  return pdfLib;
}

/** pdf.js: draws the page thumbnails in the editor. */
export function loadPdfjs() {
  pdfjs ??= import(PDFJS_URL)
    .then((mod) => { mod.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL; return mod; })
    .catch((err) => { pdfjs = null; return failed("PDF 미리보기")(err); });
  return pdfjs;
}

/** Every page's size and text pieces (pdf.js) as { width, height, items: [{ str, x, y, w, fs }] } in PDF points. */
export async function pageTexts(bytes) {
  const lib = await loadPdfjs();
  const doc = await lib.getDocument({ data: bytes.slice() }).promise;
  try {
    const out = [];
    for (let i = 1; i <= doc.numPages; i += 1) {
      const page = await doc.getPage(i);
      const [x0, y0, x1, y1] = page.view;
      const tc = await page.getTextContent();
      out.push({
        width: x1 - x0,
        height: y1 - y0,
        items: tc.items.filter((it) => typeof it.str === "string").map((it) => ({
          str: it.str, x: it.transform[4], y: it.transform[5], w: it.width, fs: Math.hypot(it.transform[2], it.transform[3]) || it.height,
        })),
      });
      page.cleanup();
    }
    return out;
  } finally {
    doc.destroy();
  }
}

/** Relative text widths for receipt.charsOf (the receipt's Latin font is Arial-like; Hangul falls back to the system gothic). */
export function textMeasurer() {
  const ctx = document.createElement("canvas").getContext("2d");
  return (s, fs) => {
    ctx.font = `${fs}px Arial, "Malgun Gothic", "Apple SD Gothic Neo", sans-serif`;
    return ctx.measureText(s).width;
  };
}

const LABEL_SCALE = 4; // draw the 구매자 line at 4x so it stays crisp when printed

/**
 * "구매자 : 이름" as a red PNG (no Korean font has to be embedded in the PDF this way).
 * Returns { png: Uint8Array, width, height, descent } in PDF points for a `size`-point line.
 */
export async function textPicture(text, { size, color = "#ff0000" }) {
  const px = size * LABEL_SCALE;
  const font = `${px}px "Malgun Gothic", "맑은 고딕", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif`;
  const probe = document.createElement("canvas").getContext("2d");
  probe.font = font;
  const m = probe.measureText(text);
  const ascent = Math.ceil(m.actualBoundingBoxAscent || px * 0.9);
  const descent = Math.ceil(m.actualBoundingBoxDescent || px * 0.2);
  const pad = Math.ceil(px * 0.05);
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(m.width) + pad * 2;
  canvas.height = ascent + descent + pad * 2;
  const ctx = canvas.getContext("2d");
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(text, pad, pad + ascent);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("구매자 글자를 그리지 못했어요");
  return {
    png: new Uint8Array(await blob.arrayBuffer()),
    width: canvas.width / LABEL_SCALE,
    height: canvas.height / LABEL_SCALE,
    descent: (descent + pad) / LABEL_SCALE, // from the picture's bottom edge up to the text baseline
    left: pad / LABEL_SCALE,
  };
}

/**
 * Draw every page as a small image, one after another, calling `onPage(index, dataUrl)` as each is ready.
 * Returns the page count right away (before the drawing finishes) and a `cancel` for when the editor closes.
 */
export async function thumbnails(bytes, { width = 160, onPage }) {
  const lib = await loadPdfjs();
  const doc = await lib.getDocument({ data: bytes.slice() }).promise; // pdf.js takes ownership of the buffer
  let stopped = false;
  (async () => {
    for (let i = 1; i <= doc.numPages && !stopped; i += 1) {
      try {
        const page = await doc.getPage(i);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: (width * (window.devicePixelRatio || 1)) / base.width });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
        if (!stopped) onPage(i - 1, canvas.toDataURL("image/jpeg", 0.7));
        page.cleanup();
      } catch { /* a page that will not draw keeps its placeholder */ }
    }
    if (stopped) doc.destroy();
  })();
  return { count: doc.numPages, cancel: () => { stopped = true; doc.destroy(); } };
}
