/* Storm File service worker — caches the app shell so the log works offline. */
const CACHE = "stormfile-v1";
const PRECACHE = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./sw.js",
  "./manifest.webmanifest",
  "./favicon.svg",
  "./log/",
  "./log/index.html",
  "./kit/",
  "./kit/index.html",
  "./about/",
  "./about/index.html",
  "./disclaimer/",
  "./disclaimer/index.html"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE.map((u) => new URL(u, self.registration.scope).toString()))).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    caches.match(req).then((cached) => {
      const fetchAndCache = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fetchAndCache;
    })
  );
});
