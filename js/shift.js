// 3조 2교대 (주주야야비비, 6일 주기). Pure functions, unit tested.
//
// 기준(사용자 지정): 2026-10-01 — 담당자1 야간, 담당자2 비번, 담당자3 주간.
// 세 조는 2일씩 어긋나 돈다. 기준일을 각 블록의 "첫째 날"로 본다
// (주간 1일차 · 야간 1일차 · 비번 1일차). 둘째 날이 기준이라면 ANCHOR 를 하루 당기면 된다.

export const CYCLE = ["주", "주", "야", "야", "비", "비"];
export const SHIFT_LABEL = { 주: "주간", 야: "야간", 비: "비번" };
export const SHIFT_KEY = { 주: "day", 야: "night", 비: "off" };
export const ANCHOR = "2026-10-01";
// person id -> position in CYCLE on ANCHOR
export const TEAMS = { p3: 0, p1: 2, p2: 4 };
export const SHIFT_PEOPLE = ["p1", "p2", "p3"];

export function dayNumber(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

/** "주" | "야" | "비", or null for people who are not on the rotation. */
export function shiftOn(personId, iso) {
  if (!(personId in TEAMS)) return null;
  const diff = dayNumber(iso) - dayNumber(ANCHOR);
  return CYCLE[(((diff + TEAMS[personId]) % CYCLE.length) + CYCLE.length) % CYCLE.length];
}

export function pad(n) {
  return String(n).padStart(2, "0");
}

export function toIso(y, m, d) {
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Weeks (Sunday first) covering a month: [{ iso, inMonth }] x 7 per row. month is 1-12. */
export function monthGrid(year, month) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const start = dayNumber(toIso(year, month, 1)) - first.getUTCDay();
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const weeks = Math.ceil((first.getUTCDay() + last) / 7);
  return Array.from({ length: weeks }, (_, w) => Array.from({ length: 7 }, (_, d) => {
    const dt = new Date((start + w * 7 + d) * 86400000);
    return { iso: toIso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()), inMonth: dt.getUTCMonth() + 1 === month };
  }));
}
