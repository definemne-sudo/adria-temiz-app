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

// Dashboard ana ekranı için tek seferde tüm veri. NOT: "Cancelled" durumu
// şu an sistemde yok (sipariş iptal akışı henüz yazılmadı), o yüzden iş
// durumu dağılımında yer almıyor. Ortalama puan, bizim like/dislike tabanlı
// değerlendirme sistemimize uygun şekilde "memnuniyet yüzdesi" olarak
// veriliyor - uydurma bir 5 yıldız ortalaması değil.
router.get('/dashboard', (req, res) => {
  const count = (sql, ...params) => db.prepare(sql).get(...params).c;

  const totalJobs = count(`SELECT COUNT(*) AS c FROM cleaning_jobs`);
  const completedJobs = count(`SELECT COUNT(*) AS c FROM cleaning_jobs WHERE status = 'done'`);
  const pendingJobs = count(`SELECT COUNT(*) AS c FROM cleaning_jobs WHERE status = 'pending'`);
  const inProgressJobs = count(`SELECT COUNT(*) AS c FROM cleaning_jobs WHERE status = 'in_progress'`);
  const assignedJobs = count(`SELECT COUNT(*) AS c FROM cleaning_jobs WHERE status = 'assigned'`);

  const totalStaff = count(`SELECT COUNT(*) AS c FROM users WHERE account_type = 'staff'`);
  const onlineStaff = count(`SELECT COUNT(*) AS c FROM users WHERE account_type = 'staff' AND is_online = 1`);
  const pendingApplications = count(`SELECT COUNT(*) AS c FROM staff_applications WHERE status = 'pending'`);
  const busyStaff = count(
    `SELECT COUNT(DISTINCT assigned_staff_id) AS c FROM cleaning_jobs WHERE status = 'in_progress' AND assigned_staff_id IS NOT NULL`
  );
  const offlineStaff = totalStaff - onlineStaff;
  const availableStaff = Math.max(0, onlineStaff - busyStaff);

  const todayRevenue = db
    .prepare(`SELECT COALESCE(SUM(price), 0) AS total FROM cleaning_jobs WHERE status = 'done' AND date(completed_at) = date('now')`)
    .get().total;

  const satisfactionRow = db
    .prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN service_rating = 'like' THEN 1 ELSE 0 END) AS likes
       FROM cleaning_jobs WHERE service_rating IS NOT NULL`
    )
    .get();
  const satisfactionPercent = satisfactionRow.total ? Math.round((satisfactionRow.likes / satisfactionRow.total) * 100) : null;

  const todaysBookings = db
    .prepare(
      `SELECT j.id, j.service_key, j.status, j.checkout_at, j.price,
              p.name AS property_name, p.city AS property_city, p.address AS property_address,
              u.name AS customer_name
       FROM cleaning_jobs j
       JOIN properties p ON p.id = j.property_id
       JOIN users u ON u.id = p.owner_id
       WHERE date(j.checkout_at) = date('now')
       ORDER BY j.checkout_at ASC
       LIMIT 20`
    )
    .all();

  const recentReviews = db
    .prepare(
      `SELECT j.id, j.service_rating, j.service_feedback, j.rated_at,
              p.name AS property_name, p.city AS property_city, u.name AS customer_name
       FROM cleaning_jobs j
       JOIN properties p ON p.id = j.property_id
       JOIN users u ON u.id = p.owner_id
       WHERE j.service_feedback IS NOT NULL AND j.service_feedback != ''
       ORDER BY j.rated_at DESC
       LIMIT 6`
    )
    .all();

  res.json({
    stats: {
      totalBookings: totalJobs,
      completedJobs,
      pendingJobs,
      totalStaff,
      onlineStaff,
      pendingApplications,
      todayRevenue,
      satisfactionPercent,
    },
    workerSummary: { total: totalStaff, online: availableStaff, busy: busyStaff, offline: offlineStaff },
    jobStatusBreakdown: { completed: completedJobs, inProgress: inProgressJobs, assigned: assignedJobs, pending: pendingJobs, total: totalJobs },
    todaysBookings,
    recentReviews,
  });
});

module.exports = router;
