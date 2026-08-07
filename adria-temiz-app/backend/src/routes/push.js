const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { VAPID_PUBLIC_KEY } = require('../services/push');

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
  if (existing) {
    db.prepare('UPDATE push_subscriptions SET user_id = ?, p256dh = ?, auth = ? WHERE endpoint = ?')
      .run(req.user.id, keys.p256dh, keys.auth, endpoint);
  } else {
    db.prepare('INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?, ?)')
      .run(uuid(), req.user.id, endpoint, keys.p256dh, keys.auth);
  }
  res.status(201).json({ message: 'Abonelik kaydedildi.' });
});

router.post('/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  if (endpoint) db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  res.json({ message: 'Abonelik kaldırıldı.' });
});

module.exports = router;
