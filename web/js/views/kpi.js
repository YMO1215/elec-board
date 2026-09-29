// KPI: team / personal, period presets, one hero figure (weighted average),
// four stat tiles with meter, delta vs the previous equal period, a 6-period
// trend (single series: no legend; current period in the accent), the
// definition of every number, and a drilldown to the records behind it.
import { api } from "../api.js";
import { fill, h, icon, svg } from "../dom.js";
import { deltaText, deltaTone, fmtDate, fmtDateTime, localDate, pct, periodPreset } from "../lib/format.js";
import { setQuery } from "../router.js";
import { on, store } from "../store.js";
import { badge, chips, describeError, emptyState, errorState, loadingState, openSheet, personTag, seg, toast } from "../ui.js";
import { openTaskSheet } from "./task-sheet.js";

const PERIODS = [
  { value: "week", label: "이번 주" },
  { value: "month", label: "이번 달" },
  { value: "last_month", label: "지난 달" },
  { value: "90d", label: "최근 90일" },
];
const JUDGEMENT = {
  met: ["목표 달성", "ok", "check"],
  near: ["목표 근접", "warn", "alert"],
  below: ["목표 미달", "danger", "x"],
  no_data: ["데이터 없음", "", "minus"],
};
const METER_TONE = { met: "", near: "tone-warn", below: "tone-danger", no_data: "" };

export function judgementBadge(j) {
  const [label, tone, ic] = JUDGEMENT[j] || JUDGEMENT.no_data;
  return badge(label, tone, ic);
}

function shortRange(p) {
  return `${p.start.slice(5).replace("-", "/")}~${p.end.slice(5).replace("-", "/")}`;
}

function trendChart(metric) {
  const W = 300;
  const H = 72;
  const BAR = 24;
  const n = metric.trend.length;
  const slot = W / n;
  const wrap = h("div", { class: "trend" });
  const tip = h("div", { class: "trend-tip", hidden: true });
  const chart = svg("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", role: "img",
    "aria-label": `${metric.name} 최근 ${n}개 기간 추이` });
  chart.append(svg("line", { class: "axis", x1: 0, y1: H - 0.5, x2: W, y2: H - 0.5 }));
  const ty = H - (metric.target / 100) * H;
  chart.append(svg("line", { class: "target-line", x1: 0, y1: ty, x2: W, y2: ty }));
  metric.trend.forEach((p, i) => {
    const x = i * slot + (slot - BAR) / 2;
    const current = i === n - 1;
    if (p.value === null) {
      const t = svg("text", { class: "empty-mark", x: x + BAR / 2, y: H - 4, "text-anchor": "middle" });
      t.textContent = "—";
      chart.append(t);
    } else {
      const bh = Math.max(2, (p.value / 100) * H);
      const r = Math.min(4, bh / 2);
      const top = H - bh;
      // 4px rounded data end, square at the baseline.
      const d = `M${x},${H} V${top + r} Q${x},${top} ${x + r},${top} H${x + BAR - r} Q${x + BAR},${top} ${x + BAR},${top + r} V${H} Z`;
      chart.append(svg("path", { class: `bar${current ? " is-current" : ""}`, d }));
    }
    const hit = svg("rect", { class: "bar-hit", x: i * slot, y: 0, width: slot, height: H });
    const text = `${shortRange(p)} · ${pct(p.value)}${p.denominator ? ` (${p.numerator}/${p.denominator})` : " (대상 없음)"}`;
    hit.addEventListener("pointerenter", () => {
      tip.textContent = text;
      tip.hidden = false;
      const box = wrap.getBoundingClientRect();
      tip.style.setProperty("--x", `${((i + 0.5) / n) * box.width}px`);
      tip.style.setProperty("--y", "0px");
    });
    hit.addEventListener("pointerleave", () => { tip.hidden = true; });
    chart.append(hit);
  });
  const labels = h("div", { class: "trend-labels", "aria-hidden": "true" },
    metric.trend.map((p, i) => h("span", null, i === n - 1 ? "이번" : shortRange(p).split("~")[0])));
  const table = h("table", { class: "sr" }, h("caption", null, `${metric.name} 기간별 값`),
    h("tbody", null, metric.trend.map((p) => h("tr", null, h("th", { scope: "row" }, `${p.start}~${p.end}`), h("td", null, pct(p.value))))));
  wrap.append(chart, tip, labels, table);
  return wrap;
}

function meter(metric) {
  const fill = h("span", { class: `meter-fill ${METER_TONE[metric.judgement]}` });
  fill.style.setProperty("--w", `${Math.min(metric.value ?? 0, 100)}%`);
  const target = h("span", { class: "meter-target", title: `목표 ${metric.target}%` });
  target.style.setProperty("--t", `${metric.target}%`);
  return h("div", null,
    h("div", { class: "meter", role: "meter", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": metric.value ?? 0,
      "aria-label": `${metric.name} ${pct(metric.value)}, 목표 ${metric.target}%` }, metric.value === null ? null : fill, target),
    h("div", { class: "meter-legend" }, h("span", null, "0%"), h("span", null, `목표 ${metric.target}%`), h("span", null, "100%")));
}

function tile(metric, summary, openDrill) {
  const tone = deltaTone(metric.delta, metric.good_direction);
  const arrow = metric.delta > 0 ? "▲" : metric.delta < 0 ? "▼" : "";
  return h("article", { class: "card kpi-tile" },
    h("div", { class: "kpi-top" }, h("h3", { class: "kpi-name" }, metric.name), judgementBadge(metric.judgement)),
    h("div", null,
      h("div", { class: "kpi-value" }, pct(metric.value)),
      h("div", { class: "kpi-frac" }, metric.denominator
        ? `${metric.numerator_label} ${metric.numerator}건 ÷ ${metric.denominator_label} ${metric.denominator}건`
        : `${metric.denominator_label}이(가) 없어 계산하지 않습니다 (0%로 보지 않음)`)),
    meter(metric),
    h("p", { class: `delta delta-${tone}` }, `${summary.baseline.label} 대비 ${deltaText(metric.delta)} ${arrow}`,
      tone === "flat" ? "" : tone === "good" ? " · 개선" : " · 악화"),
    trendChart(metric),
    h("details", { class: "inline" }, h("summary", null, "정의 보기"),
      h("dl", { class: "def-list" },
        h("dt", null, "뜻"), h("dd", null, metric.description),
        h("dt", null, "산식"), h("dd", null, `${metric.numerator_label} ÷ ${metric.denominator_label} × 100`),
        h("dt", null, "분자"), h("dd", null, `${metric.numerator_label} (${metric.numerator}건)`),
        h("dt", null, "분모"), h("dd", null, `${metric.denominator_label} (${metric.denominator}건)`),
        h("dt", null, "단위"), h("dd", null, "%, 소수 첫째 자리 · 분모 0이면 “—”"),
        h("dt", null, "좋은 방향"), h("dd", null, metric.good_direction === "up" ? "상승이 좋음" : "하락이 좋음"),
        h("dt", null, "목표·가중치"), h("dd", null, `${metric.target}% (${summary.target_source}) · 가중치 ${metric.weight}`),
        h("dt", null, "비교 기준"), h("dd", null, `${summary.baseline.label} ${summary.baseline.start}~${summary.baseline.end}: ${pct(metric.previous_value)}`),
        h("dt", null, "기준 시각"), h("dd", null, fmtDateTime(summary.computed_at)))),
    h("div", null, h("button", { class: "btn btn-sm", type: "button", onClick: () => openDrill(metric) }, "근거 목록 보기 →")));
}

export async function renderKpi(root, { query, signal, onCleanup }) {
  const today = localDate();
  const q = { scope: query.scope === "user" ? "user" : "team", user: query.user || String(store.user.id), period: query.period || "month" };
  const sub = h("p", { class: "page-sub" });
  const controls = h("div", { class: "board-tools" });
  const body = h("div", { class: "section" });
  const snapBtn = store.has("admin") ? h("button", { class: "btn", type: "button" }, "기간 마감 저장") : null;
  root.append(h("section", { class: "page" },
    h("header", { class: "page-head" }, h("div", null, h("h1", null, "KPI"), sub), h("div", { class: "head-actions" }, snapBtn)),
    controls, body));

  const range = () => periodPreset(q.period, today) || periodPreset("month", today);
  const params = () => ({ ...range(), scope: q.scope, user_id: q.scope === "user" ? q.user : undefined });

  function renderControls() {
    const members = store.members;
    fill(controls, 
      h("div", { class: "board-tools-top" },
        seg({ label: "범위", value: q.scope, options: [{ value: "team", label: "팀" }, { value: "user", label: "개인" }],
          onChange: (v) => { q.scope = v; setQuery({ scope: v === "team" ? undefined : v }); renderControls(); load(); } }),
        seg({ label: "기간", value: q.period, options: PERIODS, onChange: (v) => { q.period = v; setQuery({ period: v }); load(); } })),
      q.scope === "user" ? chips({ label: "팀원", value: q.user, options: members.map((m) => ({ value: String(m.id),
        node: personTag({ slot: m.board_slot, initials: m.initials, name: m.name }) })),
      onChange: (v) => { q.user = v; setQuery({ user: v }); load(); } }) : null);
  }

  async function openDrill(metric) {
    const sheet = openSheet({ title: `${metric.name} 근거`, body: loadingState(3), wide: true });
    try {
      const dd = await api.get("api/kpi/drilldown", { ...params(), metric: metric.key });
      const rows = dd.items.map((i) => {
        const inner = [
          h("span", { class: `badge${i.in_numerator ? " badge-ok" : ""}` }, icon(i.in_numerator ? "check" : "minus"),
            i.in_numerator ? "분자 포함" : "분모만"),
          h("div", { class: "row-main" }, h("span", { class: "row-title" }, i.label),
            h("span", { class: "row-sub" }, `${i.when} · ${i.site_name} · ${i.assignee_name}`)),
        ];
        const el = i.type === "task"
          ? h("button", { class: "row", type: "button", onClick: () => { sheet.close(); openTaskSheet(i.id); } }, inner)
          : h("a", { class: "row", href: `#/inspections/${i.link_id}`, onClick: () => sheet.close() }, inner);
        return h("li", null, el);
      });
      sheet.setBody(
        h("p", { class: "dim" }, `${metric.numerator_label} ${dd.numerator}건 ÷ ${metric.denominator_label} ${dd.denominator}건 = ${pct(dd.value)}`),
        h("p", { class: "field-hint" }, `기간 ${dd.period.start} ~ ${dd.period.end} · 기준 ${fmtDateTime(dd.computed_at)}`),
        dd.items.length ? h("ul", { class: "list" }, rows) : emptyState({ title: "대상 기록이 없습니다", text: "이 기간에는 분모가 0이라 값을 계산하지 않습니다." }));
    } catch (err) {
      sheet.setBody(errorState(err));
    }
  }

  async function load() {
    fill(body, loadingState(3));
    let s;
    try {
      s = await api.get("api/kpi/summary", params(), { signal });
    } catch (err) {
      if (err.name === "AbortError") return;
      fill(body, errorState(err, load));
      return;
    }
    const who = q.scope === "team" ? "팀 전체" : store.member(Number(q.user))?.name || "개인";
    sub.textContent = `${who} · ${fmtDate(s.period.start)} ~ ${fmtDate(s.period.end)} · ${fmtDateTime(s.computed_at)} 기준`;
    const hero = h("section", { class: "card hero-kpi" },
      h("span", { class: "stat-label" }, "가중평균 달성률"),
      h("span", { class: "hero-value" }, s.weighted === null ? "—" : `${s.weighted.toFixed(1)}%`),
      h("p", { class: "field-hint" }, s.weighted_rule),
      h("p", { class: "field-hint" }, `비교: ${s.baseline.label} (${s.baseline.start} ~ ${s.baseline.end}) · 목표: ${s.target_source}`));
    fill(body, hero, h("div", { class: "kpi-grid" }, s.metrics.map((m) => tile(m, s, openDrill))));
    if (snapBtn) {
      snapBtn.onclick = async () => {
        try {
          await api.post("api/kpi/snapshots", { scope: q.scope, user_id: q.scope === "user" ? Number(q.user) : null, ...range() });
          toast("이 기간의 KPI를 마감 기록으로 저장했습니다.");
        } catch (err) {
          toast(describeError(err), { tone: "error" });
        }
      };
    }
  }

  onCleanup(on("rev", () => load()));
  renderControls();
  await load();
}
