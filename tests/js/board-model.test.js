import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyMove, canDrop, columnKeyOf, columnsFor, groupTasks, insertionIndex, moveCommand,
} from "../../web/js/lib/board-model.js";

const slots = [
  { slot: 1, user_id: 10, name: "김관리", initials: "관리" },
  { slot: 2, user_id: 20, name: "이현장", initials: "현장" },
  { slot: 3, user_id: 30, name: "박검토", initials: "검토" },
  { slot: 4, user_id: null, name: null, initials: null },
];

const task = (id, over = {}) => ({
  id, primary_assignee_id: 10, status: "scheduled", priority: "normal", due_date: null, version: 1,
  can_move_status: true, can_reassign: true, ...over,
});

test("both views always have exactly four columns", () => {
  assert.equal(columnsFor("assignee", slots).length, 4);
  assert.equal(columnsFor("status", slots).length, 4);
  assert.deepEqual(columnsFor("status", slots).map((c) => c.key), ["scheduled", "in_progress", "review", "done"]);
  const empty = columnsFor("assignee", slots)[3];
  assert.equal(empty.userId, null);
});

test("every task lands in exactly one column per view", () => {
  const tasks = [task(1), task(2, { primary_assignee_id: 20, status: "done" }), task(3, { primary_assignee_id: 30, status: "review" })];
  for (const view of ["assignee", "status"]) {
    const cols = columnsFor(view, slots);
    const { groups, orphans } = groupTasks(tasks, view, cols);
    const placed = [...groups.values()].flat().map((t) => t.id).sort();
    assert.deepEqual(placed, [1, 2, 3]);
    assert.equal(orphans.length, 0);
  }
});

test("columns sort by priority, then due date (no date last), then id", () => {
  const tasks = [
    task(1, { priority: "low", due_date: "2026-10-01" }),
    task(2, { priority: "urgent" }),
    task(3, { priority: "normal", due_date: "2026-10-05" }),
    task(4, { priority: "normal", due_date: "2026-10-02" }),
    task(5, { priority: "normal" }),
  ];
  const { groups } = groupTasks(tasks, "assignee", columnsFor("assignee", slots));
  assert.deepEqual(groups.get("u10").map((t) => t.id), [2, 4, 3, 5, 1]);
  assert.equal(insertionIndex(groups.get("u10"), task(9, { priority: "high" })), 1);
});

test("assignee view move changes only the assignee", () => {
  const t = task(1, { status: "in_progress", version: 7 });
  const col = columnsFor("assignee", slots)[1];
  const cmd = moveCommand(t, "assignee", col);
  assert.deepEqual(cmd.body, { assignee_id: 20, version: 7 });
  assert.equal(cmd.endpoint, "assignee");
  const moved = applyMove(t, cmd);
  assert.equal(moved.primary_assignee_id, 20);
  assert.equal(moved.status, "in_progress");
  assert.equal(columnKeyOf(moved, "assignee"), "u20");
});

test("status view move changes only the status", () => {
  const t = task(1);
  const col = columnsFor("status", slots).find((c) => c.key === "done");
  const cmd = moveCommand(t, "status", col);
  assert.deepEqual(cmd.body, { status: "done", version: 1 });
  const moved = applyMove(t, cmd);
  assert.equal(moved.status, "done");
  assert.equal(moved.primary_assignee_id, 10);
});

test("no-op, empty slot and missing permission are not droppable", () => {
  const cols = columnsFor("assignee", slots);
  assert.equal(moveCommand(task(1), "assignee", cols[0]), null); // same column
  assert.equal(canDrop(task(1), "assignee", cols[3]), false); // empty slot
  assert.equal(canDrop(task(1, { can_reassign: false }), "assignee", cols[1]), false);
  const statusCol = columnsFor("status", slots)[1];
  assert.equal(canDrop(task(1, { can_move_status: false }), "status", statusCol), false);
  assert.equal(canDrop(task(1), "status", statusCol), true);
});
