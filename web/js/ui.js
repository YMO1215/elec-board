// Shared UI pieces: toast, sheet (dialog), states, segmented/chip pickers,
// badges and person tags. No alert()/confirm(): notices are toasts, and
// irreversible actions use an inline confirm next to the button.
import { fill, h, icon, nextId } from "./dom.js";
import { dueLabel } from "./lib/format.js";
import { PRIORITY_LABEL, STATUS_LABEL } from "./lib/board-model.js";

const TOAST_MS = { info: 3000, error: 6000 };
const TOAST_MAX = 3;

export function toast(message, { tone = "info" } = {}) {
  const region = document.querySelector("[data-toasts]");
  if (!region) return;
  while (region.children.length >= TOAST_MAX) region.firstElementChild.remove();
  const el = h("div", { class: `toast${tone === "error" ? " toast-error" : ""}` }, message);
  region.append(el);
  setTimeout(() => el.remove(), TOAST_MS[tone] || TOAST_MS.info);
}

export function describeError(err) {
  if (!err) return "알 수 없는 오류";
  return err.message || String(err);
}

// ---------------------------------------------------------------- sheet

export function openSheet({ title, body = [], actions = [], wide = false, onClose } = {}) {
  const titleId = nextId("sheet-title");
  const heading = h("h2", { id: titleId }, title);
  const bodyEl = h("div", { class: "sheet-body" });
  const footEl = h("div", { class: "sheet-foot" });
  const closeBtn = h("button", { class: "btn btn-ghost btn-icon btn-sm", type: "button", "aria-label": "닫기" }, icon("x"));
  const dialog = h("dialog", { class: `sheet${wide ? " sheet-wide" : ""}`, "aria-labelledby": titleId },
    h("div", { class: "sheet-inner" }, h("div", { class: "sheet-head" }, heading, closeBtn), bodyEl, footEl));
  const api = {
    dialog,
    body: bodyEl,
    setTitle(text) { heading.textContent = text; },
    setBody(...nodes) { fill(bodyEl, ...nodes.flat()); },
    setActions(...nodes) { fill(footEl, ...nodes.flat()); },
    close() { if (dialog.open) dialog.close(); },
  };
  api.setBody(body);
  api.setActions(actions);
  closeBtn.addEventListener("click", () => api.close());
  dialog.addEventListener("click", (e) => { if (e.target === dialog) api.close(); });
  dialog.addEventListener("close", () => {
    dialog.remove();
    onClose?.();
  });
  document.body.append(dialog);
  dialog.showModal();
  return api;
}

// ---------------------------------------------------------------- states

export function loadingState(lines = 3) {
  return h("div", { class: "skeleton", "aria-busy": "true", "aria-label": "불러오는 중" },
    Array.from({ length: lines }, () => h("span")));
}

export function emptyState({ title, text, action } = {}) {
  return h("div", { class: "state" }, h("h3", null, title), text ? h("p", null, text) : null, action || null);
}

export function forbiddenState(message = "이 화면을 볼 권한이 없습니다.") {
  return h("div", { class: "state" }, h("h3", null, "권한 없음"), h("p", null, message),
    h("p", { class: "mute" }, "필요하면 관리자에게 역할을 요청하세요."));
}

export function errorState(err, onRetry) {
  if (err && err.status === 403) return forbiddenState(err.message);
  const retry = onRetry ? h("button", { class: "btn btn-sm", type: "button", onClick: onRetry }, "다시 시도") : null;
  return h("div", { class: "state state-error", role: "alert" },
    h("h3", null, err && err.offline ? "연결 끊김" : "불러오지 못했습니다"),
    h("p", null, describeError(err)), retry);
}

export function staleNote(fetchedAt, online) {
  const age = Date.now() - fetchedAt;
  if (online && age < 120000) return null;
  const t = new Date(fetchedAt).toTimeString().slice(0, 5);
  return h("span", { class: "stale-badge" }, online ? `오래된 데이터 · ${t} 기준` : `오프라인 · ${t} 기준 데이터`);
}

// ---------------------------------------------------------------- pickers

function radios(kind, { name, options, value, onChange, label, cls = "" }) {
  const group = name || nextId(kind);
  const wrap = h("div", { class: `${kind}${cls ? ` ${cls}` : ""}`, role: "radiogroup", "aria-label": label });
  for (const opt of options) {
    const id = nextId(group);
    const input = h("input", { type: "radio", name: group, id, value: opt.value, checked: String(opt.value) === String(value),
      disabled: opt.disabled });
    input.addEventListener("change", () => onChange?.(opt.value));
    wrap.append(input, h("label", { for: id, class: opt.cls }, opt.node || opt.label));
  }
  return wrap;
}

/** Segmented control: 2–4 options, all visible. */
export const seg = (opts) => radios("seg", opts);
/** Chips: 5–12 options, one line with horizontal scroll. */
export const chips = (opts) => radios("chips", opts);
/** Vertical pick list (move targets). */
export const pick = (opts) => radios("pick", opts);

export function checkChips({ options, values = [], label }) {
  const set = new Set(values.map(String));
  const wrap = h("div", { class: "chips wrap", role: "group", "aria-label": label });
  for (const opt of options) {
    const id = nextId("cc");
    wrap.append(h("input", { type: "checkbox", id, value: opt.value, checked: set.has(String(opt.value)) }),
      h("label", { for: id }, opt.label));
  }
  wrap.values = () => [...wrap.querySelectorAll("input:checked")].map((i) => i.value);
  return wrap;
}

export function field(label, control, hint) {
  return h("label", { class: "field" }, h("span", null, label), control, hint ? h("span", { class: "field-hint" }, hint) : null);
}

// ---------------------------------------------------------------- badges

export function badge(text, tone = "", iconName = null) {
  return h("span", { class: `badge${tone ? ` badge-${tone}` : ""}` }, iconName ? icon(iconName) : null, text);
}

const STATUS_TONE = { scheduled: "", in_progress: "accent", review: "warn", done: "ok" };
export function statusBadge(status) {
  return badge(STATUS_LABEL[status] || status, STATUS_TONE[status], status === "done" ? "check" : null);
}

export function priorityBadge(priority) {
  if (priority === "urgent") return badge("긴급", "danger", "alert");
  if (priority === "high") return badge("높음", "warn");
  return badge(PRIORITY_LABEL[priority] || priority);
}

export function dueBadge(due, today, done) {
  const d = dueLabel(due, today, done);
  return badge(d.label, d.tone === "danger" ? "danger" : d.tone === "warn" ? "warn" : "", d.tone === "danger" ? "alert" : null);
}

const INSPECTION_TONE = { draft: "", submitted: "accent", rejected: "danger", reviewed: "warn", approved: "ok" };
const INSPECTION_LABEL = { draft: "작성 중", submitted: "검토 대기", rejected: "반려", reviewed: "승인 대기", approved: "승인" };
export function inspectionBadge(status) {
  return badge(INSPECTION_LABEL[status] || status, INSPECTION_TONE[status], status === "approved" ? "check"
    : status === "rejected" ? "x" : null);
}

export function personTag(person, { showName = true } = {}) {
  const slot = person?.slot ?? person?.board_slot ?? 0;
  return h("span", { class: `who person-${slot || 0}` },
    h("span", { class: "dot", "aria-hidden": "true" }),
    h("span", { class: "initials", "aria-hidden": showName ? "true" : null }, person?.initials || "?"),
    showName ? h("span", null, person?.name || "미지정") : h("span", { class: "sr" }, person?.name || "미지정"));
}

// ---------------------------------------------------------------- inline confirm

/** Inserts "[message] [취소] [label]" right after `anchor`. Cancel comes first and gets focus. */
export function inlineConfirm(anchor, { message, confirmLabel = "진행", danger = true, onConfirm, extra = null }) {
  // Place the confirm row below the button's row, not inside a flex row of buttons.
  const host = anchor.closest(".btn-row, .row") || anchor;
  host.parentElement.querySelector(":scope > .banner-confirm")?.remove();
  const cancel = h("button", { class: "btn btn-sm", type: "button" }, "취소");
  const go = h("button", { class: `btn btn-sm ${danger ? "btn-danger" : "btn-primary"}`, type: "button" }, confirmLabel);
  const row = h("div", { class: "banner banner-warn banner-confirm", role: "group" },
    h("span", null, message), extra, h("span", { class: "btn-row" }, cancel, go));
  const close = () => { row.remove(); anchor.focus(); };
  cancel.addEventListener("click", close);
  row.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } });
  go.addEventListener("click", async () => {
    go.disabled = true;
    try {
      await onConfirm(row);
      row.remove();
    } catch (err) {
      go.disabled = false;
      toast(describeError(err), { tone: "error" });
    }
  });
  host.after(row);
  cancel.focus();
  return row;
}

export function busy(button, promiseFactory) {
  return async (...args) => {
    if (button.disabled) return;
    button.disabled = true;
    try {
      return await promiseFactory(...args);
    } finally {
      button.disabled = false;
    }
  };
}
