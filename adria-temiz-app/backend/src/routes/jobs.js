const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { calcPrice, calcCommonAreaSubPrice, calcAddonsTotal, calcSuppliesFee, getService, calcNetEarning, estimateJobMinutes, calcPerformanceBonus, getCommissionRate } = require('../services/catalog');
const { validatePromoCode, calcDiscount, redeemPromo } = require('../services/promo');
const { dispatchJob } = require('../services/dispatch');

const router = express.Router();
router.use(requireAuth);

function accessiblePropertyIds(userId) {
  const rows = db
    .prepare(
      `SELECT id FROM properties WHERE owner_id = ?
       UNION
       SELECT p.id FROM properties p
       JOIN property_delegates d ON d.property_id = p.id
       WHERE d.delegate_user_id = ? AND d.status = 'accepted'`
    )
    .all(userId, userId);
  return rows.map((r) => r.id);
}

function resolveScheduledAt(urgency, scheduledAt) {
  if (urgency === 'now' || urgency === 'urgent') return new Date().toISOString();
  if (!scheduledAt) throw new Error('Planlanan tarih/saat zorunlu.');
  return new Date(scheduledAt).toISOString();
}

// Ana akış: kullanıcı bir mülk + hizmet + zamanlama + (opsiyonel) ekstra
// hizmetler + ödeme yöntemini TEK adımda seçip siparişini tamamlar.
// Kart seçilirse ödeme hemen alınır (escrow'da tutulur); nakit/fatura
// seçilirse tamamlanınca sonuçlanır.
//
// Ortak Alan Temizliği için kat sayısı/kat başına m²/asansör kapasitesi gibi
// bina parametreleri artık sipariş anında değil, mülk eklenirken bir kez
// girilip properties tablosunda saklanıyor - müşteri her siparişte bunları
// tekrar girmek zorunda kalmıyor, sadece hangi alt hizmeti istediğini seçiyor.
// Sipariş göndermeden önce müşterinin girdiği kodu doğrulayıp kaç € indirim
// yapacağını gösterir - "Kod Uygula" butonunun arkasındaki endpoint.
router.post('/validate-promo', (req, res) => {
  const { code, propertyId, serviceKey, priceBeforeDiscount } = req.body;
  if (!accessiblePropertyIds(req.user.id).includes(propertyId)) {
    return res.status(403).json({ error: 'Bu mülke erişim yetkiniz yok.' });
  }
  const property = db.prepare('SELECT * FROM properties WHERE id = ?').get(propertyId);
  const result = validatePromoCode({ code, customerId: req.user.id, city: property.city, serviceKey });
  if (result.error) return res.status(400).json({ error: result.error });
  const discountAmount = calcDiscount(result.promo, Number(priceBeforeDiscount) || 0);
  res.json({ valid: true, discountAmount, discountType: result.promo.discount_type, discountValue: result.promo.discount_value });
});

router.post('/', async (req, res) => {
  const {
    propertyId, serviceKey, urgency, scheduledAt, addons, paymentMethod,
    hasEquipment, hasChemicals, serviceParams,
  } = req.body;

  if (!['cash', 'card', 'invoice'].includes(paymentMethod)) {
    return res.status(400).json({ error: "paymentMethod 'cash', 'card' veya 'invoice' olmalı." });
  }
  if (paymentMethod === 'invoice' && req.user.accountType !== 'company') {
    return res.status(403).json({ error: 'Aylık fatura seçeneği yalnızca yönetim şirketi hesapları için geçerli.' });
  }
  if (!accessiblePropertyIds(req.user.id).includes(propertyId)) {
    return res.status(403).json({ error: 'Bu mülke erişim yetkiniz yok.' });
  }

  let checkoutAt;
  try {
    getService(serviceKey);
    checkoutAt = resolveScheduledAt(urgency || 'scheduled', scheduledAt);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const property = db.prepare('SELECT * FROM properties WHERE id = ?').get(propertyId);
  const isCommonArea = serviceKey === 'common_area';

  if (isCommonArea && property.category !== 'common_area') {
    return res.status(400).json({ error: 'Ortak Alan Temizliği yalnızca "Ortak Alan" kategorili bir mülk için sipariş edilebilir.' });
  }
  if (serviceKey === 'office' && property.category !== 'office') {
    return res.status(400).json({ error: 'Bu hizmet yalnızca "Ofis / İşyeri" kategorili bir mülk için sipariş edilebilir.' });
  }

  // Ortak alan siparişlerinde halı/koltuk gibi ekstra hizmetler yok -
  // gönderilse bile yok sayılır.
  const addonsList = isCommonArea
    ? []
    : (Array.isArray(addons) ? addons.filter((a) => a && a.key) : []);

  let addonsTotal = 0;
  let basePrice = 0;
  try {
    addonsTotal = calcAddonsTotal(addonsList);
    if (isCommonArea) {
      const selections = (serviceParams && serviceParams.selections) || [];
      if (selections.length === 0) throw new Error('En az bir ortak alan hizmeti seçilmeli.');
      basePrice = selections.reduce((sum, sel) => {
        if (sel.key === 'staircase' || sel.key === 'corridor') {
          if (!property.floor_count) throw new Error('Bu mülk için kat sayısı tanımlanmamış.');
        }
        if (sel.key === 'corridor' && !property.sqm_per_floor) {
          throw new Error('Bu mülk için kat başına m² tanımlanmamış.');
        }
        if (sel.key === 'elevator' && !property.elevator_capacity) {
          throw new Error('Bu mülk için asansör kapasitesi tanımlanmamış.');
        }
        return sum + calcCommonAreaSubPrice(sel.key, {
          floorCount: property.floor_count,
          sqmPerFloor: property.sqm_per_floor,
          elevatorCapacity: property.elevator_capacity,
        });
      }, 0);
    } else {
      basePrice = calcPrice(serviceKey, { sizeSqm: property.size_sqm });
    }
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const equipmentOk = hasEquipment !== false;
  const chemicalsOk = hasChemicals !== false;
  const suppliesFee = calcSuppliesFee({ hasEquipment: equipmentOk, hasChemicals: chemicalsOk });
  const priceBeforeDiscount = basePrice + addonsTotal + suppliesFee;

  let appliedPromo = null;
  let discountAmount = 0;
  if (req.body.promoCode) {
    const result = validatePromoCode({
      code: req.body.promoCode,
      customerId: req.user.id,
      city: property.city,
      serviceKey,
    });
    if (result.error) return res.status(400).json({ error: result.error });
    appliedPromo = result.promo;
    discountAmount = calcDiscount(appliedPromo, priceBeforeDiscount);
  }

  const price = Math.max(0, priceBeforeDiscount - discountAmount);
  const paymentStatus = paymentMethod === 'card' ? 'held' : 'unpaid';

  const id = uuid();
  db.prepare(
    `INSERT INTO cleaning_jobs
       (id, property_id, service_key, addons, service_params, has_equipment, has_chemicals,
        urgency, payment_method, checkout_at, status, source, price, payment_status, promo_code_id, discount_amount)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'manual', ?, ?, ?, ?)`
  ).run(
    id,
    property.id,
    serviceKey,
    addonsList.length ? JSON.stringify(addonsList) : null,
    serviceParams ? JSON.stringify(serviceParams) : null,
    equipmentOk ? 1 : 0,
    chemicalsOk ? 1 : 0,
    urgency || 'scheduled',
    paymentMethod,
    checkoutAt,
    price,
    paymentStatus,
    appliedPromo ? appliedPromo.id : null,
    discountAmount || null
  );

  if (appliedPromo) redeemPromo(appliedPromo, req.user.id, id, discountAmount);

  const createdJob = db.prepare('SELECT * FROM cleaning_jobs WHERE id = ?').get(id);
  res.status(201).json(createdJob);

  dispatchJob(id).catch((err) => console.error('dispatchJob hata:', err));
});

// Kullanıcının (bireysel ev sahibi veya yönetim şirketi) erişebildiği
// tüm mülklerdeki temizlik işleri - portföy görünümü şablon 7.1'e uygun.
router.get('/', (req, res) => {
  const ids = accessiblePropertyIds(req.user.id);
  if (ids.length === 0) return res.json([]);

  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT j.*, p.name AS property_name, p.city AS property_city
       FROM cleaning_jobs j
       JOIN properties p ON p.id = j.property_id
       WHERE j.property_id IN (${placeholders})
       ORDER BY j.checkout_at DESC`
    )
    .all(...ids);
  res.json(rows);
});

// Personel uygulamasının kullanacağı endpoint: atanmamış (pending) işler.
// Sadece personel hesapları görebilir.
router.get('/pending', (req, res) => {
  if (req.user.accountType !== 'staff') {
    return res.status(403).json({ error: 'Bu sayfayı yalnızca personel görebilir.' });
  }
  const rows = db
    .prepare(
      `SELECT j.*, p.name AS property_name, p.address AS property_address, p.city AS property_city,
              p.latitude AS property_latitude, p.longitude AS property_longitude
       FROM cleaning_jobs j
       JOIN properties p ON p.id = j.property_id
       WHERE j.status = 'pending'
       ORDER BY j.checkout_at ASC`
    )
    .all();
  res.json(rows);
});

// Personel bir işi kendine alır ("İşi Al" - Glovo'daki sipariş kabul etme
// gibi). Sadece personel hesapları kullanabilir, sadece hâlâ kimse
// tarafından alınmamış (pending) bir işi alabilirler.
// Personel, kendisine bildirilen bir iş teklifini kabul eder. Sadece
// gerçekten kendisine bildirilmiş (notified_staff_ids içinde) bir işi kabul
// edebilir - rastgele bir iş id'siyle deneme yapılamaz. Acil siparişlerde
// birden fazla personel aynı anda kabul etmeye çalışabileceği için atomik
// bir UPDATE ile "ilk kabul eden alır" garantisi sağlanıyor.
router.post('/:id/accept', (req, res) => {
  if (req.user.accountType !== 'staff') {
    return res.status(403).json({ error: 'Bu işlemi yalnızca personel yapabilir.' });
  }
  const staffUser = db.prepare('SELECT is_online FROM users WHERE id = ?').get(req.user.id);
  if (!staffUser || !staffUser.is_online) {
    return res.status(403).json({ error: 'Çevrimdışısın - iş alabilmek için önce çevrimiçi olmalısın.' });
  }
  const { id } = req.params;
  const job = db.prepare('SELECT * FROM cleaning_jobs WHERE id = ?').get(id);
  if (!job) return res.status(404).json({ error: 'Sipariş bulunamadı.' });

  // NOT: Sipariş Bildirimleri (dağıtım motoru) ertelendiği için
  // notified_staff_ids şu an hiç doldurulmuyor. Boşsa (bildirim sistemi
  // devrede değilse) herhangi bir çevrimiçi personelin işi alabilmesine
  // izin veriyoruz - dolu olduğunda (dağıtım motoru geri gelince) sadece
  // gerçekten bildirilen personelle sınırlanacak.
  const notifiedIds = JSON.parse(job.notified_staff_ids || '[]');
  if (notifiedIds.length > 0 && !notifiedIds.includes(req.user.id)) {
    return res.status(403).json({ error: 'Bu iş sana bildirilmedi.' });
  }

  const result = db
    .prepare(`UPDATE cleaning_jobs SET status = 'assigned', assigned_staff_id = ?, accepted_at = datetime('now') WHERE id = ? AND status = 'pending'`)
    .run(req.user.id, id);
  if (result.changes === 0) {
    return res.status(409).json({ error: 'Bu iş başka bir personel tarafından zaten alınmış.' });
  }
  res.json(db.prepare('SELECT * FROM cleaning_jobs WHERE id = ?').get(id));
});

// Personel bir iş teklifini reddeder. Acil olmayan siparişlerde bu, sırayı
// bir sonraki en yakın adaya devreder. Acil (herkese aynı anda bildirilen)
// siparişlerde reddetme başkasını engellemez, sadece kayıt altına alınır.
router.post('/:id/reject', async (req, res) => {
  if (req.user.accountType !== 'staff') {
    return res.status(403).json({ error: 'Bu işlemi yalnızca personel yapabilir.' });
  }
  const { id } = req.params;
  const job = db.prepare('SELECT * FROM cleaning_jobs WHERE id = ?').get(id);
  if (!job) return res.status(404).json({ error: 'Sipariş bulunamadı.' });
  if (job.status !== 'pending') {
    return res.json({ message: 'Bu iş artık uygun değil.' });
  }
  if (job.urgency !== 'urgent' && job.current_candidate_id === req.user.id) {
    db.prepare(`UPDATE cleaning_jobs SET current_candidate_id = NULL WHERE id = ?`).run(id);
    await dispatchJob(id);
  }
  res.json({ message: 'Reddedildi.' });
});

// Bildirime tıklayınca açılacak iş teklifi kartı için detay - fiyat, konum,
// ortalama süre, ödeme tipi ve personelin net kazancı dahil.
// Push bildirimi gelmediyse/kaçırıldıysa personelin elle "bekleyen bir
// teklifim var mı?" diye kontrol edebilmesi için yedek endpoint. Kendisine
// bildirilmiş (notified_staff_ids içinde), hâlâ 'pending' olan en eski işi
// döner - varsa jobId, yoksa null.
router.get('/my-pending-offer', (req, res) => {
  if (req.user.accountType !== 'staff') {
    return res.status(403).json({ error: 'Bu işlemi yalnızca personel yapabilir.' });
  }
  const pendingJobs = db
    .prepare(`SELECT id, notified_staff_ids, notification_sent_at FROM cleaning_jobs WHERE status = 'pending' AND notified_staff_ids IS NOT NULL AND notified_staff_ids != '[]'`)
    .all();
  const mine = pendingJobs
    .filter((j) => {
      try { return JSON.parse(j.notified_staff_ids).includes(req.user.id); }
      catch (e) { return false; }
    })
    .sort((a, b) => new Date(a.notification_sent_at || 0) - new Date(b.notification_sent_at || 0));
  res.json({ jobId: mine.length ? mine[0].id : null });
});

router.get('/:id/offer-detail', (req, res) => {
  if (req.user.accountType !== 'staff') {
    return res.status(403).json({ error: 'Bu sayfayı yalnızca personel görebilir.' });
  }
  const { id } = req.params;
  const job = db
    .prepare(
      `SELECT j.*, p.name AS property_name, p.address AS property_address, p.city AS property_city,
              p.latitude AS property_latitude, p.longitude AS property_longitude
       FROM cleaning_jobs j JOIN properties p ON p.id = j.property_id WHERE j.id = ?`
    )
    .get(id);
  if (!job) return res.status(404).json({ error: 'Sipariş bulunamadı.' });

  const notifiedIds = JSON.parse(job.notified_staff_ids || '[]');
  const isCandidate = notifiedIds.includes(req.user.id) || job.assigned_staff_id === req.user.id;
  if (!isCandidate) {
    return res.status(403).json({ error: 'Bu işe erişim yetkiniz yok.' });
  }

  res.json({
    ...job,
    estimatedMinutes: estimateJobMinutes(job.service_key, JSON.parse(job.service_params || 'null')),
    netEarning: calcNetEarning(job.price),
    canRespond: job.status === 'pending',
  });
});

// Personelin kendine aldığı, henüz tamamlamadığı işler ("İşlerim" listesi).
router.get('/mine', (req, res) => {
  if (req.user.accountType !== 'staff') {
    return res.status(403).json({ error: 'Bu sayfayı yalnızca personel görebilir.' });
  }
  const rows = db
    .prepare(
      `SELECT j.*, p.name AS property_name, p.address AS property_address, p.city AS property_city,
              p.latitude AS property_latitude, p.longitude AS property_longitude
       FROM cleaning_jobs j
       JOIN properties p ON p.id = j.property_id
       WHERE j.assigned_staff_id = ? AND j.status IN ('assigned','in_progress')
       ORDER BY j.checkout_at ASC`
    )
    .all(req.user.id);
  res.json(rows);
});

// Home paneli için: bugün yapılacak (onaylanmış/devam eden) işler +
// bugün tamamlanan işlerden oluşan kazanç özeti (MICISTO komisyonu
// düşülmüş hali). "Bugün" karşılaştırması sunucu saatine göre yapılır.
router.get('/home-summary', (req, res) => {
  if (req.user.accountType !== 'staff') {
    return res.status(403).json({ error: 'Bu sayfayı yalnızca personel görebilir.' });
  }
  const propertyFields = `p.name AS property_name, p.address AS property_address, p.city AS property_city,
                           p.latitude AS property_latitude, p.longitude AS property_longitude`;

  const todaysJobs = db
    .prepare(
      `SELECT j.*, ${propertyFields}
       FROM cleaning_jobs j
       JOIN properties p ON p.id = j.property_id
       WHERE j.assigned_staff_id = ? AND j.status IN ('assigned','in_progress')
         AND date(j.checkout_at) = date('now')
       ORDER BY j.checkout_at ASC`
    )
    .all(req.user.id)
    .map((j) => ({ ...j, estimatedMinutes: estimateJobMinutes(j.service_key, JSON.parse(j.service_params || 'null')) }));

  const completedToday = db
    .prepare(
      `SELECT j.*, ${propertyFields}
       FROM cleaning_jobs j
       JOIN properties p ON p.id = j.property_id
       WHERE j.assigned_staff_id = ? AND j.status = 'done'
         AND date(j.completed_at) = date('now')
       ORDER BY j.completed_at DESC`
    )
    .all(req.user.id);

  const grossTotal = completedToday.reduce((sum, j) => sum + j.price, 0);
  const netTotal = completedToday.reduce((sum, j) => sum + calcNetEarning(j.price), 0);

  res.json({
    todaysJobs,
    earningsToday: {
      jobCount: completedToday.length,
      grossTotal,
      netTotal: Math.round(netTotal * 100) / 100,
      commissionRate: getCommissionRate(),
    },
  });
});

// Hafta/ay başlangıcını hesaplar. offset: 0=içinde bulunulan dönem,
// -1=bir önceki, +1=bir sonraki (dönem gezinme için).
function getPeriodRange(period, offset) {
  const now = new Date();
  if (period === 'month') {
    const target = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const start = new Date(target.getFullYear(), target.getMonth(), 1);
    const end = new Date(target.getFullYear(), target.getMonth() + 1, 0); // ayın son günü
    return { start, end, totalDays: end.getDate() };
  }
  // hafta - Pazartesi başlangıçlı
  const day = now.getDay();
  const diffToMonday = (day === 0 ? -6 : 1 - day);
  const monday = new Date(now);
  monday.setDate(now.getDate() + diffToMonday + offset * 7);
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return { start: monday, end: sunday, totalDays: 7 };
}
function toDateKey(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Performans/Kazanç paneli: seçilen dönemde (hafta/ay) tamamlanan işler,
// net kazanç (komisyon düşülmüş) ve performans bonusu (şimdilik placeholder,
// bonus formülü netleşince doldurulacak - bkz. catalog.js).
router.get('/performance', (req, res) => {
  if (req.user.accountType !== 'staff') {
    return res.status(403).json({ error: 'Bu sayfayı yalnızca personel görebilir.' });
  }
  const period = req.query.period === 'month' ? 'month' : 'week';
  const offset = parseInt(req.query.offset, 10) || 0;
  const { start, end, totalDays } = getPeriodRange(period, offset);
  const startKey = toDateKey(start);
  const endKey = toDateKey(end);

  const jobs = db
    .prepare(
      `SELECT j.*, p.name AS property_name, p.city AS property_city
       FROM cleaning_jobs j
       JOIN properties p ON p.id = j.property_id
       WHERE j.assigned_staff_id = ? AND j.status = 'done'
         AND date(j.completed_at) BETWEEN ? AND ?
       ORDER BY j.completed_at DESC`
    )
    .all(req.user.id, startKey, endKey);

  const grossTotal = jobs.reduce((sum, j) => sum + j.price, 0);
  const netTotal = Math.round(jobs.reduce((sum, j) => sum + calcNetEarning(j.price), 0) * 100) / 100;
  const daysWorked = new Set(jobs.map((j) => (j.completed_at || '').slice(0, 10))).size;
  const completionRate = totalDays ? daysWorked / totalDays : 0;
  const bonus = calcPerformanceBonus(completionRate, { period, daysWorked, totalDays });

  res.json({
    period, offset, startDate: startKey, endDate: endKey,
    jobs, jobCount: jobs.length, grossTotal, netTotal,
    daysWorked, totalDays, completionRate, bonus,
    commissionRate: getCommissionRate(),
  });
});

// Personelin kendisine verilen değerlendirmeleri görmesi. BİLEREK sadece
// like/dislike bilgisi dönüyor - müşterinin yazdığı yorum metni (staff_feedback)
// buraya HİÇ dahil edilmiyor. Amaç: personelin memnuniyetsiz bir müşteriyle
// şikayet detaylarına bakıp sonradan iletişime geçmeye çalışmasını önlemek.
router.get('/ratings', (req, res) => {
  if (req.user.accountType !== 'staff') {
    return res.status(403).json({ error: 'Bu sayfayı yalnızca personel görebilir.' });
  }
  const period = req.query.period === 'month' ? 'month' : 'week';
  const offset = parseInt(req.query.offset, 10) || 0;
  const { start, end } = getPeriodRange(period, offset);
  const startKey = toDateKey(start);
  const endKey = toDateKey(end);

  const rows = db
    .prepare(
      `SELECT j.id, j.service_key, j.service_params, j.completed_at, j.staff_rating,
              p.name AS property_name, p.city AS property_city
       FROM cleaning_jobs j
       JOIN properties p ON p.id = j.property_id
       WHERE j.assigned_staff_id = ? AND j.status = 'done' AND j.staff_rating IS NOT NULL
         AND date(j.completed_at) BETWEEN ? AND ?
       ORDER BY j.completed_at DESC`
    )
    .all(req.user.id, startKey, endKey);

  const totalRated = rows.length;
  const likeCount = rows.filter((r) => r.staff_rating === 'like').length;
  const likePercentage = totalRated ? Math.round((likeCount / totalRated) * 100) : null;

  res.json({
    period, offset, startDate: startKey, endDate: endKey,
    ratings: rows, totalRated, likeCount, dislikeCount: totalRated - likeCount, likePercentage,
  });
});

// Durum güncelleme. 'done' olduğunda ödeme de otomatik sonuçlanır - müşteriye
// ikinci bir "öde" adımı çıkarmıyoruz: kart zaten sipariş anında emanete
// alınmıştı (held), burada personelin/sistemin tamamlama onayıyla serbest
// bırakılır; nakitte de personel tahsilatı bu onayla eş zamanlı sayılır.
router.patch('/:id/status', (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const allowed = ['pending', 'assigned', 'in_progress', 'done', 'confirmed', 'cancelled'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: 'Geçersiz durum.' });
  }
  // GEÇİCİ: personel paneli henüz yazılmadığı için, test/demo amaçlı mülk
  // sahibinin de kendi siparişini tamamlandı işaretlemesine izin veriyoruz.
  // Personel paneli tamamlanınca bu satır kaldırılıp yalnızca staff'a
  // bırakılacak.
  if (status === 'done' && req.user.accountType !== 'staff') {
    if (!accessiblePropertyIds(req.user.id).includes(
      (db.prepare('SELECT property_id FROM cleaning_jobs WHERE id = ?').get(id) || {}).property_id
    )) {
      return res.status(403).json({ error: 'Bu işlemi yalnızca personel veya mülk sahibi yapabilir.' });
    }
  }
  // Personel yalnızca kendi aldığı (assigned_staff_id kendisi olan) işi
  // tamamlandı işaretleyebilir - başkasının işini kapatamaz.
  if (status === 'done' && req.user.accountType === 'staff') {
    const jobToCheck = db.prepare('SELECT assigned_staff_id FROM cleaning_jobs WHERE id = ?').get(id);
    if (!jobToCheck || jobToCheck.assigned_staff_id !== req.user.id) {
      return res.status(403).json({ error: 'Bu iş sana atanmamış.' });
    }
  }
  const job = db.prepare('SELECT * FROM cleaning_jobs WHERE id = ?').get(id);
  if (!job) return res.status(404).json({ error: 'Sipariş bulunamadı.' });

  const shouldFinalizePayment = status === 'done' && job.payment_method && job.payment_status !== 'released';
  if (shouldFinalizePayment) {
    db.prepare(
      "UPDATE cleaning_jobs SET status = ?, payment_status = 'released', completed_at = datetime('now') WHERE id = ?"
    ).run(status, id);
  } else if (status === 'done') {
    db.prepare("UPDATE cleaning_jobs SET status = ?, completed_at = datetime('now') WHERE id = ?").run(status, id);
  } else {
    db.prepare('UPDATE cleaning_jobs SET status = ? WHERE id = ?').run(status, id);
  }
  res.json(db.prepare('SELECT * FROM cleaning_jobs WHERE id = ?').get(id));
});

// Müşteri, personel tarafından tamamlanmış (status='done') bir siparişi
// değerlendirir - hem hizmetin genelini hem de personeli ayrı ayrı.
// Uygulamayı açtığında bu değerlendirme ekranı otomatik çıkar (bkz. frontend),
// bu da gerçek bir push bildirimi olmasa da "tamamlandı" haberini iletir.
router.post('/:id/rate', (req, res) => {
  const { id } = req.params;
  const { serviceRating, serviceFeedback, staffRating, staffFeedback } = req.body;

  const job = db.prepare('SELECT * FROM cleaning_jobs WHERE id = ?').get(id);
  if (!job) return res.status(404).json({ error: 'Sipariş bulunamadı.' });
  if (!accessiblePropertyIds(req.user.id).includes(job.property_id)) {
    return res.status(403).json({ error: 'Bu siparişe erişim yetkiniz yok.' });
  }
  if (job.status !== 'done') {
    return res.status(400).json({ error: 'Yalnızca tamamlanmış siparişler değerlendirilebilir.' });
  }
  if (!['like', 'dislike'].includes(serviceRating) || !['like', 'dislike'].includes(staffRating)) {
    return res.status(400).json({ error: 'Geçerli bir değerlendirme seç.' });
  }

  db.prepare(
    `UPDATE cleaning_jobs SET
       service_rating = ?, service_feedback = ?,
       staff_rating = ?, staff_feedback = ?,
       rated_at = datetime('now')
     WHERE id = ?`
  ).run(serviceRating, serviceFeedback || null, staffRating, staffFeedback || null, id);

  res.json(db.prepare('SELECT * FROM cleaning_jobs WHERE id = ?').get(id));
});

module.exports = router;
