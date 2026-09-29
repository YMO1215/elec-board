// 점검: pick an asset (QR or list), device drafts + sync queue, submitted
// records, review / approval inbox and open findings.
import { api } from "../api.js";
import { debounce, fill, h, icon } from "../dom.js";
import { fmtDateTime, localDate } from "../lib/format.js";
import { navigate, rerender, setQuery } from "../router.js";
import { drafts, getBundle, kick, saveRemote, syncState } from "../offline/sync.js";
import { on, store } from "../store.js";
import {
  badge, chips, dueBadge, emptyState, errorState, inlineConfirm, inspectionBadge, loadingState, openSheet, seg, statusBadge,
  toast,
} from "../ui.js";

const DRAFT_STATUS = {
  editing: ["작성 중", ""],
  queued: ["동기화 대기", "accent"],
  syncing: ["동기화 중", "accent"],
  conflict: ["충돌 — 선택 필요", "danger"],
  error: ["제출 실패 — 확인 필요", "danger"],
};

export function draftBadge(d) {
  const [label, tone] = DRAFT_STATUS[d.status] || [d.status, ""];
  return badge(label, tone, d.status === "conflict" || d.status === "error" ? "alert" : d.status === "queued" ? "sync" : null);
}

function lifeBadge(life) {
  if (!life || life.state === "unknown" || life.state === "ok") return null;
  return badge(life.label, life.state === "expired" ? "danger" : "warn", "alert");
}

/** Open (or resume) a device draft for an asset, then go to the checklist. */
export async function startDraft(asset, { taskId = null, replace = false } = {}) {
  const existing = (await drafts.list()).find((d) => d.asset.id === asset.id && d.status === "editing"
    && (taskId ? d.task_id === taskId : true) && !d.corrects_id);
  if (existing) {
    toast("이 설비의 작성 중인 점검을 이어서 엽니다.");
    go(existing.local_id, replace);
    return;
  }
  const bundle = await getBundle();
  const template = bundle?.templates.find((t) => t.id === asset.template_id);
  if (!template) {
    toast("이 설비에 점검 서식이 없습니다. 관리자에게 설비 설정을 요청하세요.", { tone: "error" });
    return;
  }
  const d = await drafts.create({ asset, template, taskId });
  if (store.online) saveRemote(d).catch(() => { /* created again at submit time */ });
  go(d.local_id, replace);
}

function go(localId, replace) {
  if (!replace) {
    navigate(`/draft/${localId}`);
    return;
  }
  // QR / start links should not stay in history: back returns to where the user came from.
  history.replaceState(null, "", `#/draft/${localId}`);
  rerender();
}

// ---------------------------------------------------------------- QR scanner

function qrToken(text) {
  const m = String(text).match(/#\/q\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

export function scannerSupported() {
  return "BarcodeDetector" in window && Boolean(navigator.mediaDevices?.getUserMedia);
}

export function openScanner() {
  const video = h("video", { class: "qr-video", playsinline: true, muted: true });
  const status = h("p", { class: "field-hint", role: "status" }, "카메라를 설비 QR에 비추세요.");
  let stream = null;
  let timer = null;
  const sheet = openSheet({ title: "QR 스캔", body: [video, status], onClose: () => {
    clearInterval(timer);
    stream?.getTracks().forEach((t) => t.stop());
  } });
  (async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      video.srcObject = stream;
      await video.play();
      const detector = new window.BarcodeDetector({ formats: ["qr_code"] });
      timer = setInterval(async () => {
        const codes = await detector.detect(video).catch(() => []);
        for (const c of codes) {
          const token = qrToken(c.rawValue);
          if (token) {
            sheet.close();
            navigate(`/q/${token}`);
            return;
          }
          status.textContent = "이 앱의 설비 QR이 아닙니다.";
        }
      }, 250);
    } catch (err) {
      status.textContent = `카메라를 열 수 없습니다: ${err.message}. 휴대폰 기본 카메라로 QR을 비춰도 바로 열립니다.`;
    }
  })();
}

// ---------------------------------------------------------------- routes

export async function renderQr(root, { params }) {
  root.append(h("section", { class: "page page-narrow" }, loadingState(2)));
  const bundle = await getBundle().catch(() => null);
  let asset = bundle?.assets.find((a) => a.public_token === params.token);
  if (!asset && store.online) {
    try {
      asset = await api.get(`api/assets/by-qr/${encodeURIComponent(params.token)}`);
      await getBundle({ refresh: true });
    } catch (err) {
      fill(root, h("section", { class: "page page-narrow" }, err.status === 404
        ? emptyState({ title: "등록되지 않은 QR입니다", text: "라벨이 재발급되었거나 다른 팀의 설비일 수 있습니다.",
          action: h("a", { class: "btn btn-sm", href: "#/inspect" }, "목록에서 고르기") })
        : errorState(err)));
      return;
    }
  }
  if (!asset) {
    fill(root, h("section", { class: "page page-narrow" }, emptyState({
      title: "이 기기에 설비 정보가 없습니다",
      text: "오프라인이라 확인할 수 없습니다. 한 번 온라인일 때 점검 화면을 열어 두면 설비 목록이 기기에 저장됩니다.",
    })));
    return;
  }
  if (!store.has("admin", "worker")) {
    fill(root, h("section", { class: "page page-narrow" }, emptyState({ title: asset.name,
      text: "점검 작성은 작업자 역할이 필요합니다.", action: h("a", { class: "btn btn-sm", href: `#/sites/${asset.site_id}` }, "현장 보기") })));
    return;
  }
  await startDraft(asset, { replace: true });
}

export async function renderInspectStart(root, { query }) {
  root.append(h("section", { class: "page page-narrow" }, loadingState(2)));
  const bundle = await getBundle({ refresh: store.online }).catch(() => null);
  const asset = bundle?.assets.find((a) => a.id === Number(query.asset));
  if (!asset) {
    fill(root, h("section", { class: "page page-narrow" }, emptyState({ title: "설비를 찾을 수 없습니다",
      action: h("a", { class: "btn btn-sm", href: "#/inspect" }, "점검 목록으로") })));
    return;
  }
  await startDraft(asset, { taskId: query.task ? Number(query.task) : null, replace: true });
}

const TABS = [
  { key: "start", label: "설비 선택" },
  { key: "drafts", label: "작성·동기화" },
  { key: "records", label: "제출 기록" },
  { key: "review", label: "검토·승인", roles: ["reviewer", "admin"] },
  { key: "findings", label: "지적사항" },
];

export async function renderInspectHome(root, { query, signal, onCleanup }) {
  const tabs = TABS.filter((t) => !t.roles || store.has(...t.roles));
  let tab = tabs.some((t) => t.key === query.tab) ? query.tab : "start";
  const panel = h("div", { class: "section", role: "tabpanel" });
  const tabBar = h("div", { class: "tabs", role: "tablist", "aria-label": "점검 메뉴" });
  const canWrite = store.has("admin", "worker");
  const scanBtn = canWrite && scannerSupported()
    ? h("button", { class: "btn btn-primary", type: "button", onClick: openScanner }, icon("qr"), "QR 스캔") : null;
  root.append(h("section", { class: "page" },
    h("header", { class: "page-head" }, h("div", null, h("h1", null, "점검 체크리스트"),
      h("p", { class: "page-sub" }, "QR을 비추거나 목록에서 설비를 고르면 체크리스트로 바로 들어갑니다.")),
    h("div", { class: "head-actions" }, scanBtn)),
    tabBar, panel));

  function renderTabs() {
    fill(tabBar, ...tabs.map((t) => {
      const b = h("button", { type: "button", role: "tab", "aria-selected": String(t.key === tab), id: `tab-${t.key}`,
        tabindex: t.key === tab ? "0" : "-1" }, t.label);
      b.addEventListener("click", () => select(t.key));
      b.addEventListener("keydown", (e) => {
        const i = tabs.findIndex((x) => x.key === tab);
        if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
          select(next.key);
          tabBar.querySelector(`#tab-${next.key}`)?.focus();
        }
      });
      return b;
    }));
    panel.setAttribute("aria-labelledby", `tab-${tab}`);
  }

  function select(key) {
    tab = key;
    setQuery({ tab: key === "start" ? undefined : key });
    renderTabs();
    renderPanel();
  }

  async function renderPanel() {
    fill(panel, loadingState(3));
    try {
      if (tab === "start") await startPanel();
      else if (tab === "drafts") await draftsPanel();
      else if (tab === "records") await recordsPanel();
      else if (tab === "review") await reviewPanel();
      else await findingsPanel();
    } catch (err) {
      if (err.name !== "AbortError") fill(panel, errorState(err, renderPanel));
    }
  }

  // --- 설비 선택
  async function startPanel() {
    const bundle = await getBundle({ refresh: store.online });
    if (!bundle) {
      fill(panel, emptyState({ title: "설비 목록이 기기에 없습니다", text: "온라인일 때 한 번 이 화면을 열면 오프라인에서도 쓸 수 있습니다." }));
      return;
    }
    let site = "";
    let term = "";
    const list = h("ul", { class: "list" });
    const search = h("input", { class: "input", type: "search", placeholder: "설비 이름·위치·유형 검색", "aria-label": "설비 검색" });
    const drawList = () => {
      const t = term.trim().toLowerCase();
      const rows = bundle.assets.filter((a) => (!site || String(a.site_id) === site)
        && (!t || `${a.name} ${a.location} ${a.asset_type} ${a.site_name}`.toLowerCase().includes(t)));
      fill(list, ...rows.map((a) => h("li", null, h("div", { class: "row" },
        h("div", { class: "row-main" }, h("span", { class: "row-title" }, a.name),
          h("span", { class: "row-sub" }, `${a.asset_type} · ${a.site_name} · ${a.location || "위치 미입력"}`),
          h("span", { class: "row-sub" }, a.last_inspected_at ? `마지막 점검 ${fmtDateTime(a.last_inspected_at)}` : "점검 기록 없음",
            a.next_due_on ? ` · 다음 ${a.next_due_on}` : "")),
        h("div", { class: "row-side" }, lifeBadge(a.life),
          canWrite ? h("button", { class: "btn btn-sm btn-primary", type: "button", onClick: () => startDraft(a) }, "점검 시작") : null)))));
      if (!rows.length) {
        fill(list, h("li", null, bundle.assets.length
          ? emptyState({ title: "조건에 맞는 설비가 없습니다", action: h("button", { class: "btn btn-sm", type: "button",
            onClick: () => { site = ""; term = ""; search.value = ""; startPanel(); } }, "검색 초기화") })
          : emptyState({ title: "등록된 설비가 없습니다", text: "관리자가 설정 → 설비·QR에서 설비를 등록하면 여기에 나옵니다." })));
      }
    };
    search.addEventListener("input", debounce(() => { term = search.value; drawList(); }, 150));

    let myTasks = null;
    if (store.online && canWrite) {
      try {
        const res = await api.get("api/tasks/board", { assignee_id: store.user.id, kind: "inspection" }, { signal });
        myTasks = res.items.filter((t) => t.status !== "done");
      } catch { myTasks = null; }
    }
    const today = localDate();
    const taskSection = myTasks && myTasks.length ? h("section", { class: "section card" },
      h("h2", null, "내게 배정된 점검"),
      h("ul", { class: "list" }, myTasks.map((t) => h("li", null, h("div", { class: "row" },
        h("div", { class: "row-main" }, h("span", { class: "row-title" }, t.title), h("span", { class: "row-sub" }, `${t.asset_name} · ${t.site_name}`)),
        h("div", { class: "row-side" }, statusBadge(t.status), dueBadge(t.due_date, today, false),
          h("button", { class: "btn btn-sm btn-primary", type: "button", onClick: () => {
            const a = bundle.assets.find((x) => x.id === t.asset_id);
            if (a) startDraft(a, { taskId: t.id }); else toast("설비 정보를 찾을 수 없습니다.", { tone: "error" });
          } }, "시작"))))))) : null;

    const hint = canWrite && !scannerSupported()
      ? h("p", { class: "callout" }, icon("qr"), "휴대폰 기본 카메라로 설비 QR 라벨을 비추면 이 앱의 체크리스트가 바로 열립니다.") : null;
    fill(panel, 
      hint, taskSection,
      h("section", { class: "section" }, h("h2", { class: "sr" }, "설비 목록"), search,
        chips({ label: "현장", value: "", options: [{ value: "", label: "전체 현장" }, ...bundle.sites.map((s) => ({ value: String(s.id), label: s.name }))],
          onChange: (v) => { site = v; drawList(); } }),
        list));
    drawList();
  }

  // --- 작성·동기화
  async function draftsPanel() {
    const local = await drafts.list();
    const queued = local.filter((d) => d.status === "queued").length;
    const rows = local.map((d) => {
      const answered = d.items.filter((i) => i.result).length;
      const del = h("button", { class: "btn btn-sm btn-ghost", type: "button" }, "삭제");
      del.addEventListener("click", () => inlineConfirm(del, {
        message: "이 기기의 작성 내용과 첨부를 지웁니다. 되돌릴 수 없습니다.",
        confirmLabel: "삭제",
        onConfirm: async () => {
          if (d.server_id && store.online) await api.del(`api/inspections/${d.server_id}`).catch(() => {});
          await drafts.remove(d);
          draftsPanel();
        },
      }));
      return h("li", null, h("div", { class: "row" },
        h("div", { class: "row-main" }, h("a", { class: "row-title", href: `#/draft/${d.local_id}` }, d.asset.name),
          h("span", { class: "row-sub" }, `${d.corrects_id ? `정정본(원본 #${d.corrects_id}) · ` : ""}판정 ${answered}/${d.items.length} · 첨부 ${d.evidence.length} · ${fmtDateTime(d.updated_at)}`),
          d.error ? h("span", { class: "row-sub" }, d.error) : null),
        h("div", { class: "row-side" }, draftBadge(d), d.status === "editing" || d.status === "error" || d.status === "conflict" ? del : null)));
    });
    let remote = [];
    if (store.online) {
      const res = await api.get("api/inspections", { status: "draft", mine: true }, { signal });
      const known = new Set(local.map((d) => d.client_id));
      remote = res.items.filter((i) => !known.has(i.client_id));
    }
    const state = syncState();
    fill(panel, 
      h("p", { class: "callout" }, icon(store.online ? "sync" : "offline"),
        store.online ? `온라인 · 동기화 대기 ${queued}건${state.lastSyncAt ? ` · 마지막 동기화 ${new Date(state.lastSyncAt).toTimeString().slice(0, 5)}` : ""}`
          : "오프라인 · 작성과 제출은 이 기기에 저장되고, 연결되면 자동으로 서버에 올라갑니다. 서버 저장 전에는 완료로 표시하지 않습니다."),
      queued && store.online ? h("div", null, h("button", { class: "btn btn-sm", type: "button", onClick: () => kick().then(draftsPanel) }, icon("sync"), "지금 동기화")) : null,
      rows.length ? h("ul", { class: "list" }, rows) : emptyState({ title: "이 기기에 작성 중인 점검이 없습니다",
        action: h("button", { class: "btn btn-sm", type: "button", onClick: () => select("start") }, "설비 고르기") }),
      remote.length ? h("section", { class: "section" }, h("h2", null, "다른 기기에서 작성 중"),
        h("ul", { class: "list" }, remote.map((i) => h("li", null, h("div", { class: "row" },
          h("div", { class: "row-main" }, h("span", { class: "row-title" }, i.asset_name), h("span", { class: "row-sub" }, `${i.site_name} · ${fmtDateTime(i.updated_at)}`)),
          h("div", { class: "row-side" }, h("button", { class: "btn btn-sm", type: "button", onClick: async () => {
            const detail = await api.get(`api/inspections/${i.id}`);
            const d = await drafts.fromServer(detail);
            navigate(`/draft/${d.local_id}`);
          } }, "이 기기로 가져오기"))))))) : null,
    );
  }

  // --- 제출 기록
  async function recordsPanel(scope = "mine") {
    const res = await api.get("api/inspections", { status: "submitted,reviewed,approved,rejected", mine: scope === "mine" || undefined }, { signal });
    fill(panel, 
      seg({ label: "범위", value: scope, options: [{ value: "mine", label: "내 기록" }, { value: "all", label: "팀 전체" }], onChange: (v) => recordsPanel(v) }),
      res.items.length ? h("ul", { class: "list" }, res.items.map(inspectionRow))
        : emptyState({ title: "제출된 점검이 없습니다" }));
  }

  // --- 검토·승인
  async function reviewPanel() {
    const parts = [];
    if (store.has("reviewer")) {
      const res = await api.get("api/inspections", { status: "submitted" }, { signal });
      const mine = res.items.filter((i) => i.inspector_id !== store.user.id);
      parts.push(h("section", { class: "section" }, h("h2", null, `검토 대기 ${mine.length}건`),
        h("p", { class: "field-hint" }, "자신이 작성한 점검은 검토할 수 없습니다."),
        mine.length ? h("ul", { class: "list" }, mine.map(inspectionRow)) : emptyState({ title: "검토할 점검이 없습니다" })));
    }
    if (store.has("admin")) {
      const res = await api.get("api/reports", { status: "pending" }, { signal });
      parts.push(h("section", { class: "section" }, h("h2", null, `승인 대기 보고서 ${res.items.length}건`),
        res.items.length ? h("ul", { class: "list" }, res.items.map((r) => h("li", null, h("a", { class: "row", href: `#/inspections/${r.inspection_id}` },
          h("div", { class: "row-main" }, h("span", { class: "row-title" }, `${r.asset_name} · 보고서 v${r.version}`),
            h("span", { class: "row-sub" }, `${r.site_name} · 점검 ${r.inspector_name} · 검토 ${r.requested_by_name} · ${fmtDateTime(r.requested_at)}`)),
          h("div", { class: "row-side" }, badge("승인 대기", "warn"))))))
          : emptyState({ title: "승인할 보고서가 없습니다" })));
    }
    fill(panel, ...parts);
  }

  // --- 지적사항
  async function findingsPanel(scope = "open") {
    const res = await api.get("api/findings", { status: scope === "all" ? undefined : scope }, { signal });
    const today = localDate();
    fill(panel, 
      seg({ label: "상태", value: scope, options: [{ value: "open", label: "미조치" }, { value: "resolved", label: "조치 완료" }, { value: "all", label: "전체" }],
        onChange: (v) => findingsPanel(v) }),
      res.items.length ? h("ul", { class: "list" }, res.items.map((f) => h("li", null, h("a", { class: "row", href: `#/inspections/${f.inspection_id}` },
        h("div", { class: "row-main" }, h("span", { class: "row-title" }, `${f.asset_name} · ${f.item_label || f.item_key}`),
          h("span", { class: "row-sub" }, `${f.assignee_name} · ${f.site_name} · ${f.description}`)),
        h("div", { class: "row-side" }, f.status === "resolved" ? badge("조치 완료", "ok", "check") : dueBadge(f.due_date, today, false))))))
        : emptyState({ title: scope === "open" ? "미조치 지적이 없습니다" : "지적 기록이 없습니다" }));
  }

  onCleanup(on("drafts", () => { if (tab === "drafts") draftsPanel().catch(() => {}); }));
  onCleanup(on("rev", () => { if (tab !== "start" && tab !== "drafts") renderPanel(); }));
  renderTabs();
  await renderPanel();
}

export function inspectionRow(i) {
  return h("li", null, h("a", { class: "row", href: `#/inspections/${i.id}` },
    h("div", { class: "row-main" }, h("span", { class: "row-title" }, i.asset_name),
      h("span", { class: "row-sub" }, `${i.site_name} · ${i.inspector_name} · ${fmtDateTime(i.submitted_at)}${i.bad_count ? ` · 불량 ${i.bad_count}` : ""}${i.corrects_id ? ` · 정정본(원본 #${i.corrects_id})` : ""}`)),
    h("div", { class: "row-side" }, inspectionBadge(i.status))));
}
