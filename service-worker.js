const CACHE_VERSION = 'v7';
const APP_SHELL_CACHE = `app-shell-${CACHE_VERSION}`;
const DATA_CACHE = `data-${CACHE_VERSION}`;

self.addEventListener('install', (event) => {
  // No precacheamos archivos con rutas fijas para evitar desajustes con ?v=7
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
  const { request } = event;
  const url = new URL(request.url);

  // Ignorar esquemas no http(s) (ej. chrome-extension://)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  const isGet = request.method === 'GET';
  const sameOrigin = url.origin === self.location.origin;

  const isOpenMeteo = /(^|\.)open-meteo\.com$/.test(url.hostname);
  const isCarto = /\.basemaps\.cartocdn\.com$/.test(url.hostname);

  // 1) Datos: network-first con fallback a caché
  if (isOpenMeteo && isGet) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request, { cache: 'no-store' });
        if (fresh.ok) {
          const cache = await caches.open(DATA_CACHE);
          cache.put(request, fresh.clone());
        }
        return fresh;
      } catch {
        const cached = await caches.match(request);
        return cached || new Response(JSON.stringify({ offline: true }), {
          headers: { 'Content-Type': 'application/json' }, status: 200
        });
      }
    })());
    return;
  }

  // 2) Tiles de mapa: siempre online
  if (isCarto) {
    event.respondWith(fetch(request));
    return;
  }

  // 3) App shell (HTML/CSS/JS/íconos): cache-first con actualización en bg
  if (isGet && sameOrigin) {
    event.respondWith((async () => {
      const cache = await caches.open(APP_SHELL_CACHE);
      const cached = await cache.match(request);
      const fetchAndUpdate = fetch(request).then((resp) => {
        if (resp.ok && resp.type !== 'opaque') cache.put(request, resp.clone());
        return resp;
      }).catch(() => cached);

      // Si hay caché, devuélvelo ya y actualiza en segundo plano
      return cached || fetchAndUpdate;
    })());
    return;
  }

  // Resto: default
  event.respondWith(fetch(request));
});
