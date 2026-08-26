const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { VAPID_PUBLIC_KEY, sendPushToUser } = require('../services/push');

const router = express.Router();

// Public - frontend'in push aboneliği oluştururken ihtiyacı olan anahtar.
router.get('/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

router.use(requireAuth);

router.post('/subscribe', (req, res) => {
  const { endpoint, keys } = req.body;
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
    return res.status(400).json({ error: 'Geçersiz abonelik verisi.' });
  }
  const existing = db.prepare('SELECT id FROM push_subscriptions WHERE endpoint = ?').get(endpoint);
  // NOT: "ilk kez abone oluyor mu" kontrolünü INSERT/UPDATE'ten ÖNCE
  // yapıyoruz - sonra yaparsak az önce eklediğimiz kaydı da sayıp yanlış
  // sonuç verir. Personel başvurusu onaylandığı ANDA (henüz hesabı/cihazı
  // olmadığı için) push gönderilemiyordu - bunun yerine gerçekten ilk kez
  // bildirim izni verip abone olduğu bu an, "hoş geldin" bildirimi için
  // güvenilir bir tetikleyici.
  const isFirstEverSubscription = !existing
    && db.prepare('SELECT COUNT(*) AS c FROM push_subscriptions WHERE user_id = ?').get(req.user.id).c === 0;

  if (existing) {
    db.prepare('UPDATE push_subscriptions SET user_id = ?, p256dh = ?, auth = ? WHERE endpoint = ?')
      .run(req.user.id, keys.p256dh, keys.auth, endpoint);
  } else {
    db.prepare('INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?, ?)')
      .run(uuid(), req.user.id, endpoint, keys.p256dh, keys.auth);
  }
  res.status(201).json({ message: 'Abonelik kaydedildi.' });

  if (isFirstEverSubscription && req.user.accountType === 'staff') {
    sendPushToUser(req.user.id, {
      title: 'MICISTORad\'a hoş geldin! 👋',
      body: 'Artık iş tekliflerini anlık olarak buradan alacaksın.',
      type: 'welcome',
    }).catch((err) => console.error('Hoş geldin bildirimi hata:', err));
  }
});

router.post('/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  if (endpoint) db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  res.json({ message: 'Abonelik kaldırıldı.' });
});

module.exports = router;
