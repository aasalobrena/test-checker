/* Service worker: permite usar la app sin conexión tras la primera visita. */
const CACHE = 'corrector-v1.2.0';
const ASSETS = [
  './',
  'index.html',
  'css/style.css',
  'js/app.js',
  'js/omr.js',
  'js/worker.js',
  'vendor/opencv.js',
  'vendor/qrcode.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'plantilla.pdf',
  'plantilla-5-opciones.pdf',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Red primero para el código de la app (para recibir actualizaciones),
// caché primero para OpenCV (pesa ~10 MB y no cambia).
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  if (req.url.includes('/vendor/')) {
    e.respondWith(caches.match(req).then((r) => r || fetch(req).then((resp) => {
      const copy = resp.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
      return resp;
    })));
    return;
  }
  e.respondWith(
    // no-cache: siempre se pregunta al servidor si hay versión nueva
    fetch(req, { cache: 'no-cache' }).then((resp) => {
      if (resp.ok) { const copy = resp.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return resp;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('index.html')))
  );
});
