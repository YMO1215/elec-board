// 현장 상세: members, record retention and six tabs (업무·설비·점검·지적·보고서·이력).
// One overview + tasks + events load feeds every tab; site attachments load with 이력.
import { api } from "../api.js";
import { fill, h, icon, nextId } from "../dom.js";
import { STATUSES, STATUS_LABEL } from "../lib/board-model.js";
import { daysBetween, fileSize, fmtDateTime, localDate } from "../lib/format.js";
import { setQuery } from "../router.js";
import { on, store } from "../store.js";
import {
  badge, describeError, dueBadge, emptyState, errorState, inspectionBadge, loadingState, personTag, statusBadge, toast,
} from "../ui.js";
import { openCreateTask, openTaskSheet } from "./task-sheet.js";

const TABS = [
  { key: "tasks", label: "업무" },
  { key: "assets", label: "설비" },
  { key: "inspections", label: "점검" },
  { key: "findings", label: "지적" },
  { key: "reports", label: "보고서" },
  { key: "history", label: "이력" },
];
const DEFAULT_TAB = "tasks";
const RETENTION_WARN_DAYS = 90;
const LIMITS = { inspections: 100, findings: 200, events: 100 }; // server-side list caps
const REPORT_STATUS = {
  pending: ["승인 대기", "accent", null],
  approved: ["승인", "ok", "check"],
  rejected: ["반려", "danger", "x"],
};
const EVENT_TEXT = {
  created: "업무 생성",
  assignee: "주 담당자 변경",
  status: "상태 변경",
  edited: "내용 수정",
  check_item: "체크리스트",
  collaborators: "협업자 변경",
};
const EDIT_FIELD_LABEL = { title: "제목", description: "설명", site_id: "현장", priority: "우선순위", due_date: "마감일", asset_id: "설비" };

/** Korea-local calendar date of a UTC timestamp. */
function kstDate(ts) {
  return ts ? fmtDateTime(ts).slice(0, 10) : null;
}

function memberName(id) {
  return store.member(Number(id))?.name || `팀원 #${id}`;
}

function statusName(key) {
  return STATUS_LABEL[key] || key || "—";
}

function eventDetail(e) {
  const withNote = (text) => (e.note ? `${text} (${e.note})` : text);
  switch (e.type) {
    case "created": return `상태 ${statusName(e.to_value)}`;
    case "status": return withNote(`${statusName(e.from_value)} → ${statusName(e.to_value)}`);
    case "assignee": return withNote(`${memberName(e.from_value)} → ${memberName(e.to_value)}`);
    case "edited": return (e.note || "").split(",").map((k) => k.trim()).filter(Boolean).map((k) => EDIT_FIELD_LABEL[k] || k).join(", ");
    case "check_item": return [e.from_value, e.to_value, e.note].filter(Boolean).join(" ");
    case "collaborators": return (e.to_value || "").split(",").filter(Boolean).map(memberName).join(", ") || "없음";
    default: return withNote([e.from_value, e.to_value].filter(Boolean).join(" → "));
  }
}

function reportBadge(status) {
  const [label, tone, ic] = REPORT_STATUS[status] || [status, "", null];
  return badge(label, tone, ic);
}

function note(text) {
  return h("p", { class: "section-note" }, text);
}

function capNote(n, limit) {
  return n >= limit ? ` · 최근 ${limit}건만 표시` : "";
}

function subHead(title, count) {
  return h("div", { class: "section-head" }, h("h2", null, title), h("span", { class: "section-note num" }, `${count}건`));
}

function fold(title, count, list) {
  return h("details", { class: "fold" }, h("summary", null, title, h("span", { class: "section-note num" }, `${count}건`)),
    h("div", { class: "fold-body" }, list));
}

function expiryLine(retention) {
  if (!retention.oldest_expires_on) return null;
  const label = "가장 오래된 기록 보관 만료 예정일";
  const left = daysBetween(localDate(), retention.oldest_expires_on);
  if (left > RETENTION_WARN_DAYS) return h("p", null, `${label} ${retention.oldest_expires_on}`);
  const when = left < 0 ? `${-left}일 지남` : left === 0 ? "오늘" : `${left}일 남음`;
  return h("p", { class: "btn-row" }, h("span", null, label), badge(`${retention.oldest_expires_on} · ${when}`, "warn", "alert"));
}

export async function renderSite(root, { params, query, signal, onCleanup }) {
  const siteId = Number(params.id);
  const uid = nextId("site");
  const panelId = `${uid}-panel`;
  const tabId = (key) => `${uid}-tab-${key}`;
  let tab = TABS.some((t) => t.key === query.tab) ? query.tab : DEFAULT_TAB;
  let data = null; // {overview: {site, assets, inspections, findings}, tasks: {items, summary}, events}
  let attachmentSeq = 0;
  const canWork = store.has("admin", "worker");
  const reload = () => load({ quiet: true });

  const title = h("h1", null, store.site(siteId)?.name || "현장");
  const sub = h("p", { class: "page-sub btn-row" });
  const boardLink = h("a", { class: "btn", href: `#/board?site=${siteId}` }, icon("board"), "보드에서 보기");
  const headActions = h("div", { class: "head-actions" }, boardLink);
  const body = h("div", { class: "page" }, loadingState(4));
  const intro = h("div", { class: "section" });
  const tabBar = h("div", { class: "tabs", role: "tablist", "aria-label": "현장 정보" });
  const panel = h("div", { class: "section", role: "tabpanel", id: panelId, tabindex: "0" });
  const tabButtons = new Map();
  const tabCounts = new Map();
  for (const t of TABS) {
    const count = h("span", { class: "num" });
    const b = h("button", { type: "button", role: "tab", id: tabId(t.key), "aria-controls": panelId }, t.label, count);
    b.addEventListener("click", () => select(t.key));
    tabButtons.set(t.key, b);
    tabCounts.set(t.key, count);
    tabBar.append(b);
  }
  tabBar.addEventListener("keydown", onTabKey);

  root.append(h("section", { class: "page" },
    h("header", { class: "page-head" }, h("div", null, title, sub), headActions),
    body));

  // ---------------------------------------------------------------- tabs

  function syncTabs() {
    for (const [key, b] of tabButtons) {
      const selected = key === tab;
      b.setAttribute("aria-selected", String(selected));
      b.tabIndex = selected ? 0 : -1;
    }
    panel.setAttribute("aria-labelledby", tabId(tab));
  }

  function onTabKey(e) {
    if (!e.target.closest?.('[role="tab"]')) return;
    const i = TABS.findIndex((t) => t.key === tab);
    const moves = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 };
    if (!(e.key in moves)) return;
    e.preventDefault();
    const next = TABS[(moves[e.key] + TABS.length) % TABS.length].key;
    select(next);
    tabButtons.get(next).focus();
  }

  function select(key) {
    if (key === tab) return;
    tab = key;
    setQuery({ tab: key === DEFAULT_TAB ? undefined : key });
    syncTabs();
    renderPanel();
  }

  function updateCounts() {
    const o = data.overview;
    const counts = {
      tasks: data.tasks.summary.total,
      assets: o.assets.length,
      inspections: o.inspections.length,
      findings: o.findings.length,
      reports: o.inspections.filter((i) => i.report_id).length,
    };
    for (const [key, el] of tabCounts) el.textContent = key in counts ? ` ${counts[key]}` : "";
  }

  // ---------------------------------------------------------------- 업무

  function taskRow(t, today) {
    return h("li", null, h("button", { class: "row", type: "button", onClick: () => openTaskSheet(t.id, { onChanged: reload }) },
      personTag({ slot: t.assignee_slot, initials: t.assignee_initials, name: t.assignee_name }, { showName: false }),
      h("div", { class: "row-main" }, h("span", { class: "row-title" }, t.title),
        h("span", { class: "row-sub" }, [t.assignee_name, t.asset_name, t.kind === "finding" ? "지적 조치" : t.kind === "inspection" ? "점검" : null]
          .filter(Boolean).join(" · "))),
      h("div", { class: "row-side" }, statusBadge(t.status), dueBadge(t.due_date, today, t.status === "done"))));
  }

  function tasksPanel() {
    const { items, summary } = data.tasks;
    const today = localDate();
    const addBtn = canWork
      ? h("button", { class: "btn btn-sm", type: "button", onClick: () => openCreateTask({ defaults: { site_id: siteId }, onCreated: reload }) },
        icon("plus"), "업무 추가")
      : null;
    if (!items.length) {
      return emptyState({
        title: "이 현장에 업무가 없습니다",
        text: canWork ? "업무를 추가하면 보드의 담당자 열에도 함께 붙습니다." : "팀원이 업무를 추가하면 여기에 모입니다.",
        action: addBtn,
      });
    }
    const boardHref = `#/board?site=${siteId}&view=status`;
    const stats = h("div", { class: "stat-row" },
      STATUSES.map((s) => h("a", { class: "stat", href: boardHref }, h("span", { class: "stat-label" }, s.label),
        h("span", { class: "stat-value num" }, String(summary.by_status.find((b) => b.status === s.key)?.count ?? 0)),
        h("span", { class: "stat-note" }, "건"))),
      h("a", { class: `stat${summary.overdue ? " is-alert" : ""}`, href: `#/board?site=${siteId}` }, h("span", { class: "stat-label" }, "지연"),
        h("span", { class: "stat-value num" }, String(summary.overdue)), h("span", { class: "stat-note" }, "기한 지난 미완료")));
    const groups = STATUSES.map((s) => ({ ...s, tasks: items.filter((t) => t.status === s.key) })).filter((g) => g.tasks.length);
    return [
      h("div", { class: "section-head" }, h("span", { class: "section-note" }, `전체 ${summary.total}건 · 보드와 같은 집계`), addBtn),
      stats,
      groups.map((g) => {
        const list = h("ul", { class: "list" }, g.tasks.map((t) => taskRow(t, today)));
        return g.key === "done" ? fold(g.label, g.tasks.length, list)
          : h("section", { class: "section" }, subHead(g.label, g.tasks.length), list);
      }),
    ];
  }

  // ---------------------------------------------------------------- 설비

  function assetRow(a, today) {
    const life = a.life || { state: "unknown", label: "내용연수 정보 없음" };
    const lifeWarn = life.state === "expired" || life.state === "soon";
    const last = kstDate(a.last_inspected_at);
    const overdueDays = a.next_due_on ? daysBetween(a.next_due_on, today) : null;
    let start = null;
    if (canWork) {
      start = a.template_id
        ? h("a", { class: "btn btn-sm", href: `#/inspect/start?asset=${a.id}` }, icon("clipboard"), "점검 시작")
        : badge("점검 서식 없음");
    }
    return h("li", null, h("div", { class: "row" },
      h("div", { class: "row-main" },
        h("span", { class: "row-title" }, a.name),
        h("span", { class: "row-sub" }, [a.asset_type, a.location].filter(Boolean).join(" · ")),
        h("span", { class: "row-sub" }, `최근 점검 ${last || "기록 없음"} · 다음 점검 ${a.next_due_on || "주기 미설정"}`),
        lifeWarn ? null : h("span", { class: "row-sub" }, life.label)),
      h("div", { class: "row-side" },
        lifeWarn ? badge(life.label, "warn", "alert") : null,
        overdueDays > 0 ? badge(`점검 ${overdueDays}일 지남`, "danger", "alert") : overdueDays === 0 ? badge("오늘 점검", "warn") : null,
        start)));
  }

  function assetsPanel() {
    const assets = data.overview.assets;
    if (!assets.length) {
      return emptyState({
        title: "등록된 설비가 없습니다",
        text: store.has("admin") ? "설정 → 설비에서 이 현장의 설비를 등록하세요." : "관리자가 설비를 등록하면 여기에 보입니다.",
      });
    }
    const today = localDate();
    const overdue = assets.filter((a) => a.next_due_on && a.next_due_on < today).length;
    const life = assets.filter((a) => a.life?.state === "expired" || a.life?.state === "soon").length;
    return [
      note(`${assets.length}대${overdue ? ` · 점검 기한 지난 설비 ${overdue}대` : ""}${life ? ` · 내용연수 경과·임박 ${life}대` : ""}`),
      h("ul", { class: "list" }, assets.map((a) => assetRow(a, today))),
    ];
  }

  // ---------------------------------------------------------------- 점검

  function inspectionsPanel() {
    const list = data.overview.inspections;
    if (!list.length) {
      return emptyState({
        title: "점검 기록이 없습니다",
        text: canWork ? "설비 탭에서 ‘점검 시작’을 누르면 첫 기록이 생깁니다." : "팀원이 점검을 제출하면 여기에 모입니다.",
      });
    }
    return [
      note(`${list.length}건${capNote(list.length, LIMITS.inspections)}`),
      h("ul", { class: "list" }, list.map((i) => h("li", null, h("a", { class: "row", href: `#/inspections/${i.id}` },
        h("div", { class: "row-main" },
          h("span", { class: "row-title" }, [i.asset_name, i.asset_location].filter(Boolean).join(" · ")),
          h("span", { class: "row-sub" }, `${i.inspector_name} · ${i.submitted_at ? `제출 ${fmtDateTime(i.submitted_at)}` : `작성 중 · ${fmtDateTime(i.updated_at)}`}`)),
        h("div", { class: "row-side" },
          i.bad_count ? badge(`불량 ${i.bad_count}`, "warn", "alert") : null,
          i.corrects_id ? badge("정정본") : null,
          inspectionBadge(i.status)))))),
    ];
  }

  // ---------------------------------------------------------------- 지적

  function findingRow(f, today) {
    const resolved = f.status === "resolved";
    return h("li", null, h("a", { class: "row", href: `#/inspections/${f.inspection_id}` },
      personTag({ slot: f.assignee_slot, initials: f.assignee_initials, name: f.assignee_name }, { showName: false }),
      h("div", { class: "row-main" },
        h("span", { class: "row-title" }, `${f.asset_name} · ${f.item_label || f.item_key}`),
        h("span", { class: "row-sub" }, f.description),
        h("span", { class: "row-sub" }, `담당 ${f.assignee_name} · 조치 기한 ${f.due_date || "없음"}`)),
      h("div", { class: "row-side" },
        resolved ? badge("조치 완료", "ok", "check") : badge("미조치", "warn", "alert"),
        resolved ? null : dueBadge(f.due_date, today, false))));
  }

  function findingsPanel() {
    const all = data.overview.findings;
    if (!all.length) {
      return emptyState({ title: "지적 사항이 없습니다", text: "점검에서 불량으로 판정한 항목이 조치 대상으로 여기에 모입니다." });
    }
    const today = localDate();
    const open = all.filter((f) => f.status !== "resolved");
    const done = all.filter((f) => f.status === "resolved");
    return [
      h("section", { class: "section" }, subHead("미조치 지적", open.length),
        open.length ? h("ul", { class: "list" }, open.map((f) => findingRow(f, today))) : h("p", { class: "mute" }, "미조치 지적 없음")),
      done.length ? fold("조치 완료", done.length, h("ul", { class: "list" }, done.map((f) => findingRow(f, today)))) : null,
      all.length >= LIMITS.findings ? note(`최근 ${LIMITS.findings}건만 표시`) : null,
    ];
  }

  // ---------------------------------------------------------------- 보고서

  function reportRow(i) {
    const pdf = i.report_status === "approved"
      ? h("a", { class: "btn btn-sm", href: `api/reports/${i.report_id}/pdf`, target: "_blank", rel: "noopener noreferrer" },
        icon("external"), "PDF", h("span", { class: "sr" }, "(새 창)"))
      : null;
    return h("li", null, h("div", { class: "row" },
      h("div", { class: "row-main" },
        h("span", { class: "row-title" }, h("a", { href: `#/inspections/${i.id}` }, i.asset_name)),
        h("span", { class: "row-sub" }, `${i.inspector_name} · 제출 ${fmtDateTime(i.submitted_at)}`)),
      h("div", { class: "row-side" }, reportBadge(i.report_status), pdf)));
  }

  function reportsPanel() {
    const list = data.overview.inspections.filter((i) => i.report_id);
    if (!list.length) {
      return emptyState({ title: "보고서가 없습니다", text: "검토를 통과한 점검은 보고서 승인 대기로 올라옵니다." });
    }
    const pending = list.filter((i) => i.report_status === "pending").length;
    return [
      note(`${list.length}건${pending ? ` · 승인 대기 ${pending}건` : ""}`),
      h("ul", { class: "list" }, list.map(reportRow)),
    ];
  }

  // ---------------------------------------------------------------- 이력

  function eventRow(e) {
    const detail = eventDetail(e);
    return h("li", null, h("button", { class: "row", type: "button", onClick: () => openTaskSheet(e.task_id, { onChanged: reload }) },
      h("div", { class: "row-main" },
        h("span", { class: "row-title" }, e.task_title),
        h("span", { class: "row-sub" }, `${EVENT_TEXT[e.type] || e.type}${detail ? ` · ${detail}` : ""}`),
        h("span", { class: "row-sub" }, `${e.actor_name} · ${fmtDateTime(e.created_at)}`))));
  }

  function attachmentRow(a) {
    return h("li", null, h("a", { class: "row", href: a.url, target: "_blank", rel: "noopener noreferrer" },
      icon("file"),
      h("div", { class: "row-main" }, h("span", { class: "row-title" }, a.filename),
        h("span", { class: "row-sub" }, `${fileSize(a.size)} · ${fmtDateTime(a.created_at)}`)),
      h("div", { class: "row-side" }, badge("열기", "accent", "external"), h("span", { class: "sr" }, "(새 창)"))));
  }

  async function loadAttachments(target) {
    const mine = ++attachmentSeq;
    fill(target, loadingState(1));
    try {
      const res = await api.get("api/attachments", { owner_type: "site", owner_id: siteId }, { signal });
      if (mine !== attachmentSeq || !target.isConnected) return;
      fill(target, res.items.length
        ? h("ul", { class: "list" }, res.items.map(attachmentRow))
        : emptyState({ title: "첨부 파일이 없습니다", text: "이 현장에 첨부한 사진·동영상·음성이 여기에 모입니다." }));
    } catch (err) {
      if (err.name === "AbortError" || mine !== attachmentSeq || !target.isConnected) return;
      fill(target, errorState(err, () => loadAttachments(target)));
    }
  }

  function historyPanel() {
    const events = data.events;
    const attachmentsBody = h("div");
    loadAttachments(attachmentsBody);
    return [
      h("section", { class: "section" },
        h("div", { class: "section-head" }, h("h2", null, "업무 변경 이력"),
          h("span", { class: "section-note num" }, `${events.length}건${capNote(events.length, LIMITS.events)}`)),
        events.length ? h("ul", { class: "list" }, events.map(eventRow))
          : emptyState({ title: "변경 이력이 없습니다", text: "이 현장의 업무가 만들어지거나 옮겨지면 여기에 쌓입니다." })),
      h("section", { class: "section" }, h("div", { class: "section-head" }, h("h2", null, "현장 첨부 파일")), attachmentsBody),
    ];
  }

  // ---------------------------------------------------------------- render + load

  const PANELS = {
    tasks: tasksPanel,
    assets: assetsPanel,
    inspections: inspectionsPanel,
    findings: findingsPanel,
    reports: reportsPanel,
    history: historyPanel,
  };

  function renderPanel() {
    if (!data) return;
    fill(panel, PANELS[tab]());
  }

  function renderIntro(site) {
    const retention = site.retention || {};
    fill(intro,
      site.description ? h("p", { class: "dim" }, site.description) : null,
      h("div", { class: "callout", role: "note" }, icon("info"),
        h("div", null, h("p", null, retention.policy || `기록 보관 기간 ${site.retention_years}년`), expiryLine(retention))));
  }

  function renderAll() {
    const { site } = data.overview;
    fill(title, site.name, site.code ? h("span", { class: "mute" }, ` · ${site.code}`) : null);
    fill(sub,
      site.archived ? badge("보관된 현장", "", "lock") : null,
      site.members?.length
        ? [h("span", null, "담당 팀원"), site.members.map((m) => personTag({ slot: m.board_slot, initials: m.initials, name: m.name }))]
        : h("span", null, "배정된 팀원 없음"));
    if (!boardLink.isConnected) headActions.append(boardLink);
    renderIntro(site);
    updateCounts();
    syncTabs();
    if (!intro.isConnected) fill(body, intro, tabBar, panel);
    renderPanel();
  }

  function renderNotFound() {
    data = null;
    fill(title, "현장");
    fill(sub);
    boardLink.remove(); // .btn beats [hidden], so detach instead of hiding
    fill(body, emptyState({
      title: "현장을 찾을 수 없습니다",
      text: "주소가 잘못됐거나 볼 수 없는 현장입니다.",
      action: h("a", { class: "btn btn-sm", href: "#/" }, "대시보드로 돌아가기"),
    }));
  }

  async function load({ quiet = false } = {}) {
    if (!Number.isInteger(siteId) || siteId <= 0) {
      renderNotFound();
      return;
    }
    if (!quiet || !data) fill(body, loadingState(4));
    try {
      const [overview, tasks, events] = await Promise.all([
        api.get(`api/sites/${siteId}/overview`, {}, { signal }),
        api.get(`api/sites/${siteId}/tasks`, {}, { signal }),
        api.get(`api/sites/${siteId}/events`, {}, { signal }),
      ]);
      data = { overview, tasks, events: events.items };
      renderAll();
    } catch (err) {
      if (err.name === "AbortError") return;
      if (err.status === 404) {
        renderNotFound();
        return;
      }
      if (data) {
        toast(describeError(err), { tone: "error" });
        return;
      }
      fill(body, errorState(err, () => load()));
    }
  }

  onCleanup(on("rev", () => reload()));
  await load();
}
