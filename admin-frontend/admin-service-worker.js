// MICISTOMan Service Worker
//
// ONEMLI: CACHE_VERSION'i her onemli guncellemede DEGISTIR (orn. 'v2', 'v3'...).
// Cache-first strateji sayfa navigasyonlarinda kullanilmaz (asagida) - boylece
// admin panelin en guncel surumu her acilista agdan tazelenir, eski surumde
// takili kalinmaz.
const CACHE_VERSION = 'micistoman-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting(); // yeni service worker'i beklemeden hemen devreye al
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Sayfa navigasyonlari (paneli acma/yenileme) - HER ZAMAN agdan taze cek.
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

  // Diger statik dosyalar (ikonlar vb.) - once ag, olmazsa onbellek.
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
// jobs.js'teki notifyAdminsOfNewOrder() buraya 'new_order' tipinde push
// gonderiyor. Panel kapali/arka plandayken de admin haberdar olsun diye.

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }

  const title = data.title || 'MICISTOMan';
  const options = {
    body: data.body || '',
    icon: '/icon-micisto-512.png',
    badge: '/icon-micisto-512.png',
    data: { jobId: data.jobId || null, type: data.type || null },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const jobId = event.notification.data && event.notification.data.jobId;

  event.waitUntil(
    (async () => {
      const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      // Panel zaten aciksa, sekmeye odaklan.
      for (const client of allClients) {
        if ('focus' in client) {
          client.postMessage({ type: 'OPEN_BOOKING', jobId });
          return client.focus();
        }
      }
      // Panel kapaliysa, acik sekilde baslat.
      if (clients.openWindow) {
        return clients.openWindow('/index.html');
      }
    })()
  );
});
