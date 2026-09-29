import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COMMON, activeOf, addComment, addTask, doneOf, emptyTrash, initialState, moveTask, parse, removeComment,
  restoreFromTrash, trashOf, trashTask, updateTask,
} from "../js/store.js";

const T1 = "2026-10-01T09:00:00.000Z";
const T2 = "2026-10-01T10:30:00.000Z";

function board() {
  let s = initialState();
  for (const id of ["a", "b", "c"]) s = addTask(s, "p1", id, id); // lane: c, b, a
  s = addTask(s, COMMON, "공통", "k");
  return s;
}

test("delete moves a task to the trash; it leaves the board and the completed list", () => {
  let s = updateTask(board(), "a", { done: true, doneAt: "2026-10-01" });
  s = trashTask(s, "b", T1);
  s = trashTask(s, "a", T2); // a completed task deleted from the completed list
  assert.deepEqual(activeOf(s, "p1").map((t) => t.id), ["c"]);
  assert.deepEqual(doneOf(s).map((t) => t.id), []);
  assert.deepEqual(trashOf(s).map((t) => t.id), ["a", "b"]); // newest first
  assert.equal(trashTask(s, "b", T2), s); // already in the trash
});

test("restore puts a task back where it came from", () => {
  let s = updateTask(board(), "a", { done: true, doneAt: "2026-10-01" });
  s = trashTask(trashTask(s, "b", T1), "a", T2);
  s = restoreFromTrash(s, "b");
  assert.deepEqual(activeOf(s, "p1").map((t) => t.id), ["c", "b"]); // back in its lane, same order
  s = restoreFromTrash(s, "a");
  assert.deepEqual(doneOf(s).map((t) => t.id), ["a"]); // a completed task returns to the completed list
  assert.equal(restoreFromTrash(s, "a"), s);
});

test("drag positions ignore trashed tasks", () => {
  let s = trashTask(board(), "b", T1); // visible p1: c, a
  s = addTask(s, "p2", "x", "x");
  s = moveTask(s, "x", "p1", 1);
  assert.deepEqual(activeOf(s, "p1").map((t) => t.id), ["c", "x", "a"]);
});

test("emptying the trash removes only trashed tasks, permanently", () => {
  let s = trashTask(trashTask(board(), "b", T1), "k", T2);
  s = emptyTrash(s);
  assert.deepEqual(s.tasks.map((t) => t.id).sort(), ["a", "c"]);
  assert.equal(emptyTrash(s), s);
});

test("comments: add, ignore duplicates and blanks, remove, survive moves and storage", () => {
  let s = addComment(board(), "c", "  자재 도착 확인  ", "m1", T1);
  s = addComment(s, "c", "내일 오전 교체", "m2", T2);
  assert.deepEqual(s.tasks.find((t) => t.id === "c").comments, [
    { id: "m1", text: "자재 도착 확인", at: T1 }, { id: "m2", text: "내일 오전 교체", at: T2 },
  ]);
  assert.equal(addComment(s, "c", "again", "m2", T2), s); // a retried op with the same id is a no-op
  assert.equal(addComment(s, "c", "   ", "m3", T2), s);
  assert.equal(addComment(s, "nope", "x", "m4", T2), s);
  const moved = moveTask(s, "c", "p3", 0);
  assert.equal(moved.tasks.find((t) => t.id === "c").comments.length, 2);
  s = removeComment(s, "c", "m1");
  assert.deepEqual(s.tasks.find((t) => t.id === "c").comments.map((c) => c.id), ["m2"]);
  assert.equal(removeComment(s, "c", "m1"), s);
  const back = parse(JSON.stringify(s));
  assert.deepEqual(back.tasks.find((t) => t.id === "c").comments, [{ id: "m2", text: "내일 오전 교체", at: T2 }]);
});

test("storage drops malformed trash dates and comments", () => {
  const s = board();
  s.tasks[0] = { ...s.tasks[0], deletedAt: "어제", comments: [{ id: "x", text: "ok", at: T1 }, { id: 5, text: "bad", at: T1 }, { id: "y", text: "t", at: "nope" }, "junk"] };
  const back = parse(JSON.stringify(s));
  assert.equal(back.tasks[0].deletedAt, null);
  assert.deepEqual(back.tasks[0].comments, [{ id: "x", text: "ok", at: T1 }]);
  const trashed = parse(JSON.stringify(trashTask(board(), "a", T1)));
  assert.equal(trashed.tasks.find((t) => t.id === "a").deletedAt, T1);
});
