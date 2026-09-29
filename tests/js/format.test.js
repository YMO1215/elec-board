import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addDays, deltaText, deltaTone, dueLabel, fmtDate, fmtDateTime, localDate, pct, periodPreset,
} from "../../web/js/lib/format.js";

test("zero denominator renders as a dash, never 0%", () => {
  assert.equal(pct(null), "—");
  assert.equal(pct(undefined), "—");
  assert.equal(pct(0), "0.0%");
  assert.equal(pct(92.25), "92.3%");
});

test("delta text and tone follow the good direction", () => {
  assert.equal(deltaText(3.21), "+3.2%p");
  assert.equal(deltaText(-1), "−1.0%p");
  assert.equal(deltaText(null), "비교할 값 없음");
  assert.equal(deltaTone(2, "up"), "good");
  assert.equal(deltaTone(-2, "up"), "bad");
  assert.equal(deltaTone(-2, "down"), "good");
  assert.equal(deltaTone(0, "up"), "flat");
});

test("due labels", () => {
  assert.deepEqual(dueLabel("2026-09-27", "2026-09-29"), { label: "2일 지남", tone: "danger" });
  assert.deepEqual(dueLabel("2026-09-29", "2026-09-29"), { label: "오늘 마감", tone: "warn" });
  assert.equal(dueLabel("2026-10-02", "2026-09-29").label, "D-3");
  assert.equal(dueLabel(null, "2026-09-29").label, "기한 없음");
  assert.equal(dueLabel("2026-09-01", "2026-09-29", true).tone, "plain");
});

test("dates are Korea local", () => {
  assert.equal(localDate(new Date("2026-09-29T16:30:00Z")), "2026-09-30");
  assert.equal(fmtDateTime("2026-09-29T16:30:00+00:00"), "2026-09-30 01:30");
  assert.equal(fmtDate("2026-10-02"), "10월 2일 (금)");
  assert.equal(addDays("2026-12-30", 3), "2027-01-02");
});

test("period presets", () => {
  assert.deepEqual(periodPreset("week", "2026-10-01"), { start: "2026-09-28", end: "2026-10-04" });
  assert.deepEqual(periodPreset("month", "2026-02-10"), { start: "2026-02-01", end: "2026-02-28" });
  assert.deepEqual(periodPreset("last_month", "2026-01-15"), { start: "2025-12-01", end: "2025-12-31" });
  assert.deepEqual(periodPreset("90d", "2026-09-29"), { start: "2026-07-02", end: "2026-09-29" });
  assert.equal(periodPreset("nope", "2026-09-29"), null);
});
