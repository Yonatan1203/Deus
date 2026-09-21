const CACHE = 'deus-control-v5';
const SHELL = ['/', '/app.css', '/app.js', '/dom.js', '/icons.js', '/ui.js', '/views/chat.js', '/views/agents.js', '/views/wardens.js', '/views/mcps.js', '/views/sessions.js', '/views/groups.js', '/views/tasks.js', '/views/channels.js', '/views/memory.js', '/views/containers.js', '/views/logs.js', '/views/system.js', '/views/config.js', '/views/debug.js', '/manifest.webmanifest', '/fonts/Geist-latin.woff2', '/fonts/GeistMono-latin.woff2', '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) return;
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
    if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
    return res;
  })));
});
