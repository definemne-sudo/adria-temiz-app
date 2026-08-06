const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { requireAuth, JWT_SECRET } = require('../middleware/auth');
const { syncPropertyCalendar } = require('../services/icalSync');
const { generateUsername, generatePassword } = require('../services/credentials');

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
      taxNumber: user.tax_number,
      billingAddress: user.billing_address,
      referralCode: user.referral_code,
      profileCompleted: !!user.profile_completed,
    },
  });
});

// --- 3. Adım (yalnızca yeni kullanıcılar için): ad/hesap tipini tamamla ---
// Bireysel ev sahibi ise, Glovo tarzı akışla aynı adımda ilk mülkünü de kaydeder
// (property alanı gönderilirse). Yönetim şirketi mülk eklemeyi panelden yapar,
// çünkü genelde çok sayıda mülk portföy olarak eklenir, kayıt formuna sığmaz.
router.post('/complete-profile', requireAuth, async (req, res) => {
  const { name, accountType, companyName, taxNumber, billingAddress, property, referredByCode } = req.body;
  if (!name || !accountType) {
    return res.status(400).json({ error: 'name ve accountType zorunlu.' });
  }
  if (!['individual', 'company', 'staff'].includes(accountType)) {
    return res.status(400).json({ error: "accountType 'individual', 'company' veya 'staff' olmalı." });
  }
  if (accountType === 'company' && !companyName) {
    return res.status(400).json({ error: 'Yönetim şirketi için companyName zorunlu.' });
  }
  // Yönetim şirketleri için fatura bilgileri zorunlu - aylık faturalı ödeme
  // seçeneğini sunabilmemiz için bu bilgilere baştan ihtiyacımız var.
  if (accountType === 'company' && (!taxNumber || !billingAddress)) {
    return res.status(400).json({ error: 'Yönetim şirketi için vergi numarası ve fatura adresi zorunlu.' });
  }

  db.prepare(
    `UPDATE users SET name = ?, account_type = ?, company_name = ?, tax_number = ?, billing_address = ?, profile_completed = 1
     WHERE id = ?`
  ).run(
    name, accountType, companyName || null,
    accountType === 'company' ? taxNumber : null,
    accountType === 'company' ? billingAddress : null,
    req.user.id
  );

  // Bireysel/şirket müşteriler için benzersiz bir referans kodu üretilir -
  // MICISTOMan > Marketing'de bu kodla kaç kişi kazandırdıklarını
  // görebiliyoruz. Kayıt sırasında başka birinin kodu girildiyse (referredByCode),
  // o kişi "yönlendiren" olarak kaydediliyor.
  if ((accountType === 'individual' || accountType === 'company') ) {
    const existingRefCode = db.prepare('SELECT referral_code FROM users WHERE id = ?').get(req.user.id).referral_code;
    if (!existingRefCode) {
      const refCode = generateUsername(name).toUpperCase();
      let referredByUserId = null;
      if (referredByCode) {
        const referrer = db.prepare('SELECT id FROM users WHERE referral_code = ?').get(referredByCode.trim().toUpperCase());
        if (referrer && referrer.id !== req.user.id) referredByUserId = referrer.id;
      }
      db.prepare('UPDATE users SET referral_code = ?, referred_by_user_id = ? WHERE id = ?').run(refCode, referredByUserId, req.user.id);
    }
  }

  // Personel hesabı aktive ediliyor ya da telefonla kimlik doğrulayıp
  // giriş bilgilerini sıfırlıyor (şifresini unutan personel için de bu
  // aynı akış - "şifremi unuttum" yerine geçiyor). Her çağrıda yeni
  // kullanıcı adı + şifre üretilip eskisinin yerine geçer.
  let staffCredentials = null;
  if (accountType === 'staff') {
    const username = generateUsername(name);
    const plainPassword = generatePassword();
    const passwordHash = bcrypt.hashSync(plainPassword, 10);
    db.prepare('UPDATE users SET username = ?, password_hash = ? WHERE id = ?').run(username, passwordHash, req.user.id);
    staffCredentials = { username, password: plainPassword };
  }

  let createdProperty = null;
  let syncResult = null;
  if (accountType === 'individual' && property && (property.city || property.sizeSqm || property.name)) {
    const propertyId = uuid();
    const sizeSqm = property.sizeSqm ? Number(property.sizeSqm) : null;
    const category = ['apartment', 'house', 'office', 'common_area'].includes(property.category) ? property.category : 'apartment';
    db.prepare(
      `INSERT INTO properties (id, owner_id, name, category, address, city, latitude, longitude, size_sqm, ical_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      propertyId,
      req.user.id,
      property.name || 'Evim',
      category,
      property.address || null,
      property.city || null,
      property.latitude ? Number(property.latitude) : null,
      property.longitude ? Number(property.longitude) : null,
      sizeSqm,
      property.icalUrl || null
    );
    createdProperty = db.prepare('SELECT * FROM properties WHERE id = ?').get(propertyId);

    // Kayıt sırasında bir iCal linki verildiyse, kullanıcıya ikinci bir
    // adım çıkarmadan takvimi hemen (nakit ödeme varsayımıyla) senkronla.
    // Link geçersiz/erişilemezse kayıt akışını bozmasın diye sessizce geçiyoruz.
    if (property.icalUrl) {
      try {
        syncResult = await syncPropertyCalendar(propertyId, { paymentMethod: 'cash' });
      } catch (err) {
        syncResult = { error: err.message };
      }
    }
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
      taxNumber: user.tax_number,
      billingAddress: user.billing_address,
      username: user.username,
      isOnline: !!user.is_online,
      referralCode: user.referral_code,
      profileCompleted: true,
    },
    property: createdProperty,
    syncResult,
    staffCredentials,
  });
});

// Personel girişi - telefon/SMS değil, sabit kullanıcı adı + şifre ile.
// Kullanıcı adı/şifre complete-profile sırasında bir kez üretilip personele
// verilir (bkz. yukarısı).
router.post('/staff-login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Kullanıcı adı ve şifre zorunlu.' });
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND account_type = ?').get(username.trim(), 'staff');
  if (!user || !user.password_hash || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı.' });
  }

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
      username: user.username,
      isOnline: !!user.is_online,
      profileCompleted: !!user.profile_completed,
    },
  });
});

// MICISTOMan (admin paneli) girişi - kullanıcı adı/şifre ile. Admin
// hesapları self-servis oluşturulmaz (güvenlik) - ilk admin, bir seed
// script'iyle (bkz. scripts/create-admin.js) elle oluşturulur.
router.post('/admin-login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Kullanıcı adı ve şifre zorunlu.' });
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND account_type = ?').get(username.trim(), 'admin');
  if (!user || !user.password_hash || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı.' });
  }
  const token = jwt.sign(
    { id: user.id, phone: user.phone, accountType: user.account_type },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
  res.json({
    token,
    user: { id: user.id, name: user.name, accountType: user.account_type, username: user.username },
  });
});

// Personelin çevrimiçi/çevrimdışı durumunu değiştirmesi - çevrimdışıyken
// yeni iş alamaz (bkz. jobs.js /assign).
router.patch('/staff-status', requireAuth, (req, res) => {
  if (req.user.accountType !== 'staff') {
    return res.status(403).json({ error: 'Bu işlemi yalnızca personel yapabilir.' });
  }
  const { isOnline, lat, lng, city } = req.body;
  db.prepare(
    `UPDATE users SET is_online = ?, current_lat = COALESCE(?, current_lat), current_lng = COALESCE(?, current_lng), current_city = COALESCE(?, current_city) WHERE id = ?`
  ).run(isOnline ? 1 : 0, lat != null ? Number(lat) : null, lng != null ? Number(lng) : null, city || null, req.user.id);
  const user = db.prepare('SELECT is_online, current_lat, current_lng, current_city FROM users WHERE id = ?').get(req.user.id);
  res.json({ isOnline: !!user.is_online, city: user.current_city, lat: user.current_lat, lng: user.current_lng });
});

module.exports = router;
