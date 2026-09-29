// 4-column magnet board. Two projections of the same task list:
//   assignee view — columns = the four board slots; a move changes primary_assignee_id only
//   status view   — columns = 예정/진행/검토/완료; a move changes status only
// Column counts come from the server's board summary (never recounted here).
import { api } from "../api.js";
import { fill, h, icon } from "../dom.js";
import {
  PRIORITIES, applyMove, canDrop, columnKeyOf, columnsFor, groupTasks, insertionIndex, moveCommand,
} from "../lib/board-model.js";
import { localDate, periodPreset } from "../lib/format.js";
import { setQuery } from "../router.js";
import { on, store } from "../store.js";
import {
  chips, describeError, dueBadge, emptyState, errorState, loadingState, personTag, priorityBadge, seg, staleNote,
  statusBadge, toast,
} from "../ui.js";
import { openCreateTask, openTaskSheet } from "./task-sheet.js";

const DRAG_THRESHOLD = 5;
const DUE_PRESETS = [
  { value: "all", label: "전체" },
  { value: "today", label: "오늘" },
  { value: "week", label: "이번 주" },
  { value: "month", label: "이번 달" },
];
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function filterParams(q) {
  const today = localDate();
  const range = q.due && q.due !== "all" ? periodPreset(q.due, today) : null;
  return {
    site_id: q.site || undefined,
    assignee_id: q.assignee || undefined,
    priority: q.priority || undefined,
    due_from: range?.start,
    due_to: range?.end,
  };
}

export async function renderBoard(root, { query, signal, onCleanup }) {
  const q = { view: query.view === "status" ? "status" : "assignee", site: query.site || "", assignee: query.assignee || "",
    priority: query.priority || "", due: query.due || "all" };
  let data = null; // {items, summary}
  let fetchedAt = 0;
  let dragging = null;
  let pendingMoves = 0;
  let filtersOpen = false;

  const subtitle = h("p", { class: "page-sub" });
  const banner = h("div", { class: "banner", role: "alert", hidden: true });
  const boardEl = h("div", { class: "board" });
  const filtersEl = h("div", { class: "filters" });
  const filterToggle = h("button", { class: "btn btn-sm filter-toggle", type: "button", "aria-expanded": "false" }, icon("filter"), "필터");
  const addBtn = store.has("admin", "worker")
    ? h("button", { class: "btn btn-primary", type: "button", onClick: () => openCreateTask({ defaults: { site_id: Number(q.site) || undefined }, onCreated: () => load() }) },
      icon("plus"), "업무 추가")
    : null;
  const viewSeg = seg({
    label: "보드 보기",
    value: q.view,
    cls: "seg-lg",
    options: [{ value: "assignee", label: "담당자별 보기" }, { value: "status", label: "상태별 보기" }],
    onChange: (v) => { q.view = v; setQuery({ view: v === "assignee" ? undefined : v }); renderColumns(); },
  });

  root.append(h("section", { class: "page" },
    h("header", { class: "page-head" }, h("div", null, h("h1", null, "업무 보드"), subtitle), h("div", { class: "head-actions" }, addBtn)),
    h("div", { class: "board-tools" }, h("div", { class: "board-tools-top" }, viewSeg, filterToggle), filtersEl),
    banner,
    boardEl));

  filterToggle.addEventListener("click", () => {
    filtersOpen = !filtersOpen;
    filterToggle.setAttribute("aria-expanded", String(filtersOpen));
    filtersEl.dataset.collapsed = String(!filtersOpen);
  });
  filtersEl.dataset.collapsed = "true";

  function activeFilterCount() {
    return ["site", "assignee", "priority"].filter((k) => q[k]).length + (q.due !== "all" ? 1 : 0);
  }

  function renderFilters() {
    const setFilter = (key, value) => {
      q[key] = value;
      setQuery({ [key]: value && value !== "all" ? value : undefined });
      load();
    };
    const members = store.slotted();
    fill(filtersEl, 
      h("div", { class: "filter-row" }, h("span", null, "현장"),
        chips({ label: "현장 필터", value: q.site, options: [{ value: "", label: "전체" }, ...store.sites.map((s) => ({ value: String(s.id), label: s.name }))],
          onChange: (v) => setFilter("site", v) })),
      h("div", { class: "filter-row" }, h("span", null, "담당자"),
        chips({ label: "담당자 필터", value: q.assignee, options: [{ value: "", label: "전체" },
          ...members.map((m) => ({ value: String(m.id), node: personTag({ slot: m.board_slot, initials: m.initials, name: m.name }) }))],
        onChange: (v) => setFilter("assignee", v) })),
      h("div", { class: "filter-row" }, h("span", null, "기한"),
        seg({ label: "기한 필터", value: q.due, options: DUE_PRESETS, onChange: (v) => setFilter("due", v) })),
      h("div", { class: "filter-row" }, h("span", null, "우선순위"),
        chips({ label: "우선순위 필터", value: q.priority, options: [{ value: "", label: "전체" }, ...PRIORITIES.map((p) => ({ value: p.key, label: p.label }))],
          onChange: (v) => setFilter("priority", v) })),
    );
    const n = activeFilterCount();
    fill(filterToggle, icon("filter"), n ? `필터 ${n}` : "필터");
  }

  function renderSubtitle() {
    if (!data) return;
    const s = data.summary;
    const stale = staleNote(fetchedAt, store.online);
    fill(subtitle, 
      `전체 ${s.total}건`, s.overdue ? ` · 지연 ${s.overdue}건` : "", s.filtered ? " · 필터 적용" : "",
      ` · ${new Date(fetchedAt).toTimeString().slice(0, 5)} 기준`, stale ? " · " : "", stale);
  }

  function columnCount(col) {
    const s = data.summary;
    if (col.kind === "status") return s.by_status.find((b) => b.status === col.status)?.count ?? 0;
    return s.by_assignee.find((b) => b.slot === col.slot)?.count ?? 0;
  }

  function card(task) {
    const today = localDate();
    const done = task.status === "done";
    const draggable = q.view === "status" ? task.can_move_status : task.can_reassign;
    const openBtn = h("button", { class: "magnet-open", type: "button", "aria-keyshortcuts": "M",
      "aria-label": `${task.title}. ${task.assignee_name} 담당, ${task.status_label}. 열어서 자세히 보거나 이동` }, task.title);
    const el = h("article", {
      class: `magnet person-${task.assignee_slot || 0}${task.overdue ? " is-overdue" : ""}${draggable ? " can-drag" : ""}`,
      dataset: { id: task.id },
    },
    openBtn,
    h("div", { class: "magnet-meta" }, personTag({ slot: task.assignee_slot, initials: task.assignee_initials, name: task.assignee_name }),
      h("span", null, `· ${task.site_name}`)),
    h("div", { class: "magnet-tags" }, statusBadge(task.status), task.priority === "urgent" || task.priority === "high" ? priorityBadge(task.priority) : null,
      dueBadge(task.due_date, today, done), task.kind === "inspection" ? h("span", { class: "badge" }, "점검") : null,
      task.kind === "finding" ? h("span", { class: "badge badge-warn" }, "지적 조치") : null),
    task.check_total ? h("progress", { max: task.check_total, value: task.check_done, "aria-label": `체크리스트 ${task.check_done}/${task.check_total}` }) : null);
    openBtn.addEventListener("click", (e) => {
      if (el.dataset.suppressClick) { delete el.dataset.suppressClick; e.preventDefault(); return; }
      openSheetFor(task);
    });
    openBtn.addEventListener("keydown", (e) => {
      if (e.key === "m" || e.key === "M") { e.preventDefault(); openSheetFor(task, true); }
    });
    if (draggable) el.addEventListener("pointerdown", (e) => startPointer(e, el, task));
    return el;
  }

  function openSheetFor(task, startMove = false) {
    openTaskSheet(task.id, {
      view: q.view,
      startMove,
      onMove: (t, dimension, value) => moveFromSheet(task, dimension, value),
      onChanged: () => load(),
    });
  }

  function columnsModel() {
    return columnsFor(q.view, data.summary.by_assignee);
  }

  function renderColumns() {
    if (!data) return;
    const cols = columnsModel();
    const { groups, orphans } = groupTasks(data.items, q.view, cols);
    const colEls = cols.map((col) => {
      const tasks = groups.get(col.key);
      const headLabel = col.kind === "assignee" && col.userId
        ? personTag({ slot: col.slot, initials: col.initials, name: col.label })
        : h("span", null, col.label);
      const headId = `col-${col.key}`;
      return h("section", { class: "board-col", dataset: { col: col.key }, "aria-labelledby": headId },
        h("header", { class: "col-head", id: headId }, headLabel, h("span", { class: "col-count" }, `${columnCount(col)}건`)),
        h("div", { class: "col-body", role: "list" }, tasks.length ? tasks.map((t) => {
          const c = card(t);
          c.setAttribute("role", "listitem");
          return c;
        }) : h("p", { class: "col-empty" }, col.kind === "assignee" && !col.userId ? "배치된 팀원 없음" : "비어 있음")));
    });
    const outside = data.summary.outside_board
      ? h("div", { class: "banner banner-warn", role: "status" }, `보드 열에 없는 담당자의 업무가 ${data.summary.outside_board}건 있습니다. 설정 → 팀원에서 보드 열을 배치하세요.`)
      : null;
    if (orphans.length && q.view === "assignee" && !outside) {
      console.warn("tasks without a board column", orphans.map((t) => t.id));
    }
    if (data.summary.total === 0) {
      const empty = data.summary.filtered
        ? emptyState({ title: "조건에 맞는 업무가 없습니다", text: "필터를 풀면 다른 업무가 보입니다.",
          action: h("button", { class: "btn btn-sm", type: "button", onClick: resetFilters }, "필터 초기화") })
        : emptyState({ title: "아직 업무가 없습니다", text: "업무를 추가하면 담당자 열에 자석처럼 붙습니다.", action: addBtn ? addBtn.cloneNode(true) : null });
      if (!data.summary.filtered && addBtn) empty.querySelector("button")?.addEventListener("click", () => addBtn.click());
      fill(boardEl, outside || "", empty);
      return;
    }
    fill(boardEl, ...[outside, h("div", { class: "board-cols" }, colEls)].filter(Boolean));
  }

  function resetFilters() {
    Object.assign(q, { site: "", assignee: "", priority: "", due: "all" });
    setQuery({ site: undefined, assignee: undefined, priority: undefined, due: undefined });
    renderFilters();
    load();
  }

  async function load({ quiet = false } = {}) {
    if (!quiet && !data) fill(boardEl, loadingState(4));
    try {
      data = await api.get("api/tasks/board", filterParams(q), { signal });
      fetchedAt = Date.now();
      renderSubtitle();
      renderColumns();
    } catch (err) {
      if (err.name === "AbortError") return;
      if (data) {
        renderSubtitle();
        toast(describeError(err), { tone: "error" });
      } else {
        fill(boardEl, errorState(err, () => load()));
      }
    }
  }

  async function refreshSummary() {
    const heads = boardEl.querySelectorAll(".col-head");
    heads.forEach((el) => el.setAttribute("aria-busy", "true"));
    try {
      data.summary = await api.get("api/tasks/board-summary", filterParams(q), { signal });
      fetchedAt = Date.now();
    } finally {
      renderSubtitle();
      if (!dragging) renderColumns();
    }
  }

  // ---------------------------------------------------------------- moving

  function showMoveError(task, command, err) {
    banner.hidden = false;
    const retry = h("button", { class: "btn btn-sm", type: "button" }, "재시도");
    retry.addEventListener("click", () => {
      banner.hidden = true;
      const fresh = data.items.find((t) => t.id === task.id) || task;
      commitMove(fresh, { ...command, body: { ...command.body, version: fresh.version } });
    });
    const reason = err.code === "version_conflict" ? "다른 사용자가 먼저 이 업무를 바꿨습니다. 최신 상태로 되돌렸습니다."
      : err.offline ? "연결이 끊겨 저장하지 못했습니다. 카드를 원래 자리로 되돌렸습니다." : describeError(err);
    fill(banner, icon("alert"), h("span", null, `“${task.title}” 이동 실패 — ${reason}`),
      err.code === "version_conflict" ? null : retry);
    if (err.code === "version_conflict") load({ quiet: true });
  }

  /** Optimistic move: update locally, confirm with the server, roll back on failure. */
  async function commitMove(task, command) {
    const before = data.items.find((t) => t.id === task.id);
    data.items = data.items.map((t) => (t.id === task.id ? decorate(applyMove(t, command)) : t));
    pendingMoves += 1;
    try {
      const saved = await api.patch(`api/tasks/${task.id}/${command.endpoint}`, command.body);
      data.items = data.items.map((t) => (t.id === task.id ? { ...t, ...saved } : t));
      banner.hidden = true;
      await refreshSummary();
    } catch (err) {
      data.items = data.items.map((t) => (t.id === task.id ? before : t));
      renderColumns();
      showMoveError(task, command, err);
    } finally {
      pendingMoves -= 1;
    }
  }

  function decorate(t) {
    // Local display fields for a moved card until the server copy arrives.
    const m = store.member(t.primary_assignee_id);
    return m ? { ...t, assignee_name: m.name, assignee_initials: m.initials, assignee_slot: m.board_slot } : t;
  }

  async function moveFromSheet(task, dimension, value) {
    const fresh = data.items.find((t) => t.id === task.id) || task;
    const view = dimension === "status" ? "status" : "assignee";
    const col = columnsFor(view, data.summary.by_assignee).find((c) => (view === "status" ? c.status === value : c.userId === value));
    const command = col && moveCommand(fresh, view, col);
    if (!command) return;
    renderColumnsWith(() => commitMove(fresh, command));
    requestAnimationFrame(() => boardEl.querySelector(`[data-id="${task.id}"] .magnet-open`)?.focus());
  }

  function renderColumnsWith(fn) {
    const p = fn();
    renderColumns();
    return p;
  }

  // Pointer drag (mouse / pen). Touch uses tap → 이동 → 대상 → 확정.
  function startPointer(e, el, task) {
    if (e.pointerType === "touch" || e.button !== 0 || pendingMoves) return;
    const start = { x: e.clientX, y: e.clientY };
    const rect = el.getBoundingClientRect();
    let ghost = null;
    let target = null;

    const onMove = (ev) => {
      if (!ghost) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_THRESHOLD) return;
        ghost = beginDrag();
      }
      ev.preventDefault();
      const x = ev.clientX - (start.x - rect.left);
      const y = ev.clientY - (start.y - rect.top);
      ghost.style.transform = `translate(${x}px, ${y}px) rotate(-1.5deg) scale(1.03)`;
      const col = document.elementFromPoint(ev.clientX, ev.clientY)?.closest(".board-col");
      setTarget(col);
    };

    function beginDrag() {
      const g = el.cloneNode(true);
      g.classList.add("magnet-ghost", "is-dragging");
      g.removeAttribute("role");
      g.setAttribute("aria-hidden", "true");
      g.style.width = `${rect.width}px`;
      g.style.transform = `translate(${rect.left}px, ${rect.top}px)`;
      document.body.append(g);
      document.body.classList.add("is-dragging");
      el.classList.add("is-placeholder");
      dragging = { task };
      return g;
    }

    function setTarget(colEl) {
      if (target === colEl) return;
      boardEl.querySelectorAll(".board-col").forEach((c) => c.classList.remove("is-target", "is-invalid"));
      target = colEl;
      if (!colEl) return;
      const col = columnsModel().find((c) => c.key === colEl.dataset.col);
      if (col && columnKeyOf(task, q.view) !== col.key) colEl.classList.add(canDrop(task, q.view, col) ? "is-target" : "is-invalid");
    }

    const finish = (ev, cancelled = false) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey);
      if (!ghost) return;
      el.dataset.suppressClick = "1";
      setTimeout(() => delete el.dataset.suppressClick, 0);
      const col = !cancelled && target ? columnsModel().find((c) => c.key === target.dataset.col) : null;
      setTarget(null);
      document.body.classList.remove("is-dragging");
      const g = ghost;
      if (col && canDrop(task, q.view, col)) {
        const command = moveCommand(task, q.view, col);
        dragging = null;
        const p = commitMove(task, command);
        renderColumns();
        snapTo(g, boardEl.querySelector(`[data-id="${task.id}"]`));
        return p;
      }
      dragging = null;
      snapTo(g, el, () => el.classList.remove("is-placeholder"));
      return null;
    };
    const onUp = (ev) => finish(ev);
    const onCancel = (ev) => finish(ev, true);
    const onKey = (ev) => { if (ev.key === "Escape") finish(ev, true); };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey);
  }

  /** Short magnetic snap from the drop point into the card's final slot. */
  function snapTo(ghost, destEl, done) {
    const finish = () => { ghost.remove(); destEl?.classList.remove("is-placeholder"); done?.(); };
    if (!destEl || reducedMotion()) { finish(); return; }
    destEl.classList.add("is-placeholder");
    const r = destEl.getBoundingClientRect();
    ghost.classList.remove("is-dragging");
    ghost.classList.add("is-snapping");
    requestAnimationFrame(() => { ghost.style.transform = `translate(${r.left}px, ${r.top}px)`; });
    ghost.addEventListener("transitionend", finish, { once: true });
    setTimeout(finish, 400); // safety net if transitionend never fires
  }

  // ---------------------------------------------------------------- live updates

  onCleanup(on("rev", () => { if (!dragging && !pendingMoves) load({ quiet: true }); }));
  onCleanup(on("online", () => renderSubtitle()));
  onCleanup(on("reference", () => renderFilters()));
  const tick = setInterval(renderSubtitle, 30000);
  onCleanup(() => clearInterval(tick));
  onCleanup(() => document.querySelectorAll(".magnet-ghost").forEach((g) => g.remove()));

  renderFilters();
  await load();
}
