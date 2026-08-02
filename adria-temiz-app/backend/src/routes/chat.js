const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Kullanıcının kendi destek konuşmasını getirir.
router.get('/messages', (req, res) => {
  const rows = db
    .prepare('SELECT * FROM chat_messages WHERE user_id = ? ORDER BY created_at ASC')
    .all(req.user.id);
  res.json(rows);
});

// Kullanıcı bir mesaj gönderir (sender='user'). Personel paneli
// yazıldığında admin'in sender='admin' ile yanıt vermesi için ayrı bir
// endpoint eklenecek.
router.post('/messages', (req, res) => {
  const { message } = req.body;
  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Mesaj boş olamaz.' });
  }
  const id = uuid();
  db.prepare(
    `INSERT INTO chat_messages (id, user_id, sender, message) VALUES (?, ?, 'user', ?)`
  ).run(id, req.user.id, message.trim());
  res.status(201).json(db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(id));
});

module.exports = router;
