/*
 * Service worker: makes the installed app work with no network at all.
 *
 * The whole app is a handful of static files, so the shell is precached on
 * install and served cache-first. A background revalidation keeps the cache
 * fresh without ever making the user wait on the network.
 *
 * Bump CACHE when shipping a release so old shells are evicted.
 */
const CACHE = 'featherpad-v1';

const SHELL = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './js/highlighter.js',
  './js/search-worker.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // Individual misses must not fail the whole install.
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.match(req).then((hit) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        // Offline with nothing cached for this URL: a navigation still has
        // somewhere sensible to land.
        .catch(() => hit || (req.mode === 'navigate' ? caches.match('./index.html') : undefined));
      return hit || network;
    })
  );
});
