// 업무 보드: render, magnet drag, inline editing, keyboard moves, undo, team sync.
import { h } from "./dom.js";
import { initialOf } from "./avatar.js";
import { icon } from "./icons.js";
import { openCalendar } from "./calendar.js";
import { EASE, animateClose, reduced, replay, toggleHeight, wireDialog } from "./motion.js";
import {
  COMMON, MAX_PHOTOS, MAX_TEXT, REGULAR, STORAGE_KEY, addPhoto, addTask, load, moveTask, newId, owners, parse, removeTask, renamePerson, setAssignee,
  activeOf, addComment, doneOf, emptyTrash, purgeTrash, removeComment, restoreFromTrash, restoreTask, save, setNote,
  DONE_FOLDER_DAYS, PHOTO_MONTHS, doneFolderCutoff, doneFolderDaysLeft, dropPhotos, expiredPhotos, photoCutoff, photoUrlsOf,
  TRASH_DAYS, removePhoto, trashCutoff, trashDaysLeft, trashOf, trashTask, updateTask,
} from "./store.js";
import { POLL_MS, createSync } from "./sync.js";
import { deletePhotoFiles, fetchPhoto, fileSafe, photoName, photoSrc, saveBlob, shrinkPhoto, uploadPhoto } from "./photo.js";
import { makeZip } from "./zip.js";

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
const DRAG_THRESHOLD = 3;
const TOAST_MS = 6000;

// ---------------------------------------------------------------- storage

let storage = window.localStorage;
try {
  storage.setItem("__probe", "1");
  storage.removeItem("__probe");
} catch {
  const mem = new Map();
  storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  queueMicrotask(() => toast("이 브라우저는 저장을 막고 있어요. 창을 닫으면 내용이 사라집니다."));
}

const KEY_STORAGE = "magnet-board:key";

let local = load(storage); // this browser's copy; in shared mode it is the fast first-paint cache
let state = local; // what the screen shows
let editing = null; // { owner, id|null }
let renaming = null; // person id
let dragging = false;
const viewFromHash = () => (location.hash === "#trash" ? "trash" : location.hash === "#done" ? "done" : "board");
let view = viewFromHash(); // board | done | trash (trash lives inside the 완료 screen)

/** Optional board key: open the board once with `#k=<key>` and it is remembered. */
function readKey() {
  const m = location.hash.match(/(?:^#|&)k=([^&]+)/);
  if (m) {
    storage.setItem(KEY_STORAGE, decodeURIComponent(m[1]));
    history.replaceState(null, "", location.pathname + location.search);
  }
  return storage.getItem(KEY_STORAGE);
}

const boardKey = readKey();
const sync = createSync({ key: boardKey, onChange: () => refresh(), onStatus: showStatus });

const typingInNote = () => ["note-line-input", "comment-input"].some((c) => document.activeElement?.classList?.contains(c));
let quiet = false; // a change whose result is already on screen (the user just typed it): don't redraw
let pendingRender = false; // a redraw was skipped while the user was busy

function busy() {
  return Boolean(dragging || editing || renaming || typingInNote());
}

function refresh() {
  if (sync.mode === "shared") {
    state = sync.view();
    save(storage, state);
  } else {
    state = local;
  }
  if (quiet) return;
  if (busy()) pendingRender = true; // mid-drag / mid-typing: render when the user is done
  else render();
}

/** Every change is an operation (state -> state), so it can be re-applied after a conflict. */
function commit(op, { focusMagnet = null, silent = false } = {}) {
  quiet = silent;
  try {
    if (sync.mode === "shared") {
      sync.commit(op);
    } else {
      const next = op(local);
      if (next === local) return;
      local = next;
      save(storage, local);
      refresh();
    }
  } finally {
    quiet = false;
  }
  if (focusMagnet) document.querySelector(`.note[data-id="${focusMagnet}"] .magnet`)?.focus();
}

function showStatus({ mode, pending, detail }) {
  const el = document.getElementById("sync");
  let text;
  let tone;
  if (mode === "connecting") [text, tone] = ["연결 중…", "wait"];
  else if (mode === "shared" && detail === "offline") [text, tone] = [`오프라인 · 저장 대기 ${pending}`, "warn"];
  else if (mode === "shared" && detail) [text, tone] = [`저장 실패 — ${detail}`, "warn"];
  else if (mode === "shared") [text, tone] = [pending ? "저장 중…" : "팀과 공유 중", "live"];
  else if (mode === "error") [text, tone] = ["보드 키가 맞지 않아요 — 팀에서 받은 링크로 여세요", "warn"];
  else if (detail === "not_configured") [text, tone] = ["이 기기에만 저장", "off"];
  else [text, tone] = ["오프라인 · 이 기기에만 저장", "warn"];
  el.textContent = text;
  el.dataset.tone = tone;
  // the short label stays on one line in the top bar; the reason is one tap / hover away
  el.title = detail === "not_configured" ? "공유 저장소가 연결되지 않아 이 브라우저에만 저장됩니다." : "";
}

// ---------------------------------------------------------------- dom helpers

/** Local calendar date, YYYY-MM-DD. */
function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// The two halves of the shared strip: 공통 업무 (left) and 정기 업무 (right).
const SHARED = {
  [COMMON]: { cls: "pc", name: "공통 업무", sub: "모두의 일", hint: "함께 할 일을 여기로 끌어 놓으세요", add: "공통 업무 추가", short: "공통" },
  [REGULAR]: { cls: "pr", name: "정기 업무", sub: "반복되는 일", hint: "정기적으로 할 일을 여기로 끌어 놓으세요", add: "정기 업무 추가", short: "정기" },
};

function sharedTargets() {
  return [COMMON, REGULAR].map((id) => ({ id, cls: SHARED[id].cls, name: SHARED[id].name }));
}

function ownerName(owner) {
  return SHARED[owner]?.name ?? state.people.find((p) => p.id === owner)?.name ?? "";
}

let toastTimer;
function toast(message, action) {
  const box = document.getElementById("toast");
  clearTimeout(toastTimer);
  box.replaceChildren(h("span", {}, message));
  if (action) {
    box.append(h("button", { type: "button", onClick: () => { action.run(); box.replaceChildren(); } }, action.label));
  }
  replay(box, "is-in"); // springs up from the bottom each time
  toastTimer = setTimeout(() => box.replaceChildren(), TOAST_MS);
}

// ---------------------------------------------------------------- comments under a card

const openComments = new Set(); // cards whose comment box is open (per session)
const expandedComments = new Set(); // cards showing all comments, not just the latest
const LATEST_COMMENTS = 2;
let focusComposer = null; // put the caret back into this card's comment box after the next render

function two(n) {
  return String(n).padStart(2, "0");
}

/** "14:05" today, "10/1 14:05" otherwise (local time). */
function commentTime(iso) {
  const d = new Date(iso);
  const day = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
  return day === todayIso() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

function toggleComposer(taskId) {
  if (openComments.has(taskId)) {
    openComments.delete(taskId);
  } else {
    openComments.add(taskId);
    focusComposer = taskId;
  }
  render();
}

function commentsEl(task) {
  const all = [...(task.comments ?? [])].sort((a, b) => a.at.localeCompare(b.at));
  const open = openComments.has(task.id);
  if (!all.length && !open) return null;
  const shown = expandedComments.has(task.id) ? all : all.slice(-LATEST_COMMENTS);
  const hidden = all.length - shown.length;

  let composer = null;
  if (open) {
    const input = h("input", {
      class: "comment-input", type: "text", maxlength: String(MAX_TEXT), autocomplete: "off", enterkeyhint: "send",
      placeholder: "코멘트 추가", "aria-label": `“${task.text}”에 코멘트`,
    });
    const send = h("button", { class: "comment-send", type: "button", "aria-label": "코멘트 보내기", disabled: true }, icon("arrow-up", 16));
    const submit = () => {
      const text = input.value.trim();
      if (!text) return;
      const id = newId(); // fixed outside the op so a retried op is identical
      const at = new Date().toISOString();
      input.value = "";
      focusComposer = task.id; // keep typing the next one
      input.blur(); // leave "typing" so the render below is not deferred
      commit((s) => addComment(s, task.id, text, id, at));
    };
    input.addEventListener("input", () => { send.disabled = !input.value.trim(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); submit(); }
      if (e.key === "Escape") { e.preventDefault(); input.blur(); toggleComposer(task.id); }
    });
    send.addEventListener("click", submit);
    composer = h("div", { class: "composer" }, input, send);
  }

  return h("div", { class: "note-comments", role: "list", "aria-label": "코멘트" },
    hidden ? h("button", { class: "comment-more", type: "button", onClick: () => { expandedComments.add(task.id); render(); } },
      `이전 코멘트 ${hidden}개 보기`) : null,
    shown.map((c) => h("div", { class: "comment", role: "listitem", dataset: { id: c.id } },
      h("p", { class: "comment-text" }, c.text),
      h("span", { class: "comment-time" }, commentTime(c.at)),
      h("button", {
        class: "comment-del", type: "button", "aria-label": `코멘트 “${c.text.slice(0, 20)}” 삭제`,
        onClick: () => {
          commit((s) => removeComment(s, task.id, c.id));
          toast("코멘트를 지웠어요", { label: "되돌리기", run: () => commit((s) => addComment(s, task.id, c.text, c.id, c.at)) });
        },
      }, icon("x", 14)))),
    composer);
}

// ---------------------------------------------------------------- photos on a card

const taskOf = (id) => state.tasks.find((t) => t.id === id);

const photoPicker = h("input", { type: "file", accept: "image/*", multiple: true, hidden: true, "aria-hidden": "true", tabindex: "-1" });
let pickFor = null; // card the next picked photos belong to
photoPicker.addEventListener("change", () => {
  const files = [...photoPicker.files];
  photoPicker.value = ""; // picking the same photo again must fire change again
  if (pickFor && files.length) addPhotos(pickFor, files);
});
document.body.append(photoPicker);

function pickPhotos(taskId) {
  if ((taskOf(taskId)?.photos ?? []).length >= MAX_PHOTOS) {
    toast(`사진은 카드마다 ${MAX_PHOTOS}장까지예요`);
    return;
  }
  pickFor = taskId;
  photoPicker.click();
}

/** Shrink (640px, q0.5) -> upload -> attach the URL. One at a time; a failure stops the rest with a message. */
async function addPhotos(taskId, files) {
  let added = 0;
  for (const file of files) {
    if ((taskOf(taskId)?.photos ?? []).length >= MAX_PHOTOS) { toast(`사진은 카드마다 ${MAX_PHOTOS}장까지예요`); break; }
    toast(files.length > 1 ? `사진 올리는 중… ${added + 1}/${files.length}` : "사진 올리는 중…");
    try {
      const name = await photoName(file); // shooting time, read from the original before the resize drops EXIF
      const url = await uploadPhoto(await shrinkPhoto(file), { folder: taskId, name, key: boardKey });
      const photo = { id: newId(), url, at: new Date().toISOString(), name }; // fixed outside the op so a retried op is identical
      commit((s) => addPhoto(s, taskId, photo));
      added += 1;
    } catch (err) {
      toast(`사진을 올리지 못했어요 — ${err.message}`);
      return;
    }
  }
  if (added) toast(added > 1 ? `사진 ${added}장을 붙였어요` : "사진을 붙였어요");
}

// The album (사진첩): one folder per task (card name). Photos are named by shooting time.

const openFolders = new Set(); // folders left open (per session)
let albumDialog = null;

/** Small chip on a board card that has photos; it opens the album at that card's folder. */
function photoMark(task) {
  const n = (task.photos ?? []).length;
  if (!n || task.owner === REGULAR) return null; // 정기 업무 has no folder in the album
  return h("button", {
    class: "photo-mark", type: "button", "aria-label": `사진 ${n}장, 사진첩에서 보기`,
    onClick: () => { openFolders.add(task.id); openAlbum(task.id); },
  }, icon("album", 14), h("span", {}, String(n)));
}

function openAlbum(focusId = null) {
  if (albumDialog) return;
  const dialog = h("dialog", { class: "cal album", "aria-label": "사진첩" });
  albumDialog = dialog;
  wireDialog(dialog);
  dialog.addEventListener("close", () => { albumDialog = null; dialog.remove(); });
  document.body.append(dialog);
  fillAlbum();
  dialog.showModal();
  if (focusId) dialog.querySelector(`.folder[data-id="${focusId}"]`)?.scrollIntoView({ block: "center" });
}

// Photos this device has downloaded: their thumbnail gets a border in the owner's card colour.
// Per device on purpose (what you saved to this phone/PC), so it lives in local storage, not on the shared board.
const DOWNLOADED_KEY = "magnet-board:downloaded";
const downloaded = new Set((() => {
  try { return JSON.parse(storage.getItem(DOWNLOADED_KEY) ?? "[]"); } catch { return []; }
})());

function markDownloaded(ids) {
  for (const id of ids) downloaded.add(id);
  const live = new Set(state.tasks.flatMap((t) => (t.photos ?? []).map((p) => p.id)));
  for (const id of [...downloaded]) if (!live.has(id)) downloaded.delete(id); // forget deleted photos
  try { storage.setItem(DOWNLOADED_KEY, JSON.stringify([...downloaded])); } catch { /* storage blocked: the mark lasts this session */ }
  fillAlbum();
}

/** All of a folder's photos as one zip (named by shooting time inside). */
async function downloadFolder(task) {
  const photos = task.photos ?? [];
  if (!photos.length) return;
  toast(`사진 ${photos.length}장 묶는 중…`);
  try {
    const files = [];
    for (const p of photos) {
      files.push({ name: `${fileSafe(p.name)}.jpg`, data: new Uint8Array(await (await fetchPhoto(p.url, boardKey)).arrayBuffer()) });
    }
    saveBlob(new Blob([makeZip(files)], { type: "application/zip" }), `${fileSafe(task.text, "사진첩")}.zip`);
    markDownloaded(photos.map((p) => p.id));
    toast(`사진 ${photos.length}장을 내려받았어요`);
  } catch (err) {
    toast(`내려받지 못했어요 — ${err.message}`);
  }
}

/** One photo as a .jpg named by its shooting time. */
async function downloadPhoto(photo) {
  try {
    saveBlob(await fetchPhoto(photo.url, boardKey), `${fileSafe(photo.name)}.jpg`);
    markDownloaded([photo.id]);
  } catch (err) {
    toast(`내려받지 못했어요 — ${err.message}`);
  }
}

const SWIPE_W = 88; // width of the 삭제 button a right-to-left swipe reveals
let swipedClose = null; // closes the one folder row that is currently swiped open

/** Right-to-left swipe on a folder row reveals 삭제, which removes that folder's photos (files too). */
function swipeToDelete(details, task) {
  const photos = task.photos ?? [];
  const del = h("button", { class: "folder-del", type: "button", tabindex: "-1", "aria-hidden": "true", "aria-label": `“${task.text}” 폴더의 사진 ${photos.length}장 삭제` },
    icon("trash", 18), "삭제");
  const row = h("div", { class: "folder-row" }, del, details);
  const setX = (x, animate) => {
    details.style.transition = animate ? "" : "none";
    details.style.transform = x ? `translateX(${x}px)` : "";
  };
  const setOpen = (open) => {
    row.classList.toggle("is-swiped", open);
    del.tabIndex = open ? 0 : -1;
    if (open) del.removeAttribute("aria-hidden"); else del.setAttribute("aria-hidden", "true");
    setX(open ? -SWIPE_W : 0, true);
    if (open) {
      if (swipedClose && swipedClose !== close) swipedClose();
      swipedClose = close;
    } else if (swipedClose === close) {
      swipedClose = null;
    }
  };
  const close = () => setOpen(false);
  let pointer = null; // { id, x, y, base, mode: "pending" | "swipe", cur }
  details.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !e.target.closest("summary")) return;
    pointer = { id: e.pointerId, x: e.clientX, y: e.clientY, base: row.classList.contains("is-swiped") ? -SWIPE_W : 0, mode: "pending", cur: 0 };
  });
  details.addEventListener("pointermove", (e) => {
    if (!pointer || e.pointerId !== pointer.id) return;
    const dx = e.clientX - pointer.x;
    const dy = e.clientY - pointer.y;
    if (pointer.mode === "pending") {
      if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        pointer.mode = "swipe";
        details.setPointerCapture(e.pointerId);
      } else if (Math.abs(dy) > 8) {
        pointer = null; // a vertical scroll, not a swipe
        return;
      } else {
        return;
      }
    }
    pointer.cur = Math.max(-SWIPE_W, Math.min(0, pointer.base + dx));
    setX(pointer.cur, false);
  });
  const finish = (e) => {
    if (!pointer || e.pointerId !== pointer.id) return;
    const swiped = pointer.mode === "swipe";
    const open = pointer.cur < -SWIPE_W / 2;
    pointer = null;
    if (swiped) {
      setOpen(open);
      details.dataset.swiped = "1"; // the click that follows the release must not toggle the folder
      setTimeout(() => { delete details.dataset.swiped; }, 0);
    }
  };
  details.addEventListener("pointerup", finish);
  details.addEventListener("pointercancel", finish);
  details.addEventListener("click", (e) => {
    const onSummary = e.target.closest("summary");
    if (details.dataset.swiped || (onSummary && row.classList.contains("is-swiped"))) {
      e.preventDefault(); // after a swipe, or tapping an open row, only close/stay
      e.stopPropagation();
      if (!details.dataset.swiped) close();
    }
  }, true);
  del.addEventListener("click", async () => {
    del.disabled = true;
    try {
      await deletePhotoFiles(photos.map((p) => p.url), { key: boardKey }); // files first; records stay if this fails
    } catch (err) {
      del.disabled = false;
      toast(`사진을 지우지 못했어요 — ${err.message}`);
      return;
    }
    const ids = photos.map((p) => p.id);
    commit((s) => dropPhotos(s, ids));
    toast(`“${task.text.slice(0, 18)}” 폴더의 사진 ${ids.length}장을 지웠어요`);
  });
  return row;
}

function folderEl(task) {
  const photos = task.photos ?? [];
  const sub = task.done && task.doneAt && photos.length ? `완료 · ${doneFolderDaysLeft(task.doneAt, Date.now())}일 후 사진 삭제` : task.done ? "완료" : "";
  const details = h("details", { class: "folder", dataset: { id: task.id } },
    h("summary", {},
      h("span", { class: "folder-icon", "aria-hidden": "true" }, icon("folder", 20)),
      h("span", { class: "folder-main" }, h("span", { class: "folder-name" }, task.text), sub ? h("span", { class: "folder-sub" }, sub) : null),
      h("span", { class: "count" }, String(photos.length)),
      icon("chevron-down", 16)),
    h("div", { class: "folder-body" },
      h("div", { class: "folder-actions" },
        h("button", { class: "text-btn", type: "button", "aria-label": `“${task.text}” 폴더에 사진 추가`, onClick: () => pickPhotos(task.id) },
          icon("camera", 16), "사진 추가"),
        photos.length
          ? h("button", { class: "text-btn", type: "button", "aria-label": `“${task.text}” 폴더 사진 ${photos.length}장 모두 내려받기`, onClick: () => downloadFolder(task) },
            icon("download", 16), "전체 다운")
          : null),
      photos.length
        ? h("div", { class: "photo-grid", role: "list" }, photos.map((p) => h("button", {
          class: `photo-cell${downloaded.has(p.id) ? " is-downloaded" : ""}`, type: "button", role: "listitem",
          "aria-label": `사진 ${p.name} 크게 보기${downloaded.has(p.id) ? " (내려받음)" : ""}`, onClick: () => openPhoto(task.id, p.id),
        }, h("img", { src: photoSrc(p.url, boardKey), alt: "", loading: "lazy", decoding: "async" }), h("span", {}, p.name))))
        : h("p", { class: "folder-empty" }, "아직 사진이 없어요")));
  details.open = openFolders.has(task.id);
  details.addEventListener("toggle", () => { if (details.open) openFolders.add(task.id); else openFolders.delete(task.id); });
  return photos.length ? swipeToDelete(details, task) : details; // nothing to delete -> no swipe
}

/** One card per person / 공통 in their own colour, holding that owner's folders. (정기 업무 has no folders.) */
function ownerCards(tasks) {
  const groups = [...state.people.map((p) => ({ cls: p.id, name: p.name, id: p.id })), { cls: SHARED[COMMON].cls, name: SHARED[COMMON].name, id: COMMON }];
  return groups
    .map((g) => ({ g, rows: tasks.filter((t) => t.owner === g.id) }))
    .filter(({ rows }) => rows.length)
    .map(({ g, rows }) => h("section", { class: `album-card ${g.cls}`, "aria-label": `${g.name} 폴더` },
      h("header", { class: "album-card-head" }, avatar(g.cls, g.name), h("h3", {}, g.name), h("span", { class: "count" }, String(rows.length))),
      rows.map(folderEl)));
}

let doneFoldersOpen = false; // the folded "완료한 업무" section at the bottom

function doneFolders(tasks) {
  const details = h("details", { class: "album-done" },
    h("summary", {}, h("span", {}, "완료한 업무"), h("span", { class: "count" }, String(tasks.length)), icon("chevron-down", 16)),
    h("div", { class: "album-done-body" }, ownerCards(tasks)));
  details.open = doneFoldersOpen;
  details.addEventListener("toggle", () => { doneFoldersOpen = details.open; });
  return details;
}

function fillAlbum() {
  if (!albumDialog) return;
  const scroll = albumDialog.scrollTop;
  swipedClose = null; // the rows are rebuilt closed
  const live = state.tasks.filter((t) => !t.deletedAt && t.owner !== REGULAR);
  const active = live.filter((t) => !t.done);
  const finished = live.filter((t) => t.done);
  albumDialog.replaceChildren(h("div", { class: "album-inner" },
    h("header", { class: "album-head" },
      h("h2", { class: "cal-title" }, "사진첩"),
      h("button", { class: "icon-btn", type: "button", "aria-label": "닫기", onClick: () => animateClose(albumDialog) }, icon("x"))),
    h("p", { class: "album-note" }, `폴더를 오른쪽에서 왼쪽으로 밀면 삭제 버튼이 나와요. 사진은 올린 지 ${PHOTO_MONTHS}개월이 지나면, 완료한 업무의 사진은 ${DONE_FOLDER_DAYS}일이 지나면 자동으로 지워져요.`),
    active.length ? ownerCards(active) : h("p", { class: "folder-empty" }, "진행 중인 업무를 추가하면 여기에 폴더가 생겨요"),
    finished.length ? doneFolders(finished) : null));
  albumDialog.scrollTop = scroll;
}

/** Full-size look at one photo. Delete removes the file from Blob too (two taps to confirm). */
function openPhoto(taskId, photoId) {
  const photo = (taskOf(taskId)?.photos ?? []).find((p) => p.id === photoId);
  if (!photo) return;
  const dialog = h("dialog", { class: "cal photo", "aria-label": "사진" });
  const close = () => animateClose(dialog);
  dialog.append(h("div", { class: "photo-inner" },
    h("img", { class: "photo-full", src: photoSrc(photo.url, boardKey), alt: "업무 사진" }),
    h("div", { class: "photo-bar" },
      armed(h("button", { class: "tool is-delete", type: "button", "aria-label": "사진 삭제" }, icon("trash")), "삭제", async () => {
        try {
          await deletePhotoFiles([photo.url], { key: boardKey }); // the file goes first; the record stays if this fails
        } catch (err) {
          toast(`사진을 지우지 못했어요 — ${err.message}`);
          return;
        }
        close();
        commit((s) => removePhoto(s, taskId, photoId));
        toast("사진을 지웠어요");
      }),
      h("p", { class: "photo-name" }, photo.name),
      h("button", { class: "icon-btn", type: "button", "aria-label": "사진 내려받기", onClick: () => downloadPhoto(photo) }, icon("download")),
      h("button", { class: "icon-btn", type: "button", "aria-label": "닫기", onClick: close }, icon("x")))));
  wireDialog(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

/** Photos whose time is up (6 months after upload; 30 days after their task was completed). Files first, then the records. */
async function sweepPhotos() {
  const now = Date.now();
  const found = expiredPhotos(state, photoCutoff(now), doneFolderCutoff(now));
  if (!found.length) return;
  try {
    await deletePhotoFiles(found.map((p) => p.url), { key: boardKey });
  } catch {
    return; // keep the records; the next hourly check tries again
  }
  const ids = found.map((p) => p.id);
  commit((s) => dropPhotos(s, ids));
}

/** Files of tasks that are being deleted for good (best effort — the tasks are gone either way). */
function releasePhotoFiles(tasks) {
  const urls = photoUrlsOf(tasks);
  if (urls.length) deletePhotoFiles(urls, { key: boardKey }).catch(() => {});
}

/** A card that just landed somewhere (drag, sheet, keyboard) gets a short ring so the eye can find it. */
function flash(id) {
  replay(document.querySelector(`.note[data-id="${id}"]`), "just-dropped");
}

// ---------------------------------------------------------------- render

function noteEl(task) {
  const cls = SHARED[task.owner]?.cls ?? task.owner;
  const text = h("p", { class: "note-text", tabindex: "0", title: "눌러서 고치기" }, task.text);
  text.addEventListener("click", () => startEdit(task.owner, task.id));
  text.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); startEdit(task.owner, task.id); } });
  const magnet = h("button", {
    class: "magnet", type: "button",
    "aria-label": `자석: “${task.text}” 옮기기. 끌어서 붙이거나 방향키로 이동`,
  });
  magnet.addEventListener("pointerdown", (e) => beginDrag(e, task.id));
  magnet.addEventListener("keydown", (e) => keyMove(e, task));
  const extra = task.owner === REGULAR ? assigneePicker(task) : SHARED[task.owner] ? personLines(task) : null; // 공통: one input line per person · 정기: pick the people in charge
  const nComments = (task.comments ?? []).length;
  return h("article", { class: `note ${cls}`, dataset: { id: task.id } },
    magnet,
    text,
    extra?.button, // pinned to the card's right edge on the first line, however the text wraps
    photoMark(task),
    commentsEl(task),
    h("div", { class: "note-tools" },
      h("button", { class: "tool is-done", type: "button", "aria-label": `“${task.text}” 완료`, onClick: (e) => complete(task, e.currentTarget) }, icon("check")),
      h("button", {
        class: "tool", type: "button", "aria-expanded": String(openComments.has(task.id)),
        "aria-label": nComments ? `코멘트 ${nComments}개, 코멘트 달기` : "코멘트 달기",
        onClick: () => toggleComposer(task.id),
      }, icon("comment"), nComments ? h("span", { class: "tool-badge", "aria-hidden": "true" }, String(nComments)) : null),
      h("button", { class: "tool", type: "button", "aria-label": `“${task.text}” 다른 담당자로 이동`, onClick: () => openMoveSheet(task) }, icon("move")),
      h("button", { class: "tool is-delete", type: "button", "aria-label": `“${task.text}” 휴지통으로`, onClick: () => remove(task) }, icon("x"))),
    extra?.panel);
}

/** Avatar: person colour + one character. The parent (or the element itself) carries the p1..p4 class. */
function avatar(cls, name, small = false) {
  return h("span", { class: `avatar ${cls}${small ? " sm" : ""}`, "aria-hidden": "true" }, initialOf(name));
}

/** Tap-to-move path for touch screens (dragging stays available): a sheet with the four people + common. */
function openMoveSheet(task) {
  const targets = [...state.people.map((p) => ({ id: p.id, cls: p.id, name: p.name })), ...sharedTargets()];
  const dialog = h("dialog", { class: "sheet", "aria-label": "다른 담당자로 이동" });
  const close = () => animateClose(dialog);
  dialog.append(h("div", { class: "sheet-inner" },
    h("header", { class: "sheet-head" },
      h("div", {}, h("h2", {}, "옮기기"), h("p", {}, task.text)),
      h("button", { class: "icon-btn sheet-close", type: "button", "aria-label": "닫기", onClick: close }, icon("x"))),
    h("div", { class: "sheet-list" }, targets.map((t) => {
      const here = t.id === task.owner;
      return h("button", {
        class: "sheet-row", type: "button", disabled: here,
        "aria-label": here ? `${t.name} (현재 위치)` : `${t.name}로 옮기기`,
        onClick: () => {
          close();
          commit((s) => moveTask(s, task.id, t.id, 0));
          flash(task.id);
          navigator.vibrate?.(10);
          toast(SHARED[t.id] ? `${t.name}에 붙였어요` : `${t.name}에게 붙였어요`);
        },
      }, avatar(t.cls, t.name), h("span", { class: "row-name" }, t.name),
      here ? icon("check") : h("span", { class: "row-meta" }, `${activeOf(state, t.id).length}건`));
    }))));
  wireDialog(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

let completeLockUntil = 0; // after a completion the next card slides under the finger; ignore a double tap

/** Check button: the tick pops green, then the card folds away and shows up in the completed list. */
function complete(task, button) {
  if (performance.now() < completeLockUntil) return;
  completeLockUntil = performance.now() + 400;
  const doneAt = todayIso(); // fixed here so a retried op keeps the same date
  let committed = false;
  const finish = () => {
    if (committed) return;
    committed = true;
    commit((s) => updateTask(s, task.id, { done: true, doneAt }));
    toast(`“${task.text.slice(0, 18)}” 완료 — 완료에서 볼 수 있어요`, {
      label: "되돌리기", run: () => commit((s) => updateTask(s, task.id, { done: false, doneAt: null })),
    });
  };
  navigator.vibrate?.(10);
  const note = button?.closest(".note");
  if (!note || reduced()) {
    finish();
    return;
  }
  if (note.dataset.leaving) return; // double tap
  note.dataset.leaving = "1";
  button.classList.add("is-checked");
  const stack = note.parentElement?.dataset.layout === "stack";
  note.style.overflow = "hidden";
  const h0 = `${note.offsetHeight}px`;
  // hold ~150ms on the green tick, then collapse so the cards below glide up
  const a = note.animate([
    { height: h0, opacity: 1, transform: "scale(1)", offset: 0 },
    { height: h0, opacity: 1, transform: "scale(1)", offset: 0.3 },
    { height: "0px", opacity: 0, transform: "scale(0.94)", paddingTop: "0px", paddingBottom: "0px",
      marginBottom: stack ? "-8px" : "0px", borderTopWidth: "0px", borderBottomWidth: "0px" },
  ], { duration: 520, easing: EASE, fill: "forwards" });
  a.onfinish = finish;
  setTimeout(finish, 700); // safety net: never lose the completion
}

// ---------------------------------------------------------------- per-person lines on common tasks

const openLines = new Set(); // task ids whose lines are open; survives re-renders
const folded = new Set(); // lanes folded on phones (memory only, per session)

function personLines(task) {
  const panelId = `lines-${task.id}`;
  const noteOf = (personId) => state.tasks.find((t) => t.id === task.id)?.notes?.[personId] ?? "";
  const dots = h("span", { class: "mini-dots", "aria-hidden": "true" });
  const paintDots = () => dots.replaceChildren(...state.people.filter((p) => noteOf(p.id)).map((p) => h("i", { class: p.id })));
  paintDots();

  const panel = h("div", { class: "note-lines", id: panelId, role: "group", "aria-label": "담당자별 입력" },
    state.people.map((p) => {
      const input = h("input", {
        class: "note-line-input", type: "text", maxlength: String(MAX_TEXT), autocomplete: "off", enterkeyhint: "done",
        value: noteOf(p.id), placeholder: p.name, "aria-label": `${p.name} 입력`,
      });
      let timer = null;
      const save = () => {
        clearTimeout(timer);
        const value = input.value.trim();
        if (value === noteOf(p.id)) return;
        commit((s) => setNote(s, task.id, p.id, value), { silent: true }); // already on screen: no redraw
        paintDots();
      };
      input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(save, 700); });
      input.addEventListener("blur", save);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); input.blur(); }
        if (e.key === "Escape") { e.preventDefault(); input.value = noteOf(p.id); input.blur(); }
      });
      return h("div", { class: `note-line ${p.id}` }, avatar(p.id, p.name, true), input);
    }));
  panel.hidden = !openLines.has(task.id);

  return { button: discloseButton(task, panel, dots, "담당자별 입력", "input"), panel };
}

/** The chevron beside a shared-strip card: opens `panel`; the `dots` summary shows only while it is closed. */
function discloseButton(task, panel, dots, label, focusSelector) {
  const button = h("button", {
    class: "disclose", type: "button", "aria-label": label, "aria-expanded": String(openLines.has(task.id)),
    "aria-controls": panel.id, title: label,
  }, icon("chevron-down"));
  button.addEventListener("click", () => {
    const open = panel.hidden;
    if (open) openLines.add(task.id); else openLines.delete(task.id);
    button.setAttribute("aria-expanded", String(open));
    if (open) {
      dots.hidden = true; // the dots only summarise a closed note
      toggleHeight(panel, true);
      panel.querySelector(focusSelector)?.focus({ preventScroll: true });
    } else {
      toggleHeight(panel, false, () => { dots.hidden = false; });
    }
  });
  dots.hidden = openLines.has(task.id);
  return h("span", { class: "disclose-wrap" }, dots, button);
}

/** 정기 업무: the chevron opens the four people (by their header names); each toggles as an assignee. */
function assigneePicker(task) {
  const panelId = `lines-${task.id}`;
  const chosen = () => state.tasks.find((t) => t.id === task.id)?.assignees ?? [];
  const dots = h("span", { class: "mini-dots assignees", "aria-hidden": "true" });
  const paintDots = () => dots.replaceChildren(...state.people.filter((p) => chosen().includes(p.id)).map((p) => avatar(p.id, p.name, true)));
  paintDots();

  const panel = h("div", { class: "note-lines assign-list", id: panelId, role: "group", "aria-label": "담당자 지정" },
    state.people.map((p) => {
      const row = h("button", { class: `assign-row ${p.id}`, type: "button", "aria-pressed": String(chosen().includes(p.id)) },
        avatar(p.id, p.name, true), h("span", { class: "row-name" }, p.name), h("span", { class: "assign-check" }, icon("check", 16)));
      row.addEventListener("click", () => {
        const on = row.getAttribute("aria-pressed") !== "true";
        commit((s) => setAssignee(s, task.id, p.id, on), { silent: true }); // already on screen: no redraw
        row.setAttribute("aria-pressed", String(on));
        paintDots();
      });
      return row;
    }));
  panel.hidden = !openLines.has(task.id);
  return { button: discloseButton(task, panel, dots, "담당자 지정", ".assign-row"), panel };
}

// When typing ends, draw whatever arrived from teammates in the meantime.
document.addEventListener("focusout", (e) => {
  if (!["note-line-input", "comment-input"].some((c) => e.target.classList?.contains(c))) return;
  setTimeout(() => { if (pendingRender && !busy()) render(); }, 250); // after any click that caused the blur
});

function editorEl(owner, task) {
  const cls = SHARED[owner]?.cls ?? owner;
  const area = h("textarea", { class: "editor", maxlength: MAX_TEXT, rows: "2", "aria-label": `${ownerName(owner)} 업무 내용`,
    placeholder: "무슨 일인가요?" });
  area.value = task ? task.text : "";
  let closed = false;
  const finish = (keep) => {
    if (closed) return;
    closed = true;
    editing = null;
    const value = area.value.trim();
    if (keep && value) {
      const id = newId(); // fixed outside the op so a retried op keeps the same id
      commit(task ? (s) => updateTask(s, task.id, { text: value }) : (s) => addTask(s, owner, value, id));
    } else {
      render();
    }
  };
  area.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); finish(true); }
    if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  area.addEventListener("blur", () => finish(true));
  const el = h("article", { class: `note ${cls} is-editing` }, h("span", { class: "magnet", "aria-hidden": "true" }), area,
    h("p", { class: "editor-hint" }, "Enter 저장 · Shift+Enter 줄바꿈 · Esc 취소"));
  return el;
}

// Cards that have been on screen before: only genuinely new arrivals (added, undone,
// moved in by a teammate) rise in. The first paint marks everything as seen.
const seen = new Set();
let firstPaint = true;

function dropZone(owner, layout) {
  const tasks = activeOf(state, owner);
  const zone = h("div", { class: "drop", dataset: { owner, layout }, role: "list", "aria-label": `${ownerName(owner)} 업무` });
  if (editing && editing.owner === owner && !editing.id) zone.append(editorEl(owner, null));
  for (const t of tasks) {
    const el = editing && editing.id === t.id ? editorEl(owner, t) : noteEl(t);
    el.setAttribute("role", "listitem");
    if (!seen.has(t.id)) {
      seen.add(t.id);
      if (!firstPaint && !reduced()) {
        el.classList.add("is-entering");
        el.addEventListener("animationend", () => el.classList.remove("is-entering"), { once: true });
      }
    }
    zone.append(el);
  }
  if (!tasks.length && !(editing && editing.owner === owner)) {
    zone.append(h("p", { class: "hint" }, SHARED[owner]?.hint ?? "+ 를 눌러 업무 추가"));
  }
  return zone;
}

function nameEl(person) {
  if (renaming === person.id) {
    const input = h("input", { class: "name-input", value: person.name, maxlength: "20", "aria-label": "이름 고치기" });
    let done = false;
    const finish = (keep) => {
      if (done) return;
      done = true;
      renaming = null;
      const name = input.value.trim();
      if (keep && name && name !== person.name) commit((s) => renamePerson(s, person.id, name));
      else render();
      document.querySelector(`.lane.${person.id} .name`)?.focus();
    };
    input.addEventListener("keydown", (e) => {
      // preventDefault: focus moves to the name button inside finish(), and the same
      // Enter would otherwise "click" it and reopen the editor.
      if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); finish(true); }
      if (e.key === "Escape") { e.preventDefault(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
    return input;
  }
  return h("button", { class: "name", type: "button", title: "눌러서 이름 바꾸기", "aria-label": `${person.name} — 이름 바꾸기`,
    onClick: () => { renaming = person.id; render(); } }, h("span", {}, person.name));
}

const ARM_MS = 3000; // how long an armed (red) button waits for the confirming tap

/** Two-step button for permanent actions: the first tap arms it (red, labelled), the second runs it. */
function armed(button, label, run) {
  let timer = null;
  button.addEventListener("click", () => {
    if (!button.classList.contains("is-armed")) {
      const plain = [...button.childNodes];
      const plainLabel = button.getAttribute("aria-label");
      button.classList.add("is-armed");
      // text buttons swap their words; icon buttons keep the icon and grow a label
      if (button.classList.contains("text-btn")) button.replaceChildren(label);
      else button.append(h("span", { class: "arm-label" }, label));
      button.setAttribute("aria-label", `${label} — 한 번 더 누르면 실행`);
      timer = setTimeout(() => {
        button.classList.remove("is-armed");
        button.replaceChildren(...plain);
        button.setAttribute("aria-label", plainLabel);
      }, ARM_MS);
      return;
    }
    clearTimeout(timer);
    run();
  });
  return button;
}

function ownerOf(id) {
  return SHARED[id] ? { cls: SHARED[id].cls, name: SHARED[id].name } : { cls: id, name: state.people.find((p) => p.id === id)?.name ?? "" };
}

function renderTrash() {
  const items = trashOf(state);
  const section = document.getElementById("done");
  const header = h("header", { class: "done-head" },
    h("button", { class: "text-btn back-btn", type: "button", onClick: () => setView("done") }, icon("chevron-left", 18), "완료"),
    h("h2", { id: "done-title" }, "휴지통"),
    h("p", {}, `${items.length}건`),
    items.length ? armed(h("button", { class: "text-btn danger push-right", type: "button", "aria-label": "휴지통 비우기" }, "비우기"),
      "모두 영구 삭제", () => {
        releasePhotoFiles(trashOf(state));
        commit((s) => emptyTrash(s));
        toast("휴지통을 비웠어요");
      }) : null);
  const list = items.length
    ? h("article", { class: "done-card trash-card", "aria-label": "휴지통 목록" },
      h("ul", { class: "done-list" }, items.map((t) => {
        const o = ownerOf(t.owner);
        const d = new Date(t.deletedAt);
        return h("li", { class: "done-row" },
          avatar(o.cls, o.name, true),
          h("div", { class: "done-body" },
            h("p", { class: "done-text" }, t.text),
            h("p", { class: "done-date" }, `${o.name} · ${d.getMonth() + 1}월 ${d.getDate()}일 삭제${t.done ? " · 완료했던 일" : ""}`),
            h("p", { class: "trash-left" }, daysLeftLabel(trashDaysLeft(t.deletedAt, Date.now())))),
          h("div", { class: "done-actions" },
            h("button", { class: "text-btn", type: "button", "aria-label": `“${t.text}” 복구`,
              onClick: () => {
                commit((s) => restoreFromTrash(s, t.id));
                toast(t.done ? "완료 목록으로 복구했어요" : `${o.name} 칸으로 복구했어요`);
              } }, icon("restore", 16), "복구"),
            armed(h("button", { class: "tool is-delete", type: "button", "aria-label": `“${t.text}” 영구 삭제` }, icon("trash")),
              "영구 삭제", () => {
                releasePhotoFiles([t]);
                commit((s) => removeTask(s, t.id).state);
                toast("영구 삭제했어요");
              })));
      })))
    : h("div", { class: "done-card trash-card empty" }, h("p", { class: "done-empty" }, "휴지통이 비어 있어요. 지운 업무는 여기서 복구할 수 있어요."));
  const note = h("p", { class: "trash-note" }, `휴지통의 업무는 ${TRASH_DAYS}일이 지나면 자동으로 영구 삭제돼요.`);
  section.replaceChildren(header, note, list);
}

function daysLeftLabel(days) {
  return days <= 1 ? "하루 안에 자동 삭제" : `${days}일 후 자동 삭제`;
}

/** Drop trashed tasks older than TRASH_DAYS. Runs at start and hourly; commits only when something expired. */
function purgeExpiredTrash() {
  const cutoff = trashCutoff(Date.now()); // fixed here so a retried op is identical
  const expired = state.tasks.filter((t) => t.deletedAt && t.deletedAt < cutoff);
  if (!expired.length) return;
  releasePhotoFiles(expired);
  commit((s) => purgeTrash(s, cutoff));
}

function renderDone() {
  const doneTasks = doneOf(state);
  const section = document.getElementById("done");
  const cards = [...state.people.map((p) => ({ id: p.id, cls: p.id, name: p.name })), ...sharedTargets()]
    .map((o) => {
      // Most recently completed first; tasks finished before dates were recorded go last.
      const rows = doneTasks.filter((t) => t.owner === o.id)
        .sort((a, b) => (b.doneAt ?? "").localeCompare(a.doneAt ?? ""));
      return h("article", { class: `done-card ${o.cls}`, "aria-label": `${o.name} 완료 목록` },
        h("header", { class: "done-card-head" }, avatar(o.cls, o.name), h("h3", {}, o.name), h("span", { class: "count" }, String(rows.length))),
        rows.length ? h("ul", { class: "done-list" }, rows.map((t) => h("li", { class: "done-row" },
          h("span", { class: "done-mark", "aria-hidden": "true" }, icon("check", 14)),
          h("div", { class: "done-body" },
            h("p", { class: "done-text" }, t.text),
            h("p", { class: "done-date" }, t.doneAt ? `${Number(t.doneAt.slice(5, 7))}월 ${Number(t.doneAt.slice(8))}일 완료` : "완료")),
          h("div", { class: "done-actions" },
            h("button", { class: "text-btn", type: "button", "aria-label": `“${t.text}” 진행 중으로 되돌리기`,
              onClick: () => commit((s) => updateTask(s, t.id, { done: false, doneAt: null })) }, "되돌리기"),
            h("button", { class: "tool is-delete", type: "button", "aria-label": `“${t.text}” 휴지통으로`, onClick: () => remove(t) }, icon("x"))))))
          : h("p", { class: "done-empty" }, "완료한 일이 없어요"));
    });
  section.replaceChildren(
    h("header", { class: "done-head" }, h("h2", { id: "done-title" }, "완료한 일"), h("p", {}, `전체 ${doneTasks.length}건`),
      h("button", { class: "text-btn trash-link push-right", type: "button", "aria-label": `휴지통 ${trashOf(state).length}건` ,
        onClick: () => setView("trash") },
      icon("trash", 18), "휴지통", trashOf(state).length ? h("span", { class: "n" }, String(trashOf(state).length)) : null)),
    ...cards);
}

const lastCounts = new Map(); // key -> number, so a changed count can "bump"

/** Set a count element's text; bump it when the number actually changed. */
function setCount(el, key, n) {
  const prev = lastCounts.get(key);
  lastCounts.set(key, n);
  if (prev !== undefined && prev !== n) queueMicrotask(() => replay(el, "bump"));
}

function render() {
  pendingRender = false;
  if (!busy()) state = sync.mode === "shared" ? sync.view() : local;
  fillAlbum(); // the album (if open) follows the board
  const active = state.tasks.filter((t) => !t.done && !t.deletedAt).length;
  const done = doneOf(state).length;
  const nActive = document.getElementById("nActive");
  const nDone = document.getElementById("nDone");
  nActive.textContent = active ? String(active) : "";
  nDone.textContent = done ? String(done) : "";
  setCount(nActive, "active", active);
  setCount(nDone, "done", done);
  const onDone = view !== "board";
  document.getElementById("seg").dataset.sel = onDone ? "done" : "board"; // slides the thumb
  document.getElementById("segBoard").setAttribute("aria-pressed", String(!onDone));
  document.getElementById("segDone").setAttribute("aria-pressed", String(onDone));
  document.getElementById("board").hidden = onDone;
  document.getElementById("done").hidden = !onDone;
  if (view === "done") {
    renderDone();
    return;
  }
  if (view === "trash") {
    renderTrash();
    return;
  }
  const lanes = document.getElementById("lanes");
  lanes.replaceChildren(...state.people.map((p) => {
    const n = activeOf(state, p.id).length;
    const count = h("span", { class: "count", "aria-label": `${n}건` }, String(n));
    setCount(count, p.id, n);
    const lane = h("section", { class: `lane ${p.id}${folded.has(p.id) ? " is-collapsed" : ""}`, "aria-label": `${p.name}의 칸` },
      h("header", { class: "lane-head" },
        avatar(p.id, p.name),
        nameEl(p),
        count,
        h("button", { class: "icon-btn add", type: "button", "aria-label": `${p.name}에게 업무 추가`, onClick: () => startEdit(p.id, null) }, icon("plus")),
        h("button", { class: "icon-btn collapse", type: "button", "aria-label": `${p.name} 목록`, "aria-expanded": String(!folded.has(p.id)),
          onClick: (e) => {
            const nowFolded = lane.classList.toggle("is-collapsed"); // in-memory only, per session
            if (nowFolded) folded.add(p.id); else folded.delete(p.id);
            e.currentTarget.setAttribute("aria-expanded", String(!nowFolded));
          } }, icon("chevron-down"))),
      dropZone(p.id, "stack"));
    return lane;
  }));

  for (const id of [COMMON, REGULAR]) {
    const meta = SHARED[id];
    const n = activeOf(state, id).length;
    const count = h("span", { class: "count" }, String(n));
    setCount(count, id, n);
    document.getElementById(`${id}-head`).replaceChildren(
      h("header", { class: "common-head" },
        avatar(meta.cls, meta.short),
        h("h2", { id: `${id}-title` }, meta.name),
        h("p", {}, meta.sub),
        count,
        h("button", { class: "icon-btn add", type: "button", "aria-label": meta.add, onClick: () => startEdit(id, null) }, icon("plus"))));
    document.getElementById(`${id}-drop`).replaceChildren(dropZone(id, "wrap"));
  }
  firstPaint = false;

  // Focus synchronously: keystrokes typed right after tapping + must not be lost.
  const area = document.querySelector(".editor");
  if (area) {
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  }
  const nameInput = document.querySelector(".name-input");
  if (nameInput) {
    nameInput.focus();
    nameInput.select();
  }
  if (focusComposer) {
    document.querySelector(`.note[data-id="${focusComposer}"] .comment-input`)?.focus({ preventScroll: true });
    focusComposer = null;
  }
}

function startEdit(owner, id) {
  editing = { owner, id };
  render();
}

function remove(task) {
  const at = new Date().toISOString(); // fixed here so a retried op is identical
  commit((s) => trashTask(s, task.id, at));
  toast(`“${task.text.slice(0, 18)}” 휴지통으로 옮겼어요`, { label: "되돌리기", run: () => commit((s) => restoreFromTrash(s, task.id)) });
}

// ---------------------------------------------------------------- keyboard moves

function keyMove(e, task) {
  const order = owners(state);
  const lane = activeOf(state, task.owner);
  const idx = lane.findIndex((t) => t.id === task.id);
  let target = null;
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    const o = order[(order.indexOf(task.owner) + (e.key === "ArrowRight" ? 1 : order.length - 1)) % order.length];
    target = [o, 0];
    announce(`${ownerName(o)}에 붙였어요`);
  } else if (e.key === "ArrowUp" && idx > 0) {
    target = [task.owner, idx - 1];
  } else if (e.key === "ArrowDown" && idx < lane.length - 1) {
    target = [task.owner, idx + 1];
  }
  if (target) {
    e.preventDefault();
    commit((s) => moveTask(s, task.id, target[0], target[1]), { focusMagnet: task.id });
    flash(task.id);
  }
}

function announce(text) {
  document.getElementById("tally").textContent = text;
}

// ---------------------------------------------------------------- magnet drag

function zoneIndex(zone, x, y, skip) {
  const notes = [...zone.querySelectorAll(":scope > .note")].filter((n) => n !== skip && !n.hidden);
  const wrap = zone.dataset.layout === "wrap";
  for (let i = 0; i < notes.length; i += 1) {
    const r = notes[i].getBoundingClientRect();
    if (wrap ? (y < r.top || (y <= r.bottom && x < r.left + r.width / 2)) : y < r.top + r.height / 2) return i;
  }
  return notes.length;
}

function beginDrag(e, id) {
  if (dragging || e.button > 0) return;
  const note = e.currentTarget.closest(".note");
  const rect = note.getBoundingClientRect();
  const offX = e.clientX - rect.left;
  const offY = e.clientY - rect.top;
  const start = { x: e.clientX, y: e.clientY };
  const pointerId = e.pointerId;
  e.currentTarget.setPointerCapture?.(pointerId);
  e.preventDefault();

  let ghost = null;
  let placeholder = null;
  let zone = null;
  const home = { zone: note.parentElement, next: note.nextElementSibling };

  const place = (x, y) => {
    const target = document.elementFromPoint(x, y)?.closest(".drop");
    if (target !== zone) {
      zone?.classList.remove("is-over");
      target?.classList.add("is-over");
    }
    if (!target) {
      zone = null;
      home.zone.insertBefore(placeholder, home.next);
      return;
    }
    zone = target;
    const i = zoneIndex(zone, x, y, note);
    const notes = [...zone.querySelectorAll(":scope > .note")].filter((n) => n !== note && !n.hidden);
    const ref = notes[i] ?? null;
    if (ref) zone.insertBefore(placeholder, ref);
    else zone.append(placeholder);
  };

  const onMove = (ev) => {
    if (ev.pointerId !== pointerId) return;
    if (!ghost) {
      if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_THRESHOLD) return;
      dragging = true;
      document.body.classList.add("is-dragging");
      ghost = note.cloneNode(true);
      ghost.classList.add("is-ghost");
      ghost.removeAttribute("role");
      ghost.setAttribute("aria-hidden", "true");
      ghost.style.width = `${rect.width}px`;
      document.body.append(ghost);
      placeholder = h("div", { class: `placeholder ${note.classList[1]}`, "aria-hidden": "true" });
      placeholder.style.height = `${rect.height}px`;
      note.hidden = true;
      home.zone.insertBefore(placeholder, note);
    }
    ghost.style.transform = `translate(${ev.clientX - offX}px, ${ev.clientY - offY}px) scale(1.05) rotate(0.35deg)`;
    place(ev.clientX, ev.clientY);
  };

  const cleanup = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("keydown", onKey);
  };

  const finish = (cancelled) => {
    cleanup();
    if (!ghost) return;
    zone?.classList.remove("is-over");
    let owner = null;
    let index = 0;
    if (!cancelled && zone) {
      owner = zone.dataset.owner;
      index = [...zone.querySelectorAll(":scope > .note, :scope > .placeholder")]
        .filter((n) => n !== note && !n.hidden).indexOf(placeholder);
    } else {
      home.zone.insertBefore(placeholder, home.next);
    }
    const land = () => {
      ghost.remove();
      placeholder.remove();
      note.hidden = false;
      dragging = false;
      document.body.classList.remove("is-dragging");
      if (owner) {
        const moved = moveTask(state, id, owner, index);
        const changed = JSON.stringify(moved.tasks) !== JSON.stringify(state.tasks);
        if (changed) {
          commit((s) => moveTask(s, id, owner, index));
          flash(id);
          navigator.vibrate?.(12);
          return;
        }
      }
      render(); // catch up on changes that arrived during the drag
    };
    if (reduced()) { land(); return; }
    const r = placeholder.getBoundingClientRect();
    ghost.classList.add("is-snapping");
    requestAnimationFrame(() => { ghost.style.transform = `translate(${r.left}px, ${r.top}px) scale(1) rotate(0deg)`; });
    let landed = false;
    const once = () => { if (!landed) { landed = true; land(); } };
    ghost.addEventListener("transitionend", once, { once: true });
    setTimeout(once, 450); // safety net a little longer than the 0.35s snap
  };
  const onUp = (ev) => { if (ev.pointerId === pointerId) finish(false); };
  const onCancel = (ev) => { if (ev.pointerId === pointerId) finish(true); };
  const onKey = (ev) => { if (ev.key === "Escape") finish(true); };
  window.addEventListener("pointermove", onMove, { passive: false });
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  window.addEventListener("keydown", onKey);
}

// ---------------------------------------------------------------- boot

function stamp() {
  const d = new Date();
  document.getElementById("stampText").textContent = `${d.getMonth() + 1}월 ${d.getDate()}일 ${WEEKDAYS[d.getDay()]}요일`;
}

document.getElementById("stamp").addEventListener("click", () => openCalendar({ people: state.people, today: todayIso() }));
document.getElementById("albumBtn").prepend(icon("album", 18));
document.getElementById("albumBtn").addEventListener("click", () => openAlbum());

// Board <-> completed list. The list has its own history entry (#done) so Back returns to the board.
function setView(next, { push = true } = {}) {
  if (next === view) return;
  view = next;
  editing = null;
  renaming = null;
  if (push) history.pushState(null, "", next === "board" ? location.pathname + location.search : `#${next}`);
  render();
  window.scrollTo(0, 0);
}
// Tapping the segment that is already selected flips to the other one.
// (the trash is part of the 완료 screen, so 완료 counts as selected there)
document.getElementById("segBoard").addEventListener("click", () => setView(view === "board" ? "done" : "board"));
document.getElementById("segDone").addEventListener("click", () => setView(view === "board" ? "done" : "board"));
window.addEventListener("popstate", () => setView(viewFromHash(), { push: false }));

// Local-only mode: another tab of this browser changed the board.
window.addEventListener("storage", (e) => {
  if (e.key !== STORAGE_KEY || sync.mode === "shared" || busy()) return;
  local = e.newValue ? parse(e.newValue) : load(storage);
  refresh();
});

const PURGE_MS = 60 * 60 * 1000; // re-check the trash for expired tasks every hour

async function connect() {
  showStatus({ mode: "connecting", pending: 0 });
  const shared = await sync.start(local);
  purgeExpiredTrash(); // after start, so a shared board is cleaned on the server copy, not the local one
  sweepPhotos();
  setInterval(() => { if (!busy()) { purgeExpiredTrash(); sweepPhotos(); } }, PURGE_MS);
  if (!shared) return;
  setInterval(() => { if (!document.hidden && !busy()) sync.poll(); }, POLL_MS);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) sync.poll(); });
  window.addEventListener("online", () => { sync.flush(); sync.poll(); });
  window.addEventListener("focus", () => sync.poll());
}

// iOS nav bar: glass + hairline only once content scrolls underneath.
const topbar = document.querySelector(".topbar");
let scrollTick = false;
const onScroll = () => {
  if (scrollTick) return;
  scrollTick = true;
  requestAnimationFrame(() => {
    scrollTick = false;
    topbar.classList.toggle("is-scrolled", window.scrollY > 4);
  });
};
window.addEventListener("scroll", onScroll, { passive: true });
onScroll();

stamp();
render();
connect();
