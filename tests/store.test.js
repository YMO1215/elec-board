import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COMMON, addTask, clearDone, initialState, moveTask, parse, removeTask, renamePerson, restoreTask, tasksOf, updateTask,
} from "../js/store.js";

const ids = (s, owner) => tasksOf(s, owner).map((t) => t.id);

function board() {
  let s = initialState();
  s = addTask(s, "p1", "c", "c");
  s = addTask(s, "p1", "b", "b");
  s = addTask(s, "p1", "a", "a"); // new cards go on top
  s = addTask(s, "p2", "x", "x");
  s = addTask(s, COMMON, "공통", "k");
  return s;
}

test("four people plus a common lane", () => {
  const s = initialState();
  assert.equal(s.people.length, 4);
  assert.deepEqual(ids(board(), "p1"), ["a", "b", "c"]);
  assert.deepEqual(ids(board(), COMMON), ["k"]);
});

test("blank or unknown-owner tasks are ignored", () => {
  const s = initialState();
  assert.equal(addTask(s, "p1", "   "), s);
  assert.equal(addTask(s, "nobody", "x"), s);
});

test("move to another person at a position", () => {
  const s = moveTask(board(), "b", "p2", 0);
  assert.deepEqual(ids(s, "p1"), ["a", "c"]);
  assert.deepEqual(ids(s, "p2"), ["b", "x"]);
  const end = moveTask(board(), "a", "p2", 99);
  assert.deepEqual(ids(end, "p2"), ["x", "a"]);
});

test("move into the common strip and into an empty lane", () => {
  let s = moveTask(board(), "a", COMMON, 1);
  assert.deepEqual(ids(s, COMMON), ["k", "a"]);
  s = moveTask(s, "x", "p4", 0);
  assert.deepEqual(ids(s, "p4"), ["x"]);
  assert.equal(tasksOf(s, "p2").length, 0);
});

test("reorder inside a lane", () => {
  assert.deepEqual(ids(moveTask(board(), "a", "p1", 2), "p1"), ["b", "c", "a"]);
  assert.deepEqual(ids(moveTask(board(), "c", "p1", 0), "p1"), ["c", "a", "b"]);
});

test("edit, done, remove + undo, clear done", () => {
  let s = updateTask(board(), "a", { text: "  고친 일  " });
  assert.equal(s.tasks.find((t) => t.id === "a").text, "고친 일");
  assert.equal(updateTask(s, "a", { text: "  " }), s);
  s = updateTask(s, "b", { done: true });
  const { state: without, removed } = removeTask(s, "c");
  assert.deepEqual(ids(without, "p1"), ["a", "b"]);
  assert.deepEqual(ids(restoreTask(without, removed), "p1"), ["a", "b", "c"]);
  assert.deepEqual(ids(clearDone(s), "p1"), ["a", "c"]);
});

test("rename keeps ids; blank names are refused", () => {
  const s = renamePerson(initialState(), "p3", " 박검토 ");
  assert.equal(s.people[2].name, "박검토");
  assert.equal(renamePerson(s, "p3", "  "), s);
});

test("stored data is parsed defensively", () => {
  assert.deepEqual(parse("not json"), initialState());
  assert.deepEqual(parse(JSON.stringify({ version: 2 })), initialState());
  const s = board();
  s.tasks.push({ id: "bad", text: "x", owner: "ghost", done: false });
  const back = parse(JSON.stringify(s));
  assert.equal(back.tasks.some((t) => t.id === "bad"), false);
  assert.deepEqual(ids(back, "p1"), ["a", "b", "c"]);
});

test("정기 업무 is a lane of its own next to the common one", async () => {
  const { REGULAR, activeOf, owners } = await import("../js/store.js");
  assert.deepEqual(owners(initialState()).slice(-2), [COMMON, REGULAR]);
  let s = addTask(initialState(), REGULAR, "월간 점검", "r1");
  s = addTask(s, COMMON, "공통", "c1");
  assert.deepEqual(activeOf(s, REGULAR).map((t) => t.id), ["r1"]);
  assert.deepEqual(activeOf(s, COMMON).map((t) => t.id), ["c1"]);
  s = moveTask(s, "c1", REGULAR, 0);
  assert.deepEqual(activeOf(s, REGULAR).map((t) => t.id), ["c1", "r1"]);
  assert.deepEqual(activeOf(s, COMMON), []);
  // survives a save/load round trip (parse keeps the owner)
  assert.deepEqual(activeOf(parse(JSON.stringify(s)), REGULAR).map((t) => t.id), ["c1", "r1"]);
});
