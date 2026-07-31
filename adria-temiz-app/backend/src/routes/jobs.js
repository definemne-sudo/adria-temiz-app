const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { calcPrice, getService } = require('../services/catalog');

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

// Ana akış: kullanıcı bir mülk + hizmet türü seçip talep açar (Glovo tarzı
// "ürün seç, fiyatı gör, onayla" akışının backend karşılığı).
router.post('/', (req, res) => {
  const { propertyId, serviceKey, quantity, scheduledAt, notes } = req.body;

  if (!accessiblePropertyIds(req.user.id).includes(propertyId)) {
    return res.status(403).json({ error: 'Bu mülke erişim yetkiniz yok.' });
  }

  let service;
  try {
    service = getService(serviceKey);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const property = db.prepare('SELECT * FROM properties WHERE id = ?').get(propertyId);
  const price = calcPrice(serviceKey, { sizeSqm: property.size_sqm, quantity });

  const id = uuid();
  db.prepare(
    `INSERT INTO cleaning_jobs
       (id, property_id, service_key, quantity, checkout_at, status, source, price)
     VALUES (?, ?, ?, ?, ?, 'pending', 'manual', ?)`
  ).run(
    id,
    propertyId,
    serviceKey,
    service.calcType === 'per_item' ? Number(quantity) || 1 : null,
    scheduledAt || new Date().toISOString(),
    price
  );

  if (notes) {
    db.prepare('UPDATE cleaning_jobs SET notes = ? WHERE id = ?').run(notes, id);
  }

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

// --- Escrow ödeme simülasyonu (şablon 6.3 / 7.3: gerçek Stripe entegrasyonu
// prod'da bu iki adımın (hold -> release) yerine geçecek) ---

router.post('/:id/pay', (req, res) => {
  const { id } = req.params;
  const job = db.prepare('SELECT * FROM cleaning_jobs WHERE id = ?').get(id);
  if (!job) return res.status(404).json({ error: 'İş bulunamadı.' });
  db.prepare("UPDATE cleaning_jobs SET payment_status = 'held' WHERE id = ?").run(id);
  res.json({ message: 'Ödeme emanette tutuluyor (escrow).', jobId: id });
});

router.post('/:id/release', (req, res) => {
  const { id } = req.params;
  const job = db.prepare('SELECT * FROM cleaning_jobs WHERE id = ?').get(id);
  if (!job) return res.status(404).json({ error: 'İş bulunamadı.' });
  if (job.payment_status !== 'held') {
    return res.status(400).json({ error: 'Serbest bırakılacak bir emanet ödeme yok.' });
  }
  db.prepare(
    "UPDATE cleaning_jobs SET payment_status = 'released', status = 'confirmed' WHERE id = ?"
  ).run(id);
  res.json({ message: 'Müşteri onayladı, ödeme personele serbest bırakıldı.', jobId: id });
});

module.exports = router;
