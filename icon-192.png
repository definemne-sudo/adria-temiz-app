const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

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
