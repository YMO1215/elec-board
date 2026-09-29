// Dashboard. Task counts come from GET api/tasks/board-summary — the exact
// response the board column headers render — so the two never disagree.
import { api } from "../api.js";
import { fill, h, icon } from "../dom.js";
import { STATUSES } from "../lib/board-model.js";
import { dueLabel, fmtDate, fmtDateTime, localDate, pct } from "../lib/format.js";
import { on, store } from "../store.js";
import { badge, dueBadge, emptyState, errorState, inspectionBadge, loadingState, personTag, staleNote } from "../ui.js";
import { judgementBadge } from "./kpi.js";
import { openTaskSheet } from "./task-sheet.js";

function todo(tone, iconName, text, href) {
  return h("a", { class: `todo todo-${tone}`, href }, icon(iconName), h("span", null, text),
    h("span", { class: "todo-go" }, "보기 →"));
}

function quiet(text) {
  return h("p", { class: "todo todo-quiet" }, icon("check"), text);
}

export async function renderDashboard(root, { signal, onCleanup }) {
  const body = h("div", { class: "page" });
  const sub = h("p", { class: "page-sub" });
  root.append(h("section", { class: "page" },
    h("header", { class: "page-head" }, h("div", null, h("h1", null, "대시보드"), sub)), body));
  fill(body, loadingState(4));

  async function load() {
    let summary, dash, kpi;
    try {
      [summary, dash, kpi] = await Promise.all([
        api.get("api/tasks/board-summary", {}, { signal }),
        api.get("api/dashboard", {}, { signal }),
        api.get("api/kpi/summary", { scope: "team" }, { signal }),
      ]);
    } catch (err) {
      if (err.name === "AbortError") return;
      fill(body, errorState(err, load));
      return;
    }
    const fetchedAt = Date.now();
    const today = dash.today;
    const stale = staleNote(fetchedAt, store.online);
    fill(sub, `${store.me.org.name} · ${fmtDate(today)} · ${fmtDateTime(summary.computed_at).slice(11)} 기준`,
      stale ? " · " : "", stale);

    // --- 지금 처리할 것 (actionable, per design rule: say what to do)
    const actions = [];
    actions.push(dash.overdue.length ? todo("danger", "alert", `기한이 지난 업무 ${dash.overdue.length}건`, "#/board?due=all")
      : quiet("기한이 지난 업무 없음"));
    actions.push(dash.open_findings.length ? todo("warn", "alert", `조치하지 않은 지적 ${dash.open_findings.length}건`, "#/inspect?tab=findings")
      : quiet("미조치 지적 없음"));
    if (store.has("reviewer")) {
      const mine = dash.awaiting_review.filter((i) => i.inspector_id !== store.user.id);
      actions.push(mine.length ? todo("accent", "clipboard", `검토를 기다리는 점검 ${mine.length}건`, "#/inspect?tab=review")
        : quiet("검토할 점검 없음"));
    }
    if (store.has("admin")) {
      actions.push(dash.awaiting_approval.length ? todo("accent", "check", `승인을 기다리는 보고서 ${dash.awaiting_approval.length}건`, "#/inspect?tab=review")
        : quiet("승인할 보고서 없음"));
    }

    // --- KPI: one hero figure + four tiles
    const kpiTiles = kpi.metrics.map((m) => h("a", { class: "stat", href: "#/kpi" },
      h("span", { class: "stat-label" }, m.name),
      h("span", { class: "stat-value" }, pct(m.value)),
      h("span", { class: "stat-note" }, m.denominator ? `${m.numerator}/${m.denominator}건 · 목표 ${m.target}%` : `대상 없음 · 목표 ${m.target}%`),
      h("span", null, judgementBadge(m.judgement))));
    const kpiSection = h("section", { class: "section" },
      h("div", { class: "section-head" }, h("h2", null, "이번 달 KPI"), h("a", { href: "#/kpi", class: "section-note" }, "산식·근거 보기 →")),
      h("div", { class: "grid-2" },
        h("div", { class: "card hero-kpi" }, h("span", { class: "stat-label" }, "가중평균 달성률"),
          h("span", { class: "hero-value" }, kpi.weighted === null ? "—" : `${kpi.weighted.toFixed(1)}%`),
          h("span", { class: "stat-note" }, kpi.weighted === null ? "이번 달 계산할 데이터가 아직 없습니다." : kpi.weighted_rule)),
        h("div", { class: "stat-row" }, kpiTiles)));

    // --- task counts (board summary)
    const statusStats = STATUSES.map((s) => {
      const c = summary.by_status.find((b) => b.status === s.key)?.count ?? 0;
      return h("a", { class: "stat", href: "#/board?view=status" }, h("span", { class: "stat-label" }, s.label),
        h("span", { class: "stat-value num" }, String(c)), h("span", { class: "stat-note" }, "건"));
    });
    const countSection = h("section", { class: "section" },
      h("div", { class: "section-head" }, h("h2", null, "업무 현황"), h("span", { class: "section-note" }, `전체 ${summary.total}건 · 보드와 같은 집계`)),
      h("div", { class: "stat-row" }, statusStats,
        h("a", { class: `stat${summary.overdue ? " is-alert" : ""}`, href: "#/board" }, h("span", { class: "stat-label" }, "지연"),
          h("span", { class: "stat-value num" }, String(summary.overdue)), h("span", { class: "stat-note" }, "기한 지난 미완료")),
        h("a", { class: "stat", href: "#/board?due=today" }, h("span", { class: "stat-label" }, "오늘 마감"),
          h("span", { class: "stat-value num" }, String(summary.due_today)), h("span", { class: "stat-note" }, "건"))));

    // --- today by assignee
    const todayGroups = dash.today_by_assignee.map((g) => h("div", { class: "card card-flat section" },
      h("div", { class: "section-head" }, personTag(g), h("span", { class: "section-note num" }, `${g.tasks.length}건`)),
      g.tasks.length ? h("ul", { class: "list" }, g.tasks.map((t) => h("li", null,
        h("button", { class: "row", type: "button", onClick: () => openTaskSheet(t.id, { onChanged: load }) },
          h("div", { class: "row-main" }, h("span", { class: "row-title" }, t.title), h("span", { class: "row-sub" }, `${t.site_name} · ${t.status_label}`)),
          h("div", { class: "row-side" }, dueBadge(t.due_date, today, false))))))
        : h("p", { class: "mute" }, "오늘 마감이거나 진행 중인 업무 없음")));
    const todaySection = h("section", { class: "section" },
      h("div", { class: "section-head" }, h("h2", null, "오늘의 업무"), h("span", { class: "section-note" }, "오늘 마감 + 진행 중, 담당자별")),
      dash.today_by_assignee.length ? h("div", { class: "grid-2" }, todayGroups)
        : emptyState({ title: "보드에 배치된 팀원이 없습니다", text: "설정 → 팀원에서 1~4열을 배치하세요." }));

    // --- overdue + findings detail
    const overdueList = dash.overdue.length ? h("ul", { class: "list" }, dash.overdue.slice(0, 8).map((t) => h("li", null,
      h("button", { class: "row", type: "button", onClick: () => openTaskSheet(t.id, { onChanged: load }) },
        personTag({ slot: t.assignee_slot, initials: t.assignee_initials, name: "" }, { showName: false }),
        h("div", { class: "row-main" }, h("span", { class: "row-title" }, t.title), h("span", { class: "row-sub" }, `${t.assignee_name} · ${t.site_name}`)),
        h("div", { class: "row-side" }, badge(dueLabel(t.due_date, today).label, "danger", "alert")))))) : null;
    const findingList = dash.open_findings.length ? h("ul", { class: "list" }, dash.open_findings.slice(0, 8).map((f) => h("li", null,
      h("a", { class: "row", href: `#/inspections/${f.inspection_id}` },
        h("div", { class: "row-main" }, h("span", { class: "row-title" }, `${f.asset_name} · ${f.item_label || f.item_key}`),
          h("span", { class: "row-sub" }, `${f.assignee_name} · ${f.description}`)),
        h("div", { class: "row-side" }, dueBadge(f.due_date, today, false)))))) : null;

    const timeline = dash.recent_inspections.length ? h("ul", { class: "list" }, dash.recent_inspections.map((i) => h("li", null,
      h("a", { class: "row", href: `#/inspections/${i.id}` },
        h("div", { class: "row-main" }, h("span", { class: "row-title" }, `${i.asset_name}`),
          h("span", { class: "row-sub" }, `${i.site_name} · ${i.inspector_name} · ${fmtDateTime(i.submitted_at)}${i.bad_count ? ` · 불량 ${i.bad_count}` : ""}`)),
        h("div", { class: "row-side" }, inspectionBadge(i.status))))))
      : emptyState({ title: "아직 제출된 점검이 없습니다", text: "점검 메뉴에서 설비를 골라 첫 점검을 기록하세요.",
        action: h("a", { class: "btn btn-sm", href: "#/inspect" }, "점검 시작") });

    const sites = store.sites.length ? h("ul", { class: "list" }, store.sites.map((s) => h("li", null,
      h("a", { class: "row", href: `#/sites/${s.id}` }, h("div", { class: "row-main" }, h("span", { class: "row-title" }, s.name),
        h("span", { class: "row-sub" }, `진행 중 업무 ${s.open_tasks} · 설비 ${s.asset_count} · 미조치 지적 ${s.open_findings}`)),
      h("div", { class: "row-side" }, s.open_findings ? badge(`지적 ${s.open_findings}`, "warn") : null))))) : null;

    fill(body, 
      h("section", { class: "section" }, h("h2", { class: "sr" }, "지금 처리할 것"), h("div", { class: "todo-list" }, actions)),
      countSection,
      kpiSection,
      todaySection,
      h("div", { class: "grid-2" },
        h("section", { class: "section" }, h("div", { class: "section-head" }, h("h2", null, "지연 업무"),
          h("a", { class: "section-note", href: "#/board" }, "보드에서 보기 →")), overdueList || quiet("기한이 지난 업무 없음")),
        h("section", { class: "section" }, h("div", { class: "section-head" }, h("h2", null, "미조치 지적")), findingList || quiet("미조치 지적 없음"))),
      h("div", { class: "grid-2" },
        h("section", { class: "section" }, h("div", { class: "section-head" }, h("h2", null, "최근 점검·승인")), timeline),
        h("section", { class: "section" }, h("div", { class: "section-head" }, h("h2", null, "현장")), sites
          || emptyState({ title: "현장이 없습니다", text: "관리자가 설정에서 현장을 만들면 여기에 모입니다." }))),
    );
  }

  onCleanup(on("rev", () => load()));
  await load();
}
