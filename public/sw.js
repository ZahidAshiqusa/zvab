'use strict';

const CACHE_NAME = 'zaid-ashiq-v5-github-only';

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then((windowClients) => {
        for (const client of windowClients) {
          try {
            client.navigate(client.url);
          } catch (_) {}
        }
      })
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Always bypass cache (Network-Only) for HTML navigation, login, OAuth, and API routes
  if (
    req.mode === 'navigate' ||
    url.pathname === '/' ||
    url.pathname === '/index.html' ||
    url.pathname === '/login' ||
    url.pathname === '/login.html' ||
    url.pathname === '/sw.js' ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/auth/')
  ) {
    event.respondWith(
      fetch(req, { cache: 'no-store' }).catch(() => fetch(req))
    );
    return;
  }

  // Network-first for all other static assets
  event.respondWith(
    fetch(req).catch(() => caches.match(req))
  );
});
