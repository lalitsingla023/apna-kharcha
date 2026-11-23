const CACHE_NAME = 'apna-kharcha-v3-modal-fix';
const APP_SHELL = ['./', './index.html', './style.css', './app.js', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Cache only same-origin app files. A CDN outage should never prevent installation.
    await cache.addAll(APP_SHELL);
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
  if (url.origin !== self.location.origin) return; // Let external fonts/libraries use the network normally.
  const isAppShellAsset = request.mode === 'navigate' || ['script', 'style'].includes(request.destination) || /\/(manifest\.json|icon-192\.png)$/.test(url.pathname);
  if (isAppShellAsset) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request, { cache: 'no-store' });
        if (fresh && fresh.ok) {
          const cache = await caches.open(CACHE_NAME);
          const cacheKey = request.mode === 'navigate' ? './index.html' : request;
          await cache.put(cacheKey, fresh.clone());
        }
        return fresh;
      } catch (error) {
        return (await caches.match(request)) || (await caches.match('./index.html')) || new Response('', { status: 504, statusText: 'App shell unavailable offline' });
      }
    })());
    return;
  }
  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    try {
      const fresh = await fetch(request);
      if (fresh && fresh.ok) (await caches.open(CACHE_NAME)).put(request, fresh.clone());
      return fresh;
    } catch (error) {
      return new Response('', { status: 504, statusText: 'Offline resource unavailable' });
    }
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientsList) {
      if ('focus' in client) return client.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow('./');
  })());
});
