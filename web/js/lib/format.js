// Pure formatting helpers (no DOM) — unit tested in web/tests.

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
export const TZ_OFFSET_MIN = 9 * 60; // Korea, no DST — matches the server default

/** Local calendar date (YYYY-MM-DD) in Korea for a Date. */
export function localDate(d = new Date()) {
  const shifted = new Date(d.getTime() + TZ_OFFSET_MIN * 60000);
  return shifted.toISOString().slice(0, 10);
}

export function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(fromIso, toIso) {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86400000);
}

/** "10월 3일 (금)" */
export function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일 (${WEEKDAYS[d.getUTCDay()]})`;
}

/** ISO timestamp -> "2026-10-03 14:05" in Korea time. */
export function fmtDateTime(ts) {
  if (!ts) return "—";
  const d = new Date(Date.parse(ts) + TZ_OFFSET_MIN * 60000);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 16).replace("T", " ");
}

export function fmtTime(ts) {
  return ts ? fmtDateTime(ts).slice(11) : "—";
}

/** Due label for a task: {label, tone} — tone is danger / warn / plain. */
export function dueLabel(due, today, done = false) {
  if (!due) return { label: "기한 없음", tone: "plain" };
  if (done) return { label: fmtDate(due), tone: "plain" };
  const diff = daysBetween(today, due);
  if (diff < 0) return { label: `${-diff}일 지남`, tone: "danger" };
  if (diff === 0) return { label: "오늘 마감", tone: "warn" };
  if (diff === 1) return { label: "내일 마감", tone: "plain" };
  return { label: `D-${diff}`, tone: "plain" };
}

/** Percent with one decimal; null (zero denominator) is shown as "—", never 0%. */
export function pct(value) {
  if (value === null || value === undefined) return "—";
  return `${Number(value).toFixed(1)}%`;
}

/** Signed percentage-point delta, e.g. "+3.2%p". */
export function deltaText(delta) {
  if (delta === null || delta === undefined) return "비교할 값 없음";
  if (delta === 0) return "변화 없음";
  return `${delta > 0 ? "+" : "−"}${Math.abs(delta).toFixed(1)}%p`;
}

/** Whether a change is good, given the metric's good direction. */
export function deltaTone(delta, direction = "up") {
  if (delta === null || delta === undefined || delta === 0) return "flat";
  const up = delta > 0;
  return up === (direction === "up") ? "good" : "bad";
}

export function fileSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** Period presets used by the KPI and board filters. Returns {start, end} (inclusive). */
export function periodPreset(name, today) {
  const d = new Date(`${today}T00:00:00Z`);
  const monday = addDays(today, -((d.getUTCDay() + 6) % 7));
  const monthStart = `${today.slice(0, 8)}01`;
  const nextMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
  const monthEnd = addDays(nextMonth, -1);
  switch (name) {
    case "today":
      return { start: today, end: today };
    case "week":
      return { start: monday, end: addDays(monday, 6) };
    case "month":
      return { start: monthStart, end: monthEnd };
    case "last_month": {
      const lastEnd = addDays(monthStart, -1);
      return { start: `${lastEnd.slice(0, 8)}01`, end: lastEnd };
    }
    case "90d":
      return { start: addDays(today, -89), end: today };
    default:
      return null;
  }
}
