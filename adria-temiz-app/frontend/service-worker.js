const CACHE = 'cisto-v4';
const ASSETS = [
  '/index.html', '/manifest.json',
  '/icon-service-checkin.png', '/icon-service-deep.png', '/icon-service-office.png', '/icon-service-common-area.png',
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

// "Siparişin onaylandı" gibi bildirimler - tarayıcı/uygulama kapalı olsa
// bile (desteklenen platformlarda) bu event tetiklenir ve bildirim gösterilir.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { /* yoksay */ }
  const title = data.title || 'MICISTO';
  const options = {
    body: data.body || 'Yeni bir bildirimin var.',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { jobId: data.jobId || null, type: data.type || null },
    vibrate: [200, 100, 200],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Bildirime tıklayınca uygulamayı Siparişlerim sekmesiyle açar/öne getirir.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = '/index.html?openJobs=1';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.postMessage({ type: 'OPEN_JOBS' });
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
