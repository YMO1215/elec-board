// Hash router: "#/path/:param?query". Hash routing keeps every screen
// reachable offline from the cached shell and works under any URL prefix.
const routes = [];
let mount = null;
let current = null;

export function route(pattern, render) {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/:[a-zA-Z]+/g, (m) => { keys.push(m.slice(1)); return "([^/]+)"; })}$`);
  routes.push({ pattern, re, keys, render });
}

export function parseHash(hash = location.hash) {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const [path, search = ""] = raw.split("?");
  return { path: path || "/", query: Object.fromEntries(new URLSearchParams(search)) };
}

export function navigate(path, query) {
  const qs = query ? new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== "")).toString() : "";
  location.hash = `#${path}${qs ? `?${qs}` : ""}`;
}

/** Update the query string without re-rendering (filters, tabs). */
export function setQuery(patch) {
  const { path, query } = parseHash();
  const next = { ...query, ...patch };
  const qs = new URLSearchParams(Object.entries(next).filter(([, v]) => v !== undefined && v !== null && v !== "")).toString();
  history.replaceState(null, "", `#${path}${qs ? `?${qs}` : ""}`);
}

export function currentPath() {
  return parseHash().path;
}

async function render() {
  const { path, query } = parseHash();
  if (!path.startsWith("/")) return; // plain anchors are not routes
  for (const r of routes) {
    const m = path.match(r.re);
    if (!m) continue;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    current?.abort();
    const controller = new AbortController();
    const cleanups = [];
    controller.signal.addEventListener("abort", () => cleanups.forEach((fn) => fn()));
    current = controller;
    mount.replaceChildren();
    document.dispatchEvent(new CustomEvent("routechange", { detail: { path, pattern: r.pattern } }));
    try {
      await r.render(mount, { params, query, signal: controller.signal, onCleanup: (fn) => cleanups.push(fn) });
    } catch (err) {
      if (err.name !== "AbortError") throw err;
    }
    return;
  }
  navigate("/");
}

export function startRouter(root) {
  mount = root;
  window.addEventListener("hashchange", render);
  return render();
}

export function rerender() {
  return render();
}
