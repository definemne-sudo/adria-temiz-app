const CACHE = 'micistorad-v2';
const ASSETS = [
  '/index.html', '/manifest.json',
  '/icon-service-checkin.png', '/icon-service-deep.png', '/icon-service-office.png', '/icon-service-common-area.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).catch(() => {})
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

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request).catch(() => cached))
  );
});

// Sipariş teklifi bildirimi - tarayıcı/uygulama kapalı olsa bile (desteklenen
// platformlarda) bu event tetiklenir ve bildirim gösterilir.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { /* yoksay */ }
  const title = data.title || 'MICISTO';
  const options = {
    body: data.body || 'Yeni bir bildirimin var.',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { jobId: data.jobId || null, type: data.type || null },
    requireInteraction: true, // kabul/red karari verilene kadar ekranda kalsin
    vibrate: [200, 100, 200],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Bildirime tıklayınca uygulamayı ilgili işin teklif ekranıyla açar/öne getirir.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const jobId = event.notification.data && event.notification.data.jobId;
  const targetUrl = jobId ? `/index.html?offerJobId=${jobId}` : '/index.html';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.postMessage({ type: 'OPEN_OFFER', jobId });
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
