/* Primo service worker: keeps the app opening instantly and working offline.
   Never touches /api/ so points are always fresh. Bump VERSION when you change files. */
const VERSION = 'primo-v9';
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'favicon.ico', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png', 'phenodex/index.html', 'config.js'];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if(req.method !== 'GET') return;
  if(url.origin === location.origin && url.pathname.includes('/api/')) return;
  if(req.mode === 'navigate' && !url.pathname.includes('/phenodex/')){
    e.respondWith(fetch(req).then(r => { const c = r.clone(); caches.open(VERSION).then(x => x.put('index.html', c)); return r; }).catch(() => caches.match('index.html')));
    return;
  }
  if(url.origin === location.origin || /(^|\.)fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)){
    e.respondWith(caches.match(req).then(hit => {
      const net = fetch(req).then(r => { if(r && (r.ok || r.type === 'opaque')){ const c = r.clone(); caches.open(VERSION).then(x => x.put(req, c)); } return r; }).catch(() => hit);
      return hit || net;
    }));
  }
});
