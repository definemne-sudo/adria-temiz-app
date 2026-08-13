// MICISTO Service Worker
//
// ÖNEMLİ: CACHE_VERSION'ı her önemli güncellemede DEĞİŞTİR (örn. 'v2', 'v3'...).
// Bu numara değişmediği sürece tarayıcı eski dosyaları önbellekten sunmaya
// devam edebilir - "en son güncellediğim tasarım gelmiyor" sorununun kök
// nedeni tam olarak buydu: eski service worker sonsuza kadar aynı önbelleği
// kullanıyor, hiç kontrol etmiyordu.
const CACHE_VERSION = 'micisto-v2';

// index.html TEK dosyalık bir uygulama (tüm kod içinde) - bu yüzden onu
// ASLA "cache-first" sunmuyoruz. Her ziyarette önce ağdan taze sürüm
// istiyoruz; ağ başarısız olursa (offline) önbellekteki son bilinen
// sürümü gösteriyoruz. Böylece kullanıcı HER uygulamayı açtığında en
// güncel hâli görür, ama internet yoksa da tamamen boş ekranla kalmaz.
self.addEventListener('install', (event) => {
  self.skipWaiting(); // yeni service worker'ı beklemeden hemen devreye al
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Eski sürüm önbelleklerini temizle
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)));
      await self.clients.claim(); // açık sekmeleri de hemen bu sürüme bağla
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Sayfa navigasyonları (uygulamayı açma/yenileme) - HER ZAMAN ağdan taze
  // çek. Bu, "güncel özellikler gelmiyor" sorununu doğrudan çözen kısım.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached || caches.match('/index.html')))
    );
    return;
  }

  // Diğer statik dosyalar (ikonlar vb.) - önce ağ, olmazsa önbellek.
  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req))
  );
});

// --- Push Bildirimleri -------------------------------------------------

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }

  const title = data.title || 'MICISTO';
  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { jobId: data.jobId || null, type: data.type || null, url: data.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const jobId = event.notification.data && event.notification.data.jobId;

  event.waitUntil(
    (async () => {
      const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      // Uygulama zaten açıksa, sekmeye odaklan ve içeride yönlendir.
      for (const client of allClients) {
        if ('focus' in client) {
          client.postMessage({ type: 'OPEN_OFFER', jobId });
          return client.focus();
        }
      }
      // Uygulama kapalıysa, Siparişlerim sekmesi açık şekilde başlat.
      if (clients.openWindow) {
        return clients.openWindow('/index.html?openJobs=1');
      }
    })()
  );
});
