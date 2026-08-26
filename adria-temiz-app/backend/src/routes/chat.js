const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Gecerli kanallar: 'support' (genel destek) ve 'boat_quote' (>=50ft tekne
// fiyat teklifi talepleri - genel destekten AYRI, kendi gelen kutusu).
// Gecersiz/bos bir deger gelirse guvenli varsayilan olan 'support'a duser.
function normalizeChannel(raw) {
  return raw === 'boat_quote' ? 'boat_quote' : 'support';
}

// Kullanıcının kendi destek konuşmasını getirir. ?channel= parametresiyle
// hangi kanalin (support / boat_quote) istendigi belirtilir - gonderilmezse
// 'support' varsayilir, boylece eski cagrilar (parametre gondermeyenler)
// otomatik olarak genel destege denk gelmeye devam eder.
router.get('/messages', (req, res) => {
  const channel = normalizeChannel(req.query.channel);
  const rows = db
    .prepare('SELECT * FROM chat_messages WHERE user_id = ? AND channel = ? ORDER BY created_at ASC')
    .all(req.user.id, channel);
  res.json(rows);
});

// Kullanıcı bir mesaj gönderir (sender='user'). Personel paneli
// yazıldığında admin'in sender='admin' ile yanıt vermesi için ayrı bir
// endpoint eklenecek.
router.post('/messages', (req, res) => {
  const { message } = req.body;
  const channel = normalizeChannel(req.body.channel);
  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Mesaj boş olamaz.' });
  }
  const id = uuid();
  db.prepare(
    `INSERT INTO chat_messages (id, user_id, sender, message, channel) VALUES (?, ?, 'user', ?, ?)`
  ).run(id, req.user.id, message.trim(), channel);
  res.status(201).json(db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(id));
});

module.exports = router;
