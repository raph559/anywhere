'use strict';
const CACHE = 'anywhere-shell-v15';
const ASSETS = ['/', '/index.html', '/styles.css', '/app.js', '/manifest.webmanifest', '/icon.svg', '/mark.svg', '/fonts/source-serif-4-latin.woff2', '/fonts/source-serif-4-latin-ext.woff2', '/icon-192.png', '/icon-512.png'];
self.addEventListener('install', (event) => { event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (event) => { event.waitUntil(caches.keys().then((names) => Promise.all(names.filter((name) => name.startsWith('anywhere-shell-') && name !== CACHE).map((name) => caches.delete(name)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Authenticated API calls always go directly to the network. No user data is cached.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match('/').then((cached) => cached || Response.error())));
    return;
  }
  if (!ASSETS.includes(url.pathname)) return;
  event.respondWith(fetch(event.request).then((response) => {
    if (response.ok && response.type === 'basic') { const copy = response.clone(); caches.open(CACHE).then((cache) => cache.put(url.pathname, copy)); }
    return response;
  }).catch(() => caches.match(url.pathname).then((cached) => cached || Response.error())));
});
