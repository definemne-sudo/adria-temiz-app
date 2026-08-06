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
       SELECT 1 FROM chat_messages r WHERE r.user_id = cm.user_id AND r.sender='admin' AND r.created_at >= cm.created_at
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

  const unreadChats = count(
    `SELECT COUNT(DISTINCT user_id) AS c FROM chat_messages cm
     WHERE sender = 'user' AND NOT EXISTS (
       SELECT 1 FROM chat_messages r WHERE r.user_id = cm.user_id AND r.sender='admin' AND r.created_at >= cm.created_at
     )`
  );

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
      unreadChats,
    },
    workerSummary: { total: totalStaff, online: availableStaff, busy: busyStaff, offline: offlineStaff },
    jobStatusBreakdown: { completed: completedJobs, inProgress: inProgressJobs, assigned: assignedJobs, pending: pendingJobs, total: totalJobs },
    todaysBookings,
    recentReviews,
  });
});

// --- Siparişler (tam liste) ------------------------------------------------

router.get('/bookings', (req, res) => {
  const status = req.query.status && req.query.status !== 'all' ? req.query.status : null;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = 25;
  const offset = (page - 1) * pageSize;

  const where = status ? `WHERE j.status = ?` : '';
  const params = status ? [status] : [];

  const total = db
    .prepare(`SELECT COUNT(*) AS c FROM cleaning_jobs j ${where}`)
    .get(...params).c;

  const rows = db
    .prepare(
      `SELECT j.id, j.service_key, j.status, j.checkout_at, j.completed_at, j.price, j.payment_method, j.payment_status,
              p.name AS property_name, p.city AS property_city,
              u.name AS customer_name, u.account_type AS customer_type,
              s.name AS staff_name
       FROM cleaning_jobs j
       JOIN properties p ON p.id = j.property_id
       JOIN users u ON u.id = p.owner_id
       LEFT JOIN users s ON s.id = j.assigned_staff_id
       ${where}
       ORDER BY j.checkout_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, pageSize, offset);

  res.json({ bookings: rows, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
});

// --- Personel (tam liste) --------------------------------------------------

router.get('/workers', (req, res) => {
  const rows = db
    .prepare(
      `SELECT u.id, u.name, u.phone, u.username, u.is_online, u.current_city,
              (SELECT COUNT(*) FROM cleaning_jobs WHERE assigned_staff_id = u.id AND status = 'done') AS completed_jobs,
              (SELECT COUNT(*) FROM cleaning_jobs WHERE assigned_staff_id = u.id AND status = 'in_progress') AS active_jobs,
              (SELECT COUNT(*) FROM cleaning_jobs WHERE assigned_staff_id = u.id AND staff_rating IS NOT NULL) AS total_ratings,
              (SELECT COUNT(*) FROM cleaning_jobs WHERE assigned_staff_id = u.id AND staff_rating = 'like') AS like_ratings
       FROM users u
       WHERE u.account_type = 'staff'
       ORDER BY u.name ASC`
    )
    .all();

  const workers = rows.map((r) => ({
    ...r,
    isBusy: r.active_jobs > 0,
    satisfactionPercent: r.total_ratings ? Math.round((r.like_ratings / r.total_ratings) * 100) : null,
  }));

  res.json({ workers });
});

// --- Müşteriler (tam liste) -------------------------------------------------

router.get('/customers', (req, res) => {
  const rows = db
    .prepare(
      `SELECT u.id, u.name, u.phone, u.account_type, u.company_name, u.created_at,
              (SELECT COUNT(*) FROM properties WHERE owner_id = u.id) AS property_count,
              (SELECT COUNT(*) FROM cleaning_jobs j JOIN properties p ON p.id = j.property_id WHERE p.owner_id = u.id) AS job_count,
              (SELECT COALESCE(SUM(j.price),0) FROM cleaning_jobs j JOIN properties p ON p.id = j.property_id WHERE p.owner_id = u.id AND j.status='done') AS total_spent
       FROM users u
       WHERE u.account_type IN ('individual','company')
       ORDER BY u.created_at DESC`
    )
    .all();

  res.json({ customers: rows });
});

// --- Ciro grafiği -----------------------------------------------------------

// Son N günün günlük cirosu (varsayılan 7 - "Bu Hafta" görünümü).
router.get('/revenue', (req, res) => {
  const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 7));

  const rows = db
    .prepare(
      `SELECT date(completed_at) AS day, COALESCE(SUM(price), 0) AS total
       FROM cleaning_jobs
       WHERE status = 'done' AND completed_at IS NOT NULL
         AND date(completed_at) >= date('now', ?)
       GROUP BY date(completed_at)`
    )
    .all(`-${days - 1} days`);
  const byDay = Object.fromEntries(rows.map((r) => [r.day, r.total]));

  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    series.push({ date: key, total: byDay[key] || 0 });
  }

  const totalRevenue = series.reduce((sum, s) => sum + s.total, 0);

  const prevRows = db
    .prepare(
      `SELECT COALESCE(SUM(price), 0) AS total FROM cleaning_jobs
       WHERE status = 'done' AND completed_at IS NOT NULL
         AND date(completed_at) >= date('now', ?) AND date(completed_at) < date('now', ?)`
    )
    .get(`-${days * 2 - 1} days`, `-${days - 1} days`);
  const prevRevenue = prevRows.total;
  const percentChange = prevRevenue > 0 ? Math.round(((totalRevenue - prevRevenue) / prevRevenue) * 100) : null;

  res.json({ series, totalRevenue, percentChange, days });
});

// --- Destek sohbetleri --------------------------------------------------------

// Tüm konuşmaları (kullanıcı bazında), son mesaj önizlemesi ve okunmamış
// bilgisiyle listeler.
router.get('/chats', (req, res) => {
  const rows = db
    .prepare(
      `SELECT u.id AS user_id, u.name AS customer_name, u.account_type,
              (SELECT message FROM chat_messages WHERE user_id = u.id ORDER BY created_at DESC LIMIT 1) AS last_message,
              (SELECT created_at FROM chat_messages WHERE user_id = u.id ORDER BY created_at DESC LIMIT 1) AS last_message_at,
              (SELECT COUNT(*) FROM chat_messages cm WHERE cm.user_id = u.id AND cm.sender = 'user'
                 AND NOT EXISTS (SELECT 1 FROM chat_messages r WHERE r.user_id = u.id AND r.sender='admin' AND r.created_at >= cm.created_at)
              ) AS unread_count
       FROM users u
       WHERE EXISTS (SELECT 1 FROM chat_messages cm WHERE cm.user_id = u.id)
       ORDER BY last_message_at DESC`
    )
    .all();
  res.json(rows);
});

router.get('/chats/:userId/messages', (req, res) => {
  const rows = db
    .prepare('SELECT * FROM chat_messages WHERE user_id = ? ORDER BY created_at ASC')
    .all(req.params.userId);
  res.json(rows);
});

router.post('/chats/:userId/messages', (req, res) => {
  const { message } = req.body;
  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Mesaj boş olamaz.' });
  }
  const targetUser = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.userId);
  if (!targetUser) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });

  const id = uuid();
  db.prepare(
    `INSERT INTO chat_messages (id, user_id, sender, message) VALUES (?, ?, 'admin', ?)`
  ).run(id, req.params.userId, message.trim());
  res.status(201).json(db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(id));
});

module.exports = router;
