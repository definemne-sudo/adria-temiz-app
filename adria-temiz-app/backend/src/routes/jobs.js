const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { calcPrice, calcCommonAreaSubPrice, calcAddonsTotal, calcSuppliesFee, getService, calcNetEarning, estimateJobMinutes, calcPerformanceBonus, getCommissionRate } = require('../services/catalog');
const { validatePromoCode, calcDiscount, redeemPromo } = require('../services/promo');
const { dispatchJob } = require('../services/dispatch');
const { sendPushToUser } = require('../services/push');
const { getStaffPeriods, getStaffLifetimeTotal, round2 } = require('../services/financeCalc');

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

// Sipariş olusturmanin CEKIRDEK mantigi - hem musteri akisindan (asagidaki
// POST /) hem de ADMIN panelinden ("sistem uzerinden yeni siparis ac")
// AYNI fonksiyon cagrilir. Boylece admin'in olusturdugu bir siparis de,
// musterinin olusturdugu gibi, otomatik olarak personele dispatch edilir -
// iki ayri/farkli davranan kod yolu OLMAZ.
//
// skipAccessCheck: admin, KENDI mulku olmayan herhangi bir musterinin
// mulku icin siparis acabilmeli - bu yuzden admin cagrisinda mulk sahipligi
// kontrolu atlanir (zaten admin.js tarafinda mulkun VAR OLDUGU ayrica
// kontrol ediliyor).
async function createCleaningJob({
  propertyId, serviceKey, urgency, scheduledAt, addons, paymentMethod,
  hasEquipment, hasChemicals, serviceParams, promoCode,
  requestingUserId, requestingAccountType, skipAccessCheck = false, createdByAdminId = null,
}) {
  if (!['cash', 'card', 'invoice'].includes(paymentMethod)) {
    const err = new Error("paymentMethod 'cash', 'card' veya 'invoice' olmalı.");
    err.status = 400; throw err;
  }
  if (paymentMethod === 'invoice' && !skipAccessCheck && requestingAccountType !== 'company') {
    const err = new Error('Aylık fatura seçeneği yalnızca yönetim şirketi hesapları için geçerli.');
    err.status = 403; throw err;
  }
  if (!skipAccessCheck && !accessiblePropertyIds(requestingUserId).includes(propertyId)) {
    const err = new Error('Bu mülke erişim yetkiniz yok.');
    err.status = 403; throw err;
  }

  let checkoutAt;
  try {
    getService(serviceKey);
    checkoutAt = resolveScheduledAt(urgency || 'scheduled', scheduledAt);
  } catch (err) {
    err.status = 400; throw err;
  }

  const property = db.prepare('SELECT * FROM properties WHERE id = ?').get(propertyId);
  if (!property) { const err = new Error('Mülk bulunamadı.'); err.status = 404; throw err; }
  const isCommonArea = serviceKey === 'common_area';

  // ONEMLI: Tekne Temizligi hizmeti henuz aktif degil (ayri/uzman ekip
  // kurulana kadar musteri talebine acilmiyor - bkz. frontend'deki "Cok
  // Yakinda" ekrani). Frontend zaten bu hizmete tiklamayi engelliyor, ama
  // API DOGRUDAN cagrilirsa (ornegin eski bir istemci surumu, ya da bir
  // hata/kotu niyetli istek), fiyatlandirma hic tanimlanmadigi icin
  // asagidaki calcPrice() cagrisi price=NULL doner ve veritabani NOT NULL
  // kisitina takilip 500 SUNUCU HATASI verirdi (gercek testte yakalandi).
  // Burada erken ve net bir 400 ile engelleyip cirkin bir cokmeyi onluyoruz.
  if (serviceKey === 'boat') {
    const err = new Error('Tekne temizliği hizmeti şu anda aktif değil, çok yakında hizmetinizde olacak.');
    err.status = 400; throw err;
  }

  if (isCommonArea && property.category !== 'common_area') {
    const err = new Error('Ortak Alan Temizliği yalnızca "Ortak Alan" kategorili bir mülk için sipariş edilebilir.');
    err.status = 400; throw err;
  }
  if (serviceKey === 'office' && property.category !== 'office') {
    const err = new Error('Bu hizmet yalnızca "Ofis / İşyeri" kategorili bir mülk için sipariş edilebilir.');
    err.status = 400; throw err;
  }

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
    err.status = 400; throw err;
  }
  const equipmentOk = hasEquipment !== false;
  const chemicalsOk = hasChemicals !== false;
  const suppliesFee = calcSuppliesFee({ hasEquipment: equipmentOk, hasChemicals: chemicalsOk });
  const priceBeforeDiscount = basePrice + addonsTotal + suppliesFee;

  let appliedPromo = null;
  let discountAmount = 0;
  if (promoCode) {
    const result = validatePromoCode({
      code: promoCode,
      customerId: property.owner_id,
      city: property.city,
      serviceKey,
    });
    if (result.error) { const err = new Error(result.error); err.status = 400; throw err; }
    appliedPromo = result.promo;
    discountAmount = calcDiscount(appliedPromo, priceBeforeDiscount);
  }

  const price = Math.max(0, priceBeforeDiscount - discountAmount);
  const paymentStatus = paymentMethod === 'card' ? 'held' : 'unpaid';

  const id = uuid();
  db.prepare(
    `INSERT INTO cleaning_jobs
       (id, property_id, service_key, addons, service_params, has_equipment, has_chemicals,
        urgency, payment_method, checkout_at, status, source, price, payment_status, promo_code_id, discount_amount, created_by_admin_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`
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
    'manual',
    price,
    paymentStatus,
    appliedPromo ? appliedPromo.id : null,
    discountAmount || null,
    createdByAdminId
  );

  if (appliedPromo) redeemPromo(appliedPromo, property.owner_id, id, discountAmount);

  const createdJob = db.prepare('SELECT * FROM cleaning_jobs WHERE id = ?').get(id);
  dispatchJob(id).catch((err) => console.error('dispatchJob hata:', err));
  return createdJob;
}

router.post('/', async (req, res) => {
  const {
    propertyId, serviceKey, urgency, scheduledAt, addons, paymentMethod,
    hasEquipment, hasChemicals, serviceParams, promoCode,
  } = req.body;

  try {
    const createdJob = await createCleaningJob({
      propertyId, serviceKey, urgency, scheduledAt, addons, paymentMethod,
      hasEquipment, hasChemicals, serviceParams, promoCode,
      requestingUserId: req.user.id, requestingAccountType: req.user.accountType,
    });
    res.status(201).json(createdJob);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Sipariş oluşturulamadı.' });
  }
});

// Kullanıcının (bireysel ev sahibi veya yönetim şirketi) erişebildiği
// tüm mülklerdeki temizlik işleri - portföy görünümü şablon 7.1'e uygun.
router.get('/', (req, res) => {
  const ids = accessiblePropertyIds(req.user.id);
  if (ids.length === 0) return res.json([]);

  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT j.*, p.name AS property_name, p.city AS property_city, s.name AS staff_name
       FROM cleaning_jobs j
       JOIN properties p ON p.id = j.property_id
       LEFT JOIN users s ON s.id = j.assigned_staff_id
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

  const updatedJob = db.prepare('SELECT * FROM cleaning_jobs WHERE id = ?').get(id);
  res.json(updatedJob);

  // Müşteriye "siparişin onaylandı, şu personel şu saatte gelecek" bildirimi
  // - yanıtı bekletmeden arka planda gönderiliyor.
  notifyCustomerOfAcceptance(updatedJob).catch((err) => console.error('Müşteri bildirimi hata:', err));
});

async function notifyCustomerOfAcceptance(job) {
  const property = db.prepare('SELECT owner_id, name FROM properties WHERE id = ?').get(job.property_id);
  if (!property) return;
  const staff = db.prepare('SELECT name FROM users WHERE id = ?').get(job.assigned_staff_id);
  const staffName = staff ? staff.name : 'Personelimiz';

  let whenText = 'en kısa sürede';
  if (job.urgency === 'scheduled' && job.checkout_at) {
    const dt = new Date(job.checkout_at);
    whenText = dt.toLocaleString('tr-TR', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  }

  await sendPushToUser(property.owner_id, {
    title: 'Siparişin onaylandı! 🎉',
    body: `${staffName}, ${property.name} için ${whenText} gelecek.`,
    jobId: job.id,
    type: 'job_accepted',
  });
}

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
  // Kendisine özel bildirilmiş bir aday olabilir, kendi aldığı iş olabilir,
  // ya da "Bekleyen İşler" sekmesinden gezinerek açık bir işe bakıyor
  // olabilir (bu durumda job hâlâ 'pending' ve herkese açık) - üçü de geçerli.
  const isCandidate = notifiedIds.includes(req.user.id) || job.assigned_staff_id === req.user.id || job.status === 'pending';
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

  // ONEMLI: service_score (temizlige verilen puan) da SELECT'e dahil -
  // personel artik SADECE kendisine verilen puani degil, temizlige
  // verilen puani da goruyor. WHERE kosulu da artik iki puandan HERHANGI
  // BIRI varsa isi listeye aliyor (eskiden sadece staff_score
  // doluysa listeleniyordu - sadece service_score girilmis bir degerlendirme
  // tamamen kayboluyordu).
  const rows = db
    .prepare(
      `SELECT j.id, j.service_key, j.service_params, j.completed_at,
              j.service_score, j.service_feedback, j.staff_score, j.staff_feedback,
              p.name AS property_name, p.city AS property_city
       FROM cleaning_jobs j
       JOIN properties p ON p.id = j.property_id
       WHERE j.assigned_staff_id = ? AND j.status = 'done'
         AND (j.staff_score IS NOT NULL OR j.service_score IS NOT NULL)
         AND date(j.completed_at) BETWEEN ? AND ?
       ORDER BY j.completed_at DESC`
    )
    .all(req.user.id, startKey, endKey);

  const totalRated = rows.length;
  // Genel ortalama: her isin kendi ici ortalamasi (iki puan da varsa
  // ortalamalari, sadece biri varsa o) uzerinden hesaplaniyor - staff-frontend
  // ile birebir ayni mantik, iki taraf da ayni sayiyi gorur.
  const combinedScores = rows
    .map((r) => {
      const hasService = r.service_score !== null && r.service_score !== undefined;
      const hasStaff = r.staff_score !== null && r.staff_score !== undefined;
      if (hasService && hasStaff) return (r.service_score + r.staff_score) / 2;
      if (hasStaff) return r.staff_score;
      if (hasService) return r.service_score;
      return null;
    })
    .filter((v) => v !== null);
  const avgScore = combinedScores.length
    ? Math.round((combinedScores.reduce((a, b) => a + b, 0) / combinedScores.length) * 10) / 10
    : null;

  res.json({
    period, offset, startDate: startKey, endDate: endKey,
    ratings: rows, totalRated, avgScore,
  });
});

// Durum güncelleme. 'done' olduğunda ödeme de otomatik sonuçlanır - müşteriye
// ikinci bir "öde" adımı çıkarmıyoruz: kart zaten sipariş anında emanete
// alınmıştı (held), burada personelin/sistemin tamamlama onayıyla serbest
// bırakılır; nakitte de personel tahsilatı bu onayla eş zamanlı sayılır.
// Müşteri kendi siparişini iptal eder. Personel henüz işe BAŞLAMADIYSA
// (pending/assigned) iptal edilebilir - 'in_progress' olduktan sonra
// personel zaten mülkte/işe başlamış demektir, bu noktada müşteri kendi
// kendine iptal edemez (destek/admin üzerinden çözülmeli).
router.post('/:id/cancel', (req, res) => {
  const { id } = req.params;
  const job = db.prepare('SELECT * FROM cleaning_jobs WHERE id = ?').get(id);
  if (!job) return res.status(404).json({ error: 'Sipariş bulunamadı.' });
  if (!accessiblePropertyIds(req.user.id).includes(job.property_id)) {
    return res.status(403).json({ error: 'Bu siparişe erişim yetkiniz yok.' });
  }
  if (!['pending', 'assigned'].includes(job.status)) {
    return res.status(409).json({ error: 'Personel işe başladıktan sonra sipariş iptal edilemez - lütfen destek ile iletişime geç.' });
  }

  const newPaymentStatus = job.payment_status === 'held' ? 'refunded' : job.payment_status;
  db.prepare(
    `UPDATE cleaning_jobs SET status = 'cancelled', cancelled_at = datetime('now'), cancel_reason = ?, payment_status = ? WHERE id = ?`
  ).run(req.body.reason || null, newPaymentStatus, id);

  const updatedJob = db.prepare('SELECT * FROM cleaning_jobs WHERE id = ?').get(id);
  res.json(updatedJob);

  // İş zaten bir personele atanmışsa (assigned), o personele "bu iş iptal
  // edildi, gitmene gerek yok" bildirimi gönderiyoruz.
  if (job.assigned_staff_id) {
    sendPushToUser(job.assigned_staff_id, {
      title: 'Sipariş iptal edildi',
      body: 'Müşteri bu siparişi iptal etti - bu işe gitmene gerek yok.',
      jobId: id,
      type: 'job_cancelled',
    }).catch((err) => console.error('Personel iptal bildirimi hata:', err));
  }
});

router.patch('/:id/status', (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const allowed = ['pending', 'assigned', 'in_progress', 'done', 'confirmed', 'cancelled'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: 'Geçersiz durum.' });
  }
  // Personel yalnızca kendi aldığı (assigned_staff_id kendisi olan) işi
  // tamamlandı işaretleyebilir - başkasının işini kapatamaz. Mülk sahibi
  // artık işi tamamlandı işaretleyemez - bu, personel paneli tamamlanana
  // kadar geçici bir izindi (bkz. sürüm geçmişi), kaldırıldı.
  if (status === 'done') {
    if (req.user.accountType !== 'staff') {
      return res.status(403).json({ error: 'Bu işlemi yalnızca personel yapabilir.' });
    }
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

  // Is tamamlandiginda musteriye "degerlendir" daveti - eskiden bu haber
  // yalnizca uygulama acilinca gorunen bir ekrandi (bkz. asagidaki /:id/rate
  // yorumu), simdi push ile de anlik haber veriliyor.
  if (status === 'done') {
    const property = db.prepare('SELECT owner_id, name FROM properties WHERE id = ?').get(job.property_id);
    if (property) {
      sendPushToUser(property.owner_id, {
        title: 'Hizmetin tamamlandı! ✅',
        body: `${property.name} için hizmet tamamlandı - deneyimini değerlendirmek ister misin?`,
        jobId: id,
        type: 'job_done',
      }).catch((err) => console.error('Tamamlanma bildirimi hata:', err));
    }
  }
});

// Müşteri, personel tarafından tamamlanmış (status='done') bir siparişi
// değerlendirir - hem hizmetin genelini hem de personeli ayrı ayrı.
// Uygulamayı açtığında bu değerlendirme ekranı otomatik çıkar (bkz. frontend),
// bu da gerçek bir push bildirimi olmasa da "tamamlandı" haberini iletir.
router.post('/:id/rate', (req, res) => {
  const { id } = req.params;
  const { serviceScore, serviceFeedback, staffScore, staffFeedback } = req.body;

  const job = db.prepare('SELECT * FROM cleaning_jobs WHERE id = ?').get(id);
  if (!job) return res.status(404).json({ error: 'Sipariş bulunamadı.' });
  if (!accessiblePropertyIds(req.user.id).includes(job.property_id)) {
    return res.status(403).json({ error: 'Bu siparişe erişim yetkiniz yok.' });
  }
  if (job.status !== 'done') {
    return res.status(400).json({ error: 'Yalnızca tamamlanmış siparişler değerlendirilebilir.' });
  }
  const sScore = Number(serviceScore);
  const stScore = Number(staffScore);
  if (!Number.isInteger(sScore) || sScore < 1 || sScore > 10 || !Number.isInteger(stScore) || stScore < 1 || stScore > 10) {
    return res.status(400).json({ error: 'Puan 1 ile 10 arasında olmalı.' });
  }

  db.prepare(
    `UPDATE cleaning_jobs SET
       service_score = ?, service_feedback = ?,
       staff_score = ?, staff_feedback = ?,
       rated_at = datetime('now')
     WHERE id = ?`
  ).run(sScore, sScore < 10 ? (serviceFeedback || null) : null, stScore, stScore < 10 ? (staffFeedback || null) : null, id);

  res.json(db.prepare('SELECT * FROM cleaning_jobs WHERE id = ?').get(id));
});

// Personelin kendi finans/mutabakat görünümü: toplam ömür boyu kazancı,
// tüm 15 günlük dönemleri (admin'in gördüğüyle birebir aynı hesap), ve
// henüz ödenmemiş dönemlerin toplamı ("son ödemeden bugüne kazanç").
router.get('/finance-summary', (req, res) => {
  if (req.user.accountType !== 'staff') {
    return res.status(403).json({ error: 'Bu sayfayı yalnızca personel görebilir.' });
  }
  const totalEarned = getStaffLifetimeTotal(req.user.id);
  const periods = getStaffPeriods(req.user.id);
  const unpaidPeriods = periods.filter((p) => !p.isPaid && (p.owedToStaff > 0 || p.owedToBusiness > 0));
  const owedToStaffPending = round2(unpaidPeriods.reduce((sum, p) => sum + p.owedToStaff, 0));
  const owedToBusinessPending = round2(unpaidPeriods.reduce((sum, p) => sum + p.owedToBusiness, 0));
  const pendingNet = round2(owedToStaffPending - owedToBusinessPending);
  // staffEarningPending: personelin bu odenmemis donem(ler)deki GERCEK
  // kazanci (nakit dahil, odeme yontemi farketmeksizin) - "Bu donemki
  // kazancin" karti bunu gosterir, mutabakat (owedToStaffPending) ile
  // KARISTIRILMAMALI - ikisi kasitli olarak farkli rakamlardir.
  const staffEarningPending = round2(unpaidPeriods.reduce((sum, p) => sum + p.staffEarning, 0));
  res.json({ totalEarned, periods, owedToStaffPending, owedToBusinessPending, pendingNet, staffEarningPending });
});

// Personel "Ödememi Aldım" dediğinde, admin'in "Ödendi İşaretle" dediğinde
// yazdığı AYNI kayda (staff_payment_marks) yazılıyor - iki taraf da aynı
// mutabakat gerçeğini görüyor. Personel yalnızca KENDİ dönemini
// işaretleyebilir (req.user.id üzerinden, URL'den staffId alınmıyor).
router.post('/finance/mark-received', (req, res) => {
  if (req.user.accountType !== 'staff') {
    return res.status(403).json({ error: 'Bu işlemi yalnızca personel yapabilir.' });
  }
  const { periodStart, periodEnd, amount } = req.body;
  if (!periodStart || !periodEnd) return res.status(400).json({ error: 'periodStart ve periodEnd zorunlu.' });
  db.prepare(
    `INSERT INTO staff_payment_marks (id, staff_id, period_start, period_end, amount)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(staff_id, period_start) DO UPDATE SET amount = excluded.amount, paid_at = datetime('now')`
  ).run(uuid(), req.user.id, periodStart, periodEnd, Number(amount) || 0);
  res.json({ message: 'Ödeme alındı olarak işaretlendi.' });
});

// Personel "Yola Çık" dediğinde: 1) işi işaretle 2) müşteriye "personelin
// yola çıktı, canlı konumunu takip edebilirsin" bildirimi gönder.
router.post('/:id/head-out', (req, res) => {
  const { id } = req.params;
  const job = db.prepare('SELECT * FROM cleaning_jobs WHERE id = ?').get(id);
  if (!job) return res.status(404).json({ error: 'Sipariş bulunamadı.' });
  if (job.assigned_staff_id !== req.user.id) {
    return res.status(403).json({ error: 'Bu iş sana atanmamış.' });
  }
  db.prepare(`UPDATE cleaning_jobs SET headed_out_at = datetime('now') WHERE id = ?`).run(id);
  res.json({ message: 'Yola çıktığın işaretlendi.' });

  const property = db.prepare('SELECT owner_id, name FROM properties WHERE id = ?').get(job.property_id);
  const staff = db.prepare('SELECT name FROM users WHERE id = ?').get(req.user.id);
  if (property) {
    sendPushToUser(property.owner_id, {
      title: 'Personelin yola çıktı! 🚗',
      body: `${staff ? staff.name : 'Personelimiz'}, ${property.name} için yola çıktı - canlı konumunu uygulamadan takip edebilirsin.`,
      jobId: id,
      type: 'staff_headed_out',
    }).catch((err) => console.error('Yola çıktı bildirimi hata:', err));
  }
});

// Müşteri, kendi aktif siparişinde personelin ANLIK konumunu görebilir -
// ama yalnızca personel "Yola Çık" dedikten sonra (mahremiyet: personel
// işe atanmadan/yola çıkmadan önce konumu paylaşılmaz).
router.get('/:id/staff-location', (req, res) => {
  const { id } = req.params;
  const job = db.prepare('SELECT * FROM cleaning_jobs WHERE id = ?').get(id);
  if (!job) return res.status(404).json({ error: 'Sipariş bulunamadı.' });
  if (!accessiblePropertyIds(req.user.id).includes(job.property_id)) {
    return res.status(403).json({ error: 'Bu siparişe erişim yetkiniz yok.' });
  }
  if (!job.headed_out_at || !job.assigned_staff_id) {
    return res.status(409).json({ error: 'Personel henüz yola çıkmadı.' });
  }
  const staff = db.prepare('SELECT current_lat, current_lng FROM users WHERE id = ?').get(job.assigned_staff_id);
  const property = db.prepare('SELECT latitude, longitude FROM properties WHERE id = ?').get(job.property_id);
  res.json({
    staffLat: staff ? staff.current_lat : null,
    staffLng: staff ? staff.current_lng : null,
    propertyLat: property ? property.latitude : null,
    propertyLng: property ? property.longitude : null,
    headedOutAt: job.headed_out_at,
  });
});

// Müşterinin, atanmış personelin telefon numarasını görebilmesi - adreste
// bir sorun olursa (bulamama, yol tarifi vb.) doğrudan ulaşabilsin diye.
router.get('/:id/staff-contact', (req, res) => {
  const { id } = req.params;
  const job = db.prepare('SELECT * FROM cleaning_jobs WHERE id = ?').get(id);
  if (!job) return res.status(404).json({ error: 'Sipariş bulunamadı.' });
  if (!accessiblePropertyIds(req.user.id).includes(job.property_id)) {
    return res.status(403).json({ error: 'Bu siparişe erişim yetkiniz yok.' });
  }
  if (!job.assigned_staff_id) {
    return res.status(409).json({ error: 'Bu işe henüz bir personel atanmadı.' });
  }
  const staff = db.prepare('SELECT name, phone FROM users WHERE id = ?').get(job.assigned_staff_id);
  if (!staff) return res.status(404).json({ error: 'Personel bulunamadı.' });
  res.json({ name: staff.name, phone: staff.phone });
});

module.exports = router;
module.exports.createCleaningJob = createCleaningJob;
module.exports.accessiblePropertyIds = accessiblePropertyIds;
