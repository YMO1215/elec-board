// Free-storage meter (Vercel Blob = the photo album). Pure helpers + one small element builder.
import { h } from "./dom.js";

export const BLOB_FREE_BYTES = 1024 ** 3; // keep in step with lib/usage.js

export function formatBytes(n) {
  const v = Math.max(0, Number(n) || 0);
  if (v < 1024) return `${Math.round(v)} B`;
  if (v < 1024 ** 2) return `${Math.round(v / 1024)} KB`;
  if (v < 1024 ** 3) return `${(v / 1024 ** 2).toFixed(1)} MB`;
  return `${(v / 1024 ** 3).toFixed(2)} GB`;
}

/** used/limit in bytes -> what the meter shows. */
export function usageSummary({ used, limit = BLOB_FREE_BYTES }) {
  const u = Math.max(0, Number(used) || 0);
  const pct = Math.min(100, (u / limit) * 100);
  return { used: u, left: Math.max(0, limit - u), limit, pct, tone: pct >= 90 ? "high" : pct >= 70 ? "mid" : "ok" };
}

export async function fetchUsage(key = null, fetchImpl = (...a) => fetch(...a)) {
  const res = await fetchImpl(`api/usage${key ? `?key=${encodeURIComponent(key)}` : ""}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`사용량을 불러오지 못했어요 (${res.status})`);
  const json = await res.json();
  if (typeof json.used !== "number") throw new Error("사용량 형식이 올바르지 않아요");
  return { used: json.used, count: json.count ?? 0, limit: json.limit ?? BLOB_FREE_BYTES };
}

/** The meter: label, bar, "used · left". */
export function usageEl(usage) {
  const s = usageSummary(usage);
  return h("div", { class: `usage-meter tone-${s.tone}` },
    h("p", { class: "usage-title" }, "Vercel 무료 저장공간 (사진)"),
    h("div", { class: "usage-bar", role: "img", "aria-label": `${s.pct.toFixed(1)}% 사용` }, h("span", { style: `width:${Math.max(s.pct, s.used ? 1 : 0)}%` })),
    h("p", { class: "usage-text" }, `${formatBytes(s.used)} 사용 · ${formatBytes(s.left)} 남음 (총 ${formatBytes(s.limit)}${usage.count ? `, 사진 ${usage.count}장` : ""})`));
}
