const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { generateUsername, generatePassword } = require('../services/credentials');

const router = express.Router();
router.use(requireAuth);

// Tüm admin route'ları için ortak yetki kontrolü.
router.use((req, res, next) => {
  if (req.user.accountType !== 'admin') {
    return res.status(403).json({ error: 'Bu sayfayı yalnızca yöneticiler görebilir.' });
  }
  next();
});

// --- Personel başvuruları -------------------------------------------------

router.get('/staff-applications', (req, res) => {
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
  const rows = db
    .prepare('SELECT * FROM staff_applications WHERE status = ? ORDER BY created_at DESC')
    .all(status);
  res.json(rows);
});

// Başvuruyu onaylar ve gerçek bir 'staff' hesabı oluşturur (personel
// kaydında olduğu gibi otomatik kullanıcı adı + şifre üretilir). Üretilen
// bilgiler admin'e dönülür - admin bunları işe alınan kişiye iletir, o
// bilgilerle MICISTORad'a giriş yapar.
router.post('/staff-applications/:id/approve', (req, res) => {
  const application = db.prepare('SELECT * FROM staff_applications WHERE id = ?').get(req.params.id);
  if (!application) return res.status(404).json({ error: 'Başvuru bulunamadı.' });
  if (application.status !== 'pending') {
    return res.status(409).json({ error: 'Bu başvuru zaten işleme alınmış.' });
  }

  const existingUser = db.prepare('SELECT id FROM users WHERE phone = ?').get(application.phone);
  if (existingUser) {
    return res.status(409).json({ error: 'Bu telefon numarasıyla zaten bir hesap var.' });
  }

  const userId = uuid();
  const username = generateUsername(application.name);
  const plainPassword = generatePassword();
  const passwordHash = bcrypt.hashSync(plainPassword, 10);

  db.prepare(
    `INSERT INTO users (id, phone, name, account_type, username, password_hash, profile_completed)
     VALUES (?, ?, ?, 'staff', ?, ?, 1)`
  ).run(userId, application.phone, application.name, username, passwordHash);

  db.prepare(`UPDATE staff_applications SET status = 'approved' WHERE id = ?`).run(application.id);

  res.json({
    message: 'Başvuru onaylandı, personel hesabı oluşturuldu.',
    credentials: { username, password: plainPassword },
  });
});

router.post('/staff-applications/:id/reject', (req, res) => {
  const application = db.prepare('SELECT * FROM staff_applications WHERE id = ?').get(req.params.id);
  if (!application) return res.status(404).json({ error: 'Başvuru bulunamadı.' });
  if (application.status !== 'pending') {
    return res.status(409).json({ error: 'Bu başvuru zaten işleme alınmış.' });
  }
  db.prepare(`UPDATE staff_applications SET status = 'rejected' WHERE id = ?`).run(application.id);
  res.json({ message: 'Başvuru reddedildi.' });
});

// --- Genel özet (dashboard) ------------------------------------------------

router.get('/stats', (req, res) => {
  const count = (sql, ...params) => db.prepare(sql).get(...params).c;

  const totalCustomers = count(`SELECT COUNT(*) AS c FROM users WHERE account_type IN ('individual','company')`);
  const totalStaff = count(`SELECT COUNT(*) AS c FROM users WHERE account_type = 'staff'`);
  const onlineStaff = count(`SELECT COUNT(*) AS c FROM users WHERE account_type = 'staff' AND is_online = 1`);
  const pendingApplications = count(`SELECT COUNT(*) AS c FROM staff_applications WHERE status = 'pending'`);
  const totalProperties = count(`SELECT COUNT(*) AS c FROM properties`);
  const totalJobs = count(`SELECT COUNT(*) AS c FROM cleaning_jobs`);
  const completedJobs = count(`SELECT COUNT(*) AS c FROM cleaning_jobs WHERE status = 'done'`);
  const pendingJobs = count(`SELECT COUNT(*) AS c FROM cleaning_jobs WHERE status = 'pending'`);

  const revenue = db
    .prepare(`SELECT COALESCE(SUM(price), 0) AS total FROM cleaning_jobs WHERE status = 'done'`)
    .get().total;

  const unreadChats = count(
    `SELECT COUNT(DISTINCT user_id) AS c FROM chat_messages cm
     WHERE sender = 'user' AND NOT EXISTS (
       SELECT 1 FROM chat_messages r WHERE r.user_id = cm.user_id AND r.sender='admin' AND r.created_at > cm.created_at
     )`
  );

  res.json({
    totalCustomers, totalStaff, onlineStaff, pendingApplications,
    totalProperties, totalJobs, completedJobs, pendingJobs,
    revenue, unreadChats,
  });
});

module.exports = router;
