// 업무 대자보: render, magnet drag, inline editing, keyboard moves, undo.
import {
  COMMON, MAX_TEXT, STORAGE_KEY, addTask, clearDone, load, moveTask, owners, parse, removeTask, renamePerson,
  restoreTask, save, tasksOf, updateTask,
} from "./store.js";

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

let state = load(storage);
let editing = null; // { owner, id|null }
let renaming = null; // person id
let dragging = false;

function commit(next, { focusMagnet = null } = {}) {
  if (next === state) return;
  state = next;
  save(storage, state);
  render();
  if (focusMagnet) document.querySelector(`.note[data-id="${focusMagnet}"] .magnet`)?.focus();
}

// ---------------------------------------------------------------- dom helpers

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
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
        onClick: () => commit(updateTask(state, task.id, { done: !task.done })) }, "✓"),
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
      commit(task ? updateTask(state, task.id, { text: value }) : addTask(state, owner, value));
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
      const next = keep ? renamePerson(state, person.id, input.value) : state;
      if (next !== state) commit(next);
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

function render() {
  const lanes = document.getElementById("lanes");
  lanes.replaceChildren(...state.people.map((p) => h("section", { class: `lane ${p.id}`, "aria-label": `${p.name}의 칸` },
    h("header", { class: "lane-head" },
      nameEl(p),
      h("span", { class: "count", "aria-label": `${tasksOf(state, p.id).length}건` }, String(tasksOf(state, p.id).length)),
      h("button", { class: "add", type: "button", "aria-label": `${p.name}에게 업무 추가`, onClick: () => startEdit(p.id, null) }, "+")),
    dropZone(p.id, "stack"))));

  const common = document.getElementById("common");
  common.replaceChildren(
    h("header", { class: "common-head" },
      h("h2", { id: "common-title" }, "공통 업무"),
      h("p", {}, "모두의 일"),
      h("span", { class: "count" }, String(tasksOf(state, COMMON).length)),
      h("button", { class: "add", type: "button", "aria-label": "공통 업무 추가", onClick: () => startEdit(COMMON, null) }, "+")),
    dropZone(COMMON, "wrap"));

  const total = state.tasks.length;
  const done = state.tasks.filter((t) => t.done).length;
  document.getElementById("tally").textContent = total ? `전체 ${total} · 완료 ${done}` : "아직 붙인 업무 없음";
  const sweep = document.getElementById("sweep");
  sweep.disabled = done === 0;
  sweep.textContent = done ? `완료 치우기 (${done})` : "완료 치우기";

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
  const { state: next, removed } = removeTask(state, task.id);
  commit(next);
  toast(`“${task.text.slice(0, 18)}” 뗐어요`, { label: "되돌리기", run: () => commit(restoreTask(state, removed)) });
}

// ---------------------------------------------------------------- keyboard moves

function keyMove(e, task) {
  const order = owners(state);
  const lane = tasksOf(state, task.owner);
  const idx = lane.findIndex((t) => t.id === task.id);
  let next = null;
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    const o = order[(order.indexOf(task.owner) + (e.key === "ArrowRight" ? 1 : order.length - 1)) % order.length];
    next = moveTask(state, task.id, o, 0);
    announce(`${ownerName(o)}에 붙였어요`);
  } else if (e.key === "ArrowUp" && idx > 0) {
    next = moveTask(state, task.id, task.owner, idx - 1);
  } else if (e.key === "ArrowDown" && idx < lane.length - 1) {
    next = moveTask(state, task.id, task.owner, idx + 1);
  }
  if (next) {
    e.preventDefault();
    commit(next, { focusMagnet: task.id });
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
          commit(moved);
          navigator.vibrate?.(12);
        }
      }
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
  const el = document.getElementById("stamp");
  el.textContent = `${d.getMonth() + 1}월 ${d.getDate()}일 ${WEEKDAYS[d.getDay()]}요일`;
}

document.getElementById("sweep").addEventListener("click", () => {
  const before = state;
  const n = state.tasks.filter((t) => t.done).length;
  commit(clearDone(state));
  toast(`완료 ${n}건을 치웠어요`, { label: "되돌리기", run: () => commit(before) });
});

// Another tab changed the board: follow it (unless the user is mid-action here).
window.addEventListener("storage", (e) => {
  if (e.key !== STORAGE_KEY || dragging || editing || renaming) return;
  state = e.newValue ? parse(e.newValue) : load(storage);
  render();
});

stamp();
render();
