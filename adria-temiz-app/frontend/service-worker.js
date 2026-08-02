const CACHE = 'cisto-v3';
const ASSETS = [
  '/index.html', '/manifest.json',
  '/icon-service-checkin.png', '/icon-service-deep.png', '/icon-service-office.png',
  '/icon-property-apartment.png', '/icon-property-house.png', '/icon-property-office.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// API çağrılarını (localhost:4000 veya prod backend) önbelleğe almıyoruz,
// sadece statik arayüz dosyalarını offline kullanılabilir yapıyoruz.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api')) return;

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
