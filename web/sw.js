// Service worker: the app shell stays usable offline (inspections in the
// field). Network-first so a deploy is picked up on the next online load;
// the cache is only a fallback. API and signed files are never cached here —
// offline data lives in IndexedDB, managed by js/offline/.
const CACHE = "elec-board-shell-v1";
const SHELL = ["./", "index.html", "css/app.css", "js/app.js", "manifest.webmanifest", "icons/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function isShellRequest(url) {
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return false;
  const rest = url.pathname.slice(scope.pathname.length);
  return !rest.startsWith("api/") && !rest.startsWith("files/");
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (!isShellRequest(url)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(req.mode === "navigate" ? "./" : req, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(req.mode === "navigate" ? "./" : req, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});
