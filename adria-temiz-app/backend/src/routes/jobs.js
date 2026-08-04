const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { calcPrice, calcCommonAreaSubPrice, calcAddonsTotal, calcSuppliesFee, getService } = require('../services/catalog');

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
router.post('/', (req, res) => {
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
  const price = basePrice + addonsTotal + suppliesFee;
  const paymentStatus = paymentMethod === 'card' ? 'held' : 'unpaid';

  const id = uuid();
  db.prepare(
    `INSERT INTO cleaning_jobs
       (id, property_id, service_key, addons, service_params, has_equipment, has_chemicals,
        urgency, payment_method, checkout_at, status, source, price, payment_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'manual', ?, ?)`
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
    paymentStatus
  );

  res.status(201).json(db.prepare('SELECT * FROM cleaning_jobs WHERE id = ?').get(id));
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
router.post('/:id/assign', (req, res) => {
  if (req.user.accountType !== 'staff') {
    return res.status(403).json({ error: 'Bu işlemi yalnızca personel yapabilir.' });
  }
  const { id } = req.params;
  const job = db.prepare('SELECT * FROM cleaning_jobs WHERE id = ?').get(id);
  if (!job) return res.status(404).json({ error: 'Sipariş bulunamadı.' });
  if (job.status !== 'pending') {
    return res.status(409).json({ error: 'Bu iş başka bir personel tarafından zaten alınmış.' });
  }
  db.prepare(
    `UPDATE cleaning_jobs SET status = 'assigned', assigned_staff_id = ? WHERE id = ?`
  ).run(req.user.id, id);
  res.json(db.prepare('SELECT * FROM cleaning_jobs WHERE id = ?').get(id));
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
      "UPDATE cleaning_jobs SET status = ?, payment_status = 'released' WHERE id = ?"
    ).run(status, id);
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
