const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { calcPrice, calcAddonsTotal, getService } = require('../services/catalog');

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
// hizmetler seçip siparişini oluşturur. Ödeme burada değil, hizmet
// tamamlandıktan sonra (bkz. /:id/complete-payment) alınır.
router.post('/', (req, res) => {
  const { propertyId, serviceKey, urgency, scheduledAt, addons } = req.body;

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
  const addonsList = Array.isArray(addons) ? addons.filter((a) => a && a.key) : [];
  let addonsTotal = 0;
  try {
    addonsTotal = calcAddonsTotal(addonsList);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const price = calcPrice(serviceKey, { sizeSqm: property.size_sqm }) + addonsTotal;

  const id = uuid();
  db.prepare(
    `INSERT INTO cleaning_jobs
       (id, property_id, service_key, addons, urgency, checkout_at, status, source, price, payment_status)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', 'manual', ?, 'unpaid')`
  ).run(
    id,
    propertyId,
    serviceKey,
    addonsList.length ? JSON.stringify(addonsList) : null,
    urgency || 'scheduled',
    checkoutAt,
    price
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
// MVP'de basit tutuluyor - "en yakın/uygun personel" eşleştirme mantığı
// ilerleyen aşamada eklenebilir.
router.get('/pending', (req, res) => {
  const rows = db
    .prepare(
      `SELECT j.*, p.name AS property_name, p.address AS property_address, p.city AS property_city
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

router.patch('/:id/status', (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const allowed = ['pending', 'assigned', 'in_progress', 'done', 'confirmed', 'cancelled'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: 'Geçersiz durum.' });
  }
  db.prepare('UPDATE cleaning_jobs SET status = ? WHERE id = ?').run(status, id);
  res.json(db.prepare('SELECT * FROM cleaning_jobs WHERE id = ?').get(id));
});

// --- Ödeme: yalnızca hizmet tamamlandıktan (status='done' veya 'confirmed')
// sonra yapılabilir. Kart/Nakit farkı yalnızca kayıt amaçlı (gerçek Stripe
// entegrasyonunda kart burada tahsil edilecek, nakitte personel elden alır).
router.post('/:id/complete-payment', (req, res) => {
  const { id } = req.params;
  const { paymentMethod } = req.body;
  if (!['cash', 'card'].includes(paymentMethod)) {
    return res.status(400).json({ error: "paymentMethod 'cash' veya 'card' olmalı." });
  }
  const job = db.prepare('SELECT * FROM cleaning_jobs WHERE id = ?').get(id);
  if (!job) return res.status(404).json({ error: 'Sipariş bulunamadı.' });
  if (!['done', 'confirmed'].includes(job.status)) {
    return res.status(400).json({ error: 'Ödeme, hizmet tamamlandıktan sonra yapılabilir.' });
  }
  db.prepare(
    "UPDATE cleaning_jobs SET payment_method = ?, payment_status = 'released', status = 'confirmed' WHERE id = ?"
  ).run(paymentMethod, id);
  res.json({ message: 'Ödeme tamamlandı.', jobId: id });
});

module.exports = router;
