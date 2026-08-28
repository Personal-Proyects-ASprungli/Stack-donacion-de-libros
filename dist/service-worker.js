/* Stacks service worker.
 *
 * The shell (index.html, app.js) is fetched fresh first so a deploy lands
 * on the next launch without anyone bumping a version number by hand; the
 * cache is the fallback, and it takes over as soon as the network is slow
 * or gone, so the app still opens instantly on a train. Everything else
 * (icons, manifest) is served from cache and refreshed in the background.
 */

const CACHE = "stacks-v3";
const ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./manifest.webmanifest",
  "./icon.svg",
  "./icon-180.png",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
];

/* How long to wait for the network before falling back to a cached shell.
   Only applies when there IS something cached to fall back to. */
const NETWORK_TIMEOUT = 3000;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.all(ASSETS.map((url) => cache.add(url).catch(() => null)))
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

function store(req, res) {
  if (!res || !res.ok) return res;
  /* Clone before anyone reads the body, once per destination. */
  const forRequest = res.clone();
  /* A visit to "/" is cached under "/", which would leave the
     "./index.html" copy — our offline fallback for any other URL — frozen
     at whatever the install step precached. Keep both in step. */
  const forShell = req.mode === "navigate" ? res.clone() : null;
  caches.open(CACHE).then((c) => {
    c.put(req, forRequest).catch(() => {});
    if (forShell) c.put("./index.html", forShell).catch(() => {});
  });
  return res;
}

/* Race the network against a timer, but only when a cached copy exists —
   with nothing cached, waiting is better than failing. */
function raceNetwork(req, cached) {
  const network = fetch(req).then((res) => store(req, res));
  if (!cached) return network;
  return new Promise((resolve) => {
    let settled = false;
    const win = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const timer = setTimeout(() => win(cached), NETWORK_TIMEOUT);
    network.then(
      (res) => { clearTimeout(timer); win(res); },
      () => { clearTimeout(timer); win(cached); }
    );
  });
}

async function freshFirst(req) {
  const cached =
    (await caches.match(req)) ||
    (req.mode === "navigate" ? await caches.match("./index.html") : null);
  try {
    return await raceNetwork(req, cached);
  } catch (err) {
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(req) {
  const cached = await caches.match(req);
  const network = fetch(req)
    .then((res) => store(req, res))
    .catch(() => cached);
  return cached || network;
}

/* The app shell: the two files a deploy actually changes. */
const SHELL = /(^|\/)(index\.html|app\.js)$/;

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // never cache identify POSTs
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Gemini, Open Library: straight through

  const isShell = req.mode === "navigate" || url.pathname === "/" || SHELL.test(url.pathname);
  event.respondWith(isShell ? freshFirst(req) : cacheFirst(req));
});
