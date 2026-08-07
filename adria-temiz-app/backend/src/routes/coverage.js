const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
router.use((req, res, next) => {
  if (req.user.accountType !== 'admin') {
    return res.status(403).json({ error: 'Bu sayfayı yalnızca yöneticiler görebilir.' });
  }
  next();
});

// --- Hizmet bölgesi yönetimi -------------------------------------------------

router.get('/areas', (req, res) => {
  const areas = db.prepare('SELECT * FROM service_areas ORDER BY city ASC').all();
  res.json({ areas });
});

router.post('/areas', (req, res) => {
  const { city } = req.body || {};
  if (!city || !city.trim()) return res.status(400).json({ error: 'Şehir adı zorunlu.' });
  const normalized = city.trim();
  const existing = db.prepare('SELECT id FROM service_areas WHERE city = ?').get(normalized);
  if (existing) return res.status(409).json({ error: 'Bu şehir zaten listede.' });
  const id = uuid();
  db.prepare('INSERT INTO service_areas (id, city) VALUES (?, ?)').run(id, normalized);
  res.status(201).json(db.prepare('SELECT * FROM service_areas WHERE id = ?').get(id));
});

router.put('/areas/:id/toggle', (req, res) => {
  const area = db.prepare('SELECT * FROM service_areas WHERE id = ?').get(req.params.id);
  if (!area) return res.status(404).json({ error: 'Bölge bulunamadı.' });
  db.prepare('UPDATE service_areas SET is_active = ? WHERE id = ?').run(area.is_active ? 0 : 1, req.params.id);
  res.json({ message: 'Durum güncellendi.' });
});

router.delete('/areas/:id', (req, res) => {
  db.prepare('DELETE FROM service_areas WHERE id = ?').run(req.params.id);
  res.json({ message: 'Bölge silindi.' });
});

// --- Şehir başına personel/talep dengesi -------------------------------------
// NOT: "Yetersiz personel" eşiği başlangıç varsayımı olarak "çevrimiçi personel
// başına 5'ten fazla bekleyen iş" olarak alındı - gerçek operasyonel veriye
// göre birlikte ayarlanabilir.
const UNDERSTAFFED_RATIO = 5;

router.get('/balance', (req, res) => {
  const areas = db.prepare('SELECT * FROM service_areas WHERE is_active = 1 ORDER BY city ASC').all();
  const propertyCities = db.prepare(`SELECT DISTINCT city FROM properties WHERE city IS NOT NULL`).all().map((r) => r.city);
  const staffCities = db.prepare(`SELECT DISTINCT current_city FROM users WHERE account_type='staff' AND current_city IS NOT NULL`).all().map((r) => r.current_city);

  const allCities = Array.from(new Set([
    ...areas.map((a) => a.city), ...propertyCities, ...staffCities,
  ])).filter(Boolean).sort();

  const result = allCities.map((city) => {
    const totalStaff = db.prepare(`SELECT COUNT(*) AS c FROM users WHERE account_type='staff' AND current_city = ?`).get(city).c;
    const onlineStaff = db.prepare(`SELECT COUNT(*) AS c FROM users WHERE account_type='staff' AND current_city = ? AND is_online = 1`).get(city).c;
    const pendingJobs = db
      .prepare(`SELECT COUNT(*) AS c FROM cleaning_jobs j JOIN properties p ON p.id=j.property_id WHERE p.city = ? AND j.status IN ('pending','assigned','in_progress')`)
      .get(city).c;
    const totalJobsAllTime = db
      .prepare(`SELECT COUNT(*) AS c FROM cleaning_jobs j JOIN properties p ON p.id=j.property_id WHERE p.city = ? AND j.status='done'`)
      .get(city).c;
    const ratio = onlineStaff > 0 ? Math.round((pendingJobs / onlineStaff) * 10) / 10 : (pendingJobs > 0 ? null : 0);
    const isUnderstaffed = onlineStaff === 0 ? pendingJobs > 0 : ratio > UNDERSTAFFED_RATIO;
    const isCoveredArea = areas.some((a) => a.city === city);
    return { city, totalStaff, onlineStaff, pendingJobs, totalJobsAllTime, ratio, isUnderstaffed, isCoveredArea };
  });

  res.json({ cities: result, understaffedRatioThreshold: UNDERSTAFFED_RATIO });
});

module.exports = router;
