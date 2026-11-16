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
 * Draw "구매자 : 이름" the way the stamp prints, in PDF coordinates of the page (any rotation):
 * `stamp` = { text, rect: [x0, y0, x1, y1] } from pdfops.splitBuyerStamp.
 */
export function drawStampPreview(ctx, viewport, stamp) {
  const [x0, y0, , y1] = stamp.rect;
  const h = y1 - y0;
  const size = h / 1.2; // the picture is the text's ascent + descent + a little padding
  ctx.save();
  ctx.transform(...viewport.transform); // PDF space (y up) -> canvas
  ctx.translate(x0 + h * 0.04, y0 + h * 0.2);
  ctx.scale(1, -1); // text must not come out mirrored
  ctx.font = `${size}px "Malgun Gothic", "맑은 고딕", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif`;
  ctx.fillStyle = "#ff0000";
  ctx.fillText(stamp.text, 0, 0);
  ctx.restore();
}

/**
 * One open PDF for the page editor: small thumbnails for the list, a big render for the viewer.
 *   count                         number of pages
 *   size(i)                       { width, height } of page i at scale 1 (its own rotation applied), in CSS px
 *   thumbs(width, onPage)         draws every page one after another, onPage(i, dataUrl)
 *   render(canvas, i, { scale, rotate })  draws page i (extra rotation in degrees); a newer call cancels the older one
 *   destroy()
 */
export async function pdfViewer(bytes) {
  const lib = await loadPdfjs();
  const doc = await lib.getDocument({ data: bytes.slice() }).promise; // pdf.js takes ownership of the buffer
  const pages = [];
  for (let i = 1; i <= doc.numPages; i += 1) pages.push(await doc.getPage(i));
  let stopped = false;
  let task = null;
  const dpr = () => window.devicePixelRatio || 1;
  return {
    count: pages.length,
    size(i) {
      const v = pages[i].getViewport({ scale: 1 });
      return { width: v.width, height: v.height };
    },
    async thumbs(width, onPage) {
      for (let i = 0; i < pages.length && !stopped; i += 1) {
        try {
          const page = pages[i];
          const viewport = page.getViewport({ scale: (width * dpr()) / page.getViewport({ scale: 1 }).width });
          const canvas = document.createElement("canvas");
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
          if (!stopped) onPage(i, canvas.toDataURL("image/jpeg", 0.75));
        } catch { /* a page that will not draw keeps its placeholder */ }
      }
    },
    /** `overlay(ctx, viewport)` draws on top after the page (e.g. the 구매자 line), in canvas pixels. */
    async render(canvas, i, { scale, rotate = 0, overlay = null }) {
      task?.cancel();
      const page = pages[i];
      const viewport = page.getViewport({ scale: scale * dpr(), rotation: (page.rotate + rotate) % 360 });
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      canvas.style.width = `${Math.ceil(viewport.width / dpr())}px`;
      canvas.style.height = `${Math.ceil(viewport.height / dpr())}px`;
      task = page.render({ canvasContext: canvas.getContext("2d"), viewport });
      const mine = task;
      try {
        await mine.promise;
      } catch (err) {
        if (err?.name === "RenderingCancelledException") return;
        throw err;
      }
      if (overlay && task === mine) overlay(canvas.getContext("2d"), viewport);
    },
    destroy() {
      stopped = true;
      task?.cancel();
      doc.destroy();
    },
  };
}
