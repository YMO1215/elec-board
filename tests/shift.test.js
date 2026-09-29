import assert from "node:assert/strict";
import { test } from "node:test";

import { initialOf } from "../js/avatar.js";
import { monthGrid, shiftOn } from "../js/shift.js";
import { activeOf, addTask, initialState, moveTask, parse, setNote, tasksOf, updateTask } from "../js/store.js";

const row = (iso) => ["p1", "p2", "p3", "p4"].map((p) => shiftOn(p, iso));

test("owner's facts: 10/1 is 담당자1 야간 · 담당자2 비번 · 담당자3 주간, and 담당자1's first 주간 is 9/28", () => {
  assert.deepEqual(row("2026-10-01"), ["야", "비", "주", null]);
  const days = ["2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"];
  // 비 | 주 주 | 야 야 | 비 비 | 주 — the 28th starts the day-shift block, the 29th is only its second day
  assert.deepEqual(days.map((d) => shiftOn("p1", d)), ["비", "주", "주", "야", "야", "비", "비", "주"]);
});

test("주주야야비비 repeats every 6 days for each person", () => {
  const days = ["01", "02", "03", "04", "05", "06", "07"].map((d) => `2026-10-${d}`);
  assert.deepEqual(days.map((d) => shiftOn("p3", d)), ["주", "야", "야", "비", "비", "주", "주"]);
  assert.deepEqual(days.map((d) => shiftOn("p1", d)), ["야", "비", "비", "주", "주", "야", "야"]);
  assert.deepEqual(days.map((d) => shiftOn("p2", d)), ["비", "주", "주", "야", "야", "비", "비"]);
});

test("every day exactly one team is on day, night and off", () => {
  for (let d = -40; d <= 40; d += 1) {
    const iso = new Date(Date.UTC(2026, 9, 1 + d)).toISOString().slice(0, 10);
    assert.deepEqual(row(iso).slice(0, 3).sort(), ["비", "야", "주"], iso);
  }
});

test("works before the anchor and across month/year ends", () => {
  assert.deepEqual(row("2026-09-28"), ["주", "야", "비", null]);
  assert.deepEqual(row("2026-09-30"), ["야", "비", "주", null]);
  assert.deepEqual(row("2026-09-25"), row("2026-10-01")); // exactly one cycle earlier
  // 9/30 -> 12/31 is 92 days (92 % 6 = 2)
  assert.deepEqual(row("2026-12-31"), ["비", "주", "야", null]);
  assert.deepEqual([shiftOn("p3", "2026-12-31"), shiftOn("p3", "2027-01-01")], ["야", "야"]);
  assert.deepEqual([shiftOn("p1", "2026-12-31"), shiftOn("p1", "2027-01-01")], ["비", "비"]);
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

test("per-person note lines: set, clear, sanitise, survive a move", () => {
  let s = addTask(initialState(), "common", "공통 점검", "c1");
  s = setNote(s, "c1", "p2", "  배선 확인  ");
  s = setNote(s, "c1", "p4", "자재 준비");
  assert.deepEqual(s.tasks[0].notes, { p2: "배선 확인", p4: "자재 준비" });
  assert.equal(setNote(s, "c1", "p2", "배선 확인"), s); // unchanged -> same state (no redundant write)
  assert.equal(setNote(s, "c1", "p9", "x"), s); // unknown person
  assert.equal(setNote(s, "nope", "p1", "x"), s); // unknown task
  const moved = moveTask(s, "c1", "p1", 0);
  assert.deepEqual(moved.tasks[0].notes, { p2: "배선 확인", p4: "자재 준비" });
  const cleared = setNote(s, "c1", "p2", "   ");
  assert.deepEqual(cleared.tasks[0].notes, { p4: "자재 준비" });
  const dirty = { ...s, tasks: [{ ...s.tasks[0], notes: { p1: "ok", p9: "ghost", p2: 5, p3: "  " } }] };
  assert.deepEqual(parse(JSON.stringify(dirty)).tasks[0].notes, { p1: "ok" });
  assert.deepEqual(parse(JSON.stringify({ ...s, tasks: [{ ...s.tasks[0], notes: "junk" }] })).tasks[0].notes, {});
});

test("completed tasks leave the board; positions count only visible tasks", () => {
  let s = initialState();
  for (const id of ["a", "b", "c"]) s = addTask(s, "p1", id, id); // lane order: c, b, a
  s = addTask(s, "p2", "x", "x");
  s = updateTask(s, "b", { done: true, doneAt: "2026-10-02" });
  assert.deepEqual(activeOf(s, "p1").map((t) => t.id), ["c", "a"]);
  assert.deepEqual(tasksOf(s, "p1").map((t) => t.id), ["c", "b", "a"]); // still stored
  // index 1 among the visible tasks = after "c", before "a" — the hidden done task does not shift it
  const moved = moveTask(s, "x", "p1", 1);
  assert.deepEqual(activeOf(moved, "p1").map((t) => t.id), ["c", "x", "a"]);
  assert.deepEqual(moveTask(s, "x", "p1", 99).tasks.filter((t) => t.owner === "p1" && !t.done).map((t) => t.id), ["c", "a", "x"]);
  // an emptied-by-completion lane accepts a card
  const emptied = updateTask(updateTask(s, "c", { done: true }), "a", { done: true });
  assert.deepEqual(activeOf(moveTask(emptied, "x", "p1", 0), "p1").map((t) => t.id), ["x"]);
});

test("avatar initials tell people apart", () => {
  assert.deepEqual(["담당자 1", "담당자 2", "담당자 3", "담당자 4"].map(initialOf), ["1", "2", "3", "4"]);
  assert.equal(initialOf("박검토"), "박");
  assert.equal(initialOf("  kim "), "K");
  assert.equal(initialOf(""), "?");
  assert.equal(initialOf("🦊 여우"), "🦊"); // not split into half a surrogate pair
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
