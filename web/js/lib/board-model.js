// Pure board projection (no DOM) — unit tested in web/tests.
// Both views project the same task list; every task lands in exactly one column.

export const STATUSES = [
  { key: "scheduled", label: "예정" },
  { key: "in_progress", label: "진행" },
  { key: "review", label: "검토" },
  { key: "done", label: "완료" },
];
export const STATUS_LABEL = Object.fromEntries(STATUSES.map((s) => [s.key, s.label]));
export const PRIORITIES = [
  { key: "urgent", label: "긴급" },
  { key: "high", label: "높음" },
  { key: "normal", label: "보통" },
  { key: "low", label: "낮음" },
];
export const PRIORITY_LABEL = Object.fromEntries(PRIORITIES.map((p) => [p.key, p.label]));
const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };

/** Four columns for a view. members: [{slot, user_id, name, initials}] from board-summary. */
export function columnsFor(view, slots) {
  if (view === "status") {
    return STATUSES.map((s) => ({ key: s.key, label: s.label, kind: "status", status: s.key }));
  }
  return [1, 2, 3, 4].map((slot) => {
    const m = slots.find((s) => s.slot === slot) || { slot };
    return {
      key: m.user_id ? `u${m.user_id}` : `slot${slot}`,
      label: m.name || `${slot}열 비어 있음`,
      kind: "assignee",
      slot,
      userId: m.user_id || null,
      initials: m.initials || "",
    };
  });
}

export function columnKeyOf(task, view) {
  return view === "status" ? task.status : `u${task.primary_assignee_id}`;
}

export function compareTasks(a, b) {
  const pr = (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9);
  if (pr) return pr;
  if (a.due_date !== b.due_date) {
    if (!a.due_date) return 1;
    if (!b.due_date) return -1;
    return a.due_date < b.due_date ? -1 : 1;
  }
  return a.id - b.id;
}

/** Map columnKey -> sorted tasks. Tasks whose column is missing are returned in `orphans`. */
export function groupTasks(tasks, view, columns) {
  const groups = new Map(columns.map((c) => [c.key, []]));
  const orphans = [];
  for (const t of tasks) {
    const key = columnKeyOf(t, view);
    if (groups.has(key)) groups.get(key).push(t);
    else orphans.push(t);
  }
  for (const list of groups.values()) list.sort(compareTasks);
  return { groups, orphans };
}

/** The server command a drop in `column` means, or null when nothing changes. */
export function moveCommand(task, view, column) {
  if (view === "status") {
    if (column.status === task.status) return null;
    return { endpoint: "status", body: { status: column.status, version: task.version }, field: "status", value: column.status };
  }
  if (!column.userId || column.userId === task.primary_assignee_id) return null;
  return {
    endpoint: "assignee",
    body: { assignee_id: column.userId, version: task.version },
    field: "primary_assignee_id",
    value: column.userId,
  };
}

/** Whether the viewer may drop this task in this column (server re-checks). */
export function canDrop(task, view, column) {
  if (!moveCommand(task, view, column)) return false;
  return view === "status" ? Boolean(task.can_move_status) : Boolean(task.can_reassign);
}

/** Index a task would take inside a sorted column list. */
export function insertionIndex(list, task) {
  const idx = list.findIndex((t) => compareTasks(task, t) < 0);
  return idx === -1 ? list.length : idx;
}

export function applyMove(task, command) {
  return { ...task, [command.field]: command.value };
}
