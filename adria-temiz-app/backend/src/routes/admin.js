const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { generateActivationCode } = require('../services/credentials');
const { getAllServices, getAllCommonAreaSubOptions, getAllAddons, getSuppliesFees, calcNetEarning, getCommissionRate, getPayoutCycleDays, getChecklist, getChecklistAllLangs } = require('../services/catalog');
const { getStaffPeriods, getStaffLifetimeTotal } = require('../services/financeCalc');
const { sendPushToUser, sendPushToUsers } = require('../services/push');
const { getDormantThresholdDays } = require('../services/reengagement');
const { createCleaningJob } = require('./jobs');

const router = express.Router();
router.use(requireAuth);

// Tüm admin route'ları için ortak yetki kontrolü.
router.use((req, res, next) => {
  if (req.user.accountType !== 'admin') {
    return res.status(403).json({ error: 'Bu sayfayı yalnızca yöneticiler görebilir.' });
  }
  next();
});

// Sadece "her şeye gücü yeten" TEK admin için ek yetki kontrolü - müşteri/
// sipariş silme, diğer adminleri silme/şifresini sıfırlama gibi geri
// alınamaz/hassas işlemler için kullanılır. JWT payload'ına GÜVENMİYORUZ
// (token 30 gün geçerli - bu sürede süper admin ataması değişebilir),
// bunun yerine her istekte veritabanından TAZE kontrol ediyoruz.
function requireSuperAdmin(req, res, next) {
  const me = db.prepare(`SELECT is_super_admin FROM users WHERE id = ? AND account_type = 'admin'`).get(req.user.id);
  if (!me || !me.is_super_admin) {
    return res.status(403).json({ error: 'Bu işlem yalnızca süper admin tarafından yapılabilir.' });
  }
  next();
}

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

  // Hesabı biz oluşturmuyoruz - onay anında sadece tek kullanımlık bir
  // aktivasyon kodu üretiyoruz. Başvuran, bu kodu MICISTORad'da ilk girişte
  // kullanıp kendi kullanıcı adını/şifresini kendisi belirleyecek
  // (POST /auth/staff-activate). Hesap, o adımda gerçekten oluşturuluyor.
  const activationCode = generateActivationCode();
  db.prepare(
    `UPDATE staff_applications SET status = 'approved', activation_code = ? WHERE id = ?`
  ).run(activationCode, application.id);

  res.json({
    message: 'Başvuru onaylandı, aktivasyon kodu oluşturuldu.',
    activationCode,
  });
});

// Zaten onaylanmış bir başvuru için aktivasyon kodunu YENİDEN üretir.
// İki durumda gerekli: 1) kişi eski kodu kaybetti/kullanmadı, 2) kişi daha
// önce aktivasyonu tamamladı AMA hesabı sonradan bir şekilde silindi
// (örn. veritabanı sıfırlandı) - bu durumda eski kod "kullanıldı" olarak
// işaretli kaldığı için tekrar kullanılamaz, yeni bir kodla kurtarılır.
router.post('/staff-applications/:id/resend-code', (req, res) => {
  const application = db.prepare('SELECT * FROM staff_applications WHERE id = ?').get(req.params.id);
  if (!application) return res.status(404).json({ error: 'Başvuru bulunamadı.' });
  if (application.status !== 'approved') {
    return res.status(409).json({ error: 'Sadece onaylanmış başvurular için kod yenilenebilir.' });
  }
  // Hesap gerçekten var mı (aktivasyon tamamlanmış ve hesap hâlâ duruyor
  // mu) kontrol ediyoruz - eğer varsa, yeni kod üretmek anlamsız, kişi zaten
  // normal kullanıcı adı/şifresiyle giriş yapabilir durumda.
  const existingUser = db.prepare('SELECT id FROM users WHERE phone = ?').get(application.phone);
  if (existingUser) {
    return res.status(409).json({ error: 'Bu kişinin zaten aktif bir hesabı var, giriş bilgileriyle giriş yapabilir.' });
  }
  const activationCode = generateActivationCode();
  db.prepare(
    `UPDATE staff_applications SET activation_code = ?, activation_used_at = NULL WHERE id = ?`
  ).run(activationCode, application.id);
  res.json({ message: 'Yeni aktivasyon kodu oluşturuldu.', activationCode });
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
     WHERE sender = 'user' AND channel = 'support' AND NOT EXISTS (
       SELECT 1 FROM chat_messages r WHERE r.user_id = cm.user_id AND r.channel = 'support' AND r.sender='admin' AND r.created_at >= cm.created_at
     )`
  );
  const unreadBoatQuotes = count(
    `SELECT COUNT(DISTINCT user_id) AS c FROM chat_messages cm
     WHERE sender = 'user' AND channel = 'boat_quote' AND NOT EXISTS (
       SELECT 1 FROM chat_messages r WHERE r.user_id = cm.user_id AND r.channel = 'boat_quote' AND r.sender='admin' AND r.created_at >= cm.created_at
     )`
  );

  res.json({
    totalCustomers, totalStaff, onlineStaff, pendingApplications,
    totalProperties, totalJobs, completedJobs, pendingJobs,
    revenue, unreadChats, unreadBoatQuotes,
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
      `SELECT COUNT(*) AS total, SUM(service_score) AS sumScore
       FROM cleaning_jobs WHERE service_score IS NOT NULL`
    )
    .get();
  const avgScore = satisfactionRow.total ? Math.round((satisfactionRow.sumScore / satisfactionRow.total) * 10) / 10 : null;

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
      `SELECT j.id, j.service_score, j.service_feedback, j.rated_at,
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
     WHERE sender = 'user' AND channel = 'support' AND NOT EXISTS (
       SELECT 1 FROM chat_messages r WHERE r.user_id = cm.user_id AND r.channel = 'support' AND r.sender='admin' AND r.created_at >= cm.created_at
     )`
  );
  const unreadBoatQuotes = count(
    `SELECT COUNT(DISTINCT user_id) AS c FROM chat_messages cm
     WHERE sender = 'user' AND channel = 'boat_quote' AND NOT EXISTS (
       SELECT 1 FROM chat_messages r WHERE r.user_id = cm.user_id AND r.channel = 'boat_quote' AND r.sender='admin' AND r.created_at >= cm.created_at
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
      avgScore,
      unreadChats,
      unreadBoatQuotes,
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
              j.created_at, j.service_params, j.urgency, j.notes, j.has_equipment, j.has_chemicals,
              p.name AS property_name, p.city AS property_city, p.address AS property_address, p.category AS property_category,
              u.name AS customer_name, u.account_type AS customer_type, u.phone AS customer_phone,
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

// Admin, sistem uzerinden BIR MUSTERI ADINA yeni bir siparis olusturabilir
// (orn. telefonla arayan bir musteri icin). musteri.js'teki AYNI cekirdek
// fonksiyonu (createCleaningJob) cagriliyor - bu, otomatik personel
// dispatch'inin (dispatchJob) musteri siparislerindeki ile BIREBIR AYNI
// sekilde calismasini garanti eder; admin'in olusturdugu bir siparis de
// tipki musterinin kendi olusturdugu gibi uygun personele otomatik iletilir.
router.post('/jobs', async (req, res) => {
  const {
    propertyId, serviceKey, urgency, scheduledAt, addons, paymentMethod,
    hasEquipment, hasChemicals, serviceParams, promoCode,
  } = req.body;
  try {
    const createdJob = await createCleaningJob({
      propertyId, serviceKey, urgency, scheduledAt, addons, paymentMethod,
      hasEquipment, hasChemicals, serviceParams, promoCode,
      skipAccessCheck: true, createdByAdminId: req.user.id,
    });
    res.status(201).json(createdJob);

    // Musteri, admin ADINA/ONUN YERINE olusturulan bu siparisten anlik
    // olarak haberdar olsun - kendisi olusturmadigi icin (telefonla arayip
    // admin'e siparis verdirdigi senaryo), uygulamayi actiginda "Siparislerim"
    // ekraninda gormeden once push ile bilgilendirilmesi onemli.
    const property = db.prepare('SELECT owner_id, name FROM properties WHERE id = ?').get(propertyId);
    if (property) {
      sendPushToUser(property.owner_id, {
        title: 'Siparişin Oluşturuldu ✅',
        body: `${property.name || 'Mülkün'} için bir sipariş oluşturuldu - detayları uygulamadan görebilirsin.`,
        jobId: createdJob.id,
        type: 'order_created_by_admin',
      }).catch((err) => console.error('Admin siparis olusturma push hatasi:', err));
    }
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Sipariş oluşturulamadı.' });
  }
});

// Admin, mevcut bir siparisi duzenler - yeniden planlama, personel
// atama/degistirme, fiyat/not duzeltmesi. Sadece GONDERILEN alanlar
// guncellenir (COALESCE deseni). Eger assignedStaffId DEGISIYORSA (yeni bir
// personele atama/aktarma), o personele - tipki otomatik dispatch'teki gibi -
// bir "yeni is teklifi" push bildirimi gonderilir, boylece admin'in elle
// atamasi ile sistemin otomatik atamasi PERSONEL ACISINDAN AYNI deneyimi
// verir (personel haberdar olmadan uzerine is yuklenmis olmaz).
router.put('/jobs/:id', (req, res) => {
  const { id } = req.params;
  const job = db.prepare('SELECT * FROM cleaning_jobs WHERE id = ?').get(id);
  if (!job) return res.status(404).json({ error: 'Sipariş bulunamadı.' });

  const { scheduledAt, assignedStaffId, price, notes, urgency } = req.body || {};
  const newCheckoutAt = scheduledAt ? new Date(scheduledAt).toISOString() : null;
  const isReassigning = assignedStaffId !== undefined && assignedStaffId !== job.assigned_staff_id;

  db.prepare(
    `UPDATE cleaning_jobs SET
       checkout_at = COALESCE(?, checkout_at),
       assigned_staff_id = COALESCE(?, assigned_staff_id),
       price = COALESCE(?, price),
       notes = COALESCE(?, notes),
       urgency = COALESCE(?, urgency),
       status = CASE WHEN ? IS NOT NULL THEN 'assigned' ELSE status END
     WHERE id = ?`
  ).run(
    newCheckoutAt, assignedStaffId || null, price !== undefined ? Number(price) : null,
    notes || null, urgency || null, assignedStaffId || null, id
  );

  const updatedJob = db.prepare('SELECT * FROM cleaning_jobs WHERE id = ?').get(id);
  res.json(updatedJob);

  if (isReassigning && assignedStaffId) {
    const property = db.prepare('SELECT city FROM properties WHERE id = ?').get(updatedJob.property_id);
    sendPushToUser(assignedStaffId, {
      title: 'MICISTO — Yeni iş teklifi',
      body: `${property?.city || ''} · ${updatedJob.price} € (admin tarafından atandı)`,
      jobId: id,
      type: 'job_offer',
    }).catch((err) => console.error('Admin atama push hatası:', err));
  }
});

// --- Personel (tam liste) --------------------------------------------------

router.get('/workers', (req, res) => {
  const rows = db
    .prepare(
      `SELECT u.id, u.name, u.phone, u.username, u.is_online, u.current_city, u.current_lat, u.current_lng,
              (SELECT COUNT(*) FROM cleaning_jobs WHERE assigned_staff_id = u.id AND status = 'done') AS completed_jobs,
              (SELECT COUNT(*) FROM cleaning_jobs WHERE assigned_staff_id = u.id AND status = 'in_progress') AS active_jobs,
              (SELECT COUNT(*) FROM cleaning_jobs WHERE assigned_staff_id = u.id AND staff_score IS NOT NULL) AS total_ratings,
              (SELECT SUM(staff_score) FROM cleaning_jobs WHERE assigned_staff_id = u.id AND staff_score IS NOT NULL) AS sum_score
       FROM users u
       WHERE u.account_type = 'staff'
       ORDER BY u.name ASC`
    )
    .all();

  const workers = rows.map((r) => ({
    ...r,
    isBusy: r.active_jobs > 0,
    avgScore: r.total_ratings ? Math.round((r.sum_score / r.total_ratings) * 10) / 10 : null,
  }));

  res.json({ workers });
});

// Canlı harita için hafif endpoint - sadece konumu bilinen ÇEVRİMİÇİ
// personeli döner (Dashboard'daki Live Map, sık yenilense bile diğer
// istatistikleri tekrar çekmesin diye ayrı tutuldu).
router.get('/workers/live-locations', (req, res) => {
  const rows = db
    .prepare(
      `SELECT u.id, u.name, u.current_city, u.current_lat, u.current_lng,
              (SELECT COUNT(*) FROM cleaning_jobs WHERE assigned_staff_id = u.id AND status = 'in_progress') AS active_jobs
       FROM users u
       WHERE u.account_type = 'staff' AND u.is_online = 1
         AND u.current_lat IS NOT NULL AND u.current_lng IS NOT NULL`
    )
    .all();
  res.json({ workers: rows.map((r) => ({ ...r, isBusy: r.active_jobs > 0 })) });
});

// Bir personel hesabini siler - SADECE SUPER ADMIN. Aktif/bekleyen bir
// siparise atanmis bir personel yanlislikla silinip is yariinda kalmasin
// diye, once bu kontrol yapiliyor (musteri/siparis silmede kullanilan
// AYNI guvenlik prensibi).
router.delete('/workers/:id', requireSuperAdmin, (req, res) => {
  const { id } = req.params;
  const target = db.prepare(`SELECT id FROM users WHERE id = ? AND account_type = 'staff'`).get(id);
  if (!target) return res.status(404).json({ error: 'Personel bulunamadı.' });
  const activeJobs = db
    .prepare(`SELECT COUNT(*) AS c FROM cleaning_jobs WHERE assigned_staff_id = ? AND status IN ('pending','assigned','in_progress')`)
    .get(id).c;
  if (activeJobs > 0) {
    return res.status(409).json({ error: 'Bu personelin aktif/bekleyen siparişleri var, önce onları tamamlat ya da başka bir personele aktar.' });
  }
  // ONEMLI: chat_messages/push_subscriptions gibi ikincil kayitlar musteri
  // silmedeki AYNI gerekceyle temizleniyor. GECMIS (tamamlanmis/iptal)
  // siparislerin assigned_staff_id / current_candidate_id alanlarini ise
  // SILMIYORUZ, SADECE NULL'a cekiyoruz - o siparis kayitlari mali/analitik
  // gecmis icin onemli, personel hesabi silinse bile o gecmisin kaybolmamasi
  // gerekiyor (sadece "kim yaptigi" bilgisi bosa dusuyor).
  const deleteRelated = db.transaction(() => {
    db.prepare(`DELETE FROM chat_messages WHERE user_id = ?`).run(id);
    db.prepare(`DELETE FROM push_subscriptions WHERE user_id = ?`).run(id);
    db.prepare(`DELETE FROM saved_cards WHERE user_id = ?`).run(id);
    db.prepare(`DELETE FROM property_delegates WHERE delegate_user_id = ?`).run(id);
    db.prepare(`UPDATE cleaning_jobs SET assigned_staff_id = NULL WHERE assigned_staff_id = ?`).run(id);
    db.prepare(`UPDATE cleaning_jobs SET current_candidate_id = NULL WHERE current_candidate_id = ?`).run(id);
    db.prepare(`DELETE FROM users WHERE id = ?`).run(id);
  });
  deleteRelated();
  res.json({ message: 'Personel hesabı silindi.' });
});

// Super admin, bir PERSONELIN sifresini sifirlar (gormek degil - bkz.
// admins/:id/reset-password'daki ayni gerekce: hash'lenmis sifreler geri
// cozulemez, bu YUZDEN "goster" degil "yenisini belirle" akisi var).
router.put('/workers/:id/reset-password', requireSuperAdmin, (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'Yeni şifre en az 6 karakter olmalı.' });
  }
  const target = db.prepare(`SELECT id FROM users WHERE id = ? AND account_type = 'staff'`).get(req.params.id);
  if (!target) return res.status(404).json({ error: 'Personel bulunamadı.' });
  const passwordHash = bcrypt.hashSync(newPassword, 10);
  db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(passwordHash, req.params.id);
  res.json({ message: 'Şifre sıfırlandı.' });
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

// Bir müşterinin tüm mülkleri - Müşteriler sayfasında satıra tıklayınca
// açılan detay modalı için. Tekneye özgü alanlar (berth_number, length_ft
// vb.) dahil TÜM sütunlar dönüyor - kategoriye göre hangisinin gösterileceğine
// admin panelinin kendisi (categoryLabel/propertyMetaLine benzeri mantıkla)
// karar veriyor, tıpkı müşteri uygulamasındaki gibi.
router.get('/customers/:id/properties', (req, res) => {
  const { id } = req.params;
  const rows = db
    .prepare('SELECT * FROM properties WHERE owner_id = ? ORDER BY created_at DESC')
    .all(id);
  res.json({ properties: rows });
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
    d.setUTCDate(d.getUTCDate() - i);
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
// Gecerli kanallar: 'support' (genel destek) ve 'boat_quote' (>=50ft tekne
// fiyat teklifi talepleri). Admin panelinde bu ikisi TAMAMEN AYRI gelen
// kutulari olarak gosterilir - "Tekne Fiyat Talepleri" sekmesi "Destek"
// sekmesinden bagimsiz calisir.
function normalizeChannel(raw) {
  return raw === 'boat_quote' ? 'boat_quote' : 'support';
}

router.get('/chats', (req, res) => {
  const channel = normalizeChannel(req.query.channel);
  const rows = db
    .prepare(
      `SELECT u.id AS user_id, u.name AS customer_name, u.account_type,
              (SELECT message FROM chat_messages WHERE user_id = u.id AND channel = ? ORDER BY created_at DESC LIMIT 1) AS last_message,
              (SELECT created_at FROM chat_messages WHERE user_id = u.id AND channel = ? ORDER BY created_at DESC LIMIT 1) AS last_message_at,
              (SELECT COUNT(*) FROM chat_messages cm WHERE cm.user_id = u.id AND cm.channel = ? AND cm.sender = 'user'
                 AND NOT EXISTS (SELECT 1 FROM chat_messages r WHERE r.user_id = u.id AND r.channel = ? AND r.sender='admin' AND r.created_at >= cm.created_at)
              ) AS unread_count
       FROM users u
       WHERE EXISTS (SELECT 1 FROM chat_messages cm WHERE cm.user_id = u.id AND cm.channel = ?)
       ORDER BY last_message_at DESC`
    )
    .all(channel, channel, channel, channel, channel);
  res.json(rows);
});

router.get('/chats/:userId/messages', (req, res) => {
  const channel = normalizeChannel(req.query.channel);
  const rows = db
    .prepare('SELECT * FROM chat_messages WHERE user_id = ? AND channel = ? ORDER BY created_at ASC')
    .all(req.params.userId, channel);
  res.json(rows);
});

router.post('/chats/:userId/messages', (req, res) => {
  const { message } = req.body;
  const channel = normalizeChannel(req.body.channel);
  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Mesaj boş olamaz.' });
  }
  const targetUser = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.userId);
  if (!targetUser) return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });

  const id = uuid();
  db.prepare(
    `INSERT INTO chat_messages (id, user_id, sender, message, channel) VALUES (?, ?, 'admin', ?, ?)`
  ).run(id, req.params.userId, message.trim(), channel);
  res.status(201).json(db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(id));

  // Musteriye, admin'in yanitini push ile haber veriyoruz - kanala gore
  // baslik farkli (destek vs tekne fiyat teklifi), boylece musteri hangi
  // konuda yanit geldigini bildirimden bile anlar.
  sendPushToUser(req.params.userId, {
    title: channel === 'boat_quote' ? 'Tekne fiyat teklifine yanıt geldi' : 'MICISTO Destek\'ten yeni mesaj',
    body: message.trim().slice(0, 120),
    type: 'chat_message',
    channel,
  }).catch((err) => console.error('Chat push bildirimi hata:', err));
});

// --- Hizmetler & Fiyatlandırma ----------------------------------------------

// Fiyatlandırma alanı isimlerinin pricing_settings'teki anahtara nasıl
// eşlendiğini kontrol eder - admin rastgele bir sütuna yazamasın diye
// (SQL injection değil ama en azından anlamsız bir key üretmesin diye).
const PRICING_FIELDS = ['base', 'rate', 'min', 'estimatedMinutes', 'ratePerFloor', 'ratePerSqm', 'ratePerCapacity', 'thresholdSqm', 'flatPrice', 'extraRate'];

// NOT: getChecklist artık services/catalog.js'te - burada import ediliyor
// (müşteri uygulaması da aynı fonksiyonu kullanıyor, tek doğru kaynak).
// Admin paneli duzenleme ekrani icin UC DIL BIRDEN donuyor (tek dil degil).

router.get('/services', (req, res) => {
  const services = getAllServices().map((s) => ({ ...s, checklist: s.isGroup ? [] : getChecklistAllLangs(s.key) }));
  const commonAreaSubOptions = getAllCommonAreaSubOptions().map((s) => ({ ...s, checklist: getChecklistAllLangs(s.key) }));
  const addons = getAllAddons();
  const suppliesFees = getSuppliesFees();
  res.json({ services, commonAreaSubOptions, addons, suppliesFees });
});

// Bir hizmetin (ya da ortak alan alt seçeneğinin, ya da ekstra/tedarik
// ücretinin) fiyat parametrelerini günceller. Body: { base: 22, rate: 0.3, ... }
// - sadece gönderilen alanlar güncellenir, diğerlerine dokunulmaz.
router.put('/services/:key/pricing', (req, res) => {
  const { key } = req.params;
  const updates = req.body || {};
  const upsert = db.prepare(
    `INSERT INTO pricing_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  );
  let changed = 0;
  for (const field of PRICING_FIELDS) {
    if (updates[field] !== undefined && updates[field] !== null && updates[field] !== '') {
      const num = Number(updates[field]);
      if (Number.isNaN(num)) return res.status(400).json({ error: `${field} sayısal bir değer olmalı.` });
      upsert.run(`${key}.${field}`, num);
      changed++;
    }
  }
  if (changed === 0) return res.status(400).json({ error: 'Güncellenecek bir alan gönderilmedi.' });
  res.json({ message: 'Fiyatlandırma güncellendi.' });
});

// Yeni bir checklist maddesi ekler - ARTIK 3 DİLDE BİRDEN (itemTextTr
// zorunlu, itemTextEn/itemTextMe opsiyonel). NOT: eski "item_text" sütunu
// hâlâ NOT NULL kısıtlamasına sahip olduğu için, geriye dönük uyumluluk
// amacıyla oraya da Türkçe metni yazıyoruz (aksi halde INSERT hata verir).
router.post('/services/:key/checklist', (req, res) => {
  const { key } = req.params;
  const { itemTextTr, itemTextEn, itemTextMe } = req.body;
  if (!itemTextTr || !itemTextTr.trim()) return res.status(400).json({ error: 'Türkçe görev metni boş olamaz.' });

  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM service_checklists WHERE service_key = ?').get(key).m;
  const id = uuid();
  db.prepare('INSERT INTO service_checklists (id, service_key, item_text, item_text_tr, item_text_en, item_text_me, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, key, itemTextTr.trim(), itemTextTr.trim(), (itemTextEn || '').trim() || null, (itemTextMe || '').trim() || null, maxOrder + 1);
  res.status(201).json(db.prepare('SELECT * FROM service_checklists WHERE id = ?').get(id));
});

router.delete('/services/checklist/:itemId', (req, res) => {
  db.prepare('DELETE FROM service_checklists WHERE id = ?').run(req.params.itemId);
  res.json({ message: 'Silindi.' });
});

// Malzeme yok ("ekipman/kimyasal yok") ek ücretlerini günceller - bunlar
// belirli bir hizmete değil genel ayarlara ait olduğu için ayrı bir endpoint.
router.put('/supplies-fees', (req, res) => {
  const { noEquipment, noChemicals } = req.body || {};
  const upsert = db.prepare(
    `INSERT INTO pricing_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  );
  if (noEquipment !== undefined && noEquipment !== '') {
    const num = Number(noEquipment);
    if (Number.isNaN(num)) return res.status(400).json({ error: 'noEquipment sayısal olmalı.' });
    upsert.run('supplies.noEquipment', num);
  }
  if (noChemicals !== undefined && noChemicals !== '') {
    const num = Number(noChemicals);
    if (Number.isNaN(num)) return res.status(400).json({ error: 'noChemicals sayısal olmalı.' });
    upsert.run('supplies.noChemicals', num);
  }
  res.json({ message: 'Güncellendi.' });
});

router.post('/services/checklist/:itemId/move', (req, res) => {
  const { direction } = req.body; // 'up' | 'down'
  const item = db.prepare('SELECT * FROM service_checklists WHERE id = ?').get(req.params.itemId);
  if (!item) return res.status(404).json({ error: 'Görev bulunamadı.' });

  const neighbor = direction === 'up'
    ? db.prepare('SELECT * FROM service_checklists WHERE service_key = ? AND sort_order < ? ORDER BY sort_order DESC LIMIT 1').get(item.service_key, item.sort_order)
    : db.prepare('SELECT * FROM service_checklists WHERE service_key = ? AND sort_order > ? ORDER BY sort_order ASC LIMIT 1').get(item.service_key, item.sort_order);
  if (!neighbor) return res.json({ message: 'Zaten uçta.' });

  db.prepare('UPDATE service_checklists SET sort_order = ? WHERE id = ?').run(neighbor.sort_order, item.id);
  db.prepare('UPDATE service_checklists SET sort_order = ? WHERE id = ?').run(item.sort_order, neighbor.id);
  res.json({ message: 'Sıra güncellendi.' });
});

// --- Finans -----------------------------------------------------------------

// ONEMLI: financeCalc.js'teki ayni prensip burada da gecerli - SQLite'in
// date() fonksiyonu UTC calisir, bu yuzden JS tarafi da UTC kullanmali
// (aksi halde personel tarafiyla admin tarafi farkli "bugun" gorebilir).
function getFinancePeriodRange(period, offset) {
  const now = new Date();
  if (period === 'month') {
    const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
    const start = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), 1));
    const end = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0));
    return { start, end };
  }
  const day = now.getUTCDay();
  const diffToMonday = (day === 0 ? -6 : 1 - day);
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + diffToMonday + offset * 7));
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return { start: monday, end: sunday };
}
function toDateKey(d) {
  const y = d.getUTCFullYear(), m = String(d.getUTCMonth() + 1).padStart(2, '0'), day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Seçilen dönemde tamamlanan işlerden: toplam ciro, MICISTO komisyonu,
// ödeme yöntemi dağılımı, ve personel bazında mutabakat (kim kime ne kadar
// borçlu). Nakit işlerde para zaten personelde - o yüzden personel bize
// komisyonu ÖDEMELİ. Kart/fatura işlerinde para bizde - o yüzden biz
// personele net kazancını ÖDEMELİYİZ. netSettlement = biz personele
// borçluysak pozitif, personel bize borçluysa negatif.
router.get('/finance', (req, res) => {
  const period = req.query.period === 'month' ? 'month' : 'week';
  const offset = parseInt(req.query.offset, 10) || 0;
  const { start, end } = getFinancePeriodRange(period, offset);
  const startKey = toDateKey(start);
  const endKey = toDateKey(end);

  const jobs = db
    .prepare(
      `SELECT j.price, j.payment_method, j.assigned_staff_id, u.name AS staff_name
       FROM cleaning_jobs j
       LEFT JOIN users u ON u.id = j.assigned_staff_id
       WHERE j.status = 'done' AND date(j.completed_at) BETWEEN ? AND ?`
    )
    .all(startKey, endKey);

  const totalRevenue = jobs.reduce((sum, j) => sum + j.price, 0);
  const totalCommission = Math.round(jobs.reduce((sum, j) => sum + (j.price - calcNetEarning(j.price)), 0) * 100) / 100;
  const totalPayout = Math.round(jobs.reduce((sum, j) => sum + calcNetEarning(j.price), 0) * 100) / 100;

  const paymentBreakdown = { cash: { count: 0, total: 0 }, card: { count: 0, total: 0 }, invoice: { count: 0, total: 0 } };
  jobs.forEach((j) => {
    const method = paymentBreakdown[j.payment_method] ? j.payment_method : 'cash';
    paymentBreakdown[method].count += 1;
    paymentBreakdown[method].total += j.price;
  });

  const byStaff = {};
  jobs.forEach((j) => {
    if (!j.assigned_staff_id) return;
    if (!byStaff[j.assigned_staff_id]) {
      byStaff[j.assigned_staff_id] = {
        staffId: j.assigned_staff_id, staffName: j.staff_name,
        cashJobs: 0, cashTotal: 0, otherJobs: 0, otherTotal: 0,
        owedToStaff: 0, owedToBusiness: 0,
      };
    }
    const s = byStaff[j.assigned_staff_id];
    const net = calcNetEarning(j.price);
    if (j.payment_method === 'cash') {
      s.cashJobs += 1;
      s.cashTotal += j.price;
      s.owedToBusiness += (j.price - net); // personel bizim komisyonumuzu bize ödemeli
    } else {
      s.otherJobs += 1;
      s.otherTotal += j.price;
      s.owedToStaff += net; // biz personele net kazancini odemeliyiz
    }
  });
  const staffSettlements = Object.values(byStaff).map((s) => ({
    ...s,
    owedToStaff: Math.round(s.owedToStaff * 100) / 100,
    owedToBusiness: Math.round(s.owedToBusiness * 100) / 100,
    netSettlement: Math.round((s.owedToStaff - s.owedToBusiness) * 100) / 100,
  })).sort((a, b) => b.otherTotal + b.cashTotal - (a.otherTotal + a.cashTotal));

  res.json({
    period, offset, startDate: startKey, endDate: endKey,
    totalRevenue, totalCommission, totalPayout, commissionRate: getCommissionRate(),
    paymentBreakdown, staffSettlements, jobCount: jobs.length,
  });
});

// --- Personel bazlı mutabakat (ödeme dönemleri) ------------------------------
// ONEMLI: Burada getStaffPeriods/getStaffLifetimeTotal - personelin KENDI
// finans ekraninda (jobs.js /finance-summary) kullandigi AYNI fonksiyonlar.
// Admin ve personel taraflari boylece garantili olarak ayni sayilari gorur
// (iki ayri hesaplama mantigi degil, tek ortak kaynak).
router.get('/finance/staff', (req, res) => {
  const staffRows = db.prepare(`SELECT id, name, current_city FROM users WHERE account_type = 'staff' ORDER BY name ASC`).all();
  const staff = staffRows.map((s) => {
    const periods = getStaffPeriods(s.id);
    const unpaidPeriodCount = periods.filter((p) => !p.isPaid && (p.owedToStaff > 0 || p.owedToBusiness > 0)).length;
    return {
      id: s.id, name: s.name, current_city: s.current_city,
      totalEarned: getStaffLifetimeTotal(s.id),
      unpaidPeriodCount,
    };
  });
  res.json({ staff });
});

router.get('/finance/staff/:id/periods', (req, res) => {
  const staffRow = db.prepare(`SELECT id, name FROM users WHERE id = ? AND account_type = 'staff'`).get(req.params.id);
  if (!staffRow) return res.status(404).json({ error: 'Personel bulunamadı.' });
  const periods = getStaffPeriods(req.params.id);
  res.json({ staff: staffRow, periods });
});

// Personel kendi "Ödememi Aldım" derken de, admin burada "Ödendi
// İşaretle" derken de AYNI staff_payment_marks kaydına, AYNI upsert
// desenine yazılıyor (bkz. jobs.js /finance/mark-received) - iki taraf da
// aynı mutabakat gerçeğini görür.
router.post('/finance/staff/:id/periods/mark-paid', (req, res) => {
  const { periodStart, periodEnd, amount } = req.body || {};
  if (!periodStart || !periodEnd) return res.status(400).json({ error: 'Dönem bilgisi eksik.' });
  db.prepare(
    `INSERT INTO staff_payment_marks (id, staff_id, period_start, period_end, amount)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(staff_id, period_start) DO UPDATE SET amount = excluded.amount, paid_at = datetime('now')`
  ).run(uuid(), req.params.id, periodStart, periodEnd, Number(amount) || 0);
  res.json({ message: 'Ödendi olarak işaretlendi.' });

  // Personel kendi mutabakatini "Odememi Aldim" ile ZATEN kendisi
  // isaretliyorsa (jobs.js /finance/mark-received) bu push'a gerek yok -
  // kendine bildirim gondermek anlamsiz. Sadece ADMIN tarafindan
  // isaretlendiginde (yani personel henuz haberi yokken) push gonderiyoruz.
  if (req.user.accountType === 'admin') {
    sendPushToUser(req.params.id, {
      title: 'Ödemen gönderildi 💸',
      body: `${amount ? Number(amount).toFixed(2) + ' € ' : ''}tutarındaki ödemen işleme alındı.`,
      type: 'payment_sent',
    }).catch((err) => console.error('Ödeme bildirimi hata:', err));
  }
});

router.post('/finance/staff/:id/periods/unmark-paid', (req, res) => {
  const { periodStart } = req.body || {};
  db.prepare('DELETE FROM staff_payment_marks WHERE staff_id = ? AND period_start = ?').run(req.params.id, periodStart);
  res.json({ message: 'Ödeme işareti geri alındı.' });
});

// --- Push Kampanyalari (pazarlama/promosyon anlik gonderimleri) --------------
// Admin, secilen bir kitleye (tumu / bireysel / sirket, opsiyonel sehir
// filtresiyle) anlik bir push bildirimi olusturup gonderir. Gonderilen her
// kampanya push_campaigns tablosuna kayit olarak dusuyor - hem gecmis
// gorunsun hem "bugun zaten gonderdim mi" diye admin kontrol edebilsin.
router.get('/marketing/push-campaigns', (req, res) => {
  const campaigns = db
    .prepare(`SELECT * FROM push_campaigns ORDER BY created_at DESC LIMIT 50`)
    .all();
  res.json({ campaigns });
});

router.post('/marketing/push-campaigns', async (req, res) => {
  const { title, body, targetType, targetCity } = req.body || {};
  if (!title || !title.trim() || !body || !body.trim()) {
    return res.status(400).json({ error: 'Başlık ve mesaj metni zorunlu.' });
  }
  const finalTargetType = ['all', 'individual', 'company'].includes(targetType) ? targetType : 'all';
  const finalCity = targetCity && targetCity.trim() ? targetCity.trim() : null;

  // Hedef kitleyi olustur: her zaman sadece MUSTERI hesaplari (bireysel/
  // sirket) - personel/admin'e pazarlama push'u gitmiyor, bu kasitli.
  let query = `SELECT id FROM users WHERE account_type IN ('individual','company')`;
  const params = [];
  if (finalTargetType !== 'all') {
    query += ` AND account_type = ?`;
    params.push(finalTargetType);
  }
  if (finalCity) {
    // Musterinin sehri dogrudan users tablosunda degil, mulklerinden
    // cikariliyor - en az bir mulku o sehirde olan musteriler hedeflenir.
    query += ` AND id IN (SELECT owner_id FROM properties WHERE city = ?)`;
    params.push(finalCity);
  }
  const targets = db.prepare(query).all(...params);

  await sendPushToUsers(targets.map((t) => t.id), {
    title: title.trim(),
    body: body.trim(),
    type: 'campaign',
  });

  const id = uuid();
  db.prepare(
    `INSERT INTO push_campaigns (id, title, body, target_type, target_city, sent_count, created_by_admin_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, title.trim(), body.trim(), finalTargetType, finalCity, targets.length, req.user.id);

  res.status(201).json({ message: `Kampanya ${targets.length} kullanıcıya gönderildi.`, sentCount: targets.length });
});

// --- Ayarlar (Settings) ------------------------------------------------------

// --- Demo verisi temizleme --------------------------------------------------
// TUM musteri ve TUM siparis verisini geri alinamaz sekilde siler - demo/
// test asamasindan gercek kullanima gecerken kullanilir. Personel, admin ve
// personel basvurulari (staff_applications) HIC DOKUNULMUYOR - bilerek
// boyle, cunku bunlar demo verisi degil gercek operasyonel kurulum.
//
// Guvenlik: sadece super admin cagirabilir VE istegin govdesinde tam olarak
// "SIL" onay metni gelmesi gerekiyor - yanlislikla (orn. bir test script'i
// ya da yanlis tiklama ile) tetiklenmesini zorlastirmak icin. Frontend'de
// AYRICA kendi onay dialogu var (iki katmanli koruma).
router.post('/system/wipe-customer-data', requireSuperAdmin, (req, res) => {
  const { confirm } = req.body || {};
  if (confirm !== 'SIL') {
    return res.status(400).json({ error: 'Onay metni yanlış. Bu geri alınamaz bir işlemdir.' });
  }

  const customerPhones = db
    .prepare(`SELECT phone FROM users WHERE account_type IN ('individual','company')`)
    .all()
    .map((r) => r.phone);
  const customerCount = customerPhones.length;
  const propertyCount = db.prepare(`SELECT COUNT(*) AS c FROM properties`).get().c;
  const jobCount = db.prepare(`SELECT COUNT(*) AS c FROM cleaning_jobs`).get().c;

  const wipe = db.transaction(() => {
    db.exec(`DELETE FROM chat_messages WHERE user_id IN (SELECT id FROM users WHERE account_type IN ('individual','company'))`);
    db.exec(`DELETE FROM push_subscriptions WHERE user_id IN (SELECT id FROM users WHERE account_type IN ('individual','company'))`);
    db.exec(`DELETE FROM saved_cards WHERE user_id IN (SELECT id FROM users WHERE account_type IN ('individual','company'))`);
    db.exec(`DELETE FROM property_delegates`);
    db.exec(`DELETE FROM promo_code_redemptions`);
    db.exec(`DELETE FROM cleaning_jobs`);
    db.exec(`DELETE FROM properties`);
    db.exec(`DELETE FROM users WHERE account_type IN ('individual','company')`);
    const deleteOtp = db.prepare(`DELETE FROM otp_requests WHERE phone = ?`);
    for (const phone of customerPhones) deleteOtp.run(phone);
  });
  wipe();

  res.json({
    message: 'Tüm müşteri ve sipariş verisi temizlendi.',
    deletedCustomers: customerCount,
    deletedProperties: propertyCount,
    deletedOrders: jobCount,
  });
});

router.get('/settings', (req, res) => {
  res.json({
    commissionRate: getCommissionRate(),
    payoutCycleDays: getPayoutCycleDays(),
    dormantThresholdDays: getDormantThresholdDays(),
  });
});

router.put('/settings', (req, res) => {
  const { commissionRate, payoutCycleDays, dormantThresholdDays } = req.body || {};
  const upsert = db.prepare(
    `INSERT INTO pricing_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  );
  if (commissionRate !== undefined && commissionRate !== '') {
    const num = Number(commissionRate);
    if (Number.isNaN(num) || num < 0 || num > 1) {
      return res.status(400).json({ error: 'Komisyon oranı 0 ile 1 arasında bir ondalık sayı olmalı (örn. %20 için 0.2).' });
    }
    upsert.run('system.commissionRate', num);
  }
  if (payoutCycleDays !== undefined && payoutCycleDays !== '') {
    const num = Number(payoutCycleDays);
    if (Number.isNaN(num) || num < 1) {
      return res.status(400).json({ error: 'Ödeme döngüsü en az 1 gün olmalı.' });
    }
    upsert.run('system.payoutCycleDays', num);
  }
  if (dormantThresholdDays !== undefined && dormantThresholdDays !== '') {
    const num = Number(dormantThresholdDays);
    if (Number.isNaN(num) || num < 1) {
      return res.status(400).json({ error: 'Kullanmayan müşteri eşiği en az 1 gün olmalı.' });
    }
    upsert.run('marketing.dormantThresholdDays', num);
  }
  res.json({ message: 'Ayarlar güncellendi.' });
});

// --- Admin hesap yönetimi ----------------------------------------------------

router.get('/admins', (req, res) => {
  const admins = db.prepare(`SELECT id, name, username, created_at, is_super_admin FROM users WHERE account_type = 'admin' ORDER BY created_at ASC`).all();
  res.json({ admins });
});

// Yeni bir admin hesabı oluşturur - artık Railway konsoluna girmeye gerek
// yok, panel içinden birbirini davet edebilirler.
router.post('/admins', (req, res) => {
  const { name, username, password } = req.body || {};
  if (!name || !username || !password) {
    return res.status(400).json({ error: 'Ad, kullanıcı adı ve şifre zorunlu.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Şifre en az 6 karakter olmalı.' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim());
  if (existing) return res.status(409).json({ error: 'Bu kullanıcı adı zaten alınmış.' });

  const id = uuid();
  const passwordHash = bcrypt.hashSync(password, 10);
  const placeholderPhone = `admin-${id.slice(0, 8)}`;
  db.prepare(
    `INSERT INTO users (id, phone, name, account_type, username, password_hash, profile_completed)
     VALUES (?, ?, ?, 'admin', ?, ?, 1)`
  ).run(id, placeholderPhone, name.trim(), username.trim(), passwordHash);
  res.status(201).json({ message: 'Admin hesabı oluşturuldu.', admin: { id, name: name.trim(), username: username.trim() } });
});

router.delete('/admins/:id', requireSuperAdmin, (req, res) => {
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: 'Kendi hesabını silemezsin.' });
  }
  const totalAdmins = db.prepare(`SELECT COUNT(*) AS c FROM users WHERE account_type = 'admin'`).get().c;
  if (totalAdmins <= 1) {
    return res.status(400).json({ error: 'Son admin hesabı silinemez.' });
  }
  // Musteri/personel silmedeki AYNI FOREIGN KEY guvenlik onlemi - admin
  // hesabinin (dusuk ihtimal de olsa) chat/push kaydi varsa silme islemi
  // patlamasin diye.
  const deleteRelated = db.transaction(() => {
    db.prepare(`DELETE FROM chat_messages WHERE user_id = ?`).run(req.params.id);
    db.prepare(`DELETE FROM push_subscriptions WHERE user_id = ?`).run(req.params.id);
    db.prepare(`UPDATE push_campaigns SET created_by_admin_id = NULL WHERE created_by_admin_id = ?`).run(req.params.id);
    db.prepare(`UPDATE cleaning_jobs SET created_by_admin_id = NULL WHERE created_by_admin_id = ?`).run(req.params.id);
    db.prepare(`DELETE FROM users WHERE id = ? AND account_type = 'admin'`).run(req.params.id);
  });
  deleteRelated();
  res.json({ message: 'Admin hesabı silindi.' });
});

// Süper admin, BAŞKA bir adminin şifresini SIFIRLAR (yeni bir şifre
// belirler). ÖNEMLİ: mevcut şifreyi GÖRMEK/GERİ ÇÖZMEK mümkün değil ve
// güvenlik açısından zaten doğru olan budur - şifreler bcrypt ile
// hash'lenmiş durumda, hash'ten orijinal şifreye geri dönülemez. Bu yüzden
// "şifreyi göster" değil, "yeni şifre belirle" akışı sunuluyor.
router.put('/admins/:id/reset-password', requireSuperAdmin, (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'Yeni şifre en az 6 karakter olmalı.' });
  }
  const target = db.prepare(`SELECT id FROM users WHERE id = ? AND account_type = 'admin'`).get(req.params.id);
  if (!target) return res.status(404).json({ error: 'Admin hesabı bulunamadı.' });
  const passwordHash = bcrypt.hashSync(newPassword, 10);
  db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(passwordHash, req.params.id);
  res.json({ message: 'Şifre sıfırlandı.' });
});

// Bir müşteriyi (birey ya da yönetim şirketi) siler - yalnızca süper admin.
// Güvenlik: aktif/geçmiş mülkü olan bir müşteri YANLIŞLIKLA silinip veri
// bütünlüğü bozulmasın diye, önce mülkü olup olmadığı kontrol edilir. Gerçek
// bir müşteriyi silmek istiyorsa, önce mülklerini silmesi gerekir - bu,
// "yanlış/test kaydı" silme senaryosu için zaten yeterli bir akış (yeni
// kayıt olmuş, henüz hiçbir mülk eklememiş birini silmek serbest).
router.delete('/customers/:id', requireSuperAdmin, (req, res) => {
  const { id } = req.params;
  const target = db.prepare(`SELECT id FROM users WHERE id = ? AND account_type IN ('individual','company')`).get(id);
  if (!target) return res.status(404).json({ error: 'Müşteri bulunamadı.' });
  const propertyCount = db.prepare(`SELECT COUNT(*) AS c FROM properties WHERE owner_id = ?`).get(id).c;
  if (propertyCount > 0) {
    return res.status(409).json({ error: 'Bu müşterinin kayıtlı mülkleri var, önce onları silmelisin.' });
  }
  // ONEMLI: users tablosuna FOREIGN KEY ile referans veren BASKA tablolar da
  // var (chat_messages, push_subscriptions, saved_cards, property_delegates) -
  // bunlar "kritik iş verisi" degil (mulk/siparis gibi), sadece yardimci/
  // ikincil kayitlar. Musteri silinmeden ONCE bunlarin temizlenmesi gerekiyor,
  // yoksa SQLite FOREIGN KEY constraint hatasi verip 500 sunucu hatasina
  // yol aciyordu (gercek bir demo hesabinda chat mesaji oldugu icin tam bu
  // hata yasandi - test edilip dogrulandi).
  const deleteRelated = db.transaction(() => {
    db.prepare(`DELETE FROM chat_messages WHERE user_id = ?`).run(id);
    db.prepare(`DELETE FROM push_subscriptions WHERE user_id = ?`).run(id);
    db.prepare(`DELETE FROM saved_cards WHERE user_id = ?`).run(id);
    db.prepare(`DELETE FROM property_delegates WHERE delegate_user_id = ?`).run(id);
    db.prepare(`DELETE FROM users WHERE id = ?`).run(id);
  });
  deleteRelated();
  res.json({ message: 'Müşteri silindi.' });
});

// Bir siparişi/işi siler - yalnızca süper admin. Tamamlanmış/ödenmiş bir
// işin yanlışlıkla silinip mali kayıtların bozulmaması için, ödemesi
// alınmış (payment_status='released' ya da 'held') işlerin silinmesi
// engellenir - bunlar yalnızca durum değiştirilerek (iptal vb.) yönetilebilir.
router.delete('/bookings/:id', requireSuperAdmin, (req, res) => {
  const { id } = req.params;
  const job = db.prepare(`SELECT id, payment_status FROM cleaning_jobs WHERE id = ?`).get(id);
  if (!job) return res.status(404).json({ error: 'Sipariş bulunamadı.' });
  if (['held', 'released'].includes(job.payment_status)) {
    return res.status(409).json({ error: 'Ödemesi alınmış/tutulan bir sipariş silinemez.' });
  }
  db.prepare(`DELETE FROM cleaning_jobs WHERE id = ?`).run(id);
  res.json({ message: 'Sipariş silindi.' });
});

// Giriş yapmış admin kendi şifresini değiştirir.
router.put('/account/password', (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Mevcut şifre ve yeni şifre zorunlu.' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'Yeni şifre en az 6 karakter olmalı.' });
  }
  const me = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!me || !bcrypt.compareSync(currentPassword, me.password_hash)) {
    return res.status(401).json({ error: 'Mevcut şifre hatalı.' });
  }
  const newHash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, req.user.id);
  res.json({ message: 'Şifre güncellendi.' });
});

// --- Performans Paneli (personel + müşteri) ---------------------------------
// NOT: service_score (temizliğe verilen puan) ve staff_score (personele
// verilen puan) ayrı sütunlar. Şirket geneli "Genel Kalite Puanımız" kartı,
// personel ortalamalarının ortalaması DEĞİL - her işin kendi puanı üzerinden
// hesaplanıyor (çok değerlendirmesi olan personel, az olana göre daha doğru
// ağırlıkta sayılsın diye).
router.get('/performance/staff', (req, res) => {
  const staffRows = db.prepare(`SELECT id, name FROM users WHERE account_type = 'staff' ORDER BY name ASC`).all();
  const jobRows = db.prepare(`
    SELECT assigned_staff_id, service_score, staff_score
    FROM cleaning_jobs
    WHERE assigned_staff_id IS NOT NULL AND (service_score IS NOT NULL OR staff_score IS NOT NULL)
  `).all();

  const byStaff = {};
  const allCombinedScores = [];
  jobRows.forEach((j) => {
    if (!byStaff[j.assigned_staff_id]) {
      byStaff[j.assigned_staff_id] = { serviceSum: 0, serviceCount: 0, staffSum: 0, staffCount: 0 };
    }
    const b = byStaff[j.assigned_staff_id];
    if (j.service_score !== null) { b.serviceSum += j.service_score; b.serviceCount += 1; }
    if (j.staff_score !== null) { b.staffSum += j.staff_score; b.staffCount += 1; }
    if (j.service_score !== null && j.staff_score !== null) allCombinedScores.push((j.service_score + j.staff_score) / 2);
    else if (j.staff_score !== null) allCombinedScores.push(j.staff_score);
    else if (j.service_score !== null) allCombinedScores.push(j.service_score);
  });

  const staff = staffRows.map((s) => {
    const b = byStaff[s.id] || { serviceSum: 0, serviceCount: 0, staffSum: 0, staffCount: 0 };
    const serviceAvg = b.serviceCount ? Math.round((b.serviceSum / b.serviceCount) * 10) / 10 : null;
    const staffAvg = b.staffCount ? Math.round((b.staffSum / b.staffCount) * 10) / 10 : null;
    const overallAvg = (serviceAvg !== null && staffAvg !== null)
      ? Math.round(((serviceAvg + staffAvg) / 2) * 10) / 10
      : (staffAvg !== null ? staffAvg : serviceAvg);
    const ratingCount = Math.max(b.serviceCount, b.staffCount);
    return { id: s.id, name: s.name, serviceAvg, staffAvg, overallAvg, ratingCount };
  }).sort((a, b) => (b.overallAvg ?? -1) - (a.overallAvg ?? -1));

  const companyAvg = allCombinedScores.length
    ? Math.round((allCombinedScores.reduce((a, b) => a + b, 0) / allCombinedScores.length) * 10) / 10
    : null;

  res.json({ companyAvg, staff });
});

router.get('/performance/customers', (req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.name, u.company_name, u.account_type,
      (SELECT COUNT(*) FROM cleaning_jobs j JOIN properties p ON p.id = j.property_id WHERE p.owner_id = u.id) AS orderCount,
      (SELECT COUNT(*) FROM promo_code_redemptions r
         JOIN promo_codes pc ON pc.id = r.promo_code_id
         WHERE r.customer_id = u.id AND pc.source = 'referral') AS referralUsedCount
    FROM users u
    WHERE u.account_type IN ('individual','company')
    ORDER BY orderCount DESC
  `).all();
  res.json({ customers: rows });
});

module.exports = router;
