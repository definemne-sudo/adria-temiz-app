// MICISTORad Service Worker
//
// ONEMLI: CACHE_VERSION'i her onemli guncellemede DEGISTIR (orn. 'v2', 'v3'...).
// Eski dosyada bu kontrol hic yoktu ve "cache-first" strateji kullaniliyordu -
// yani service worker index.html'i bir kere onbellege aldiktan sonra BIR DAHA
// HIC agdan kontrol etmiyordu. Bu, "guncel logo/tasarim gelmiyor" sorununun
// tam kok nedeniydi. Musteri uygulamasinda (frontend/) uyguladigimiz ayni
// duzeltmeyi burada da uyguluyoruz.
const CACHE_VERSION = 'micistorad-v2';

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

  // Sayfa navigasyonlari (uygulamayi acma/yenileme) - HER ZAMAN agdan taze
  // cek. Boylece kullanici HER acilista en guncel logo/tasarimi gorur.
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

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }

  const title = data.title || 'MICISTORad';
  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
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
      // Uygulama zaten aciksa, sekmeye odaklan ve iceride teklif modalini ac.
      for (const client of allClients) {
        if ('focus' in client) {
          client.postMessage({ type: 'OPEN_OFFER', jobId });
          return client.focus();
        }
      }
      // Uygulama kapaliysa, teklif ekrani acik sekilde baslat.
      if (clients.openWindow) {
        return clients.openWindow(`/index.html?offerJobId=${jobId}`);
      }
    })()
  );
});
