// LoopSmith Studio service worker: makes the app installable and keeps the last
// good copy of the editor so a phone on the hotspot opens it instantly. Network first —
// the pedal link itself is a live WebSocket and is never cached.
const CACHE = 'gls-studio-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/') || url.pathname === '/ws' ||
      url.pathname.startsWith('/library/')) return;
  e.respondWith(
    fetch(e.request).then(r => {
      if (r.ok && SHELL.includes(url.pathname)) {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      }
      return r;
    }).catch(() => caches.match(e.request).then(m => m || Response.error()))
  );
});
