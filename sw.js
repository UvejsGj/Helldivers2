/**
 * Service worker.
 *
 * Caches the app shell so the dashboard opens with no connection at all — the
 * stored war snapshot in localStorage then fills it with the last known
 * positions, which is the whole reason offline is worth supporting here.
 *
 * The API is never cached. Stale war data served silently from a cache would be
 * indistinguishable from live data, and the app already has an honest,
 * timestamped staleness path of its own.
 */

const VERSION = 'v1';
const CACHE = `sew-shell-${VERSION}`;

/** Relative, so the worker works under a project path like /Helldivers2/. */
const SHELL = [
  './',
  './index.html',
  './css/styles.css',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './js/app.js',
  './js/config.js',
  './js/api.js',
  './js/state.js',
  './js/normalize.js',
  './js/format.js',
  './js/mock.js',
  './js/trend.js',
  './js/events.js',
  './js/audio.js',
  './js/priority.js',
  './js/report.js',
  './js/ui/map.js',
  './js/ui/majorOrder.js',
  './js/ui/planetPanel.js',
  './js/ui/stats.js',
  './js/ui/dispatches.js',
  './js/ui/bulletins.js',
  './js/ui/status.js',
  './js/ui/alerts.js',
  './js/ui/boot.js',
  './js/ui/search.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Individually, not addAll: one 404 would otherwise reject the whole
    // install and leave the app with no worker at all.
    await Promise.all(SHELL.map((url) => cache.add(url).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith('sew-shell-') && name !== CACHE)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Never intercept the war feed, or anything off this origin.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/api/')) return;

  event.respondWith((async () => {
    // Network first, so a deploy is picked up as soon as there is a connection;
    // the cache is the fallback rather than the default.
    try {
      const response = await fetch(request);
      if (response && response.ok) {
        const cache = await caches.open(CACHE);
        cache.put(request, response.clone());
      }
      return response;
    } catch {
      const cached = await caches.match(request);
      if (cached) return cached;
      // A navigation that misses still gets the shell, so deep links work offline.
      if (request.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      throw new Error('offline and uncached');
    }
  })());
});
