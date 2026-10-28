// Service worker do Central.PDV: guarda a "casca" do aplicativo para abrir sem internet.
// Dados (vendas, produtos, caixa) nunca são guardados aqui: a API nunca passa pelo cache.
const CACHE = 'pdv-shell-v3';
const SHELL = ['/app', '/manifest.webmanifest', '/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin && url.pathname.startsWith('/api/')) return;
  // Telas do sistema (/app): tenta a rede; sem internet, abre a última versão guardada.
  if (req.mode === 'navigate') {
    if (!/^\/app(\/|$)/.test(url.pathname)) return;
    e.respondWith(fetch(req).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put('/app', copy)); return r; })
      .catch(() => caches.match('/app')));
    return;
  }
  // Arquivos com hash (/assets), ícones e fontes: cache primeiro.
  if ((url.origin === location.origin && (url.pathname.startsWith('/assets/') || /\.(png|webp|svg|webmanifest)$/.test(url.pathname)))
    || url.hostname.endsWith('fonts.googleapis.com') || url.hostname.endsWith('fonts.gstatic.com')) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((r) => {
      if (r.ok || r.type === 'opaque') { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return r;
    })));
  }
});
