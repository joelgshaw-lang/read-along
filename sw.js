// Keeps the reader working offline. Books themselves live in the page's own storage.
const CACHE = 'readalong-v13';
const FILES = ['./', 'index.html', 'app.js?v=13', 'listen.js?v=13', 'kokoro-worker.js?v=13', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== 'readalong-cdn').map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Network first (so updates arrive when online), falling back to the saved copy offline.
// 'no-cache' asks GitHub every time, so the page and app.js never come from different versions.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // The studio voice program (from jsDelivr): keep a copy so it works offline. The voice
  // model itself is kept by the program in its own store.
  if (new URL(e.request.url).hostname === 'cdn.jsdelivr.net') {
    e.respondWith(caches.open('readalong-cdn').then((c) => c.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok) c.put(e.request, res.clone());
      return res;
    }))));
    return;
  }
  if (new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html')))
  );
});
