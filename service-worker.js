const CACHE_VERSION = 'v5';
const APP_SHELL_CACHE = `app-shell-${CACHE_VERSION}`;
const DATA_CACHE = `data-${CACHE_VERSION}`;

const APP_SHELL_FILES = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(APP_SHELL_CACHE).then((c) => c.addAll(APP_SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys
        .filter(k => ![APP_SHELL_CACHE, DATA_CACHE].includes(k))
        .map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // ⛔️ Ignorar todo lo que no sea http(s) (p. ej. chrome-extension://)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return;
  }

  const isOpenMeteo = url.hostname.endsWith('open-meteo.com');
  const isCarto = /\.basemaps\.cartocdn\.com$/.test(url.hostname);

  if (isOpenMeteo) {
    // Red primero + cache de respaldo
    event.respondWith((async () => {
      try {
        const fresh = await fetch(event.request, { cache: 'no-store' });
        if (event.request.method === 'GET' && fresh.ok) {
          const cache = await caches.open(DATA_CACHE);
          await cache.put(event.request, fresh.clone());
        }
        return fresh;
      } catch (e) {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        return new Response(JSON.stringify({ offline: true }), {
          headers: { 'Content-Type': 'application/json' }, status: 200
        });
      }
    })());
    return;
  }

  if (isCarto) {
    // Tiles siempre online
    event.respondWith(fetch(event.request));
    return;
  }

  // App shell: cache-first (solo GET y http(s))
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((resp) => {
        if (event.request.method === 'GET' && resp.status === 200 && resp.type !== 'opaque') {
          const clone = resp.clone();
          caches.open(APP_SHELL_CACHE).then((c) => c.put(event.request, clone));
        }
        return resp;
      }).catch(() => {
        if (event.request.mode === 'navigate') return caches.match('./index.html');
      });
    })
  );
});
