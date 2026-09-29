// Board state — pure functions, no DOM (unit tested in tests/store.test.js).
// Task order inside a lane = order in the tasks array.

export const STORAGE_KEY = "magnet-board:v1";
export const COMMON = "common";
export const MAX_TEXT = 200;

const DEFAULT_PEOPLE = [
  { id: "p1", name: "담당자 1" },
  { id: "p2", name: "담당자 2" },
  { id: "p3", name: "담당자 3" },
  { id: "p4", name: "담당자 4" },
];

export function initialState() {
  return { version: 1, people: DEFAULT_PEOPLE.map((p) => ({ ...p })), tasks: [] };
}

export function owners(state) {
  return [...state.people.map((p) => p.id), COMMON];
}

export function tasksOf(state, owner) {
  return state.tasks.filter((t) => t.owner === owner);
}

/** What the board shows: completed tasks leave the board and live in the completed list. */
export function activeOf(state, owner) {
  return state.tasks.filter((t) => t.owner === owner && !t.done);
}

export function newId() {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function cleanText(text) {
  return String(text ?? "").trim().slice(0, MAX_TEXT);
}

export function addTask(state, owner, text, id = newId()) {
  const clean = cleanText(text);
  if (!clean || !owners(state).includes(owner)) return state;
  // New cards go to the top of their lane.
  const firstIdx = state.tasks.findIndex((t) => t.owner === owner);
  const task = { id, text: clean, owner, done: false };
  const tasks = [...state.tasks];
  tasks.splice(firstIdx === -1 ? tasks.length : firstIdx, 0, task);
  return { ...state, tasks };
}

/** Move a task to `owner` at position `index` among that lane's visible (not completed) tasks. */
export function moveTask(state, id, owner, index) {
  const task = state.tasks.find((t) => t.id === id);
  if (!task || !owners(state).includes(owner)) return state;
  const rest = state.tasks.filter((t) => t.id !== id);
  const lane = rest.filter((t) => t.owner === owner && !t.done);
  const at = Math.max(0, Math.min(index, lane.length));
  let globalIdx;
  if (lane.length === 0) globalIdx = rest.length;
  else if (at >= lane.length) globalIdx = rest.indexOf(lane[lane.length - 1]) + 1;
  else globalIdx = rest.indexOf(lane[at]);
  rest.splice(globalIdx, 0, { ...task, owner });
  return { ...state, tasks: rest };
}

export function updateTask(state, id, patch) {
  const next = { ...patch };
  if ("text" in next) {
    next.text = cleanText(next.text);
    if (!next.text) return state;
  }
  return { ...state, tasks: state.tasks.map((t) => (t.id === id ? { ...t, ...next } : t)) };
}

/** One person's input line on a task (used by the expandable rows on common tasks). Empty text clears it. */
export function setNote(state, id, personId, text) {
  if (!state.people.some((p) => p.id === personId)) return state;
  const clean = cleanText(text);
  const task = state.tasks.find((t) => t.id === id);
  if (!task || (task.notes?.[personId] ?? "") === clean) return state;
  const notes = { ...(task.notes ?? {}) };
  if (clean) notes[personId] = clean;
  else delete notes[personId];
  return { ...state, tasks: state.tasks.map((t) => (t.id === id ? { ...t, notes } : t)) };
}

export function removeTask(state, id) {
  const index = state.tasks.findIndex((t) => t.id === id);
  if (index === -1) return { state, removed: null };
  return { state: { ...state, tasks: state.tasks.filter((t) => t.id !== id) }, removed: { task: state.tasks[index], index } };
}

export function restoreTask(state, removed) {
  if (!removed || state.tasks.some((t) => t.id === removed.task.id)) return state;
  const tasks = [...state.tasks];
  tasks.splice(Math.min(removed.index, tasks.length), 0, removed.task);
  return { ...state, tasks };
}

export function renamePerson(state, id, name) {
  const clean = String(name ?? "").trim().slice(0, 20);
  if (!clean) return state;
  return { ...state, people: state.people.map((p) => (p.id === id ? { ...p, name: clean } : p)) };
}

export function clearDone(state) {
  return { ...state, tasks: state.tasks.filter((t) => !t.done) };
}

function cleanNotes(raw, people) {
  const out = {};
  if (raw && typeof raw === "object") {
    for (const p of people) {
      const text = typeof raw[p.id] === "string" ? cleanText(raw[p.id]) : "";
      if (text) out[p.id] = text;
    }
  }
  return out;
}

/** Parse stored JSON defensively: anything malformed falls back to a fresh board. */
export function parse(raw) {
  try {
    const data = JSON.parse(raw);
    if (!data || data.version !== 1 || !Array.isArray(data.people) || data.people.length !== 4 || !Array.isArray(data.tasks)) {
      return initialState();
    }
    const people = data.people.map((p, i) => ({ id: DEFAULT_PEOPLE[i].id, name: cleanText(p.name).slice(0, 20) || DEFAULT_PEOPLE[i].name }));
    const valid = new Set([...people.map((p) => p.id), COMMON]);
    const tasks = data.tasks
      .filter((t) => t && typeof t.id === "string" && valid.has(t.owner) && cleanText(t.text))
      .map((t) => ({
        id: t.id, text: cleanText(t.text), owner: t.owner, done: Boolean(t.done),
        doneAt: t.done && /^\d{4}-\d{2}-\d{2}$/.test(t.doneAt) ? t.doneAt : null,
        notes: cleanNotes(t.notes, people),
      }));
    return { version: 1, people, tasks };
  } catch {
    return initialState();
  }
}

export function load(storage) {
  const raw = storage.getItem(STORAGE_KEY);
  return raw ? parse(raw) : initialState();
}

export function save(storage, state) {
  storage.setItem(STORAGE_KEY, JSON.stringify(state));
}
