const express = require('express');
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

function toDateKey(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function getPeriodRange(period, offset) {
  const now = new Date();
  if (period === 'month') {
    const target = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    return { start: new Date(target.getFullYear(), target.getMonth(), 1), end: new Date(target.getFullYear(), target.getMonth() + 1, 0) };
  }
  if (period === 'all') return { start: null, end: null };
  const day = now.getDay();
  const diffToMonday = (day === 0 ? -6 : 1 - day);
  const monday = new Date(now); monday.setDate(now.getDate() + diffToMonday + offset * 7); monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
  return { start: monday, end: sunday };
}
const SERVICE_NAMES = { checkin_checkout: 'Airbnb/Booking Temizliği', deep_clean: 'Detaylı Temizlik', office: 'Ofis/İşyeri Temizliği', common_area: 'Ortak Alan Temizliği' };

// --- Hangi hizmetler en çok satılıyor ---------------------------------------
router.get('/services-popularity', (req, res) => {
  const period = req.query.period || 'month';
  const offset = parseInt(req.query.offset, 10) || 0;
  const { start, end } = getPeriodRange(period, offset);
  const dateFilter = start ? `AND date(completed_at) BETWEEN ? AND ?` : '';
  const params = start ? [toDateKey(start), toDateKey(end)] : [];

  const rows = db
    .prepare(`SELECT service_key, COUNT(*) AS jobCount, COALESCE(SUM(price),0) AS revenue FROM cleaning_jobs WHERE status='done' ${dateFilter} GROUP BY service_key ORDER BY jobCount DESC`)
    .all(...params);
  const totalJobs = rows.reduce((s, r) => s + r.jobCount, 0);
  const result = rows.map((r) => ({
    serviceKey: r.service_key, serviceName: SERVICE_NAMES[r.service_key] || r.service_key,
    jobCount: r.jobCount, revenue: r.revenue, percent: totalJobs ? Math.round((r.jobCount / totalJobs) * 1000) / 10 : 0,
  }));
  res.json({ period, offset, services: result, totalJobs });
});

// --- Müşteri elde tutma -------------------------------------------------------
router.get('/retention', (req, res) => {
  const rows = db
    .prepare(
      `SELECT u.id, COUNT(j.id) AS orderCount FROM users u
       LEFT JOIN properties p ON p.owner_id = u.id
       LEFT JOIN cleaning_jobs j ON j.property_id = p.id AND j.status = 'done'
       WHERE u.account_type IN ('individual','company')
       GROUP BY u.id`
    )
    .all();
  const totalCustomers = rows.length;
  const withOrders = rows.filter((r) => r.orderCount > 0).length;
  const repeatCustomers = rows.filter((r) => r.orderCount >= 2).length;
  const loyalCustomers = rows.filter((r) => r.orderCount >= 5).length;
  const repeatRate = withOrders ? Math.round((repeatCustomers / withOrders) * 1000) / 10 : 0;
  const avgOrdersPerCustomer = withOrders ? Math.round((rows.reduce((s, r) => s + r.orderCount, 0) / withOrders) * 10) / 10 : 0;
  res.json({ totalCustomers, withOrders, repeatCustomers, loyalCustomers, repeatRate, avgOrdersPerCustomer });
});

// --- Şehir bazlı talep yoğunluğu ---------------------------------------------
router.get('/city-demand', (req, res) => {
  const period = req.query.period || 'month';
  const offset = parseInt(req.query.offset, 10) || 0;
  const { start, end } = getPeriodRange(period, offset);
  const dateFilter = start ? `AND date(j.completed_at) BETWEEN ? AND ?` : '';
  const params = start ? [toDateKey(start), toDateKey(end)] : [];

  const rows = db
    .prepare(
      `SELECT p.city, COUNT(*) AS jobCount, COALESCE(SUM(j.price),0) AS revenue
       FROM cleaning_jobs j JOIN properties p ON p.id = j.property_id
       WHERE j.status = 'done' AND p.city IS NOT NULL ${dateFilter}
       GROUP BY p.city ORDER BY jobCount DESC`
    )
    .all(...params);
  res.json({ period, offset, cities: rows });
});

// --- Personel performans trendleri -------------------------------------------
router.get('/staff-trend', (req, res) => {
  const granularity = ['week', 'month'].includes(req.query.granularity) ? req.query.granularity : 'week';
  const count = Math.min(24, Math.max(1, parseInt(req.query.count, 10) || 8));

  const series = [];
  for (let i = count - 1; i >= 0; i--) {
    let startKey, endKey, label;
    if (granularity === 'week') {
      const now = new Date(); const day = now.getDay(); const diffToMonday = (day === 0 ? -6 : 1 - day);
      const monday = new Date(now); monday.setDate(now.getDate() + diffToMonday - i * 7);
      const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
      startKey = toDateKey(monday); endKey = toDateKey(sunday); label = startKey;
    } else {
      const now = new Date(); const target = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthEnd = new Date(target.getFullYear(), target.getMonth() + 1, 0);
      startKey = toDateKey(target); endKey = toDateKey(monthEnd); label = startKey.slice(0, 7);
    }
    const row = db.prepare(`SELECT COUNT(*) AS jobs FROM cleaning_jobs WHERE status='done' AND date(completed_at) BETWEEN ? AND ?`).get(startKey, endKey);
    const ratingRow = db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN staff_rating='like' THEN 1 ELSE 0 END) AS likes FROM cleaning_jobs WHERE staff_rating IS NOT NULL AND date(completed_at) BETWEEN ? AND ?`).get(startKey, endKey);
    series.push({ label, jobs: row.jobs, satisfactionPercent: ratingRow.total ? Math.round((ratingRow.likes / ratingRow.total) * 100) : null });
  }

  const leaderboard = db
    .prepare(
      `SELECT u.id, u.name,
              (SELECT COUNT(*) FROM cleaning_jobs WHERE assigned_staff_id = u.id AND status='done') AS totalJobs,
              (SELECT COUNT(*) FROM cleaning_jobs WHERE assigned_staff_id = u.id AND staff_rating IS NOT NULL) AS totalRatings,
              (SELECT COUNT(*) FROM cleaning_jobs WHERE assigned_staff_id = u.id AND staff_rating = 'like') AS likeRatings
       FROM users u WHERE u.account_type = 'staff' ORDER BY totalJobs DESC`
    )
    .all()
    .map((s) => ({ ...s, satisfactionPercent: s.totalRatings ? Math.round((s.likeRatings / s.totalRatings) * 100) : null }));

  res.json({ granularity, series, leaderboard });
});

module.exports = router;
