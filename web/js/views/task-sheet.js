// Task detail / move / edit / create sheets — shared by board, dashboard, site.
import { api } from "../api.js";
import { fill, h, icon } from "../dom.js";
import { PRIORITIES, STATUSES, STATUS_LABEL } from "../lib/board-model.js";
import { addDays, fmtDate, fmtDateTime, localDate } from "../lib/format.js";
import { navigate } from "../router.js";
import { store } from "../store.js";
import {
  badge, checkChips, chips, describeError, dueBadge, errorState, field, loadingState, openSheet, personTag, pick,
  priorityBadge, seg, statusBadge, toast,
} from "../ui.js";

const EVENT_TEXT = {
  created: "업무 생성",
  assignee: "주 담당자 변경",
  status: "상태 변경",
  edited: "내용 수정",
  check_item: "체크리스트",
  collaborators: "협업자 변경",
};

function memberName(id) {
  return store.member(Number(id))?.name || `#${id}`;
}

function eventLine(e) {
  let detail = e.note || "";
  if (e.type === "assignee") detail = `${memberName(e.from_value)} → ${memberName(e.to_value)}`;
  if (e.type === "status") detail = `${STATUS_LABEL[e.from_value] || "—"} → ${STATUS_LABEL[e.to_value]}${e.note ? ` (${e.note})` : ""}`;
  if (e.type === "check_item") detail = `${e.from_value || ""} ${e.to_value || ""}`.trim();
  if (e.type === "collaborators") detail = (e.to_value || "").split(",").filter(Boolean).map(memberName).join(", ") || "없음";
  return h("li", null, h("div", { class: "row" }, h("div", { class: "row-main" },
    h("span", { class: "row-title" }, `${EVENT_TEXT[e.type] || e.type} · ${detail}`),
    h("span", { class: "row-sub" }, `${e.actor_name} · ${fmtDateTime(e.created_at)}`))));
}

/** Move targets for a dimension ("assignee" | "status"). */
export function moveTargets(task, dimension) {
  if (dimension === "status") {
    return STATUSES.map((s) => ({ value: s.key, label: s.label, current: task.status === s.key }));
  }
  return [1, 2, 3, 4].map((slot) => {
    const m = store.slotted().find((x) => x.board_slot === slot);
    return m
      ? { value: String(m.id), label: m.name, person: { slot, initials: m.initials, name: m.name }, current: task.primary_assignee_id === m.id }
      : { value: `empty-${slot}`, label: `${slot}열 비어 있음`, empty: true };
  });
}

function movePanel(task, dimension, onConfirm, onCancel) {
  let chosen = null;
  const allowed = dimension === "status" ? task.can_move_status : task.can_reassign;
  const targets = moveTargets(task, dimension);
  const list = pick({
    label: dimension === "status" ? "옮길 상태" : "옮길 담당자",
    options: targets.map((t) => ({
      value: t.value,
      disabled: t.current || t.empty || !allowed,
      node: [t.person ? personTag(t.person) : h("span", null, t.label),
        t.current ? h("span", { class: "pick-note" }, "현재") : null],
    })),
    onChange: (v) => { chosen = v; confirm.disabled = false; },
  });
  const confirm = h("button", { class: "btn btn-primary", type: "button", disabled: true }, "확정");
  const cancel = h("button", { class: "btn", type: "button" }, "취소");
  confirm.addEventListener("click", () => chosen && onConfirm(dimension, chosen));
  cancel.addEventListener("click", onCancel);
  const note = allowed ? null : h("p", { class: "callout" }, icon("lock"),
    dimension === "status" ? "관리자 또는 주 담당자만 상태를 바꿀 수 있습니다." : "관리자 또는 현재 주 담당자만 담당자를 바꿀 수 있습니다.");
  const panel = h("section", { class: "section card card-flat", "aria-label": "이동" },
    h("h3", null, dimension === "status" ? "어느 상태로 옮길까요?" : "누구에게 넘길까요?"),
    note, list, h("div", { class: "btn-row" }, cancel, confirm));
  return { panel, focus: () => (list.querySelector("input:not(:disabled)") || cancel).focus() };
}

/**
 * opts.view        board view, decides the default move dimension
 * opts.startMove   open straight into the move panel (keyboard "m")
 * opts.onMove(task, dimension, value) -> Promise; lets the board run its optimistic move
 * opts.onChanged(task)
 */
export async function openTaskSheet(taskId, opts = {}) {
  const sheet = openSheet({ title: "업무", body: loadingState(3) });
  let task;
  const load = async () => {
    task = await api.get(`api/tasks/${taskId}`);
    sheet.setTitle(task.title);
    renderView();
  };

  const doMove = async (dimension, value) => {
    const target = dimension === "status" ? value : Number(value);
    try {
      if (opts.onMove) {
        sheet.close();
        await opts.onMove(task, dimension, target);
        return;
      }
      const endpoint = dimension === "status" ? "status" : "assignee";
      const body = dimension === "status" ? { status: target, version: task.version } : { assignee_id: target, version: task.version };
      await api.patch(`api/tasks/${task.id}/${endpoint}`, body);
      toast("옮겼습니다.");
      opts.onChanged?.();
      await load();
    } catch (err) {
      toast(describeError(err), { tone: "error" });
      if (!opts.onMove) await load();
    }
  };

  function renderView(moveDimension = null) {
    const today = localDate();
    const done = task.status === "done";
    const assignee = store.member(task.primary_assignee_id) || { name: task.assignee_name, initials: task.assignee_initials,
      board_slot: task.assignee_slot };
    const facts = h("dl", { class: "facts" },
      h("dt", null, "현장"), h("dd", null, h("a", { href: `#/sites/${task.site_id}`, onClick: () => sheet.close() }, task.site_name)),
      h("dt", null, "주 담당자"), h("dd", null, personTag(assignee)),
      h("dt", null, "상태"), h("dd", null, statusBadge(task.status)),
      h("dt", null, "마감일"), h("dd", null, task.due_date ? [fmtDate(task.due_date), " ", dueBadge(task.due_date, today, done)] : "기한 없음"),
      h("dt", null, "우선순위"), h("dd", null, priorityBadge(task.priority)),
      task.kind !== "general" ? [h("dt", null, "종류"), h("dd", null, task.kind === "inspection" ? `점검 · ${task.asset_name || ""}` : "지적 조치")] : null,
      h("dt", null, "협업자"), h("dd", null, task.collaborators.length ? task.collaborators.map((c) => personTag({ ...c, slot: c.board_slot })) : "없음"),
    );
    const canEdit = store.has("admin", "worker");
    const moveBtn = h("button", { class: "btn", type: "button", onClick: () => openMove(opts.view === "status" ? "status" : "assignee") },
      icon("move"), "이동");
    const editBtn = canEdit ? h("button", { class: "btn", type: "button", onClick: () => renderEdit() }, "편집") : null;
    const startBtn = task.kind === "inspection" && task.asset_id && !done && canEdit
      ? h("button", { class: "btn btn-primary", type: "button", onClick: () => { sheet.close(); navigate("/inspect/start", { asset: task.asset_id, task: task.id }); } },
        icon("clipboard"), "점검 시작")
      : null;
    const findingLink = task.finding
      ? h("a", { class: "btn", href: `#/inspections/${task.finding.inspection_id}`, onClick: () => sheet.close() }, "원 점검 보기")
      : null;

    const checklist = h("ul", { class: "list" }, task.check_items.map((c) => {
      const box = h("input", { type: "checkbox", checked: Boolean(c.done), disabled: !canEdit });
      box.addEventListener("change", async () => {
        try {
          task = { ...task, ...(await api.patch(`api/tasks/${task.id}/check-items/${c.id}`, { done: box.checked })) };
          opts.onChanged?.();
        } catch (err) {
          box.checked = !box.checked;
          toast(describeError(err), { tone: "error" });
        }
      });
      return h("li", null, h("label", { class: "check row" }, box, h("span", null, c.label),
        c.done ? h("span", { class: "mute" }, `· ${c.done_by_name || ""}`) : null));
    }));
    const addInput = h("input", { class: "input input-sm", placeholder: "체크 항목 추가", maxlength: 120 });
    const addForm = canEdit ? h("form", { class: "btn-row" }, addInput, h("button", { class: "btn btn-sm", type: "submit" }, "추가")) : null;
    addForm?.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!addInput.value.trim()) return;
      try {
        task = { ...task, ...(await api.post(`api/tasks/${task.id}/check-items`, { label: addInput.value })) };
        opts.onChanged?.();
        renderView();
      } catch (err) {
        toast(describeError(err), { tone: "error" });
      }
    });

    const collabPicker = canEdit ? checkChips({
      label: "협업자",
      options: store.members.filter((m) => m.id !== task.primary_assignee_id).map((m) => ({ value: m.id, label: m.name })),
      values: task.collaborators.map((c) => c.id),
    }) : null;
    const collabSave = canEdit ? h("button", { class: "btn btn-sm", type: "button" }, "협업자 저장") : null;
    collabSave?.addEventListener("click", async () => {
      try {
        task = { ...task, ...(await api.put(`api/tasks/${task.id}/collaborators`, { user_ids: collabPicker.values().map(Number) })) };
        toast("협업자를 저장했습니다. 보드 열은 주 담당자 기준 그대로입니다.");
        renderView();
      } catch (err) {
        toast(describeError(err), { tone: "error" });
      }
    });

    const moveSlot = h("div");
    function openMove(dimension) {
      const { panel, focus } = movePanel(task, dimension, doMove, () => { fill(moveSlot); moveBtn.focus(); });
      const dimSeg = seg({ label: "이동 기준", value: dimension, options: [{ value: "assignee", label: "담당자" }, { value: "status", label: "상태" }],
        onChange: (v) => openMove(v) });
      fill(moveSlot, h("div", { class: "section" }, dimSeg, panel));
      focus();
    }

    sheet.setBody(
      h("div", { class: "btn-row" }, statusBadge(task.status), priorityBadge(task.priority), task.overdue ? badge("기한 지남", "danger", "alert") : null),
      facts,
      task.description ? h("p", { class: "dim" }, task.description) : null,
      h("div", { class: "btn-row" }, moveBtn, editBtn, startBtn, findingLink),
      moveSlot,
      h("section", { class: "section" }, h("div", { class: "section-head" }, h("h3", null, "체크리스트"),
        h("span", { class: "section-note num" }, `${task.check_done}/${task.check_total}`)),
      task.check_items.length ? checklist : h("p", { class: "mute" }, "체크 항목이 없습니다."), addForm),
      canEdit ? h("section", { class: "section" }, h("h3", null, "협업자"), h("p", { class: "field-hint" }, "협업자는 함께 보는 사람입니다. 보드 열은 주 담당자 한 명으로만 정해집니다."),
        collabPicker, h("div", null, collabSave)) : null,
      h("details", { class: "fold" }, h("summary", null, "변경 이력", h("span", { class: "section-note" }, `${task.events.length}건`)),
        h("div", { class: "fold-body" }, h("ul", { class: "list" }, task.events.map(eventLine)))),
    );
    sheet.setActions();
    if (moveDimension) openMove(moveDimension);
  }

  function renderEdit(conflictServer = null, draftValues = null) {
    const v = draftValues || { title: task.title, description: task.description, site_id: task.site_id, priority: task.priority,
      due_date: task.due_date || "" };
    const title = h("input", { class: "input", value: v.title, maxlength: 120, required: true });
    const desc = h("textarea", { class: "textarea", maxlength: 4000 }, v.description);
    let siteId = v.site_id;
    let priority = v.priority;
    const due = h("input", { class: "input", type: "date", value: v.due_date });
    const err = h("p", { class: "field-error", role: "alert", hidden: true });
    const conflictBox = conflictServer ? h("div", { class: "callout callout-warn", role: "alert" }, icon("alert"),
      h("div", null, h("strong", null, "다른 사용자가 먼저 이 업무를 바꿨습니다."),
        h("p", null, `서버: 제목 “${conflictServer.title}”, 우선순위 ${PRIORITIES.find((p) => p.key === conflictServer.priority)?.label}, 마감 ${conflictServer.due_date || "없음"}`),
        h("p", null, "아래 내 입력으로 덮어쓰거나, 서버 값을 불러와 다시 고칠 수 있습니다."))) : null;
    const save = h("button", { class: "btn btn-primary", type: "button" }, conflictServer ? "내 입력으로 덮어쓰기" : "저장");
    const useServer = conflictServer ? h("button", { class: "btn", type: "button" }, "서버 값 사용") : null;
    const cancel = h("button", { class: "btn", type: "button", onClick: () => renderView() }, "취소");
    useServer?.addEventListener("click", () => { task = { ...task, ...conflictServer }; renderEdit(); });
    save.addEventListener("click", async () => {
      const body = { version: conflictServer ? conflictServer.version : task.version, title: title.value, description: desc.value,
        site_id: siteId, priority };
      if (due.value) body.due_date = due.value; else body.clear_due_date = true;
      try {
        const updated = await api.patch(`api/tasks/${task.id}`, body);
        toast("저장했습니다.");
        opts.onChanged?.(updated);
        await load();
      } catch (e) {
        if (e.code === "version_conflict") {
          renderEdit(e.detail.server, { title: title.value, description: desc.value, site_id: siteId, priority, due_date: due.value });
          return;
        }
        err.textContent = describeError(e);
        err.hidden = false;
      }
    });
    sheet.setBody(
      conflictBox,
      field("제목", title),
      h("div", { class: "field" }, h("span", { class: "field-label" }, "현장"),
        chips({ label: "현장", value: siteId, options: store.sites.map((s) => ({ value: s.id, label: s.name })), onChange: (x) => { siteId = Number(x); } })),
      h("div", { class: "field" }, h("span", { class: "field-label" }, "우선순위"),
        seg({ label: "우선순위", value: priority, options: PRIORITIES.map((p) => ({ value: p.key, label: p.label })), onChange: (x) => { priority = x; } })),
      field("마감일", due, "비우면 기한 없음"),
      field("설명", desc),
      err,
    );
    sheet.setActions(cancel, useServer, save);
    title.focus();
  }

  try {
    await load();
    if (opts.startMove) renderView(opts.view === "status" ? "status" : "assignee");
  } catch (err) {
    sheet.setBody(errorState(err, () => load()));
  }
  return sheet;
}

export function openCreateTask({ defaults = {}, onCreated } = {}) {
  const today = localDate();
  const slotted = store.slotted();
  let siteId = defaults.site_id || store.sites[0]?.id;
  let assigneeId = defaults.primary_assignee_id || (store.user.board_slot ? store.user.id : slotted[0]?.id);
  let priority = "normal";
  let kind = "general";
  let assetId = null;
  const title = h("input", { class: "input", maxlength: 120, required: true, placeholder: "예: 3층 분전반 열화상 촬영" });
  const due = h("input", { class: "input", type: "date", value: defaults.due_date || "" });
  const checks = h("textarea", { class: "textarea", placeholder: "한 줄에 하나씩 (선택)" });
  const desc = h("textarea", { class: "textarea", maxlength: 4000 });
  const err = h("p", { class: "field-error", role: "alert", hidden: true });
  const assetSlot = h("div", { class: "field" });

  async function loadAssets() {
    if (kind !== "inspection") { fill(assetSlot); assetId = null; return; }
    fill(assetSlot, h("span", { class: "field-label" }, "설비"), loadingState(1));
    try {
      const res = await api.get("api/assets", { site_id: siteId });
      assetId = res.items[0]?.id || null;
      fill(assetSlot, h("span", { class: "field-label" }, "설비"), res.items.length
        ? chips({ label: "설비", value: assetId, options: res.items.map((a) => ({ value: a.id, label: a.name })), onChange: (x) => { assetId = Number(x); } })
        : h("p", { class: "field-hint" }, "이 현장에 등록된 설비가 없습니다. 설정 → 설비에서 먼저 등록하세요."));
    } catch (e) {
      fill(assetSlot, errorState(e, loadAssets));
    }
  }

  if (!store.sites.length) {
    openSheet({ title: "업무 추가", body: [h("div", { class: "state" }, h("h3", null, "현장이 없습니다"),
      h("p", null, "업무는 현장 단위로 묶입니다. 관리자가 설정에서 현장을 먼저 만들어야 합니다."),
      store.has("admin") ? h("a", { class: "btn btn-primary", href: "#/settings?open=sites" }, "현장 만들기") : null)] });
    return;
  }

  const sheet = openSheet({ title: "업무 추가" });
  const submit = h("button", { class: "btn btn-primary", type: "button" }, "추가");
  submit.addEventListener("click", async () => {
    if (!title.value.trim()) { err.textContent = "제목을 입력하세요."; err.hidden = false; title.focus(); return; }
    const body = {
      site_id: siteId, title: title.value.trim(), description: desc.value, primary_assignee_id: assigneeId, priority,
      due_date: due.value || null, kind, asset_id: kind === "inspection" ? assetId : null,
      check_items: checks.value.split("\n").map((s) => s.trim()).filter(Boolean),
    };
    submit.disabled = true;
    try {
      const created = await api.post("api/tasks", body);
      toast("업무를 추가했습니다.");
      sheet.close();
      onCreated?.(created);
    } catch (e) {
      err.textContent = describeError(e);
      err.hidden = false;
      submit.disabled = false;
    }
  });
  sheet.setBody(
    field("제목", title),
    h("div", { class: "field" }, h("span", { class: "field-label" }, "현장"),
      chips({ label: "현장", value: siteId, options: store.sites.map((s) => ({ value: s.id, label: s.name })),
        onChange: (x) => { siteId = Number(x); loadAssets(); } })),
    h("fieldset", null, h("legend", null, "주 담당자 (보드 열)"),
      pick({ label: "주 담당자", value: assigneeId, options: [1, 2, 3, 4].map((slot) => {
        const m = slotted.find((x) => x.board_slot === slot);
        return m ? { value: m.id, node: personTag({ slot, initials: m.initials, name: m.name }) }
          : { value: `empty-${slot}`, disabled: true, node: h("span", { class: "mute" }, `${slot}열 비어 있음`) };
      }), onChange: (x) => { assigneeId = Number(x); } })),
    h("div", { class: "field" }, h("span", { class: "field-label" }, "우선순위"),
      seg({ label: "우선순위", value: priority, options: PRIORITIES.map((p) => ({ value: p.key, label: p.label })), onChange: (x) => { priority = x; } })),
    h("div", { class: "field" }, h("span", { class: "field-label" }, "마감일"), due,
      h("div", { class: "btn-row" }, [["오늘", 0], ["내일", 1], ["일주일 뒤", 7]].map(([label, n]) =>
        h("button", { class: "btn btn-sm btn-ghost", type: "button", onClick: () => { due.value = addDays(today, n); } }, label)),
        h("button", { class: "btn btn-sm btn-ghost", type: "button", onClick: () => { due.value = ""; } }, "기한 없음"))),
    h("div", { class: "field" }, h("span", { class: "field-label" }, "종류"),
      seg({ label: "업무 종류", value: kind, options: [{ value: "general", label: "일반 업무" }, { value: "inspection", label: "설비 점검" }],
        onChange: (x) => { kind = x; loadAssets(); } })),
    assetSlot,
    field("체크리스트", checks),
    field("설명", desc),
    err,
  );
  sheet.setActions(h("button", { class: "btn", type: "button", onClick: () => sheet.close() }, "취소"), submit);
  title.focus();
}
