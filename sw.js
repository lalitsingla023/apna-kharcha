const CACHE_NAME = 'apna-kharcha-v4-modal-pdf-reliable';
const APP_SHELL = ['./', './index.html', './style.css', './app.js', './manifest.json'];
const OPTIONAL_ASSETS = ['./icon-192.png', './icon-512.png'];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Required app files must be cached; optional icons must never block an update.
    await cache.addAll(APP_SHELL);
    await Promise.all(OPTIONAL_ASSETS.map(async path => {
      try {
        const response = await fetch(path, { cache: 'no-store' });
        if (response.ok) await cache.put(path, response);
      } catch (_) { /* optional icon not deployed yet */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith('apna-kharcha-') && key !== CACHE_NAME).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const isAppAsset = request.mode === 'navigate' || ['script', 'style'].includes(request.destination) ||
    /\/(manifest\.json|icon-192\.png|icon-512\.png)$/.test(url.pathname);
  if (!isAppAsset) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      const fresh = await fetch(request, { cache: 'no-store' });
      if (fresh && fresh.ok) {
        const key = request.mode === 'navigate' ? './index.html' : request;
        await cache.put(key, fresh.clone());
      }
      return fresh;
    } catch (error) {
      return (await cache.match(request)) || (await cache.match('./index.html')) ||
        new Response('Apna Kharcha is unavailable offline. Reconnect and reload.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) if ('focus' in client) return client.focus();
    if (self.clients.openWindow) return self.clients.openWindow('./');
  })());
});
