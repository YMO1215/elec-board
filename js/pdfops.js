// PDF merge / page edit. The pdf-lib module is passed in (CDN in the browser, the npm package in tests),
// so this file stays free of any loader and can be unit tested against real PDFs.

/** 0 / 90 / 180 / 270 for any multiple of 90 (negative ones too). */
export function normAngle(deg) {
  return (((Math.round(deg / 90) * 90) % 360) + 360) % 360;
}

async function open(lib, bytes) {
  try {
    return await lib.PDFDocument.load(bytes, { ignoreEncryption: true });
  } catch (err) {
    throw new Error(`PDF 를 읽지 못했어요 (${err?.message || err})`);
  }
}

/** Several PDFs -> one, in the given order. Returns Uint8Array. */
export async function mergePdfs(lib, list) {
  if (!Array.isArray(list) || list.length < 2) throw new Error("병합할 PDF 를 2개 이상 고르세요");
  const out = await lib.PDFDocument.create();
  for (const bytes of list) {
    const src = await open(lib, bytes);
    const pages = await out.copyPages(src, src.getPageIndices());
    for (const p of pages) out.addPage(p);
  }
  return out.save();
}

/**
 * Rebuild a PDF from a page plan: `plan` = [{ index, rotate }] in the new order —
 * pages left out are deleted, `rotate` (degrees) is added to the page's own rotation. Returns Uint8Array.
 */
export async function editPdf(lib, bytes, plan) {
  if (!Array.isArray(plan) || !plan.length) throw new Error("페이지가 하나는 남아 있어야 해요");
  const src = await open(lib, bytes);
  const count = src.getPageCount();
  if (plan.some((p) => !Number.isInteger(p.index) || p.index < 0 || p.index >= count)) throw new Error("페이지 번호가 올바르지 않아요");
  const out = await lib.PDFDocument.create();
  const pages = await out.copyPages(src, plan.map((p) => p.index));
  pages.forEach((page, i) => {
    page.setRotation(lib.degrees(normAngle(page.getRotation().angle + (plan[i].rotate || 0))));
    out.addPage(page);
  });
  return out.save();
}

/**
 * 카드 영수증 marking: yellow Highlight annotations (as a PDF viewer / PyMuPDF makes them: QuadPoints + a Multiply
 * appearance, so they print and show everywhere) on each page, and the "구매자 : 이름" picture on the first page.
 * `pages[i]` = [{ quad, rect }] from receipt.highlightBox; `buyer` = { png: Uint8Array, x, y, width, height } or null.
 * Earlier highlights on the page are removed first, so marking twice does not stack them. Returns Uint8Array.
 */
export async function markReceipt(lib, bytes, pages, buyer) {
  const doc = await open(lib, bytes);
  const { PDFName, PDFArray, PDFDict } = lib;
  const ctx = doc.context;
  const docPages = doc.getPages();
  docPages.forEach((page, i) => {
    const old = page.node.lookup(PDFName.of("Annots"));
    const keep = [];
    if (old instanceof PDFArray) {
      const isHighlight = (d) => d instanceof PDFDict && d.get(PDFName.of("Subtype"))?.toString() === "/Highlight";
      for (const ref of old.asArray()) {
        const a = ctx.lookup(ref);
        const st = a instanceof PDFDict ? a.get(PDFName.of("Subtype"))?.toString() : "";
        if (st === "/Highlight") continue;
        if (st === "/Popup" && isHighlight(ctx.lookup(a.get(PDFName.of("Parent"))))) continue; // a removed highlight's note
        keep.push(ref);
      }
    }
    for (const { quad, rect } of pages[i] ?? []) {
      const [x0, top, x1, , , bottom] = quad;
      const ap = ctx.stream(`/H gs ${HL_RGB} rg ${x0} ${top} m ${x1} ${top} l ${x1} ${bottom} l ${x0} ${bottom} l f`, {
        Type: "XObject", Subtype: "Form", BBox: rect, Matrix: [1, 0, 0, 1, 0, 0],
        Resources: { ExtGState: { H: { BM: "Multiply" } } },
      });
      const annot = ctx.obj({
        Type: "Annot", Subtype: "Highlight", Rect: rect, QuadPoints: quad, C: HL_COLOR, F: 4, BM: "Multiply",
        P: page.ref, AP: { N: ctx.register(ap) },
      });
      keep.push(ctx.register(annot));
    }
    if (keep.length || old) page.node.set(PDFName.of("Annots"), ctx.obj(keep));
  });
  if (buyer && docPages[0]) {
    const img = await doc.embedPng(buyer.png);
    docPages[0].drawImage(img, { x: buyer.x, y: buyer.y, width: buyer.width, height: buyer.height });
  }
  return doc.save();
}
const HL_COLOR = [1, 1, 0];
const HL_RGB = HL_COLOR.join(" ");

/** Did the plan change anything compared to the original page list? */
export function planChanged(plan, pageCount) {
  return plan.length !== pageCount || plan.some((p, i) => p.index !== i || normAngle(p.rotate || 0) !== 0);
}
