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
