// Service worker mínimo: permite instalar o Central.PDV como aplicativo.
// Não guarda dados em cache: vendas e estoque sempre vêm do servidor.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
