const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { generateActivationCode } = require('../services/credentials');
const { getAllServices, getAllCommonAreaSubOptions, getAllAddons, getSuppliesFees, calcNetEarning, getCommissionRate, getPayoutCycleDays, getChecklist, getChecklistAllLangs } = require('../services/catalog');

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
      avgScore,
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

// --- Hizmetler & Fiyatlandırma ----------------------------------------------

// Fiyatlandırma alanı isimlerinin pricing_settings'teki anahtara nasıl
// eşlendiğini kontrol eder - admin rastgele bir sütuna yazamasın diye
// (SQL injection değil ama en azından anlamsız bir key üretmesin diye).
const PRICING_FIELDS = ['base', 'rate', 'min', 'estimatedMinutes', 'ratePerFloor', 'ratePerSqm', 'ratePerCapacity', 'thresholdSqm', 'flatPrice', 'extraRate'];

// NOT: getChecklist artık services/catalog.js'te - burada import ediliyor
// (müşteri uygulaması da aynı fonksiyonu kullanıyor, tek doğru kaynak).
// Admin paneli düzenleme ekranı için getChecklistAllLangs kullanılıyor -
// bu, TR/EN/ME metinlerini BİRLİKTE döner (tek dil değil), böylece admin
// panelinde 3 dil kutusu aynı anda doldurulabiliyor.

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
// zorunlu, itemTextEn/itemTextMe opsiyonel ama admin panelindeki form
// ikisini de gönderecek şekilde tasarlanmalı). Türkçe metin girilip diğer
// ikisi boş bırakılırsa, o diller için checklist boş görünür - admin
// panelindeki 3 kutuyu doldurmak asıl doğru kullanım.
router.post('/services/:key/checklist', (req, res) => {
  const { key } = req.params;
  const { itemTextTr, itemTextEn, itemTextMe } = req.body;
  if (!itemTextTr || !itemTextTr.trim()) return res.status(400).json({ error: 'Türkçe görev metni boş olamaz.' });

  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM service_checklists WHERE service_key = ?').get(key).m;
  const id = uuid();
  db.prepare('INSERT INTO service_checklists (id, service_key, item_text_tr, item_text_en, item_text_me, sort_order) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, key, itemTextTr.trim(), (itemTextEn || '').trim() || null, (itemTextMe || '').trim() || null, maxOrder + 1);
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

function getFinancePeriodRange(period, offset) {
  const now = new Date();
  if (period === 'month') {
    const target = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const start = new Date(target.getFullYear(), target.getMonth(), 1);
    const end = new Date(target.getFullYear(), target.getMonth() + 1, 0);
    return { start, end };
  }
  const day = now.getDay();
  const diffToMonday = (day === 0 ? -6 : 1 - day);
  const monday = new Date(now);
  monday.setDate(now.getDate() + diffToMonday + offset * 7);
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return { start: monday, end: sunday };
}
function toDateKey(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
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

// --- Ayarlar (Settings) ------------------------------------------------------

router.get('/settings', (req, res) => {
  res.json({
    commissionRate: getCommissionRate(),
    payoutCycleDays: getPayoutCycleDays(),
  });
});

router.put('/settings', (req, res) => {
  const { commissionRate, payoutCycleDays } = req.body || {};
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
  res.json({ message: 'Ayarlar güncellendi.' });
});

// --- Admin hesap yönetimi ----------------------------------------------------

router.get('/admins', (req, res) => {
  const admins = db.prepare(`SELECT id, name, username, created_at FROM users WHERE account_type = 'admin' ORDER BY created_at ASC`).all();
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

router.delete('/admins/:id', (req, res) => {
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: 'Kendi hesabını silemezsin.' });
  }
  const totalAdmins = db.prepare(`SELECT COUNT(*) AS c FROM users WHERE account_type = 'admin'`).get().c;
  if (totalAdmins <= 1) {
    return res.status(400).json({ error: 'Son admin hesabı silinemez.' });
  }
  db.prepare(`DELETE FROM users WHERE id = ? AND account_type = 'admin'`).run(req.params.id);
  res.json({ message: 'Admin hesabı silindi.' });
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

module.exports = router;
