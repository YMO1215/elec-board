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

/** Did the plan change anything compared to the original page list? */
export function planChanged(plan, pageCount) {
  return plan.length !== pageCount || plan.some((p, i) => p.index !== i || normAngle(p.rotate || 0) !== 0);
}
