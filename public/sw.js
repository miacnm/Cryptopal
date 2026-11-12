// Lets CryptoPal install as an app.
// - The face check files (about 8 MB) are kept on the phone, so they load instantly after the first time.
// - Balances and payments always use the network (/api is never cached).
// - The rest of the app loads from the network when it can, from the phone when offline.
const FACE = 'cp-face-1.7.15', SHELL = 'cp-shell-1';
self.addEventListener('install', e => e.waitUntil(caches.open(SHELL).then(c => c.addAll(['/', '/app.js', '/face.js', '/style.css']).catch(() => {})).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('cp-') && k !== FACE && k !== SHELL).map(k => caches.delete(k)))).then(() => self.clients.claim())
));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/') || u.pathname === '/manifest.webmanifest') return;
  if (u.pathname.startsWith('/face-api/')) {
    e.respondWith(caches.open(FACE).then(async c => (await c.match(u.pathname)) || fetch(e.request).then(r => { if (r.ok) c.put(u.pathname, r.clone()).catch(() => {}); return r; })));
    return;
  }
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok && !u.search) { const copy = r.clone(); caches.open(SHELL).then(c => c.put(e.request, copy)); }
    return r;
  }).catch(async () => (await caches.match(e.request, { ignoreSearch: true })) || (await caches.match('/'))));
});
