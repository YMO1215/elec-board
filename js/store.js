// Board state — pure functions, no DOM (unit tested in tests/store.test.js).
// Task order inside a lane = order in the tasks array.

export const STORAGE_KEY = "magnet-board:v1";
export const COMMON = "common";
export const REGULAR = "regular"; // 정기 업무 — the right half of the shared strip
export const MAX_TEXT = 200;

const DEFAULT_PEOPLE = [
  { id: "p1", name: "담당자 1" },
  { id: "p2", name: "담당자 2" },
  { id: "p3", name: "담당자 3" },
  { id: "p4", name: "담당자 4" },
];

export function initialState() {
  return { version: 1, people: DEFAULT_PEOPLE.map((p) => ({ ...p })), tasks: [], contacts: [] };
}

export function owners(state) {
  return [...state.people.map((p) => p.id), COMMON, REGULAR];
}

export function tasksOf(state, owner) {
  return state.tasks.filter((t) => t.owner === owner);
}

/** What the board shows: completed and trashed tasks leave the board. */
export function activeOf(state, owner) {
  return state.tasks.filter((t) => t.owner === owner && !t.done && !t.deletedAt);
}

/** Completed list: done and not in the trash. */
export function doneOf(state) {
  return state.tasks.filter((t) => t.done && !t.deletedAt);
}

/** Trash, most recently deleted first. */
export function trashOf(state) {
  return state.tasks.filter((t) => t.deletedAt).sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
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
  const lane = rest.filter((t) => t.owner === owner && !t.done && !t.deletedAt);
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

/** 정기 업무: switch one person on/off as an assignee of a task (ids kept in people order). */
export function setAssignee(state, id, personId, on) {
  if (!state.people.some((p) => p.id === personId)) return state;
  const task = state.tasks.find((t) => t.id === id);
  if (!task) return state;
  const has = (task.assignees ?? []).includes(personId);
  if (has === Boolean(on)) return state;
  const assignees = state.people.map((p) => p.id).filter((pid) => (pid === personId ? Boolean(on) : (task.assignees ?? []).includes(pid)));
  return { ...state, tasks: state.tasks.map((t) => (t.id === id ? { ...t, assignees } : t)) };
}

/** Delete = move to the trash (recoverable). `at` is an ISO timestamp fixed by the caller. */
export function trashTask(state, id, at) {
  if (!state.tasks.some((t) => t.id === id && !t.deletedAt)) return state;
  return updateTask(state, id, { deletedAt: at });
}

export function restoreFromTrash(state, id) {
  if (!state.tasks.some((t) => t.id === id && t.deletedAt)) return state;
  return updateTask(state, id, { deletedAt: null });
}

/** Permanently remove everything in the trash. */
export function emptyTrash(state) {
  if (!state.tasks.some((t) => t.deletedAt)) return state;
  return { ...state, tasks: state.tasks.filter((t) => !t.deletedAt) };
}

export const TRASH_DAYS = 30; // trashed tasks are removed for good after this many days
const DAY_MS = 24 * 60 * 60 * 1000;

/** ISO time before which a trashed task has expired, given "now" (ms). */
export function trashCutoff(nowMs) {
  return new Date(nowMs - TRASH_DAYS * DAY_MS).toISOString();
}

/** Remove trashed tasks deleted before `before` (ISO). The caller fixes `before` so a retried op is identical. */
export function purgeTrash(state, before) {
  if (!state.tasks.some((t) => t.deletedAt && t.deletedAt < before)) return state;
  return { ...state, tasks: state.tasks.filter((t) => !(t.deletedAt && t.deletedAt < before)) };
}

/** Whole days left before a trashed task is removed (0 = goes on the next purge). */
export function trashDaysLeft(deletedAt, nowMs) {
  return Math.max(0, Math.ceil((Date.parse(deletedAt) + TRASH_DAYS * DAY_MS - nowMs) / DAY_MS));
}

export const MAX_COMMENTS = 100;

/** Append a comment under a task. `id` and `at` are fixed by the caller so a retried op is identical. */
export function addComment(state, taskId, text, id, at) {
  const clean = cleanText(text);
  const task = state.tasks.find((t) => t.id === taskId);
  if (!clean || !task || (task.comments ?? []).some((c) => c.id === id)) return state;
  const comments = [...(task.comments ?? []), { id, text: clean, at }].slice(-MAX_COMMENTS);
  return { ...state, tasks: state.tasks.map((t) => (t.id === taskId ? { ...t, comments } : t)) };
}

export function removeComment(state, taskId, commentId) {
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task || !(task.comments ?? []).some((c) => c.id === commentId)) return state;
  const comments = task.comments.filter((c) => c.id !== commentId);
  return { ...state, tasks: state.tasks.map((t) => (t.id === taskId ? { ...t, comments } : t)) };
}

export const MAX_PHOTOS = Infinity; // no per-card limit (board JSON still capped by MAX_BODY_BYTES on the server)
const PHOTO_HOST = /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\//;

export const PHOTO_MONTHS = 6; // a photo is removed this many months after it was uploaded
export const DONE_FOLDER_DAYS = 30; // a completed task's photo folder is removed this many days after completion

function cleanPhotoName(name) {
  return String(name ?? "").trim().slice(0, 40) || "사진";
}

/** Attach an uploaded photo (a Vercel Blob URL) to a task. `id`, `at` (upload time) and `name` (shooting time) are fixed by the caller so a retried op is identical. */
export function addPhoto(state, taskId, photo) {
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task || !photo || !PHOTO_HOST.test(photo.url ?? "") || (task.photos ?? []).some((p) => p.id === photo.id)) return state;
  if ((task.photos ?? []).length >= MAX_PHOTOS) return state;
  const photos = [...(task.photos ?? []), { id: photo.id, url: photo.url, at: photo.at, name: cleanPhotoName(photo.name) }];
  return { ...state, tasks: state.tasks.map((t) => (t.id === taskId ? { ...t, photos } : t)) };
}

/** ISO time before which an uploaded photo has expired, given "now" (ms). */
export function photoCutoff(nowMs) {
  const d = new Date(nowMs);
  d.setMonth(d.getMonth() - PHOTO_MONTHS);
  return d.toISOString();
}

/** Local date (YYYY-MM-DD) on or before which a completed task's folder has expired, given "now" (ms). */
export function doneFolderCutoff(nowMs) {
  const d = new Date(nowMs - DONE_FOLDER_DAYS * DAY_MS);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Whole days left before a completed task's photos are removed (0 = on the next sweep). */
export function doneFolderDaysLeft(doneAt, nowMs) {
  return Math.max(0, Math.ceil((Date.parse(`${doneAt}T00:00:00`) + DONE_FOLDER_DAYS * DAY_MS - nowMs) / DAY_MS));
}

/** Photos that must go: older than `photoBefore` (ISO), or in the folder of a task completed on/before `doneBefore` (date). */
export function expiredPhotos(state, photoBefore, doneBefore) {
  const out = [];
  for (const t of state.tasks) {
    const folderGone = t.done && t.doneAt && t.doneAt <= doneBefore;
    for (const p of t.photos ?? []) if (folderGone || p.at < photoBefore) out.push({ taskId: t.id, id: p.id, url: p.url });
  }
  return out;
}

/** Remove these photo ids (any task). Used after their files were deleted from Blob. */
export function dropPhotos(state, ids) {
  const gone = new Set(ids);
  if (!state.tasks.some((t) => (t.photos ?? []).some((p) => gone.has(p.id)))) return state;
  return { ...state, tasks: state.tasks.map((t) => ((t.photos ?? []).some((p) => gone.has(p.id)) ? { ...t, photos: t.photos.filter((p) => !gone.has(p.id)) } : t)) };
}

/** Blob URLs of every photo on these tasks (for tasks that are being deleted for good). */
export function photoUrlsOf(tasks) {
  return tasks.flatMap((t) => (t.photos ?? []).map((p) => p.url));
}

export function removePhoto(state, taskId, photoId) {
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task || !(task.photos ?? []).some((p) => p.id === photoId)) return state;
  const photos = task.photos.filter((p) => p.id !== photoId);
  return { ...state, tasks: state.tasks.map((t) => (t.id === taskId ? { ...t, photos } : t)) };
}

export const MAX_CONTACTS = 300;
const MAX_CONTACT_FIELD = 60;
const MAX_CONTACT_MEMO = 200;
export const CONTACT_KEYS = ["company", "name", "phone", "car", "memo"]; // 업체명 · 이름 · 연락처 · 차량번호 · 직무 메모

function cleanField(value, max = MAX_CONTACT_FIELD) {
  return String(value ?? "").trim().slice(0, max);
}

/** A contact row with every field cleaned (missing ones become ""). */
function contactRow(id, src) {
  const row = { id };
  for (const key of CONTACT_KEYS) row[key] = cleanField(src?.[key], key === "memo" ? MAX_CONTACT_MEMO : MAX_CONTACT_FIELD);
  return row;
}

const hasContent = (row) => CONTACT_KEYS.some((key) => row[key]);

/** 연락처 card: one row = 업체명 + 이름 + 연락처 + 차량번호 + 직무 메모. A row needs at least one field. `id` is fixed by the caller so a retried op is identical. */
export function addContact(state, input) {
  const contacts = state.contacts ?? [];
  const id = input?.id;
  if (typeof id !== "string" || !id || contacts.length >= MAX_CONTACTS || contacts.some((c) => c.id === id)) return state;
  const row = contactRow(id, input);
  return hasContent(row) ? { ...state, contacts: [...contacts, row] } : state;
}

export function updateContact(state, id, patch) {
  const contacts = state.contacts ?? [];
  const old = contacts.find((c) => c.id === id);
  if (!old) return state;
  const next = contactRow(id, { ...old, ...patch });
  if (!hasContent(next)) return state;
  return { ...state, contacts: contacts.map((c) => (c.id === id ? next : c)) };
}

export function removeContact(state, id) {
  const contacts = state.contacts ?? [];
  if (!contacts.some((c) => c.id === id)) return state;
  return { ...state, contacts: contacts.filter((c) => c.id !== id) };
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

function cleanAssignees(raw, people) {
  return Array.isArray(raw) ? people.map((p) => p.id).filter((id) => raw.includes(id)) : [];
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;

function cleanComments(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c) => c && typeof c.id === "string" && typeof c.at === "string" && ISO_TIME.test(c.at) && cleanText(c.text))
    .map((c) => ({ id: c.id, text: cleanText(c.text), at: c.at }))
    .slice(-MAX_COMMENTS);
}

function cleanPhotos(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p) => p && typeof p.id === "string" && typeof p.url === "string" && PHOTO_HOST.test(p.url) && typeof p.at === "string" && ISO_TIME.test(p.at))
    .map((p) => ({ id: p.id, url: p.url, at: p.at, name: cleanPhotoName(p.name) }))
    .slice(0, MAX_PHOTOS);
}

function cleanContacts(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const c of raw) {
    if (!c || typeof c.id !== "string" || !c.id || seen.has(c.id)) continue;
    const row = contactRow(c.id, c);
    if (!hasContent(row)) continue;
    seen.add(c.id);
    out.push(row);
  }
  return out.slice(0, MAX_CONTACTS);
}

/** Parse stored JSON defensively: anything malformed falls back to a fresh board. */
export function parse(raw) {
  try {
    const data = JSON.parse(raw);
    if (!data || data.version !== 1 || !Array.isArray(data.people) || data.people.length !== 4 || !Array.isArray(data.tasks)) {
      return initialState();
    }
    const people = data.people.map((p, i) => ({ id: DEFAULT_PEOPLE[i].id, name: cleanText(p.name).slice(0, 20) || DEFAULT_PEOPLE[i].name }));
    const valid = new Set([...people.map((p) => p.id), COMMON, REGULAR]);
    const tasks = data.tasks
      .filter((t) => t && typeof t.id === "string" && valid.has(t.owner) && cleanText(t.text))
      .map((t) => ({
        id: t.id, text: cleanText(t.text), owner: t.owner, done: Boolean(t.done),
        doneAt: t.done && /^\d{4}-\d{2}-\d{2}$/.test(t.doneAt) ? t.doneAt : null,
        notes: cleanNotes(t.notes, people),
        assignees: cleanAssignees(t.assignees, people),
        comments: cleanComments(t.comments),
        photos: cleanPhotos(t.photos),
        deletedAt: typeof t.deletedAt === "string" && ISO_TIME.test(t.deletedAt) ? t.deletedAt : null,
      }));
    return { version: 1, people, tasks, contacts: cleanContacts(data.contacts) };
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
