// Boot: auth gate, shell (sidebar / tab bar), routes, sync status, live refresh.
import { api, onUnauthorized, setCsrf } from "./api.js";
import { fill, h, icon } from "./dom.js";
import { drafts, getBundle, kick, refreshBundle, syncState, watchConnectivity } from "./offline/sync.js";
import { currentPath, route, startRouter } from "./router.js";
import { emit, loadReference, on, store } from "./store.js";
import { badge } from "./ui.js";
import { renderInvite, renderLogin, renderSetup } from "./views/auth.js";
import { renderBoard } from "./views/board.js";
import { renderDashboard } from "./views/dashboard.js";
import { renderInspection } from "./views/inspection-detail.js";
import { renderInspectHome, renderInspectStart, renderQr } from "./views/inspect.js";
import { renderDraft } from "./views/inspect-run.js";
import { renderKnowledge } from "./views/knowledge.js";
import { renderKpi } from "./views/kpi.js";
import { renderSettings } from "./views/settings.js";
import { renderSite } from "./views/site.js";

const REV_POLL_MS = 15000;
const BUNDLE_REFRESH_MS = 10 * 60 * 1000;
const ME_CACHE_KEY = "eb-me";

// ---------------------------------------------------------------- theme

function effectiveTheme() {
  const t = document.documentElement.dataset.theme;
  if (t) return t;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyStoredTheme() {
  const t = localStorage.getItem("eb-theme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

function renderThemeButtons() {
  const next = effectiveTheme() === "dark" ? "light" : "dark";
  document.querySelectorAll("[data-theme-toggle]").forEach((b) => {
    const label = next === "dark" ? "어둡게" : "밝게";
    fill(b, icon(next === "dark" ? "moon" : "sun"), b.classList.contains("btn-icon") ? h("span", { class: "sr" }, label) : label);
    b.setAttribute("aria-label", `${label} 보기로 바꾸기`);
  });
}

function wireTheme() {
  document.querySelectorAll("[data-theme-toggle]").forEach((b) => b.addEventListener("click", () => {
    const next = effectiveTheme() === "dark" ? "light" : "dark";
    localStorage.setItem("eb-theme", next);
    applyStoredTheme();
    document.dispatchEvent(new CustomEvent("themechange"));
  }));
  document.addEventListener("themechange", renderThemeButtons);
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", renderThemeButtons);
  renderThemeButtons();
}

// ---------------------------------------------------------------- shell

function highlightNav(path) {
  const section = `/${path.split("/")[1] || ""}`;
  const key = section === "/draft" || section === "/q" || section === "/inspections" ? "/inspect" : section;
  document.querySelectorAll("[data-route]").forEach((a) => {
    if (a.dataset.route === key) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
}

async function renderSyncPill() {
  const list = await drafts.list().catch(() => []);
  const queued = list.filter((d) => d.status === "queued" || d.status === "syncing").length;
  const problems = list.filter((d) => d.status === "conflict" || d.status === "error").length;
  const state = syncState();
  let text;
  let mode;
  if (problems) { text = `확인 필요 ${problems}건`; mode = "problem"; }
  else if (!store.online) { text = queued ? `오프라인 · 대기 ${queued}건` : "오프라인"; mode = "offline"; }
  else if (queued || state.running) { text = state.running ? "동기화 중" : `동기화 대기 ${queued}건`; mode = "pending"; }
  else { text = "온라인"; mode = "online"; }
  document.querySelectorAll("[data-sync-pill]").forEach((el) => {
    el.dataset.state = mode;
    fill(el, icon(mode === "offline" ? "offline" : mode === "online" ? "check" : "sync", "icon icon-sm"), text);
  });
}

function renderRailUser() {
  const el = document.querySelector("[data-rail-user]");
  if (!el || !store.me) return;
  const labels = store.me.role_labels || {};
  fill(el, h("strong", null, store.user.name), `${store.me.org.name} · ${store.user.roles.map((r) => labels[r] || r).join("·")}`);
}

// ---------------------------------------------------------------- live refresh

function startRevPolling() {
  let busy = false;
  const poll = async () => {
    if (busy || document.hidden || !store.online) return;
    busy = true;
    try {
      const { rev } = await api.get("api/sync/rev");
      if (store.rev !== null && rev !== store.rev) {
        await loadReference().catch(() => {});
        emit("rev", rev);
      }
      store.rev = rev;
    } catch {
      /* offline or session gone — handled elsewhere */
    } finally {
      busy = false;
    }
  };
  setInterval(poll, REV_POLL_MS);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
  poll();
}

// ---------------------------------------------------------------- boot

function registerRoutes() {
  route("/", renderDashboard);
  route("/board", renderBoard);
  route("/inspect", renderInspectHome);
  route("/inspect/start", renderInspectStart);
  route("/q/:token", renderQr);
  route("/draft/:id", renderDraft);
  route("/inspections/:id", renderInspection);
  route("/kpi", renderKpi);
  route("/knowledge", renderKnowledge);
  route("/sites/:id", renderSite);
  route("/settings", renderSettings);
  route("/invite/:token", async (root) => {
    root.append(h("section", { class: "page page-narrow" }, h("div", { class: "state" }, h("h3", null, "이미 로그인되어 있습니다"),
      h("p", null, "초대 링크는 새 팀원이 로그인하지 않은 상태에서 엽니다."), h("a", { class: "btn btn-sm", href: "#/" }, "대시보드로"))));
  });
}

async function startApp(me, { offline = false } = {}) {
  store.me = me;
  if (me.csrf) setCsrf(me.csrf);
  const { csrf: _omit, ...cacheable } = me;
  localStorage.setItem(ME_CACHE_KEY, JSON.stringify(cacheable));
  document.body.dataset.auth = "in";
  renderRailUser();
  try {
    await loadReference();
  } catch {
    // Offline boot: fall back to the device bundle for members and sites.
    const bundle = await getBundle().catch(() => null);
    if (bundle) {
      store.members = bundle.members;
      store.sites = bundle.sites;
    }
  }
  registerRoutes();
  document.addEventListener("routechange", (e) => highlightNav(e.detail.path));
  on("drafts", renderSyncPill);
  on("sync", renderSyncPill);
  on("online", renderSyncPill);
  on("synced", renderSyncPill);
  renderSyncPill();
  highlightNav(currentPath());
  await startRouter(document.getElementById("main"));
  if (!offline) {
    startRevPolling();
    kick();
    refreshBundle().catch(() => {});
    setInterval(() => { if (store.online) refreshBundle().catch(() => {}); }, BUNDLE_REFRESH_MS);
  }
}

function showAuth(render) {
  document.body.dataset.auth = "out";
  render(document.getElementById("main"));
}

async function boot() {
  applyStoredTheme();
  wireTheme();
  document.querySelector("[data-skip]")?.addEventListener("click", () => document.getElementById("main").focus());
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  watchConnectivity();
  onUnauthorized(() => {
    localStorage.removeItem(ME_CACHE_KEY);
    showAuth((root) => renderLogin(root, () => location.reload(), { demo: document.body.dataset.demo === "true" }));
  });

  let state;
  try {
    state = await api.get("api/auth/state", {}, { quiet401: true });
  } catch (err) {
    const cached = localStorage.getItem(ME_CACHE_KEY);
    if (err.offline && cached) {
      store.online = false;
      await startApp(JSON.parse(cached), { offline: true });
      window.addEventListener("online", () => location.reload(), { once: true });
      return;
    }
    fill(document.getElementById("main"), h("section", { class: "page page-narrow" },
      h("div", { class: "state state-error", role: "alert" }, h("h3", null, "서버에 연결할 수 없습니다"), h("p", null, err.message),
        h("button", { class: "btn btn-sm", type: "button", onClick: () => location.reload() }, "다시 시도"))));
    return;
  }
  if (state.demo) {
    document.body.dataset.demo = "true";
    document.querySelectorAll(".brand").forEach((b) => b.append(badge("미리보기 데모", "warn")));
  }
  if (state.needs_setup) {
    showAuth((root) => renderSetup(root, () => location.reload()));
    return;
  }
  if (!state.me) {
    localStorage.removeItem(ME_CACHE_KEY); // logged out: never boot offline as the previous user
    const m = location.hash.match(/^#\/invite\/([^?]+)/);
    showAuth((root) => (m ? renderInvite(root, decodeURIComponent(m[1]), () => { location.hash = "#/"; location.reload(); })
      : renderLogin(root, () => location.reload(), { demo: state.demo })));
    return;
  }
  await startApp(state.me);
}

boot();
