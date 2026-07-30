const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { JWT_SECRET } = require('../middleware/auth');

const router = express.Router();

// Kayıt: hesap tipi 'individual' (bireysel ev sahibi) veya 'company' (yönetim şirketi)
// -> şablonun 7.1 bölümündeki "birleşik panel" mantığı burada uygulanıyor.
router.post('/register', (req, res) => {
  const { email, password, name, accountType, companyName } = req.body;

  if (!email || !password || !name || !accountType) {
    return res.status(400).json({ error: 'email, password, name ve accountType zorunlu.' });
  }
  if (!['individual', 'company'].includes(accountType)) {
    return res.status(400).json({ error: "accountType 'individual' veya 'company' olmalı." });
  }
  if (accountType === 'company' && !companyName) {
    return res.status(400).json({ error: 'Yönetim şirketi hesabı için companyName zorunlu.' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    return res.status(409).json({ error: 'Bu e-posta ile zaten bir hesap var.' });
  }

  const id = uuid();
  const passwordHash = bcrypt.hashSync(password, 10);
  db.prepare(
    `INSERT INTO users (id, email, password_hash, name, account_type, company_name)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, email, passwordHash, name, accountType, companyName || null);

  const token = jwt.sign({ id, email, accountType }, JWT_SECRET, { expiresIn: '7d' });
  res.status(201).json({
    token,
    user: { id, email, name, accountType, companyName: companyName || null },
  });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'E-posta veya şifre hatalı.' });
  }
  const token = jwt.sign(
    { id: user.id, email: user.email, accountType: user.account_type },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
  res.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      accountType: user.account_type,
      companyName: user.company_name,
    },
  });
});

module.exports = router;
