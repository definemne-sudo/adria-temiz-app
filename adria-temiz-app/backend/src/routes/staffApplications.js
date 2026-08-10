const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../db');

const router = express.Router();

// Kimlik doğrulama GEREKMİYOR - başvuran kişi henüz hesap açmamış,
// bu tamamen genel bir "iş başvurusu" formu (Glovo/Wolt'un "Kurye ol"
// formuna benzer). Admin paneli yazıldığında buradan onaylanıp gerçek
// bir 'staff' hesabına dönüştürülecek.
router.post('/', (req, res) => {
  const {
    name, phone, city, message,
    nationality, gender, birthDate, hasExperience, experienceYears, languages,
  } = req.body;
  if (!name || !phone) {
    return res.status(400).json({ error: 'İsim ve telefon numarası zorunlu.' });
  }
  const id = uuid();
  db.prepare(
    `INSERT INTO staff_applications
       (id, name, phone, city, message, nationality, gender, birth_date, has_experience, experience_years, languages)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, name.trim(), phone.trim(), city || null, message || null,
    nationality || null, gender || null, birthDate || null,
    hasExperience ? 1 : 0, hasExperience && experienceYears ? Number(experienceYears) : null,
    Array.isArray(languages) ? languages.join(', ') : (languages || null)
  );

  res.status(201).json({ message: 'Başvurun alındı.', id });
});

module.exports = router;
