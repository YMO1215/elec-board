import assert from "node:assert/strict";
import { test } from "node:test";

import { monthGrid, shiftOn } from "../js/shift.js";
import { addTask, initialState, parse, updateTask } from "../js/store.js";

const row = (iso) => ["p1", "p2", "p3", "p4"].map((p) => shiftOn(p, iso));

test("anchor: 10/1 is 담당자1 야간, 담당자2 비번, 담당자3 주간", () => {
  assert.deepEqual(row("2026-10-01"), ["야", "비", "주", null]);
});

test("주주야야비비 repeats every 6 days for each person", () => {
  const days = ["01", "02", "03", "04", "05", "06", "07"].map((d) => `2026-10-${d}`);
  assert.deepEqual(days.map((d) => shiftOn("p3", d)), ["주", "주", "야", "야", "비", "비", "주"]);
  assert.deepEqual(days.map((d) => shiftOn("p1", d)), ["야", "야", "비", "비", "주", "주", "야"]);
  assert.deepEqual(days.map((d) => shiftOn("p2", d)), ["비", "비", "주", "주", "야", "야", "비"]);
});

test("every day exactly one team is on day, night and off", () => {
  for (let d = -40; d <= 40; d += 1) {
    const iso = new Date(Date.UTC(2026, 9, 1 + d)).toISOString().slice(0, 10);
    assert.deepEqual(row(iso).slice(0, 3).sort(), ["비", "야", "주"], iso);
  }
});

test("works before the anchor and across month/year ends", () => {
  assert.deepEqual(row("2026-09-30"), ["주", "야", "비", null]);
  assert.deepEqual(row("2026-09-25"), row("2026-10-01")); // exactly one cycle earlier
  // 10/1 -> 12/31 is 91 days (91 % 6 = 1): 담당자3 주 1일차 -> 2일차, 담당자1 야 1일차 -> 2일차
  assert.deepEqual(row("2026-12-31"), ["야", "비", "주", null]);
  assert.deepEqual([shiftOn("p3", "2026-12-31"), shiftOn("p3", "2027-01-01")], ["주", "야"]);
  assert.deepEqual([shiftOn("p1", "2026-12-31"), shiftOn("p1", "2027-01-01")], ["야", "비"]);
});

test("month grid is Sunday-first and covers the whole month", () => {
  const oct = monthGrid(2026, 10); // 10/1/2026 is a Thursday
  assert.equal(oct[0][4].iso, "2026-10-01");
  assert.equal(oct[0][4].inMonth, true);
  assert.equal(oct[0][0].iso, "2026-09-27");
  assert.equal(oct[0][0].inMonth, false);
  assert.equal(oct.flat().filter((c) => c.inMonth).length, 31);
  assert.ok(oct.every((w) => w.length === 7));
  assert.equal(monthGrid(2026, 2).flat().filter((c) => c.inMonth).length, 28);
  assert.equal(monthGrid(2028, 2).flat().filter((c) => c.inMonth).length, 29);
});

test("completion date is kept through storage", () => {
  let s = addTask(initialState(), "p1", "일", "t");
  s = updateTask(s, "t", { done: true, doneAt: "2026-10-02" });
  assert.equal(parse(JSON.stringify(s)).tasks[0].doneAt, "2026-10-02");
  s = updateTask(s, "t", { done: false, doneAt: null });
  assert.equal(parse(JSON.stringify(s)).tasks[0].doneAt, null);
  const bad = { ...s, tasks: [{ ...s.tasks[0], doneAt: "어제" }] };
  assert.equal(parse(JSON.stringify(bad)).tasks[0].doneAt, null);
});
