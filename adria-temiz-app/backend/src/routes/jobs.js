const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { calcPrice, calcAddonsTotal, calcSuppliesFee, getService } = require('../services/catalog');

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
// Kart seçilirse ödeme hemen alınır (escrow'da tutulur); nakit seçilirse
// personel gelince elden tahsil edilir. Her iki durumda da müşteri burada
// bir daha işlem yapmaz — tamamlanma anında sistem otomatik sonuçlandırır
// (bkz. PATCH /:id/status).
router.post('/', (req, res) => {
  const {
    propertyId, serviceKey, urgency, scheduledAt, addons, paymentMethod,
    hasEquipment, hasChemicals,
  } = req.body;

  if (!accessiblePropertyIds(req.user.id).includes(propertyId)) {
    return res.status(403).json({ error: 'Bu mülke erişim yetkiniz yok.' });
  }
  if (!['cash', 'card'].includes(paymentMethod)) {
    return res.status(400).json({ error: "paymentMethod 'cash' veya 'card' olmalı." });
  }

  let checkoutAt;
  try {
    getService(serviceKey);
    checkoutAt = resolveScheduledAt(urgency || 'scheduled', scheduledAt);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const property = db.prepare('SELECT * FROM properties WHERE id = ?').get(propertyId);
  const addonsList = Array.isArray(addons) ? addons.filter((a) => a && a.key) : [];
  let addonsTotal = 0;
  try {
    addonsTotal = calcAddonsTotal(addonsList);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const equipmentOk = hasEquipment !== false;
  const chemicalsOk = hasChemicals !== false;
  const suppliesFee = calcSuppliesFee({ hasEquipment: equipmentOk, hasChemicals: chemicalsOk });
  const price = calcPrice(serviceKey, { sizeSqm: property.size_sqm }) + addonsTotal + suppliesFee;
  const paymentStatus = paymentMethod === 'card' ? 'held' : 'unpaid';

  const id = uuid();
  db.prepare(
    `INSERT INTO cleaning_jobs
       (id, property_id, service_key, addons, has_equipment, has_chemicals,
        urgency, payment_method, checkout_at, status, source, price, payment_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'manual', ?, ?)`
  ).run(
    id,
    propertyId,
    serviceKey,
    addonsList.length ? JSON.stringify(addonsList) : null,
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

router.post('/:id/assign', (req, res) => {
  const { id } = req.params;
  const { staffId } = req.body;
  db.prepare(
    `UPDATE cleaning_jobs SET status = 'assigned', assigned_staff_id = ? WHERE id = ?`
  ).run(staffId, id);
  res.json(db.prepare('SELECT * FROM cleaning_jobs WHERE id = ?').get(id));
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
  // "Tamamlandı" onayını yalnızca personel verebilir - müşteri kendi
  // siparişini tamamlandı olarak işaretleyemez.
  if (status === 'done' && req.user.accountType !== 'staff') {
    return res.status(403).json({ error: 'Bu işlemi yalnızca personel yapabilir.' });
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
