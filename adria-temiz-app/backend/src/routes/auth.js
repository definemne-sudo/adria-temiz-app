const express = require('express');
const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { requireAuth, JWT_SECRET } = require('../middleware/auth');

const router = express.Router();

const OTP_TTL_MINUTES = 5;

function normalizePhone(raw) {
  // Boşluk/tire gibi karakterleri temizler, rakam ve baştaki '+' kalır.
  return (raw || '').replace(/[^\d+]/g, '');
}

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6 haneli
}

// --- 1. Adım: telefon numarasına kod gönder ---
// Ablan Temizler/Glovo tarzı akış: kullanıcı adı/e-posta yok, sadece telefon.
router.post('/request-otp', (req, res) => {
  const phone = normalizePhone(req.body.phone);
  if (!phone || phone.length < 8) {
    return res.status(400).json({ error: 'Geçerli bir telefon numarası gir.' });
  }

  const code = generateCode();
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000).toISOString();

  db.prepare(
    `INSERT INTO otp_requests (phone, code, expires_at, attempts)
     VALUES (?, ?, ?, 0)
     ON CONFLICT(phone) DO UPDATE SET code = excluded.code, expires_at = excluded.expires_at, attempts = 0`
  ).run(phone, code, expiresAt);

  // --- GERÇEK SMS ENTEGRASYONU BURAYA GELECEK ---
  // Prod'da burada Twilio/yerel SMS sağlayıcı çağrılır, kod client'a asla dönülmez.
  // Şu an gerçek bir SMS sağlayıcımız olmadığı için demo amaçlı konsola yazıyor
  // ve response'ta devCode olarak dönüyoruz.
  console.log(`[SMS SİMÜLASYONU] ${phone} numarasına gönderilen kod: ${code}`);

  res.json({
    message: 'Doğrulama kodu telefonuna gönderildi.',
    devCode: code, // TODO: prod'a çıkarken bu satırı sil, gerçek SMS gönderimiyle değiştir.
  });
});

// --- 2. Adım: kodu doğrula, kullanıcı yoksa oluştur ---
router.post('/verify-otp', (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const { code } = req.body;

  const otp = db.prepare('SELECT * FROM otp_requests WHERE phone = ?').get(phone);
  if (!otp) {
    return res.status(400).json({ error: 'Önce bir doğrulama kodu iste.' });
  }
  if (new Date(otp.expires_at).getTime() < Date.now()) {
    return res.status(400).json({ error: 'Kodun süresi doldu, yeni kod iste.' });
  }
  if (otp.attempts >= 5) {
    return res.status(429).json({ error: 'Çok fazla yanlış deneme. Yeni kod iste.' });
  }
  if (otp.code !== code) {
    db.prepare('UPDATE otp_requests SET attempts = attempts + 1 WHERE phone = ?').run(phone);
    return res.status(400).json({ error: 'Kod hatalı.' });
  }

  db.prepare('DELETE FROM otp_requests WHERE phone = ?').run(phone);

  let user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  let isNewUser = false;
  if (!user) {
    const id = uuid();
    db.prepare(
      `INSERT INTO users (id, phone, account_type, profile_completed)
       VALUES (?, ?, 'individual', 0)`
    ).run(id, phone);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    isNewUser = true;
  }

  const token = jwt.sign(
    { id: user.id, phone: user.phone, accountType: user.account_type },
    JWT_SECRET,
    { expiresIn: '30d' }
  );

  res.json({
    token,
    isNewUser: isNewUser || !user.profile_completed,
    user: {
      id: user.id,
      phone: user.phone,
      name: user.name,
      accountType: user.account_type,
      companyName: user.company_name,
      profileCompleted: !!user.profile_completed,
    },
  });
});

// --- 3. Adım (yalnızca yeni kullanıcılar için): ad/hesap tipini tamamla ---
// Bireysel ev sahibi ise, Glovo tarzı akışla aynı adımda ilk mülkünü de kaydeder
// (property alanı gönderilirse). Yönetim şirketi mülk eklemeyi panelden yapar,
// çünkü genelde çok sayıda mülk portföy olarak eklenir, kayıt formuna sığmaz.
router.post('/complete-profile', requireAuth, (req, res) => {
  const { name, accountType, companyName, property } = req.body;
  if (!name || !accountType) {
    return res.status(400).json({ error: 'name ve accountType zorunlu.' });
  }
  if (!['individual', 'company'].includes(accountType)) {
    return res.status(400).json({ error: "accountType 'individual' veya 'company' olmalı." });
  }
  if (accountType === 'company' && !companyName) {
    return res.status(400).json({ error: 'Yönetim şirketi için companyName zorunlu.' });
  }

  db.prepare(
    `UPDATE users SET name = ?, account_type = ?, company_name = ?, profile_completed = 1
     WHERE id = ?`
  ).run(name, accountType, companyName || null, req.user.id);

  let createdProperty = null;
  if (accountType === 'individual' && property && (property.city || property.sizeSqm || property.name)) {
    const propertyId = uuid();
    const sizeSqm = property.sizeSqm ? Number(property.sizeSqm) : null;
    db.prepare(
      `INSERT INTO properties (id, owner_id, name, address, city, size_sqm)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      propertyId,
      req.user.id,
      property.name || 'Evim',
      property.address || null,
      property.city || null,
      sizeSqm
    );
    createdProperty = db.prepare('SELECT * FROM properties WHERE id = ?').get(propertyId);
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const token = jwt.sign(
    { id: user.id, phone: user.phone, accountType: user.account_type },
    JWT_SECRET,
    { expiresIn: '30d' }
  );

  res.json({
    token,
    user: {
      id: user.id,
      phone: user.phone,
      name: user.name,
      accountType: user.account_type,
      companyName: user.company_name,
      profileCompleted: true,
    },
    property: createdProperty,
  });
});

module.exports = router;
