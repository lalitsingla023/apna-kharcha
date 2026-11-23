const CACHE_NAME = 'apna-kharcha-v9-monetra-brand';
const APP_SHELL = [
  './',
  './index.html',
  './style.css?v=4.0.0',
  './app.js?v=4.0.0',
  './manifest.json?v=4.0.0'
];
const OPTIONAL_ASSETS = ['./icon-192.png?v=4.0.0', './icon-512.png?v=4.0.0'];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL);
    await Promise.all(OPTIONAL_ASSETS.map(async path => {
      try {
        const response = await fetch(path, { cache: 'no-store' });
        if (response.ok) await cache.put(path, response);
      } catch (_) { /* optional icons do not block app updates */ }
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
      // Prefer the deployed revision whenever online. This prevents a successful
      // GitHub Pages update from being hidden by an older cached app.js.
      const fresh = await fetch(request, { cache: 'no-store' });
      if (fresh && fresh.ok) {
        const key = request.mode === 'navigate' ? './index.html' : request;
        await cache.put(key, fresh.clone());
      }
      return fresh;
    } catch (error) {
      const cached = await cache.match(request) || (request.mode === 'navigate' ? await cache.match('./index.html') : null);
      return cached || new Response('MONETRA is unavailable offline. Reconnect and reload.', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
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
