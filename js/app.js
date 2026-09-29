// 업무 보드: render, magnet drag, inline editing, keyboard moves, undo, team sync.
import { h } from "./dom.js";
import { openCalendar } from "./calendar.js";
import {
  COMMON, MAX_TEXT, STORAGE_KEY, addTask, load, moveTask, newId, owners, parse, removeTask, renamePerson,
  restoreTask, save, tasksOf, updateTask,
} from "./store.js";
import { POLL_MS, createSync } from "./sync.js";

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
const DRAG_THRESHOLD = 3;
const TOAST_MS = 6000;
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

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
let view = location.hash === "#done" ? "done" : "board";

/** Optional board key: open the board once with `#k=<key>` and it is remembered. */
function readKey() {
  const m = location.hash.match(/(?:^#|&)k=([^&]+)/);
  if (m) {
    storage.setItem(KEY_STORAGE, decodeURIComponent(m[1]));
    history.replaceState(null, "", location.pathname + location.search);
  }
  return storage.getItem(KEY_STORAGE);
}

const sync = createSync({ key: readKey(), onChange: () => refresh(), onStatus: showStatus });

function busy() {
  return Boolean(dragging || editing || renaming);
}

function refresh() {
  if (sync.mode === "shared") {
    state = sync.view();
    save(storage, state);
  } else {
    state = local;
  }
  if (!busy()) render(); // mid-drag / mid-typing: render when the user is done
}

/** Every change is an operation (state -> state), so it can be re-applied after a conflict. */
function commit(op, { focusMagnet = null } = {}) {
  if (sync.mode === "shared") {
    sync.commit(op);
  } else {
    const next = op(local);
    if (next === local) return;
    local = next;
    save(storage, local);
    refresh();
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
  else if (detail === "not_configured") [text, tone] = ["이 기기에만 저장 (공유 저장소 미연결)", "off"];
  else [text, tone] = ["오프라인 · 이 기기에만 저장", "warn"];
  el.textContent = text;
  el.dataset.tone = tone;
}

// ---------------------------------------------------------------- dom helpers

/** Local calendar date, YYYY-MM-DD. */
function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function ownerName(owner) {
  return owner === COMMON ? "공통 업무" : state.people.find((p) => p.id === owner)?.name ?? "";
}

let toastTimer;
function toast(message, action) {
  const box = document.getElementById("toast");
  clearTimeout(toastTimer);
  box.replaceChildren(h("span", {}, message));
  if (action) {
    box.append(h("button", { type: "button", onClick: () => { action.run(); box.replaceChildren(); } }, action.label));
  }
  toastTimer = setTimeout(() => box.replaceChildren(), TOAST_MS);
}

// ---------------------------------------------------------------- render

function noteEl(task) {
  const cls = task.owner === COMMON ? "pc" : task.owner;
  const text = h("p", { class: "note-text", tabindex: "0", title: "눌러서 고치기" }, task.text);
  text.addEventListener("click", () => startEdit(task.owner, task.id));
  text.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); startEdit(task.owner, task.id); } });
  const magnet = h("button", {
    class: "magnet", type: "button",
    "aria-label": `자석: “${task.text}” 옮기기. 끌어서 붙이거나 방향키로 이동`,
  });
  magnet.addEventListener("pointerdown", (e) => beginDrag(e, task.id));
  magnet.addEventListener("keydown", (e) => keyMove(e, task));
  return h("article", { class: `note ${cls}${task.done ? " is-done" : ""}`, dataset: { id: task.id } },
    magnet,
    text,
    h("div", { class: "note-tools" },
      h("button", { class: "tool", type: "button", "aria-pressed": String(task.done), "aria-label": task.done ? "완료 취소" : "완료 표시",
        onClick: () => {
          const doneAt = task.done ? null : todayIso(); // fixed here so a retried op keeps the same date
          commit((s) => updateTask(s, task.id, { done: !task.done, doneAt }));
        } }, "✓"),
      h("button", { class: "tool", type: "button", "aria-label": "삭제", onClick: () => remove(task) }, "✕")));
}

function editorEl(owner, task) {
  const cls = owner === COMMON ? "pc" : owner;
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

function dropZone(owner, layout) {
  const tasks = tasksOf(state, owner);
  const zone = h("div", { class: "drop", dataset: { owner, layout }, role: "list", "aria-label": `${ownerName(owner)} 업무` });
  if (editing && editing.owner === owner && !editing.id) zone.append(editorEl(owner, null));
  for (const t of tasks) {
    const el = editing && editing.id === t.id ? editorEl(owner, t) : noteEl(t);
    el.setAttribute("role", "listitem");
    zone.append(el);
  }
  if (!tasks.length && !(editing && editing.owner === owner)) {
    zone.append(h("p", { class: "hint" }, owner === COMMON ? "함께 할 일을 여기로 끌어 놓으세요" : "+ 를 눌러 업무 추가"));
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

// ---------------------------------------------------------------- quick entry (common card)

const PERSON_EMOJI = { p1: "🦊", p2: "🐳", p3: "🐸", p4: "🦁" };
let quickOpen = false;
const quickInput = document.getElementById("quickInput");
const quickPeople = document.getElementById("quickPeople");

/** Add typed text to `owner`. Empty input just moves focus there. */
function quickAdd(owner) {
  const text = quickInput.value.trim();
  if (!text) {
    quickInput.focus();
    return;
  }
  const id = newId(); // fixed outside the op so a retried op keeps the same id
  commit((s) => addTask(s, owner, text, id));
  quickInput.value = "";
  quickInput.focus();
  toast(owner === COMMON ? "공통 업무에 붙였어요" : `${ownerName(owner)}에게 붙였어요`);
}

for (const p of state.people) {
  quickPeople.append(h("button", {
    class: `quick-person ${p.id}`, type: "button", dataset: { id: p.id },
    onClick: () => quickAdd(p.id),
  }, h("span", { class: "quick-emoji", "aria-hidden": "true" }, PERSON_EMOJI[p.id]), h("span", { class: "quick-name" }, p.name)));
}

/** Names can change (rename / other people's edits): update text only, never rebuild the panel. */
function syncQuickNames() {
  for (const p of state.people) {
    const btn = quickPeople.querySelector(`[data-id="${p.id}"]`);
    if (!btn) continue;
    btn.querySelector(".quick-name").textContent = p.name;
    btn.setAttribute("aria-label", `${p.name}에게 붙이기`);
  }
}

function toggleQuick() {
  quickOpen = !quickOpen;
  document.getElementById("quick").hidden = !quickOpen;
  const btn = document.querySelector(".expand");
  btn.setAttribute("aria-expanded", String(quickOpen));
  btn.firstElementChild.textContent = quickOpen ? "접기" : "펼치기";
  if (quickOpen) quickInput.focus();
}

quickInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.isComposing) {
    e.preventDefault();
    quickAdd(COMMON);
  }
  if (e.key === "Escape") {
    e.preventDefault();
    toggleQuick();
    document.querySelector(".expand")?.focus();
  }
});

function renderDone() {
  const doneTasks = state.tasks.filter((t) => t.done);
  const section = document.getElementById("done");
  const cards = [...state.people.map((p) => ({ id: p.id, cls: p.id, name: p.name })), { id: COMMON, cls: "pc", name: "공통 업무" }]
    .map((o) => {
      // Most recently completed first; tasks finished before dates were recorded go last.
      const rows = doneTasks.filter((t) => t.owner === o.id)
        .sort((a, b) => (b.doneAt ?? "").localeCompare(a.doneAt ?? ""));
      return h("article", { class: `done-card ${o.cls}`, "aria-label": `${o.name} 완료 목록` },
        h("header", { class: "done-card-head" }, h("h3", {}, o.name), h("span", { class: "count" }, String(rows.length))),
        rows.length ? h("ul", { class: "done-list" }, rows.map((t) => h("li", { class: "done-row" },
          h("span", { class: "done-mark", "aria-hidden": "true" }, "✓"),
          h("div", { class: "done-body" },
            h("p", { class: "done-text" }, t.text),
            h("p", { class: "done-date" }, t.doneAt ? `${Number(t.doneAt.slice(5, 7))}월 ${Number(t.doneAt.slice(8))}일 완료` : "완료")),
          h("div", { class: "done-actions" },
            h("button", { class: "text-btn", type: "button", "aria-label": `“${t.text}” 진행 중으로 되돌리기`,
              onClick: () => commit((s) => updateTask(s, t.id, { done: false, doneAt: null })) }, "되돌리기"),
            h("button", { class: "tool", type: "button", "aria-label": `“${t.text}” 삭제`, onClick: () => remove(t) }, "✕")))))
          : h("p", { class: "done-empty" }, "완료한 일이 없어요"));
    });
  section.replaceChildren(
    h("header", { class: "done-head" }, h("h2", { id: "done-title" }, "완료한 일"), h("p", {}, `전체 ${doneTasks.length}건`)),
    ...cards);
}

function render() {
  if (!busy()) state = sync.mode === "shared" ? sync.view() : local;
  const total = state.tasks.length;
  const done = state.tasks.filter((t) => t.done).length;
  document.getElementById("tally").textContent = total ? `전체 ${total} · 완료 ${done}` : "아직 붙인 업무 없음";
  const doneBtn = document.getElementById("doneBtn");
  doneBtn.textContent = view === "done" ? "보드로" : done ? `완료 보기 (${done})` : "완료 보기";
  doneBtn.setAttribute("aria-pressed", String(view === "done"));
  document.getElementById("board").hidden = view === "done";
  document.getElementById("done").hidden = view !== "done";
  if (view === "done") {
    renderDone();
    return;
  }
  const lanes = document.getElementById("lanes");
  lanes.replaceChildren(...state.people.map((p) => h("section", { class: `lane ${p.id}`, "aria-label": `${p.name}의 칸` },
    h("header", { class: "lane-head" },
      nameEl(p),
      h("span", { class: "count", "aria-label": `${tasksOf(state, p.id).length}건` }, String(tasksOf(state, p.id).length)),
      h("button", { class: "add", type: "button", "aria-label": `${p.name}에게 업무 추가`, onClick: () => startEdit(p.id, null) }, "+")),
    dropZone(p.id, "stack"))));

  document.getElementById("common-head").replaceChildren(
    h("header", { class: "common-head" },
      h("h2", { id: "common-title" }, "공통 업무"),
      h("p", {}, "모두의 일"),
      h("span", { class: "count" }, String(tasksOf(state, COMMON).length)),
      h("button", { class: "add", type: "button", "aria-label": "공통 업무 추가", onClick: () => startEdit(COMMON, null) }, "+"),
      h("button", { class: "expand", type: "button", "aria-expanded": String(quickOpen), "aria-controls": "quick", onClick: toggleQuick },
        h("span", {}, quickOpen ? "접기" : "펼치기"))));
  document.getElementById("common-drop").replaceChildren(dropZone(COMMON, "wrap"));
  syncQuickNames();

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
}

function startEdit(owner, id) {
  editing = { owner, id };
  render();
}

function remove(task) {
  const { removed } = removeTask(state, task.id);
  if (!removed) return;
  commit((s) => removeTask(s, task.id).state);
  toast(`“${task.text.slice(0, 18)}” 뗐어요`, { label: "되돌리기", run: () => commit((s) => restoreTask(s, removed)) });
}

// ---------------------------------------------------------------- keyboard moves

function keyMove(e, task) {
  const order = owners(state);
  const lane = tasksOf(state, task.owner);
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
  }
}

function announce(text) {
  document.getElementById("tally").setAttribute("aria-label", text);
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
    ghost.style.transform = `translate(${ev.clientX - offX}px, ${ev.clientY - offY}px) scale(1.03)`;
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
          navigator.vibrate?.(12);
          return;
        }
      }
      render(); // catch up on changes that arrived during the drag
    };
    if (reducedMotion()) { land(); return; }
    const r = placeholder.getBoundingClientRect();
    ghost.classList.add("is-snapping");
    requestAnimationFrame(() => { ghost.style.transform = `translate(${r.left}px, ${r.top}px) scale(1)`; });
    let landed = false;
    const once = () => { if (!landed) { landed = true; land(); } };
    ghost.addEventListener("transitionend", once, { once: true });
    setTimeout(once, 320);
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
  document.getElementById("stamp").textContent = `${d.getMonth() + 1}월 ${d.getDate()}일 ${WEEKDAYS[d.getDay()]}요일`;
}

document.getElementById("stamp").addEventListener("click", () => openCalendar({ people: state.people, today: todayIso() }));

// Board <-> completed list. The list has its own history entry (#done) so Back returns to the board.
function setView(next, { push = true } = {}) {
  if (next === view) return;
  view = next;
  editing = null;
  renaming = null;
  if (push) history.pushState(null, "", next === "done" ? "#done" : location.pathname + location.search);
  render();
  window.scrollTo(0, 0);
}
document.getElementById("doneBtn").addEventListener("click", () => setView(view === "done" ? "board" : "done"));
window.addEventListener("popstate", () => setView(location.hash === "#done" ? "done" : "board", { push: false }));

// Local-only mode: another tab of this browser changed the board.
window.addEventListener("storage", (e) => {
  if (e.key !== STORAGE_KEY || sync.mode === "shared" || busy()) return;
  local = e.newValue ? parse(e.newValue) : load(storage);
  refresh();
});

async function connect() {
  showStatus({ mode: "connecting", pending: 0 });
  const shared = await sync.start(local);
  if (!shared) return;
  setInterval(() => { if (!document.hidden && !busy()) sync.poll(); }, POLL_MS);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) sync.poll(); });
  window.addEventListener("online", () => { sync.flush(); sync.poll(); });
  window.addEventListener("focus", () => sync.poll());
}

stamp();
render();
connect();
