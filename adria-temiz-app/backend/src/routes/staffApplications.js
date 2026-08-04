const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../db');

const router = express.Router();

// Kimlik doğrulama GEREKMİYOR - başvuran kişi henüz hesap açmamış,
// bu tamamen genel bir "iş başvurusu" formu (Glovo/Wolt'un "Kurye ol"
// formuna benzer). Admin paneli yazıldığında buradan onaylanıp gerçek
// bir 'staff' hesabına dönüştürülecek.
router.post('/', (req, res) => {
  const { name, phone, city, message } = req.body;
  if (!name || !phone) {
    return res.status(400).json({ error: 'İsim ve telefon numarası zorunlu.' });
  }
  const id = uuid();
  db.prepare(
    `INSERT INTO staff_applications (id, name, phone, city, message) VALUES (?, ?, ?, ?, ?)`
  ).run(id, name.trim(), phone.trim(), city || null, message || null);

  res.status(201).json({ message: 'Başvurun alındı.', id });
});

module.exports = router;
