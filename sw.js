/**
 * Service Worker con Auto-Update Automático
 * Cada vez que se modifiquen archivos, la versión en el móvil se actualizará sola.
 */

// ⚙️ Versión del caché — se actualiza automáticamente con el script bump-version.js
const CACHE_VERSION = 'v20260903-1329';
const CACHE_NAME = `smc-scanner-${CACHE_VERSION}`;

const STATIC_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './js/app.js',
  './js/scanner.js',
  './js/smc_detector.js',
  './js/binance_api.js',
  './js/trade_tracker.js',
  './js/binance_trade.js',
  './js/cloud_sync.js'
];

// ─────────────────────────────────────────────
// INSTALL: precachea todos los assets estáticos
// ─────────────────────────────────────────────
self.addEventListener('install', event => {
  console.log(`[SW] Instalando nueva versión: ${CACHE_NAME}`);
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting()) // Activa el nuevo SW inmediatamente
  );
});

// ─────────────────────────────────────────────
// ACTIVATE: elimina cachés antiguas y toma control
// ─────────────────────────────────────────────
self.addEventListener('activate', event => {
  console.log(`[SW] Activado: ${CACHE_NAME}`);
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key.startsWith('smc-scanner-') && key !== CACHE_NAME)
          .map(key => {
            console.log(`[SW] Eliminando caché antigua: ${key}`);
            return caches.delete(key);
          })
      )
    ).then(() => self.clients.claim()) // Toma control de todos los clientes abiertos
  );
});

// ─────────────────────────────────────────────
// FETCH: Network-first para HTML/JS/CSS (siempre frescos), Caché para iconos
// ─────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Las llamadas a APIs externas o proxy SIEMPRE van directo a la red
  if (url.hostname.includes('binance.com') || url.hostname.includes('discord.com') || url.pathname.startsWith('/proxy-binance')) {
    event.respondWith(
      fetch(event.request).catch(() => new Response('', { status: 503 }))
    );
    return;
  }

  // Para iconos y manifest: caché primero (raramente cambian)
  if (url.pathname.includes('/icons/') || url.pathname.includes('manifest.json')) {
    event.respondWith(
      caches.match(event.request).then(cached => cached || fetch(event.request))
    );
    return;
  }

  // Para HTML, JS y CSS: red primero → si falla usa caché (funciona offline)
  event.respondWith(
    fetch(event.request)
      .then(networkResponse => {
        // Si la respuesta es válida, actualiza el caché con la versión nueva
        if (networkResponse && networkResponse.status === 200) {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, responseClone));
        }
        return networkResponse;
      })
      .catch(() => {
        // Sin conexión: sirve desde caché
        return caches.match(event.request);
      })
  );
});

// ─────────────────────────────────────────────
// MESSAGE: Recibe la orden de actualizar desde la app
// ─────────────────────────────────────────────
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
