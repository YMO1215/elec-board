// 업무 보드: render, magnet drag, inline editing, keyboard moves, undo, team sync.
import { h } from "./dom.js";
import { initialOf } from "./avatar.js";
import { icon } from "./icons.js";
import { initThemeToggle } from "./theme.js";
import { openCalendar } from "./calendar.js";
import { EASE, animateClose, reduced, replay, toggleHeight, wireDialog } from "./motion.js";
import {
  COMMON, MAX_PHOTOS, MAX_TEXT, REGULAR, STORAGE_KEY, addCategory, addContact, addPhoto, addTask, formatPhone, removeCategory, removeContact, renameCategory, updateContact, load, moveTask, newId, owners, parse, removeTask, renamePerson, setAssignee, movePerson,
  activeOf, addComment, doneOf, emptyTrash, purgeTrash, removeComment, restoreFromTrash, restoreTask, save, setNote,
  DONE_FOLDER_DAYS, PHOTO_MONTHS, doneFolderCutoff, doneFolderDaysLeft, dropPhotos, expiredPhotos, photoCutoff, photoUrlsOf,
  TRASH_DAYS, removePhoto, trashCutoff, trashDaysLeft, trashOf, trashTask, updateTask,
  MAX_DOCS, MAX_DOC_FOLDERS, addDoc, addDocFolder, childDocs, moveDocs, removeDocFolder, removeDocs, renameDoc, renameDocFolder, replaceDocFile,
} from "./store.js";
import { MAX_DOC_BYTES, deleteDocFiles, docProblem, docSrc, fetchDoc, uploadDoc } from "./doc.js";
import { editPdf, markReceipt, mergePdfs, mergePlan, normAngle, planChanged, splitBuyerStamp } from "./pdfops.js";
import { drawStampPreview, loadPdfLib, pageTexts, pdfViewer, textMeasurer, textPicture } from "./pdfkit.js";
import { BUYER, buyerSpot, buyerText, highlightBox, receiptFields, receiptMarks, rowsOf } from "./receipt.js";
import { csvName, receiptCsv } from "./receiptcsv.js";
import { auditReceipts } from "./receiptaudit.js";
import { parseDraft } from "./draft.js";
import { matchDraft } from "./draftmatch.js";
import { SORTS, selectableIds, toggleAll, viewDocs } from "./docview.js";
import { POLL_MS, createSync } from "./sync.js";
import { deletePhotoFiles, fetchPhoto, fileSafe, photoName, photoSrc, saveBlob, shrinkPhoto, uploadPhoto } from "./photo.js";
import { makeZip } from "./zip.js";
import { SITE, fetchTwilight, twilightText } from "./twilight.js";
import { fetchUsage, formatBytes, usageEl } from "./usage.js";

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
let contactEditing = null; // 연락처 card: "new" | contact id | null
let categoryPanel = false; // 연락처 분류 편집 panel open
const CONTACTS_OPEN_KEY = "magnet-board:contacts-open";
let contactsOpen = (() => { try { return storage.getItem(CONTACTS_OPEN_KEY) === "1"; } catch { return false; } })(); // the whole 연락처 card: folded to its title line unless opened
function setContactsOpen(open) {
  contactsOpen = open;
  try { storage.setItem(CONTACTS_OPEN_KEY, open ? "1" : "0"); } catch { /* private mode: just remember for this visit */ }
  render();
}
let contactFilter = "all"; // all | none | <category id>
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
  return Boolean(dragging || editing || renaming || contactEditing || categoryPanel || typingInNote());
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
  raiseToast(box);
  replay(box, "is-in"); // springs up from the bottom each time
  toastTimer = setTimeout(() => { box.replaceChildren(); lowerToast(box); }, TOAST_MS);
}

/**
 * An open modal dialog (사진첩·PDF·달력) sits in the browser's top layer, above everything with a z-index,
 * so the toast was drawn under its dim backdrop. As a manual popover the toast joins the top layer too,
 * and re-showing it each time puts it above the dialog that is open now.
 */
function raiseToast(box) {
  if (typeof box.showPopover !== "function") return; // older browser: plain fixed toast
  try {
    if (box.matches(":popover-open")) box.hidePopover();
    box.showPopover();
  } catch { /* not connected yet: stays a plain fixed toast */ }
}

function lowerToast(box) {
  try { if (box.matches(":popover-open")) box.hidePopover(); } catch { /* no popover support */ }
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
  refreshUsage();
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

// Free Vercel Blob storage left (the photo album's files). Fetched on start, after uploads and when the album opens/closes.
let usage = null;
async function refreshUsage() {
  try { usage = await fetchUsage(boardKey); } catch { usage = null; } // local-only mode / storage not connected: hide the meter
  const box = document.getElementById("usage");
  box.replaceChildren(...(usage ? [usageEl(usage)] : []));
  box.hidden = !usage;
  fillAlbum();
}

function openAlbum(focusId = null) {
  if (albumDialog) return;
  refreshUsage();
  const dialog = h("dialog", { class: "cal album", "aria-label": "사진첩" });
  albumDialog = dialog;
  wireDialog(dialog);
  dialog.addEventListener("close", () => { albumDialog = null; dialog.remove(); refreshUsage(); });
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
    usage ? usageEl(usage) : null,
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

// ---------------------------------------------------------------- PDF 문서함 (next to 사진첩)
// One board-wide list shared with the team, sorted into folders (삭제한 폴더의 PDF 는 미분류로).
// Tap a name to open it; 선택 picks several for 병합 · 이동 · 삭제; the pencil opens the page editor.

let docsDialog = null;
let docFolder = "all"; // all | none | <folder id>
let docSelect = null; // null = normal list; [] = selecting (ids in the order they were picked = merge order)
let folderPanel = false; // 폴더 관리 panel open
let docsPending = false; // a refill was skipped while the user was typing in the dialog
let docQuery = ""; // the search box
const DOC_SORT_KEY = "docs-sort";
let docSort = "new"; // key of SORTS, remembered in storage (read when the sheet opens)
let docView = []; // the PDFs on screen in order — what 전체 선택 picks from

const docPicker = h("input", { type: "file", accept: "application/pdf,.pdf", multiple: true, hidden: true, "aria-hidden": "true", tabindex: "-1" });
docPicker.addEventListener("change", () => {
  const files = [...docPicker.files];
  docPicker.value = ""; // picking the same file again must fire change again
  if (files.length) addDocs(files);
});
document.body.append(docPicker);

const docFolders = () => state.docFolders ?? [];
const docsAll = () => state.docs ?? [];
const docOf = (id) => docsAll().find((d) => d.id === id);
const folderName = (id) => docFolders().find((f) => f.id === id)?.name ?? "미분류";
/** The folder new files go into: the one being viewed, else 미분류. */
const currentFolderId = () => (docFolders().some((f) => f.id === docFolder) ? docFolder : "");

async function uploadDocBlob(blob, name) {
  if (blob.size > MAX_DOC_BYTES) throw new Error(`결과 파일이 ${formatBytes(blob.size)}라 4MB 를 넘어요`);
  return uploadDoc(blob, { name, key: boardKey });
}

async function addDocs(files) {
  let added = 0;
  const folder = currentFolderId();
  for (const file of files) {
    if (docsAll().length >= MAX_DOCS) { toast(`PDF 는 ${MAX_DOCS}개까지예요`); break; }
    const problem = docProblem(file);
    if (problem) { toast(`${file.name} — ${problem}`); continue; }
    toast(files.length > 1 ? `PDF 올리는 중… ${added + 1}/${files.length}` : "PDF 올리는 중…");
    try {
      const name = String(file.name ?? "").replace(/\.pdf$/i, "").trim() || "문서";
      const url = await uploadDoc(file, { name, key: boardKey });
      const doc = { id: newId(), url, at: new Date().toISOString(), name, size: file.size, folder }; // fixed outside the op so a retried op is identical
      commit((s) => addDoc(s, doc));
      added += 1;
    } catch (err) {
      toast(`PDF 를 올리지 못했어요 — ${err.message}`);
      return;
    }
  }
  if (added) toast(added > 1 ? `PDF ${added}개를 올렸어요` : "PDF 를 올렸어요");
  refreshUsage();
}

async function docBytes(doc) {
  return new Uint8Array(await (await fetchDoc(doc.url, boardKey)).arrayBuffer());
}

async function downloadDoc(doc) {
  try {
    saveBlob(await fetchDoc(doc.url, boardKey), `${fileSafe(doc.name, "문서")}.pdf`);
  } catch (err) {
    toast(`내려받지 못했어요 — ${err.message}`);
  }
}

/** Delete PDFs: the files go first; the records stay if that fails. */
async function deleteDocs(ids) {
  const docs = ids.map(docOf).filter(Boolean);
  if (!docs.length) return false;
  try {
    await deleteDocFiles(docs.map((d) => d.url), { key: boardKey });
  } catch (err) {
    toast(`PDF 를 지우지 못했어요 — ${err.message}`);
    return false;
  }
  commit((s) => removeDocs(s, docs.map((d) => d.id)));
  toast(docs.length > 1 ? `PDF ${docs.length}개를 지웠어요` : "PDF 를 지웠어요");
  refreshUsage();
  return true;
}

/** Merge the picked PDFs in the order they were picked; the originals stay. */
async function mergeSelected() {
  const docs = (docSelect ?? []).map(docOf).filter(Boolean);
  if (docs.length < 2) { toast("병합할 PDF 를 2개 이상 고르세요"); return; }
  if (docsAll().length >= MAX_DOCS) { toast(`PDF 는 ${MAX_DOCS}개까지예요`); return; }
  toast(`PDF ${docs.length}개 병합하는 중…`);
  try {
    const [lib, ...files] = await Promise.all([loadPdfLib(), ...docs.map(docBytes)]);
    const merged = new Blob([await mergePdfs(lib, files)], { type: "application/pdf" });
    const name = `${docs[0].name} 외 ${docs.length - 1}개`.slice(0, 80);
    const url = await uploadDocBlob(merged, name);
    const folder = currentFolderId() || docs[0].folder;
    const doc = { id: newId(), url, at: new Date().toISOString(), name, size: merged.size, folder };
    commit((s) => addDoc(s, doc));
    docSelect = null;
    fillDocs();
    toast(`“${name}” 로 합쳤어요`);
    refreshUsage();
  } catch (err) {
    toast(`병합하지 못했어요 — ${err.message}`);
  }
}

function toggleSelect(id) {
  const i = docSelect.indexOf(id);
  if (i >= 0) docSelect.splice(i, 1); else docSelect.push(id);
  fillDocs();
}

function docRowEl(doc) {
  const d = new Date(doc.at);
  const when = `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`;
  const sub = [when, doc.size ? formatBytes(doc.size) : "", docFolder === "all" && doc.folder ? folderName(doc.folder) : ""].filter(Boolean).join(" · ");
  const main = [
    h("span", { class: "doc-icon", "aria-hidden": "true" }, icon("doc", 20)),
    h("span", { class: "doc-main" }, h("span", { class: "doc-name" }, doc.name), h("span", { class: "doc-sub" }, sub)),
  ];
  if (docSelect) {
    const order = docSelect.indexOf(doc.id);
    return h("li", { class: `doc-row${doc.parent ? " is-child" : ""}${order >= 0 ? " is-picked" : ""}`, dataset: { id: doc.id } },
      h("button", { class: "doc-open", type: "button", "aria-pressed": order >= 0 ? "true" : "false", "aria-label": `“${doc.name}” ${order >= 0 ? `선택됨 ${order + 1}번째` : "선택"}`, onClick: () => toggleSelect(doc.id) },
        h("span", { class: "doc-check", "aria-hidden": "true" }, order >= 0 ? String(order + 1) : ""), main));
  }
  return h("li", { class: `doc-row${doc.parent ? " is-child" : ""}`, dataset: { id: doc.id } },
    h("a", { class: "doc-open", href: docSrc(doc.url, doc.name, boardKey), target: "_blank", rel: "noopener", "aria-label": `“${doc.name}” 열기` }, main),
    h("button", { class: "icon-btn", type: "button", title: "페이지 편집", "aria-label": `“${doc.name}” 편집`, onClick: () => openDocEditor(doc.id) }, icon("edit")),
    h("button", { class: "icon-btn doc-more", type: "button", title: "더보기", "aria-haspopup": "dialog", "aria-label": `“${doc.name}” 더보기 (표시본·CSV·검산·이동·내려받기·삭제)`, onClick: () => openDocMenu(doc.id) }, icon("more")));
}

/** 폴더 관리: rename / delete each folder, add a new one. Deleting a folder keeps its PDFs (they become 미분류). */
function folderPanelEl() {
  const rows = docFolders().map((f) => {
    const input = h("input", { class: "contact-input", type: "text", value: f.name, maxlength: 30, "aria-label": `${f.name} 폴더 이름` });
    input.addEventListener("change", () => {
      if (!input.value.trim()) { input.value = f.name; return; }
      if (docFolders().some((o) => o.id !== f.id && o.name === input.value.trim())) { toast("같은 이름의 폴더가 있어요"); input.value = f.name; return; }
      commit((s) => renameDocFolder(s, f.id, input.value));
    });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); input.blur(); } });
    const n = docsAll().filter((d) => d.folder === f.id).length;
    return h("div", { class: "cat-row" }, input,
      armed(h("button", { class: "text-btn danger", type: "button", "aria-label": `${f.name} 폴더 삭제${n ? ` (PDF ${n}개는 미분류로)` : ""}` }, "삭제"), "정말 삭제",
        () => { if (docFolder === f.id) docFolder = "all"; commit((s) => removeDocFolder(s, f.id)); fillDocs(); }));
  });
  const fresh = h("input", { class: "contact-input cat-new", type: "text", maxlength: 30, placeholder: "새 폴더 이름 (예: 점검표)", "aria-label": "새 폴더 이름" });
  const add = () => {
    const name = fresh.value.trim();
    if (!name) { fresh.focus(); return; }
    if (docFolders().some((f) => f.name === name)) { toast("같은 이름의 폴더가 있어요"); fresh.focus(); return; }
    if (docFolders().length >= MAX_DOC_FOLDERS) { toast(`폴더는 ${MAX_DOC_FOLDERS}개까지예요`); return; }
    const id = newId(); // fixed outside the op so a retried op is identical
    commit((s) => addDocFolder(s, { id, name }));
    fresh.value = "";
    fillDocs(true);
    docsDialog?.querySelector(".cat-new")?.focus();
  };
  fresh.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } });
  return h("div", { class: "cat-panel doc-folder-panel" }, rows,
    h("div", { class: "cat-row" }, fresh, h("button", { class: "text-btn", type: "button", onClick: add }, "추가")),
    h("p", { class: "album-note" }, "폴더를 지워도 안의 PDF 는 지워지지 않고 미분류로 옮겨져요."),
    h("div", { class: "cat-row" }, h("span", { class: "spacer" }),
      h("button", { class: "text-btn", type: "button", onClick: () => { folderPanel = false; fillDocs(true); } }, "완료")));
}

function folderChips() {
  const folders = docFolders();
  const count = (pred) => docsAll().filter(pred).length;
  const chip = (id, label, n) => h("button", {
    class: "chip sm", type: "button", title: label, "aria-pressed": docFolder === id ? "true" : "false",
    onClick: () => { docFolder = id; fillDocs(true); revealFolderChip(); },
  }, h("span", { class: "chip-name" }, label), h("span", { class: "n" }, String(n)));
  return h("div", { class: "doc-folders", role: "group", "aria-label": "폴더" },
    chip("all", "전체", docsAll().length),
    folders.length ? chip("none", "미분류", count((d) => !d.folder)) : null,
    folders.map((f) => chip(f.id, f.name, count((d) => d.folder === f.id))));
}

/** Phones show the folders as one scrolling line: bring the chosen one into view. */
function revealFolderChip() {
  docsDialog?.querySelector('.doc-folders [aria-pressed="true"]')?.scrollIntoView({ inline: "center", block: "nearest" });
}

/** 전체 선택 / 전체 해제 over the originals on screen (copies made from them are left out). */
function toggleSelectAll() {
  docSelect = toggleAll(docSelect, selectableIds(docView));
  fillDocs(true);
}

function selectTop() {
  const n = docSelect.length;
  const ids = selectableIds(docView);
  const allOn = ids.length > 0 && ids.every((id) => docSelect.includes(id));
  return h("div", { class: "doc-seltop" },
    h("span", { class: "doc-selcount" }, n ? `${n}개 선택` : "PDF 를 고르세요"),
    h("button", { class: "text-btn", type: "button", disabled: ids.length ? null : true, title: "화면에 보이는 PDF 전체 (구매자 표시본은 제외)", onClick: toggleSelectAll }, allOn ? "전체 해제" : "전체 선택"),
    h("button", { class: "text-btn quiet", type: "button", onClick: () => { docSelect = null; fillDocs(true); } }, "취소"));
}

/** Actions on the picked PDFs, pinned to the bottom of the sheet: icon + short word, no box around them. */
function selectFoot() {
  const n = docSelect.length;
  const act = (label, name, props = {}) => h("button", { class: "doc-act", type: "button", ...props }, icon(name, 18), h("span", {}, label));
  return h("div", { class: "doc-selfoot" },
    act("병합", "merge", { disabled: n < 2 ? true : null, title: n < 2 ? "2개 이상 고르세요" : "고른 순서대로 한 PDF 로 합치기", onClick: mergeSelected }),
    act("맞춤병합", "merge", { disabled: n < 2 ? true : null, title: n < 2 ? "기안문 + 카드 영수증을 고르세요" : "기안문의 품목 순서대로 카드 영수증을 맞춰 병합 (금액 검산 포함)", onClick: () => openDraftMergeDialog([...docSelect]) }),
    act("검산", "check", { disabled: n ? null : true, title: "고른 영수증의 품목·금액이 맞는지 검산", onClick: () => openAuditDialog([...docSelect]) }),
    act("CSV", "table", { disabled: n ? null : true, title: "고른 영수증 PDF 를 한 CSV 로 정리", onClick: () => exportReceiptCsv([...docSelect]) }),
    act("이동", "move", { disabled: n ? null : true, title: "폴더로 이동", onClick: () => openDocFolderSheet([...docSelect]) }),
    n ? armed(h("button", { class: "doc-act is-danger text-btn", type: "button" }, icon("trash", 18)), `${n}개 삭제`, async () => {
      if (await deleteDocs([...docSelect])) { docSelect = null; fillDocs(true); }
    }) : h("button", { class: "doc-act is-danger", type: "button", disabled: true }, icon("trash", 18), h("span", {}, "삭제")));
}

/** Choose a folder for the given PDFs (a copy that moves alone leaves its original; see store.moveDocs). */
function openDocFolderSheet(ids) {
  const docs = ids.map(docOf).filter(Boolean);
  if (!docs.length) return;
  const here = docs.every((d) => d.folder === docs[0].folder) ? docs[0].folder : null;
  const targets = [{ id: "", name: "미분류" }, ...docFolders()];
  const dialog = h("dialog", { class: "sheet", "aria-label": "폴더로 이동" });
  const close = () => animateClose(dialog);
  dialog.append(h("div", { class: "sheet-inner" },
    h("header", { class: "sheet-head" },
      h("div", {}, h("h2", {}, "폴더로 이동"), h("p", {}, docs.length > 1 ? `PDF ${docs.length}개` : docs[0].name)),
      h("button", { class: "icon-btn sheet-close", type: "button", "aria-label": "닫기", onClick: close }, icon("x"))),
    h("div", { class: "sheet-list" }, targets.map((t) => h("button", {
      class: "sheet-row", type: "button", disabled: here === t.id ? true : null,
      "aria-label": here === t.id ? `${t.name} (현재 폴더)` : `${t.name} 폴더로 옮기기`,
      onClick: () => {
        close();
        commit((s) => moveDocs(s, ids, t.id));
        docSelect = null;
        fillDocs(true);
        toast(`PDF ${docs.length}개를 “${t.name}” 로 옮겼어요`);
      },
    }, icon("folder", 20), h("span", { class: "row-name" }, t.name), here === t.id ? icon("check") : null)))));
  wireDialog(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

/** The ⋯ of a row: everything except open and edit, each with its name written out. */
function openDocMenu(id) {
  const doc = docOf(id);
  if (!doc) return;
  const dialog = h("dialog", { class: "sheet", "aria-label": `“${doc.name}” 작업` });
  const close = () => animateClose(dialog);
  const item = (name, label, run) => h("button", { class: "sheet-row", type: "button", onClick: () => { close(); run(); } },
    icon(name, 20), h("span", { class: "row-name" }, label));
  dialog.append(h("div", { class: "sheet-inner" },
    h("header", { class: "sheet-head" },
      h("div", {}, h("h2", {}, "PDF 작업"), h("p", {}, doc.name)),
      h("button", { class: "icon-btn sheet-close", type: "button", "aria-label": "닫기", onClick: close }, icon("x"))),
    h("div", { class: "sheet-list" },
      doc.parent ? null : item("marker", "구매자 표시본 만들기", () => openBuyerDialog(doc.id)),
      doc.parent ? null : item("table", "영수증 정리 CSV 받기", () => exportReceiptCsv([doc.id])),
      doc.parent ? null : item("check", "영수증 검산", () => openAuditDialog([doc.id])),
      item("folder", "폴더로 이동", () => openDocFolderSheet([doc.id])),
      item("download", "내려받기", () => downloadDoc(doc)),
      armed(h("button", { class: "sheet-row is-danger text-btn", type: "button" }, icon("trash", 20), "삭제"), "한 번 더 누르면 삭제",
        async () => { close(); await deleteDocs([doc.id]); }))));
  wireDialog(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

/** The list part of the sheet (notes, folder panel, rows). Search typing only repaints this, never the input itself (IME). */
function paintDocList() {
  const box = docsDialog?.querySelector(".doc-scroll");
  if (!box) return;
  docView = viewDocs(docsAll(), { folder: docFolder, query: docQuery, sort: docSort });
  const upload = h("button", { class: "text-btn", type: "button", onClick: () => docPicker.click() }, icon("plus", 16), "PDF 올리기");
  const q = docQuery.trim();
  let body;
  if (docView.length) body = h("ul", { class: "doc-list", role: "list" }, docView.map(docRowEl));
  else if (q) body = h("p", { class: "folder-empty" }, `“${q}” 와 맞는 PDF 가 없어요`);
  else body = h("div", { class: "doc-empty" }, h("p", { class: "folder-empty" }, docsAll().length ? "이 폴더에는 PDF 가 없어요" : "아직 올린 PDF 가 없어요"), upload);
  box.replaceChildren(...[
    folderPanel ? folderPanelEl() : null,
    docSelect ? h("p", { class: "album-note" }, "고른 순서대로 병합돼요. 원본은 그대로 남아요.") : h("p", { class: "album-note" }, "여기에 끌어다 놓아도 올라가요 · 파일당 4MB · 팀 모두에게 보여요"),
    body,
  ].filter(Boolean));
  const top = docsDialog.querySelector(".doc-seltop");
  if (top && docSelect) top.replaceWith(selectTop());
}

function fillDocs(force = false) {
  if (!docsDialog) return;
  const typing = docsDialog.contains(document.activeElement) && document.activeElement.matches("input, select");
  if (typing && !force) { docsPending = true; return; } // don't wipe what is being typed; refill on focusout
  docsPending = false;
  if (docFolder !== "all" && docFolder !== "none" && !docFolders().some((f) => f.id === docFolder)) docFolder = "all"; // that folder is gone
  if (docSelect) docSelect = docSelect.filter((id) => docOf(id)); // drop PDFs someone else deleted
  const scroll = docsDialog.querySelector(".doc-scroll")?.scrollTop ?? 0;
  const barLeft = docsDialog.querySelector(".doc-folders")?.scrollLeft ?? 0;
  const search = h("input", { class: "contact-input doc-search", type: "search", value: docQuery, placeholder: "이름으로 찾기 (/)", "aria-label": "PDF 이름 검색", autocomplete: "off", enterkeyhint: "search" });
  search.addEventListener("input", () => { docQuery = search.value; paintDocList(); });
  const sortLabel = SORTS.find(([k]) => k === docSort)?.[1] ?? "최신순";
  const tools = docSelect ? selectTop() : h("div", { class: "folder-actions doc-tools" },
    h("button", { class: "text-btn", type: "button", "aria-label": `PDF 파일 올리기${currentFolderId() ? ` (${folderName(currentFolderId())} 폴더)` : ""}`, onClick: () => docPicker.click() }, icon("plus", 16), "PDF 올리기"),
    docsAll().length ? h("button", { class: "text-btn", type: "button", onClick: () => { docSelect = []; fillDocs(true); } }, icon("check", 16), "선택") : null,
    h("span", { class: "spacer" }),
    h("button", { class: "text-btn quiet", type: "button", title: "정렬 바꾸기", "aria-label": `정렬: ${sortLabel} — 누르면 바뀜`, onClick: () => {
      docSort = SORTS[(SORTS.findIndex(([k]) => k === docSort) + 1) % SORTS.length][0];
      try { storage.setItem(DOC_SORT_KEY, docSort); } catch { /* remembered for this visit only */ }
      fillDocs(true);
    } }, sortLabel));
  docsDialog.replaceChildren(h("div", { class: "album-inner doc-shell" },
    h("header", { class: "doc-head" },
      h("div", { class: "album-head" },
        h("h2", { class: "cal-title" }, "PDF"),
        h("button", { class: "icon-btn", type: "button", title: "폴더 관리", "aria-label": "폴더 관리", "aria-expanded": folderPanel ? "true" : "false", onClick: () => { folderPanel = !folderPanel; fillDocs(true); } }, icon("folder")),
        h("button", { class: "icon-btn", type: "button", "aria-label": "닫기", onClick: () => animateClose(docsDialog) }, icon("x"))),
      search,
      tools),
    h("div", { class: "doc-body" }, folderChips(), h("div", { class: "doc-scroll" })),
    docSelect ? selectFoot() : null));
  paintDocList();
  const box = docsDialog.querySelector(".doc-scroll");
  if (box) box.scrollTop = scroll;
  const bar = docsDialog.querySelector(".doc-folders");
  if (bar) bar.scrollLeft = barLeft;
}

function openDocs() {
  if (docsDialog) return;
  const dialog = h("dialog", { class: "cal album docs", "aria-label": "PDF" });
  docsDialog = dialog;
  try { const v = storage.getItem(DOC_SORT_KEY); if (SORTS.some(([k]) => k === v)) docSort = v; } catch { /* default order */ }
  wireDialog(dialog);
  dialog.addEventListener("keydown", (e) => {
    const typingNow = e.target.matches?.("input, textarea, select");
    if (e.key === "/" && !typingNow) { e.preventDefault(); dialog.querySelector(".doc-search")?.focus(); }
    if (e.key === "Escape" && docSelect) { e.preventDefault(); e.stopPropagation(); docSelect = null; fillDocs(true); } // Esc leaves 선택 first, a second Esc closes
  }, true);
  dialog.addEventListener("close", () => { docsDialog = null; docSelect = null; folderPanel = false; docQuery = ""; dialog.remove(); });
  dialog.addEventListener("focusout", () => setTimeout(() => { if (docsPending) fillDocs(); }, 250));
  wireDocDrop(dialog);
  document.body.append(dialog);
  fillDocs(true);
  dialog.showModal();
  revealFolderChip();
}

/**
 * Drop PDFs anywhere on the open 문서함 (the backdrop belongs to the dialog too) to upload them into the folder being viewed.
 * Listeners sit on the dialog itself because fillDocs rebuilds everything inside it.
 */
function wireDocDrop(dialog) {
  let depth = 0; // dragenter/leave fire for every child crossed
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes("Files");
  const setDropping = (on) => dialog.classList.toggle("is-dropping", on);
  dialog.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth += 1;
    setDropping(true);
  });
  dialog.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); // without this the browser opens the PDF itself instead of dropping it here
    e.dataTransfer.dropEffect = "copy";
  });
  dialog.addEventListener("dragleave", (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) setDropping(false);
  });
  dialog.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    setDropping(false);
    const files = [...(e.dataTransfer.files ?? [])];
    if (!files.length) return;
    if (docSelect) { docSelect = null; fillDocs(true); } // leave select mode: the new files land in the plain list
    addDocs(files);
  });
}

// ---------------------------------------------------------------- 카드 영수증: 구매자 이름 + 형광 표시본
// Same marks the owner made by hand (see js/receipt.js). The result is a new PDF listed under the original.

const BUYER_KEY = "magnet-board:buyer"; // the last name typed, per device

/** Build the marked copy of `doc` for `name`; returns the new record (already uploaded and committed). */
async function makeBuyerCopy(doc, name) {
  const [bytes, lib] = await Promise.all([docBytes(doc), loadPdfLib()]);
  const pages = await pageTexts(bytes);
  const measure = textMeasurer();
  const marks = pages.map((p) => receiptMarks(p.items, measure));
  if (!marks.some((m) => m.found >= 3)) throw new Error("카드 영수증 형식이 아니에요 (카드번호·결제일자 같은 항목을 찾지 못했어요)");
  if (marks[0]?.hasBuyer) throw new Error("이 파일 첫 장에 이미 구매자 표시가 있어요 — 표시 없는 원본에서 만들어 주세요");
  const first = pages[0];
  const spot = buyerSpot(first.width, first.height);
  const pic = await textPicture(buyerText(name), { size: spot.size, color: `rgb(${BUYER.color.map((c) => c * 255).join(",")})` });
  const buyer = { png: pic.png, x: spot.x - pic.left, y: spot.baseline - pic.descent, width: pic.width, height: pic.height, text: buyerText(name) };
  const out = new Blob([await markReceipt(lib, bytes, marks.map((m) => m.quads.map(highlightBox)), buyer)], { type: "application/pdf" });
  const fileName = `${doc.name} - 구매자 ${name}`.slice(0, 80);
  const url = await uploadDocBlob(out, fileName);
  const record = { id: newId(), url, at: new Date().toISOString(), name: fileName, size: out.size, folder: doc.folder, parent: doc.id };
  if (addDoc(state, record) === state) { // only the PDF count limit refuses it (a vanished parent just makes it top-level)
    deleteDocFiles([url], { key: boardKey }).catch(() => {});
    throw new Error(`PDF 는 ${MAX_DOCS}개까지예요`);
  }
  commit((s) => addDoc(s, record));
  return { record, highlights: marks.reduce((n, m) => n + m.quads.length, 0), pages: pages.length };
}

function openBuyerDialog(id) {
  const doc = docOf(id);
  if (!doc) return;
  if (docsAll().length >= MAX_DOCS) { toast(`PDF 는 ${MAX_DOCS}개까지예요`); return; }
  let last = "";
  try { last = storage.getItem(BUYER_KEY) ?? ""; } catch { /* storage blocked */ }
  const dialog = h("dialog", { class: "cal album buyer-sheet", "aria-label": "구매자 표시본 만들기" });
  const close = () => animateClose(dialog);
  const input = h("input", { class: "contact-input", type: "text", value: last, maxlength: 20, placeholder: "구매자 이름", "aria-label": "구매자 이름", autocomplete: "name" });
  const preview = h("p", { class: "buyer-preview", "aria-hidden": "true" }, buyerText(last || "이름"));
  const go = h("button", { class: "text-btn doc-save", type: "button" }, "만들기");
  input.addEventListener("input", () => { preview.textContent = buyerText(input.value.trim() || "이름"); });
  const run = async () => {
    const name = input.value.trim();
    if (!name) { input.focus(); toast("구매자 이름을 입력하세요"); return; }
    go.disabled = true;
    input.disabled = true;
    try { storage.setItem(BUYER_KEY, name); } catch { /* remembered for this visit only */ }
    toast("구매자 표시본 만드는 중…");
    try {
      const made = await makeBuyerCopy(doc, name);
      close();
      toast(`“${made.record.name}” 을 만들었어요 (${made.pages}쪽, 형광 ${made.highlights}곳)`);
      refreshUsage();
    } catch (err) {
      toast(`만들지 못했어요 — ${err.message}`);
      go.disabled = false;
      input.disabled = false;
    }
  };
  go.addEventListener("click", run);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); run(); } });
  dialog.append(h("div", { class: "album-inner" },
    h("header", { class: "album-head" },
      h("h2", { class: "cal-title" }, "구매자 표시본"),
      h("button", { class: "icon-btn", type: "button", "aria-label": "닫기", onClick: close }, icon("x"))),
    h("p", { class: "album-note" }, `“${doc.name}” 첫 장 왼쪽 위에 빨간 구매자 이름을 넣고, 모든 장의 카드번호 끝 4자리·결제일자·상품명·판매자 정보·공급가액·부가세액에 노란 형광 표시를 해서 새 파일로 만들어요. 새 파일은 원본 아래에 보여요.`),
    input,
    preview,
    h("div", { class: "folder-actions" }, h("span", { class: "spacer" }), h("button", { class: "text-btn quiet", type: "button", onClick: close }, "취소"), go)));
  wireDialog(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  input.focus();
  input.select();
}

/** Every card-receipt page of the given PDFs, in order: [{ file, page, ...receiptFields }]. Non-receipt pages are skipped. */
async function readReceipts(docs) {
  const receipts = [];
  for (const doc of docs) {
    const pages = await pageTexts(await docBytes(doc));
    pages.forEach((p, i) => {
      const r = receiptFields(p.items);
      if (r) receipts.push({ file: doc.name, page: i + 1, ...r });
    });
  }
  return receipts;
}

/** Read the picked PDFs: which one is the 기안문 (has the 품명·단가·수량·금액 table) and which pages are card receipts. */
async function readDraftSelection(docs) {
  const sources = [];
  const pageCounts = [];
  const receipts = [];
  let draft = null;
  let draftAt = -1;
  for (const [at, doc] of docs.entries()) {
    const bytes = await docBytes(doc);
    const pages = await pageTexts(bytes);
    sources.push(bytes);
    pageCounts.push(pages.length);
    const parsed = draft ? null : parseDraft(pages.flatMap((p) => rowsOf(p.items).map((r) => r.items.map((i) => i.str))));
    if (parsed) { draft = parsed; draftAt = at; continue; }
    pages.forEach((p, i) => {
      const r = receiptFields(p.items);
      if (r) receipts.push({ file: doc.name, doc: at, page: i + 1, ...r });
    });
  }
  return { sources, pageCounts, receipts, draft, draftAt };
}

/**
 * 기안문 맞춤 병합: the picked PDFs = one 기안문 + card receipts (any number of pages / files, any names).
 * Pairs each 기안문 item with its receipts by amount, checks the sums, shows what differs, and merges
 * 기안문 → receipts in the 기안문's item order (상품 then 배송비 of each item) → anything unrecognised last.
 */
async function openDraftMergeDialog(ids) {
  const docs = ids.map(docOf).filter(Boolean);
  if (docs.length < 2) { toast("기안문 PDF 와 카드 영수증 PDF 를 함께 고르세요"); return; }
  toast("기안문과 영수증 읽는 중…");
  let read;
  try { read = await readDraftSelection(docs); } catch (err) { toast(`읽지 못했어요 — ${err.message}`); return; }
  if (!read.draft) { toast("기안문(품명·단가·수량·금액 표가 있는 문서)을 찾지 못했어요"); return; }
  if (!read.receipts.length) { toast("카드 영수증 내용을 찾지 못했어요"); return; }
  const match = matchDraft(read.draft, read.receipts);
  // page plan: every page of the 기안문, the receipts in the matched order, then every page not placed yet (in file order)
  const plan = Array.from({ length: read.pageCounts[read.draftAt] }, (_, index) => ({ src: read.draftAt, index }));
  for (const r of match.order) plan.push({ src: r.doc, index: r.page - 1 });
  const placed = new Set(plan.map((p) => `${p.src}:${p.index}`));
  let loose = 0;
  read.pageCounts.forEach((n, src) => { for (let index = 0; index < n; index += 1) if (!placed.has(`${src}:${index}`)) { plan.push({ src, index }); loose += 1; } });

  const fmt = (n) => (Number.isInteger(n) ? n.toLocaleString("ko-KR") : "—");
  const errors = match.issues.filter((i) => i.level === "error");
  const warns = match.issues.filter((i) => i.level === "warn");
  const pagesText = (g) => (g ? g.rows.slice().sort((a, b) => (a.shipping - b.shipping) || (a.doc - b.doc) || (a.page - b.page)).map((r) => r.page).join("+") : "—");
  const dialog = h("dialog", { class: "cal album audit-sheet", "aria-label": "기안문 맞춤 병합" });
  const close = () => animateClose(dialog);
  const go = h("button", { class: "text-btn doc-save", type: "button" }, match.ok ? "이 순서로 병합" : "불일치지만 병합");
  go.addEventListener("click", async () => {
    if (docsAll().length >= MAX_DOCS) { toast(`PDF 는 ${MAX_DOCS}개까지예요`); return; }
    go.disabled = true;
    toast("병합하는 중…");
    try {
      const merged = new Blob([await mergePlan(await loadPdfLib(), read.sources, plan)], { type: "application/pdf" });
      const name = `${docs[read.draftAt].name} 외 ${docs.length - 1}개 (기안문 순서)`.slice(0, 80);
      const url = await uploadDocBlob(merged, name);
      const folder = currentFolderId() || docs[read.draftAt].folder;
      const doc = { id: newId(), url, at: new Date().toISOString(), name, size: merged.size, folder };
      commit((s) => addDoc(s, doc));
      docSelect = null;
      fillDocs(true);
      close();
      toast(`“${name}” 로 합쳤어요 (${plan.length}쪽)`);
      refreshUsage();
    } catch (err) {
      toast(`병합하지 못했어요 — ${err.message}`);
      go.disabled = false;
    }
  });
  const shipDraft = read.draft.shipping?.amount ?? null;
  const shipReceipt = match.audit.items.reduce((n, g) => n + g.shipAmt, 0);
  const totalDraft = read.draft.total?.amount ?? null;
  const cell = (v, bad) => h("span", { role: "cell", class: bad ? "is-bad" : null }, v);
  dialog.append(h("div", { class: "album-inner" },
    h("header", { class: "album-head" },
      h("h2", { class: "cal-title" }, "기안문 맞춤 병합"),
      h("button", { class: "icon-btn", type: "button", "aria-label": "닫기", onClick: close }, icon("x"))),
    h("p", { class: `audit-verdict ${match.ok ? "is-ok" : "is-bad"}` }, icon(match.ok ? "check" : "x", 16), " ",
      match.ok ? `맞아요 — 기안문 품목 ${match.rows.length}개 · 영수증 ${read.receipts.length}장 · 합계 ${fmt(match.audit.total)}원` : `확인할 곳 ${errors.length}건`),
    h("div", { class: "audit-table", role: "table", "aria-label": "기안문 품목과 영수증" },
      h("div", { class: "audit-row audit-head", role: "row" }, h("span", { role: "columnheader" }, "기안문 품목"), h("span", { role: "columnheader" }, "기안문"), h("span", { role: "columnheader" }, "영수증"), h("span", { role: "columnheader" }, "쪽")),
      match.rows.map((r) => h("div", { class: `audit-row${r.status === "ok" ? "" : " is-bad"}`, role: "row" },
        h("span", { class: "audit-name", role: "cell" }, r.name, r.changed && r.prevAmount != null ? h("small", {}, `변경 전 ${fmt(r.prevAmount)}원`) : null),
        cell(fmt(r.amount), r.status !== "ok"), cell(fmt(r.receiptAmount), r.status !== "ok"), cell(pagesText(r.group), r.status !== "ok"))),
      match.extra.map((g) => h("div", { class: "audit-row is-bad", role: "row" },
        h("span", { class: "audit-name", role: "cell" }, g.product || "(상품명 없음)", h("small", {}, "기안문에 없는 영수증")), cell("—", true), cell(fmt(g.itemAmt), true), cell(pagesText(g), true))),
      shipDraft != null || shipReceipt ? h("div", { class: `audit-row${shipDraft === shipReceipt ? "" : " is-bad"}`, role: "row" },
        h("span", { class: "audit-name", role: "cell" }, "배송비"), cell(fmt(shipDraft), shipDraft !== shipReceipt), cell(fmt(shipReceipt), shipDraft !== shipReceipt), cell("", false)) : null,
      h("div", { class: "audit-row audit-sum", role: "row" },
        h("span", { role: "cell" }, "합계"), cell(fmt(totalDraft), totalDraft !== match.audit.total), cell(fmt(match.audit.total), totalDraft !== match.audit.total), cell("", false))),
    errors.length ? h("ul", { class: "audit-list is-bad" }, errors.map((i) => h("li", {}, h("b", {}, i.where), " ", i.msg))) : null,
    warns.length ? h("ul", { class: "audit-list is-warn" }, warns.map((i) => h("li", {}, h("b", {}, i.where), " ", i.msg))) : null,
    h("p", { class: "album-note" }, `병합 순서: 기안문 ${read.pageCounts[read.draftAt]}쪽 → 영수증 ${match.order.length}쪽(품목마다 상품 → 배송비)${loose ? ` → 알아보지 못한 ${loose}쪽(맨 뒤)` : ""}. 원본 PDF 는 그대로 남아요.`),
    h("div", { class: "folder-actions" }, h("span", { class: "spacer" }), h("button", { class: "text-btn quiet", type: "button", onClick: close }, "취소"), go)));
  dialog.addEventListener("close", () => dialog.remove());
  wireDialog(dialog);
  document.body.append(dialog);
  dialog.showModal();
}

/**
 * 검산: read the picked receipt PDFs, group them into 품목 (상품 + 배송비), check the arithmetic and show the result.
 * The amount box compares the receipts' total with a number the owner types (card bill, 지출결의).
 */
async function openAuditDialog(ids) {
  const picked = new Set(ids);
  const docs = ids.map(docOf).filter((d) => d && !(d.parent && picked.has(d.parent)));
  if (!docs.length) return;
  toast(docs.length > 1 ? `PDF ${docs.length}개에서 영수증 읽는 중…` : "영수증 읽는 중…");
  let receipts;
  try {
    receipts = await readReceipts(docs);
  } catch (err) {
    toast(`영수증을 읽지 못했어요 — ${err.message}`);
    return;
  }
  const dialog = h("dialog", { class: "cal album audit-sheet", "aria-label": "영수증 검산" });
  const close = () => animateClose(dialog);
  const input = h("input", { class: "contact-input", type: "text", inputmode: "numeric", placeholder: "카드 청구액·지출결의 금액 (원)", "aria-label": "비교할 금액", autocomplete: "off" });
  const body = h("div", { class: "audit-body" });
  const fmt = (n) => n.toLocaleString("ko-KR");
  const paint = () => {
    const digits = input.value.replace(/[^\d]/g, "");
    const out = auditReceipts(receipts, { expectedTotal: digits ? Number(digits) : null });
    const errors = out.issues.filter((i) => i.level === "error");
    const warns = out.issues.filter((i) => i.level === "warn");
    const verdict = out.ok
      ? `맞아요 — 영수증 ${receipts.length}장, 품목 ${out.items.length}개, 합계 ${fmt(out.total)}원${out.compare ? " (입력한 금액과 같아요)" : ""}`
      : `확인할 곳 ${errors.length}건`;
    body.replaceChildren(...[
      h("p", { class: `audit-verdict ${out.ok ? "is-ok" : "is-bad"}` }, icon(out.ok ? "check" : "x", 16), " ", verdict),
      out.items.length ? h("div", { class: "audit-table", role: "table", "aria-label": "품목" },
        h("div", { class: "audit-row audit-head", role: "row" }, h("span", { role: "columnheader" }, "품목"), h("span", { role: "columnheader" }, "상품"), h("span", { role: "columnheader" }, "배송"), h("span", { role: "columnheader" }, "합계")),
        out.items.map((it) => h("div", { class: "audit-row", role: "row" },
          h("span", { class: "audit-name", role: "cell" }, it.product || "(상품명 없음)", h("small", {}, it.seller)),
          h("span", { role: "cell" }, fmt(it.itemAmt)), h("span", { role: "cell" }, it.shipAmt ? fmt(it.shipAmt) : "—"), h("span", { role: "cell" }, fmt(it.total)))),
        h("div", { class: "audit-row audit-sum", role: "row" },
          h("span", { role: "cell" }, `합계 ${out.items.length}개`),
          h("span", { role: "cell" }, fmt(out.items.reduce((n, it) => n + it.itemAmt, 0))), h("span", { role: "cell" }, fmt(out.items.reduce((n, it) => n + it.shipAmt, 0))), h("span", { role: "cell" }, fmt(out.total)))) : null,
      out.approvals.length ? h("ul", { class: "audit-list" }, out.approvals.map((a) =>
        h("li", {}, `승인번호 ${a.approvalNo || "?"} · ${(a.date || "").slice(0, 10)} · ${a.count}장 · ${fmt(a.approved)}원 (공급 ${fmt(a.supply)} + 부가세 ${fmt(a.vat)})`))) : null,
      errors.length ? h("ul", { class: "audit-list is-bad" }, errors.map((i) => h("li", {}, h("b", {}, i.where), " ", i.msg))) : null,
      warns.length ? h("ul", { class: "audit-list is-warn" }, warns.map((i) => h("li", {}, h("b", {}, i.where), " ", i.msg))) : null,
    ].filter(Boolean));
  };
  input.addEventListener("input", paint);
  dialog.append(h("div", { class: "album-inner" },
    h("header", { class: "album-head" },
      h("h2", { class: "cal-title" }, "영수증 검산"),
      h("button", { class: "icon-btn", type: "button", "aria-label": "닫기", onClick: close }, icon("x"))),
    h("p", { class: "album-note" }, `${docs.map((d) => `“${d.name}”`).join(" · ")} — 같은 상품의 상품·배송비 영수증을 한 품목으로 묶고, 장마다 공급가액+부가세=승인금액, 부가세=승인금액÷11(내림)을 확인해요.`),
    input,
    body));
  dialog.addEventListener("close", () => dialog.remove());
  wireDialog(dialog);
  document.body.append(dialog);
  dialog.showModal();
  paint();
}

/**
 * 영수증 정리 CSV: every receipt page of the given PDFs → one CSV (요약 · 판매자별 · 상세, totals as Excel formulas).
 * A 구매자 표시본 picked together with its original is skipped (same receipts twice).
 */
async function exportReceiptCsv(ids) {
  const picked = new Set(ids);
  const docs = ids.map(docOf).filter((d) => d && !(d.parent && picked.has(d.parent)));
  if (!docs.length) return;
  toast(docs.length > 1 ? `PDF ${docs.length}개에서 영수증 읽는 중…` : "영수증 읽는 중…");
  try {
    const receipts = await readReceipts(docs);
    if (!receipts.length) throw new Error("카드 영수증 내용을 찾지 못했어요");
    const now = new Date();
    const madeAt = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}:${two(now.getMinutes())}`;
    const csv = receiptCsv(receipts, { madeAt, files: docs.map((d) => d.name) });
    saveBlob(new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" }), `${fileSafe(csvName(docs.map((d) => d.name), now).replace(/\.csv$/, ""), "영수증정리")}.csv`); // trim the name, never the extension
    const total = receipts.reduce((n, r) => n + (r.approved ?? 0), 0);
    toast(`영수증 ${receipts.length}장 정리 CSV 를 받았어요 (승인금액 ${total.toLocaleString("ko-KR")}원)`);
  } catch (err) {
    toast(`CSV 를 만들지 못했어요 — ${err.message}`);
  }
}

// ---------------------------------------------------------------- PDF page editor
// Page list on the left (drag to reorder), the chosen page big on the right (zoom in / out / fit).
// Rotate and delete act on the chosen page. Saving uploads a new file, points the record at it, then deletes the old file.
// A 구매자 stamp (made by the receipt button) always ends up on the first page: the preview draws it there live,
// and pdfops.editPdf moves the real stamp when saving.

const ZOOMS = [0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4]; // 1 = page fits the viewer's width
const DRAG_HOLD_MS = 320; // touch: press this long on a page in the list to pick it up (a quick swipe still scrolls)

function openDocEditor(id) {
  const doc = docOf(id);
  if (!doc) return;
  let plan = []; // [{ index, rotate }] in the new order
  let count = 0;
  let sel = 0; // position in plan of the page shown big
  let zoom = 1;
  const thumbs = [];
  let viewer = null;
  let stamp = null; // { text, rect } when this PDF carries a 구매자 stamp
  let bytes = null;
  let saving = false;

  const dialog = h("dialog", { class: "cal doc-editor", "aria-label": `“${doc.name}” 편집` });
  const close = () => animateClose(dialog);
  const nameInput = h("input", { class: "contact-input pe-name", type: "text", value: doc.name, maxlength: 80, "aria-label": "PDF 이름" });
  const list = h("ol", { class: "pe-list", role: "listbox", "aria-label": "페이지 — 끌어서 순서 바꾸기" });
  const canvas = h("canvas", { class: "pe-canvas", "aria-label": "선택한 페이지" });
  const view = h("div", { class: "pe-view", tabindex: "0" }, h("div", { class: "pe-sheet" }, canvas));
  const info = h("span", { class: "pe-info" }, "불러오는 중…");
  const zoomLabel = h("span", { class: "pe-zoom" }, "100%");
  const saveBtn = h("button", { class: "text-btn doc-save", type: "button", disabled: true }, "저장");
  const toolBtn = (iconName, label, run) => h("button", { class: "icon-btn", type: "button", "aria-label": label, title: label, onClick: run }, icon(iconName));
  const prevBtn = toolBtn("chevron-left", "선택한 페이지를 앞으로", () => move(sel, sel - 1));
  const nextBtn = toolBtn("chevron-right", "선택한 페이지를 뒤로", () => move(sel, sel + 1));
  const rotBtn = toolBtn("rotate", "선택한 페이지 오른쪽으로 돌리기", () => rotate());
  const delBtn = h("button", { class: "icon-btn is-delete", type: "button", "aria-label": "선택한 페이지 삭제", title: "선택한 페이지 삭제", onClick: () => remove() }, icon("trash"));
  const resetBtn = h("button", { class: "text-btn quiet", type: "button", onClick: () => { plan = Array.from({ length: count }, (_, i) => ({ index: i, rotate: 0 })); sel = 0; refresh(); } }, icon("restore", 16), "원래대로");
  const stampNote = h("p", { class: "album-note pe-note", hidden: true }, "구매자 표시는 순서를 바꿔도 항상 1쪽에 표시되고, 저장할 때 1쪽으로 옮겨져요.");

  // ---- page operations
  function move(from, to) {
    if (to < 0 || to >= plan.length || from === to) return;
    const [p] = plan.splice(from, 1);
    plan.splice(to, 0, p);
    sel = to;
    refresh();
  }
  function rotate() {
    plan[sel] = { ...plan[sel], rotate: normAngle(plan[sel].rotate + 90) };
    refresh();
  }
  function remove() {
    if (plan.length === 1) { toast("페이지가 하나는 남아 있어야 해요"); return; }
    plan.splice(sel, 1);
    sel = Math.min(sel, plan.length - 1);
    refresh();
  }
  function select(pos, focus = false) {
    sel = Math.max(0, Math.min(plan.length - 1, pos));
    drawList();
    drawView();
    if (focus) list.children[sel]?.focus();
  }

  // ---- list (left)
  function itemEl(p, pos) {
    const thumb = thumbs[p.index]
      ? h("img", { src: thumbs[p.index], alt: "", draggable: "false", style: `transform: rotate(${p.rotate}deg)` })
      : h("span", { class: "page-wait" }, String(p.index + 1));
    const li = h("li", {
      class: `pe-item${pos === sel ? " is-sel" : ""}`, role: "option", tabindex: pos === sel ? "0" : "-1",
      "aria-selected": pos === sel ? "true" : "false", "aria-label": `${pos + 1}쪽${p.index !== pos ? ` (원래 ${p.index + 1}쪽)` : ""}`,
      dataset: { pos: String(pos) },
    },
      h("div", { class: "pe-thumb" }, thumb, stamp && pos === 0 ? h("span", { class: "pe-buyer", "aria-hidden": "true" }, stamp.text) : null),
      h("span", { class: "pe-num" }, String(pos + 1), p.index !== pos ? h("small", {}, ` 원래 ${p.index + 1}`) : null));
    li.addEventListener("click", () => { if (!dragged) select(pos); });
    li.addEventListener("keydown", (e) => {
      const step = e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : 0;
      if (step) { e.preventDefault(); if (e.altKey) { move(sel, sel + step); list.children[sel]?.focus(); } else select(sel + step, true); }
      if (e.key === "Delete") { e.preventDefault(); remove(); list.children[sel]?.focus(); }
    });
    return li;
  }
  function drawList() {
    list.replaceChildren(...plan.map(itemEl));
    list.children[sel]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  // ---- drag to reorder (mouse: as soon as it moves; touch: after a short hold, so the list still scrolls)
  let drag = null; // { li, from, pointerId, startX, startY, active, timer }
  let dragged = false; // swallow the click that ends a drag
  const vertical = () => getComputedStyle(list).flexDirection.startsWith("column");
  function startDrag() {
    drag.active = true;
    drag.li.classList.add("is-dragging");
    list.classList.add("is-sorting");
    navigator.vibrate?.(10);
  }
  list.addEventListener("pointerdown", (e) => {
    const li = e.target.closest(".pe-item");
    if (!li || e.button !== 0 || plan.length < 2) return;
    drag = { li, from: Number(li.dataset.pos), pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, active: false, timer: null };
    if (e.pointerType !== "mouse") drag.timer = setTimeout(() => { if (drag) { startDrag(); li.setPointerCapture(e.pointerId); } }, DRAG_HOLD_MS);
  });
  list.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const moved = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
    if (!drag.active) {
      if (e.pointerType === "mouse" && moved > 4) { startDrag(); drag.li.setPointerCapture(e.pointerId); }
      else if (e.pointerType !== "mouse" && moved > 8) { clearTimeout(drag.timer); drag = null; } // a scroll, not a hold
      return;
    }
    e.preventDefault();
    // move the lifted item in the DOM next to the item under the pointer
    const v = vertical();
    const others = [...list.children].filter((el) => el !== drag.li);
    const before = others.find((el) => {
      const r = el.getBoundingClientRect();
      return v ? e.clientY < r.top + r.height / 2 : e.clientX < r.left + r.width / 2;
    });
    if (before) { if (drag.li.nextElementSibling !== before) list.insertBefore(drag.li, before); }
    else if (list.lastElementChild !== drag.li) list.append(drag.li);
    // keep scrolling while dragging near the edge
    const r = list.getBoundingClientRect();
    const edge = 36;
    if (v) list.scrollTop += e.clientY < r.top + edge ? -12 : e.clientY > r.bottom - edge ? 12 : 0;
    else list.scrollLeft += e.clientX < r.left + edge ? -12 : e.clientX > r.right - edge ? 12 : 0;
  });
  // touch: once a page is picked up the list must not scroll under the finger
  list.addEventListener("touchmove", (e) => { if (drag?.active) e.preventDefault(); }, { passive: false });
  const endDrag = (e) => {
    if (!drag || (e && e.pointerId !== drag.pointerId)) return;
    clearTimeout(drag.timer);
    const was = drag;
    drag = null;
    if (!was.active) return;
    list.classList.remove("is-sorting");
    const to = [...list.children].indexOf(was.li);
    dragged = true;
    setTimeout(() => { dragged = false; }, 0);
    if (to >= 0 && to !== was.from) move(was.from, to);
    else drawList();
  };
  list.addEventListener("pointerup", endDrag);
  list.addEventListener("pointercancel", endDrag);
  list.addEventListener("contextmenu", (e) => { if (drag) e.preventDefault(); }); // long-press menu on phones

  // ---- big view (right)
  function fitScale() {
    const p = plan[sel];
    const s = viewer.size(p.index);
    const sideways = p.rotate % 180 !== 0;
    const w = sideways ? s.height : s.width;
    return Math.max(0.1, (view.clientWidth - 32) / w);
  }
  function drawView() {
    if (!viewer || !plan.length) return;
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    const p = plan[sel];
    const overlay = stamp && sel === 0 ? (ctx, vp) => drawStampPreview(ctx, vp, stamp) : null;
    viewer.render(canvas, p.index, { scale: fitScale() * zoom, rotate: p.rotate, overlay }).catch(() => {});
  }
  function setZoom(next, anchor = null) {
    const z = Math.max(ZOOMS[0], Math.min(ZOOMS[ZOOMS.length - 1], next));
    if (z === zoom) return;
    // keep the point under the pointer (or the centre) in place
    const ax = anchor ? anchor.x : view.clientWidth / 2;
    const ay = anchor ? anchor.y : view.clientHeight / 2;
    const fx = (view.scrollLeft + ax) / Math.max(1, view.scrollWidth);
    const fy = (view.scrollTop + ay) / Math.max(1, view.scrollHeight);
    zoom = z;
    drawView();
    requestAnimationFrame(() => {
      view.scrollLeft = fx * view.scrollWidth - ax;
      view.scrollTop = fy * view.scrollHeight - ay;
    });
  }
  const zoomStep = (dir) => {
    const i = ZOOMS.findIndex((z) => z >= zoom - 1e-6);
    setZoom(ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (i < 0 ? ZOOMS.length - 1 : i) + dir))]);
  };
  view.addEventListener("wheel", (e) => {
    if (!e.ctrlKey && !e.metaKey) return; // plain wheel scrolls the page
    e.preventDefault();
    const r = view.getBoundingClientRect();
    setZoom(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), { x: e.clientX - r.left, y: e.clientY - r.top });
  }, { passive: false });
  view.addEventListener("keydown", (e) => {
    if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomStep(1); }
    if (e.key === "-") { e.preventDefault(); zoomStep(-1); }
    if (e.key === "0") { e.preventDefault(); setZoom(1); }
    if (e.key === "PageDown") { e.preventDefault(); select(sel + 1); }
    if (e.key === "PageUp") { e.preventDefault(); select(sel - 1); }
  });
  const resize = new ResizeObserver(() => drawView());

  function refresh() {
    drawList();
    drawView();
    const changed = count && planChanged(plan, count);
    info.textContent = count ? `${sel + 1} / ${plan.length}쪽${changed ? ` · 원래 ${count}쪽에서 바뀜` : ""}` : info.textContent;
    prevBtn.disabled = sel === 0;
    nextBtn.disabled = sel === plan.length - 1;
    delBtn.disabled = plan.length === 1;
  }

  // ---- save
  saveBtn.addEventListener("click", async () => {
    if (saving) return;
    const name = nameInput.value.trim() || doc.name;
    const pagesChanged = count && planChanged(plan, count);
    if (!pagesChanged && name === doc.name) { close(); return; }
    saving = true;
    saveBtn.disabled = true;
    try {
      if (pagesChanged) {
        toast("PDF 저장하는 중…");
        const lib = await loadPdfLib();
        const out = new Blob([await editPdf(lib, bytes, plan)], { type: "application/pdf" }); // moves a 구매자 stamp to the new page 1
        const url = await uploadDocBlob(out, name);
        const oldUrl = docOf(id)?.url;
        commit((s) => replaceDocFile(renameDoc(s, id, name), id, { url, size: out.size }));
        if (!docOf(id)) { deleteDocFiles([url], { key: boardKey }).catch(() => {}); throw new Error("그 사이에 누군가 이 PDF 를 지웠어요"); }
        if (oldUrl && oldUrl !== url) deleteDocFiles([oldUrl], { key: boardKey }).catch(() => {}); // best effort: the record already points at the new file
        refreshUsage();
      } else {
        commit((s) => renameDoc(s, id, name));
      }
      toast("PDF 를 저장했어요");
      close();
    } catch (err) {
      toast(`저장하지 못했어요 — ${err.message}`);
      saving = false;
      saveBtn.disabled = false;
    }
  });
  nameInput.addEventListener("input", () => { if (bytes) saveBtn.disabled = false; });
  nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); nameInput.blur(); } });

  dialog.append(h("div", { class: "pe" },
    h("header", { class: "pe-bar" },
      h("h2", { class: "cal-title" }, "PDF 편집"),
      nameInput,
      saveBtn,
      h("button", { class: "icon-btn", type: "button", "aria-label": "닫기", onClick: close }, icon("x"))),
    h("div", { class: "pe-tools" },
      info, prevBtn, nextBtn, rotBtn, delBtn, resetBtn,
      h("span", { class: "spacer" }),
      toolBtn("zoom-out", "축소", () => zoomStep(-1)), zoomLabel, toolBtn("zoom-in", "확대", () => zoomStep(1)),
      h("button", { class: "text-btn quiet", type: "button", title: "폭 맞춤", onClick: () => setZoom(1) }, "맞춤")),
    stampNote,
    h("div", { class: "pe-body" }, list, view)));
  wireDialog(dialog);
  dialog.addEventListener("close", () => { resize.disconnect(); viewer?.destroy(); dialog.remove(); });
  document.body.append(dialog);
  dialog.showModal();

  (async () => {
    try {
      const [raw, lib] = await Promise.all([docBytes(doc), loadPdfLib()]);
      bytes = raw;
      const split = await splitBuyerStamp(lib, bytes); // preview without the stamp; the editor draws it on page 1
      stamp = split.stamp;
      stampNote.hidden = !stamp;
      viewer = await pdfViewer(split.bytes);
      count = viewer.count;
      plan = Array.from({ length: count }, (_, i) => ({ index: i, rotate: 0 }));
      saveBtn.disabled = false;
      refresh();
      resize.observe(view);
      view.focus({ preventScroll: true });
      viewer.thumbs(132, (i, url) => {
        thumbs[i] = url;
        const pos = plan.findIndex((p) => p.index === i);
        const box = list.children[pos]?.querySelector(".pe-thumb");
        if (box) box.replaceChildren(h("img", { src: url, alt: "", draggable: "false", style: `transform: rotate(${plan[pos].rotate}deg)` }),
          stamp && pos === 0 ? h("span", { class: "pe-buyer", "aria-hidden": "true" }, stamp.text) : null);
      });
    } catch (err) {
      info.textContent = `열지 못했어요 — ${err.message}`;
    }
  })();
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

/** The lane's avatar doubles as its drag handle (arrow keys work too); the lane order is saved the moment it changes. */
function laneHandle(person) {
  const el = avatar(person.id, person.name);
  el.classList.add("lane-handle");
  el.removeAttribute("aria-hidden");
  el.setAttribute("role", "button");
  el.setAttribute("tabindex", "0");
  el.setAttribute("title", "끌어서 칸 순서 바꾸기");
  el.setAttribute("aria-label", `${person.name} 칸 — 끌거나 방향키로 순서 바꾸기`);
  el.addEventListener("pointerdown", (e) => beginLaneDrag(e, person.id));
  el.addEventListener("keydown", (e) => {
    const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const at = state.people.findIndex((p) => p.id === person.id);
    commit((s) => movePerson(s, person.id, at + step));
    document.querySelector(`.lane.${person.id} .lane-handle`)?.focus();
  });
  return el;
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

// 시민박명: a fixed line (not a task — no `.note`, so counts, drag and storage ignore it) on top of 이강현's list.
// Computed for today's date on every render, so it changes by itself each day.
const TWILIGHT_OWNER = "p4";

const TWILIGHT_KEY = "magnet-board:twilight";
let twilightDay = null; // { day, dawn, dusk } fetched for that day (kept in storage so a reload does not refetch)
let twilightAsked = "";

function twilightToday() {
  const day = todayIso();
  if (twilightDay?.day !== day) {
    try { const c = JSON.parse(storage.getItem(TWILIGHT_KEY)); if (c?.day === day) twilightDay = c; } catch { /* no cache */ }
  }
  if (twilightDay?.day === day) return twilightDay;
  if (twilightAsked !== day) { // once per day (retried after a failure on the next date roll / reload)
    twilightAsked = day;
    fetchTwilight(day).then((t) => {
      if (!t) { twilightAsked = ""; return; }
      twilightDay = { day, ...t };
      try { storage.setItem(TWILIGHT_KEY, JSON.stringify(twilightDay)); } catch { /* private mode */ }
      if (!busy()) render();
    });
  }
  return null;
}

function twilightEl() {
  const t = twilightToday() ?? twilightText(todayIso()); // computed value shows until (or if never) the fetched one arrives
  return h("div", { class: "twilight", role: "listitem", title: `${SITE.name} 기준 시민박명 (태양 고도 -6°)` },
    h("span", { class: "twilight-label" }, "시민박명"),
    h("span", { class: "twilight-time" }, t ? `${t.dawn} ~ ${t.dusk}` : "—"));
}

function dropZone(owner, layout) {
  const tasks = activeOf(state, owner);
  const zone = h("div", { class: "drop", dataset: { owner, layout }, role: "list", "aria-label": `${ownerName(owner)} 업무` });
  if (owner === TWILIGHT_OWNER) zone.append(twilightEl());
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

const DONE_VISIBLE_ROWS = 4; // a card's completed list shows this many rows, then scrolls inside the card

/** Cap each card's list at the height of its first DONE_VISIBLE_ROWS rows (rows differ in height when text wraps). */
function fitDoneLists() {
  for (const list of document.querySelectorAll("#done .done-card:not(.trash-card) .done-list")) {
    const rows = list.children;
    if (rows.length <= DONE_VISIBLE_ROWS) { list.style.removeProperty("--rows-h"); list.classList.remove("is-capped"); continue; }
    const cap = rows[DONE_VISIBLE_ROWS].getBoundingClientRect().top - rows[0].getBoundingClientRect().top + list.scrollTop;
    list.style.setProperty("--rows-h", `${Math.round(cap)}px`);
    list.classList.add("is-capped");
  }
}
window.addEventListener("resize", () => { if (view === "done") fitDoneLists(); });

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
  fitDoneLists();
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
  fillDocs(); // so does the PDF 문서함
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
        laneHandle(p),
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
  renderContacts();

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

// ---------------------------------------------------------------- 연락처 card (bottom of the board)

const CONTACT_FIELDS = [
  { key: "company", label: "업체명", type: "text", autocomplete: "organization" },
  { key: "name", label: "이름", type: "text", autocomplete: "name" },
  { key: "phone", label: "연락처", type: "tel", autocomplete: "tel", inputmode: "numeric", max: 13 },
  { key: "car", label: "차량번호", type: "text", autocomplete: "off" },
  { key: "memo", label: "직무 메모", type: "textarea", max: 200 },
];
let focusContact = false; // put the caret into the open editor right after the next render
let focusCategory = false; // put the caret into the "새 분류" box after the next render

function openContactEditor(id) {
  contactsOpen = true;
  contactEditing = id;
  focusContact = true;
  render();
}

function closeContactEditor() {
  contactEditing = null;
  render();
}

function contactEditor(contact) {
  const cats = state.categories ?? [];
  let cat = contact ? contact.cat : cats.some((c) => c.id === contactFilter) ? contactFilter : ""; // a new contact starts in the category being viewed
  const inputs = CONTACT_FIELDS.map((f) => (f.type === "textarea"
    ? h("textarea", { class: "contact-input contact-memo", rows: 2, maxlength: f.max, placeholder: f.label, "aria-label": f.label }, contact?.[f.key] ?? "")
    : h("input", {
      class: "contact-input", type: f.type, value: f.key === "phone" ? formatPhone(contact?.phone) : contact?.[f.key] ?? "", placeholder: f.key === "phone" ? "연락처 (숫자만)" : f.label,
      maxlength: f.max ?? 60, inputmode: f.inputmode, "aria-label": f.label, autocomplete: f.autocomplete, enterkeyhint: "next",
    })));
  inputs[CONTACT_FIELDS.findIndex((f) => f.key === "phone")].addEventListener("input", (e) => {
    const el = e.currentTarget;
    const digitsBeforeCaret = el.value.slice(0, el.selectionStart ?? el.value.length).replace(/\D/g, "").length;
    el.value = formatPhone(el.value);
    let caret = 0; // keep the caret after the same number of digits, hyphens added around it
    for (let seen = 0; caret < el.value.length && seen < digitsBeforeCaret; caret += 1) if (/\d/.test(el.value[caret])) seen += 1;
    el.setSelectionRange(caret, caret);
  });
  const picker = cats.length
    ? h("div", { class: "contact-cats", role: "group", "aria-label": "분류" },
      [{ id: "", name: "분류 없음" }, ...cats].map((c) => h("button", {
        class: "chip sm", type: "button", "aria-pressed": String(c.id === cat),
        onClick: (e) => {
          cat = c.id;
          for (const b of e.currentTarget.parentElement.children) b.setAttribute("aria-pressed", String(b === e.currentTarget));
        },
      }, c.name)))
    : null;
  const values = () => Object.fromEntries(CONTACT_FIELDS.map((f, i) => [f.key, inputs[i].value]));
  const submit = () => {
    const v = { ...values(), cat };
    if (!CONTACT_FIELDS.some((f) => v[f.key].trim())) { toast("한 칸은 적어 주세요"); inputs[0].focus(); return; }
    contactEditing = null;
    commit(contact ? (s) => updateContact(s, contact.id, v) : (s) => addContact(s, { id, ...v }));
    render();
  };
  const id = contact?.id ?? newId();
  for (const input of inputs) {
    input.addEventListener("keydown", (e) => {
      const memo = input.tagName === "TEXTAREA"; // 직무 메모: Enter = new line, Ctrl/Cmd+Enter = save
      if (e.key === "Enter" && (!memo || e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } // preventDefault: the same Enter must not click a button we move focus to
      else if (e.key === "Escape") { e.preventDefault(); closeContactEditor(); }
    });
  }
  const del = contact
    ? armed(h("button", { class: "text-btn danger", type: "button", "aria-label": `${contactLabel(contact)} 삭제` }, "삭제"), "정말 삭제",
      () => { contactEditing = null; commit((s) => removeContact(s, contact.id)); render(); })
    : null;
  return h("li", { class: "contact is-editing" },
    picker,
    h("div", { class: "contact-fields" }, inputs),
    h("div", { class: "contact-actions" },
      del,
      h("span", { class: "spacer" }),
      h("button", { class: "text-btn quiet", type: "button", onClick: closeContactEditor }, "취소"),
      h("button", { class: "text-btn", type: "button", onClick: submit }, "저장")));
}

const contactLabel = (c) => c.company || c.name || c.phone || c.car || c.memo;

function contactRow(contact) {
  const digits = contact.phone.replace(/[^\d+]/g, "");
  return h("li", { class: "contact" },
    h("div", { class: "contact-body" },
      contact.company ? h("p", { class: "contact-company" }, contact.company) : null,
      contact.name ? h("p", { class: "contact-name" }, contact.name) : null,
      contact.phone ? (digits
        ? h("a", { class: "contact-phone", href: `tel:${digits}` }, contact.phone)
        : h("p", { class: "contact-phone" }, contact.phone)) : null,
      contact.car ? h("p", { class: "contact-car" }, h("span", { class: "contact-tag" }, "차량"), contact.car) : null,
      contact.memo ? h("p", { class: "contact-memo-text" }, contact.memo) : null),
    h("button", { class: "tool", type: "button", "aria-label": `${contactLabel(contact)} 고치기`, onClick: () => openContactEditor(contact.id) }, icon("edit")));
}

/** 분류 편집: rename / delete each category, add a new one. Deleting keeps the contacts (they become 미분류). */
function categoryPanelEl(cats) {
  const rows = cats.map((c) => {
    const input = h("input", { class: "contact-input", type: "text", value: c.name, maxlength: 20, "aria-label": `${c.name} 분류 이름` });
    input.addEventListener("change", () => {
      if (!input.value.trim()) { input.value = c.name; return; }
      commit((s) => renameCategory(s, c.id, input.value)); // the chips follow when the panel closes
    });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); input.blur(); } });
    return h("div", { class: "cat-row" }, input,
      armed(h("button", { class: "text-btn danger", type: "button", "aria-label": `${c.name} 분류 삭제` }, "삭제"), "정말 삭제",
        () => { if (contactFilter === c.id) contactFilter = "all"; commit((s) => removeCategory(s, c.id)); render(); }));
  });
  const fresh = h("input", { class: "contact-input cat-new", type: "text", maxlength: 20, placeholder: "새 분류 이름 (예: 협력업체)", "aria-label": "새 분류 이름" });
  const add = () => {
    const name = fresh.value.trim();
    if (!name) { fresh.focus(); return; }
    if (cats.some((c) => c.name === name)) { toast("같은 이름의 분류가 있어요"); fresh.focus(); return; }
    const id = newId(); // fixed outside the op so a retried op is identical
    commit((s) => addCategory(s, { id, name }));
    focusCategory = true;
    render();
  };
  fresh.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } });
  return h("div", { class: "cat-panel" }, rows,
    h("div", { class: "cat-row" }, fresh, h("button", { class: "text-btn", type: "button", onClick: add }, "추가")),
    h("div", { class: "cat-row" }, h("span", { class: "spacer" }),
      h("button", { class: "text-btn", type: "button", onClick: () => { categoryPanel = false; render(); } }, "완료")));
}

/** Folded card: show the chips, the first group title and the FIRST ROW of contacts, clip the rest (and keep the clipped ones out of the tab order). */
function fitContactsFold() {
  const body = document.getElementById("contacts-body");
  if (!body) return;
  body.style.removeProperty("--fold-h"); // measure without the cap
  for (const el of body.querySelectorAll(".contact[inert]")) el.inert = false;
  if (!document.getElementById("contacts").classList.contains("is-folded")) return;
  const tiles = [...body.querySelectorAll(".contact")];
  if (!tiles.length) return;
  const rowTop = tiles[0].getBoundingClientRect().top;
  let bottom = 0;
  for (const el of tiles) {
    const r = el.getBoundingClientRect();
    if (Math.abs(r.top - rowTop) < 2) bottom = Math.max(bottom, r.bottom);
    else el.inert = true;
  }
  body.style.setProperty("--fold-h", `${Math.ceil(bottom - body.getBoundingClientRect().top)}px`);
}
window.addEventListener("resize", () => { if (view === "board") fitContactsFold(); });

function renderContacts() {
  const contacts = state.contacts ?? [];
  const cats = state.categories ?? [];
  if (contactFilter !== "all" && contactFilter !== "none" && !cats.some((c) => c.id === contactFilter)) contactFilter = "all"; // that category is gone
  if (contactFilter === "none" && !cats.length) contactFilter = "all";
  const adding = contactEditing === "new";
  const groups = cats.length
    ? [...cats.map((c) => ({ id: c.id, name: c.name, rows: contacts.filter((x) => x.cat === c.id) })), { id: "none", name: "미분류", rows: contacts.filter((x) => !x.cat) }]
    : [{ id: "all", name: null, rows: contacts }];
  const shown = contactFilter === "all" ? groups.filter((g) => g.rows.length || contactEditing && g.rows.some((x) => x.id === contactEditing)) : groups.filter((g) => g.id === contactFilter);
  const chip = (id, label, n) => h("button", {
    class: "chip", type: "button", "aria-pressed": String(contactFilter === id),
    onClick: () => { contactFilter = id; render(); },
  }, label, h("span", { class: "n" }, String(n)));
  const bar = cats.length
    ? h("div", { class: "contact-bar", role: "group", "aria-label": "분류" },
      chip("all", "전체", contacts.length),
      cats.map((c) => chip(c.id, c.name, contacts.filter((x) => x.cat === c.id).length)),
      contacts.some((x) => !x.cat) ? chip("none", "미분류", contacts.filter((x) => !x.cat).length) : null,
      h("button", { class: "text-btn chip-edit", type: "button", "aria-expanded": String(categoryPanel), onClick: () => { categoryPanel = !categoryPanel; focusCategory = categoryPanel; render(); } }, "분류 편집"))
    : h("div", { class: "contact-bar" },
      h("button", { class: "text-btn chip-edit", type: "button", "aria-expanded": String(categoryPanel), onClick: () => { categoryPanel = !categoryPanel; focusCategory = categoryPanel; render(); } }, "+ 분류 만들기"));
  const list = (rows) => h("ul", { class: "contact-list" }, rows.map((c) => (contactEditing === c.id ? contactEditor(c) : contactRow(c))));
  const body = shown.map((g) => h("section", { class: "contact-group" },
    g.name && (contactFilter === "all" || g.rows.length === 0) ? h("h3", { class: "contact-group-title" }, g.name, h("span", { class: "n" }, String(g.rows.length))) : null,
    g.rows.length ? list(g.rows) : h("p", { class: "hint" }, "이 분류에 연락처가 없어요.")));
  const open = contactsOpen || Boolean(contactEditing) || categoryPanel; // never fold away an open editor
  const section = document.getElementById("contacts");
  section.classList.toggle("is-folded", !open);
  const head = h("header", { class: "common-head" },
    h("h2", { id: "contacts-title" }, "연락처"),
    h("p", {}, contacts.length ? `${contacts.length}곳` : "업체명 · 이름 · 연락처 · 차량번호 · 직무 메모"),
    open ? h("button", { class: "icon-btn add", type: "button", "aria-label": "연락처 추가", onClick: (e) => { e.stopPropagation(); openContactEditor("new"); } }, icon("plus")) : null,
    h("button", { class: "icon-btn fold", type: "button", "aria-expanded": String(open), "aria-controls": "contacts-body", "aria-label": open ? "연락처 접기" : "연락처 펼치기", onClick: (e) => { e.stopPropagation(); if (open) { contactEditing = null; categoryPanel = false; } setContactsOpen(!open); } }, icon("chevron-down")));
  head.addEventListener("click", () => { if (open) { contactEditing = null; categoryPanel = false; } setContactsOpen(!open); });
  section.replaceChildren(...[ // replaceChildren turns null / arrays into text: flatten and drop empties
    head,
    h("div", { id: "contacts-body" }, ...[
    bar,
    categoryPanel ? categoryPanelEl(cats) : null,
    adding ? h("ul", { class: "contact-list new-contact" }, contactEditor(null)) : null,
    contacts.length || adding ? body : h("p", { class: "hint" }, "+ 를 눌러 업체 연락처를 적어 두세요."),
    ].flat().filter(Boolean)),
  ]);
  fitContactsFold();
  if (focusContact) {
    focusContact = false;
    document.querySelector(".contact.is-editing .contact-input")?.focus();
  } else if (focusCategory) {
    focusCategory = false;
    document.querySelector(".cat-new")?.focus();
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

/** Drag a whole lane (by its avatar) to another slot. Same ghost + placeholder idea as the cards; the order is committed on drop. */
function beginLaneDrag(e, id) {
  if (dragging || e.button > 0) return;
  const lane = e.currentTarget.closest(".lane");
  const container = lane.parentElement;
  const rect = lane.getBoundingClientRect();
  const head = lane.querySelector(".lane-head").getBoundingClientRect();
  const offX = e.clientX - head.left;
  const offY = e.clientY - head.top;
  const start = { x: e.clientX, y: e.clientY };
  const pointerId = e.pointerId;
  e.currentTarget.setPointerCapture?.(pointerId);
  e.preventDefault();

  let ghost = null;
  let placeholder = null;

  const place = (x, y) => {
    const lanes = [...container.querySelectorAll(":scope > .lane")].filter((n) => n !== lane && !n.hidden);
    const ref = lanes.find((n) => {
      const r = n.getBoundingClientRect();
      return y < r.top || (y <= r.bottom && x < r.left + r.width / 2);
    });
    if (ref) container.insertBefore(placeholder, ref);
    else container.append(placeholder);
  };

  const onMove = (ev) => {
    if (ev.pointerId !== pointerId) return;
    if (!ghost) {
      if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_THRESHOLD) return;
      dragging = true;
      document.body.classList.add("is-dragging");
      ghost = h("div", { class: `lane-ghost ${id}`, "aria-hidden": "true" }, lane.querySelector(".lane-head").cloneNode(true));
      ghost.style.width = `${head.width}px`;
      document.body.append(ghost);
      placeholder = h("div", { class: `placeholder lane-ph ${id}`, "aria-hidden": "true" });
      placeholder.style.height = `${rect.height}px`;
      lane.hidden = true;
      container.insertBefore(placeholder, lane);
    }
    ghost.style.transform = `translate(${ev.clientX - offX}px, ${ev.clientY - offY}px) scale(1.04)`;
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
    let index = state.people.findIndex((p) => p.id === id);
    if (!cancelled) {
      index = [...container.querySelectorAll(":scope > .lane, :scope > .placeholder")]
        .filter((n) => n !== lane && !n.hidden).indexOf(placeholder);
    } else {
      container.insertBefore(placeholder, lane);
    }
    const land = () => {
      ghost.remove();
      placeholder.remove();
      lane.hidden = false;
      dragging = false;
      document.body.classList.remove("is-dragging");
      if (!cancelled && JSON.stringify(movePerson(state, id, index).people) !== JSON.stringify(state.people)) {
        commit((s) => movePerson(s, id, index)); // saved (and shared) right away
        navigator.vibrate?.(12);
        return;
      }
      render(); // catch up on changes that arrived during the drag
    };
    if (reduced()) { land(); return; }
    const r = placeholder.getBoundingClientRect();
    ghost.classList.add("is-snapping");
    requestAnimationFrame(() => { ghost.style.transform = `translate(${r.left}px, ${r.top}px) scale(1)`; });
    let landed = false;
    const once = () => { if (!landed) { landed = true; land(); } };
    ghost.addEventListener("transitionend", once, { once: true });
    setTimeout(once, 450);
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
initThemeToggle(document.getElementById("themeBtn"));
document.getElementById("docBtn").prepend(icon("doc", 18));
document.getElementById("docBtn").addEventListener("click", () => openDocs());

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
  refreshUsage();
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

// A board left open overnight: when the date rolls over, refresh the date line and the 시민박명 times.
let shownDay = todayIso();
function rollDay() {
  const today = todayIso();
  if (today === shownDay) return;
  shownDay = today;
  stamp();
  if (!busy()) render();
}
setInterval(rollDay, 60 * 1000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) rollDay(); });

stamp();
render();
connect();
