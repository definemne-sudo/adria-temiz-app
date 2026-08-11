const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { calcNetEarning, getCommissionRate, getPayoutCycleDays } = require('../services/catalog');
const { toDateKey, round2, getStaffPeriods, getStaffLifetimeTotal } = require('../services/financeCalc');

const router = express.Router();
router.use(requireAuth);
router.use((req, res, next) => {
  if (req.user.accountType !== 'admin') {
    return res.status(403).json({ error: 'Bu sayfayı yalnızca yöneticiler görebilir.' });
  }
  next();
});

function getPeriodRange(period, offset) {
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

// --- Personel bazında 15 günlük ödeme dönemleri -----------------------------

router.get('/staff', (req, res) => {
  const staffRows = db.prepare(`SELECT id, name, phone, current_city, is_online FROM users WHERE account_type = 'staff' ORDER BY name ASC`).all();
  const result = staffRows.map((s) => {
    const totalEarned = getStaffLifetimeTotal(s.id);
    const allJobs = db.prepare(`SELECT COUNT(*) AS c FROM cleaning_jobs WHERE assigned_staff_id = ? AND status = 'done'`).get(s.id);
    const periods = getStaffPeriods(s.id);
    const unpaidPeriods = periods.filter((p) => !p.isPaid && (p.owedToStaff > 0 || p.owedToBusiness > 0));
    const pendingNet = round2(unpaidPeriods.reduce((sum, p) => sum + p.netSettlement, 0));
    return { ...s, totalEarned, jobCount: allJobs.c, unpaidPeriodCount: unpaidPeriods.length, pendingNet };
  });
  res.json({ staff: result });
});

router.get('/staff/:staffId/periods', (req, res) => {
  const staff = db.prepare(`SELECT id, name FROM users WHERE id = ? AND account_type = 'staff'`).get(req.params.staffId);
  if (!staff) return res.status(404).json({ error: 'Personel bulunamadı.' });
  res.json({ staff, periods: getStaffPeriods(req.params.staffId) });
});

router.post('/staff/:staffId/periods/mark-paid', (req, res) => {
  const { periodStart, periodEnd, amount } = req.body;
  if (!periodStart || !periodEnd) return res.status(400).json({ error: 'periodStart ve periodEnd zorunlu.' });
  db.prepare(
    `INSERT INTO staff_payment_marks (id, staff_id, period_start, period_end, amount)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(staff_id, period_start) DO UPDATE SET amount = excluded.amount, paid_at = datetime('now')`
  ).run(uuid(), req.params.staffId, periodStart, periodEnd, Number(amount) || 0);
  res.json({ message: 'Ödeme mutabakatı işaretlendi.' });
});

router.post('/staff/:staffId/periods/unmark-paid', (req, res) => {
  const { periodStart } = req.body;
  db.prepare('DELETE FROM staff_payment_marks WHERE staff_id = ? AND period_start = ?').run(req.params.staffId, periodStart);
  res.json({ message: 'İşaret kaldırıldı.' });
});

// --- MICISTO'nun kendi kazancı (gün/hafta/ay) -------------------------------

// Kart/fatura işlerinde para bizim hesabımıza geçtiği için payment_status
// 'released' olunca komisyon fiilen tahsil edilmiş sayılır. Ancak NAKİT
// işlerde para tamamlanınca personelde kalıyor - job kaydı yine
// 'released' işaretlense bile (mevcut akış tüm ödeme yöntemlerinde aynı
// bayrağı kullanıyor), komisyonun bize fiilen geçmesi ancak o personelin
// 15 günlük ödeme dönemi "ödendi" işaretlenince gerçekleşiyor. Bu yüzden
// nakit işler için "tahsil edildi" ayrı bir mantıkla, dönem mutabakatına
// bakılarak hesaplanıyor - sadece payment_status'a güvenmiyoruz.
function isCashJobSettled(staffId, completedAt) {
  if (!staffId || !completedAt) return false;
  const dateKey = completedAt.slice(0, 10);
  const mark = db
    .prepare(`SELECT 1 AS x FROM staff_payment_marks WHERE staff_id = ? AND ? BETWEEN period_start AND period_end`)
    .get(staffId, dateKey);
  return !!mark;
}

router.get('/overview', (req, res) => {
  const granularity = ['day', 'week', 'month'].includes(req.query.granularity) ? req.query.granularity : 'day';
  const defaultCount = granularity === 'day' ? 14 : granularity === 'week' ? 8 : 6;
  const count = Math.min(60, Math.max(1, parseInt(req.query.count, 10) || defaultCount));

  const series = [];
  for (let i = count - 1; i >= 0; i--) {
    let startKey, endKey, label;
    if (granularity === 'day') {
      const d = new Date(); d.setDate(d.getDate() - i);
      startKey = endKey = toDateKey(d);
      label = startKey;
    } else if (granularity === 'week') {
      const now = new Date();
      const day = now.getDay(); const diffToMonday = (day === 0 ? -6 : 1 - day);
      const monday = new Date(now); monday.setDate(now.getDate() + diffToMonday - i * 7);
      const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
      startKey = toDateKey(monday); endKey = toDateKey(sunday);
      label = startKey;
    } else {
      const now = new Date();
      const target = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthEnd = new Date(target.getFullYear(), target.getMonth() + 1, 0);
      startKey = toDateKey(target); endKey = toDateKey(monthEnd);
      label = startKey.slice(0, 7);
    }
    const jobs = db.prepare(`SELECT price FROM cleaning_jobs WHERE status = 'done' AND date(completed_at) BETWEEN ? AND ?`).all(startKey, endKey);
    const revenue = jobs.reduce((sum, j) => sum + j.price, 0);
    const commission = round2(jobs.reduce((sum, j) => sum + (j.price - calcNetEarning(j.price)), 0));
    series.push({ label, startKey, endKey, revenue, commission, jobCount: jobs.length });
  }

  // Kart/fatura: payment_status='released' ise komisyon fiilen bizde -
  // tahsil edilmiş. Nakit: para personelde, komisyon ancak o personelin
  // ilgili 15 günlük dönemi "ödendi" işaretlenince fiilen bize geçmiş sayılır.
  const doneJobs = db.prepare(`SELECT price, payment_method, payment_status, assigned_staff_id, completed_at FROM cleaning_jobs WHERE status = 'done'`).all();
  let collectedCommission = 0, pendingCommission = 0, collectedRevenue = 0, pendingRevenue = 0;
  doneJobs.forEach((j) => {
    const commission = j.price - calcNetEarning(j.price);
    const isCash = j.payment_method === 'cash';
    const isCollected = isCash ? isCashJobSettled(j.assigned_staff_id, j.completed_at) : j.payment_status === 'released';
    if (isCollected) { collectedCommission += commission; collectedRevenue += j.price; }
    else { pendingCommission += commission; pendingRevenue += j.price; }
  });

  res.json({
    granularity, series, commissionRate: getCommissionRate(),
    collectedRevenue: round2(collectedRevenue), pendingRevenue: round2(pendingRevenue),
    collectedCommission: round2(collectedCommission), pendingCommission: round2(pendingCommission),
  });
});

// --- İptal / iade -------------------------------------------------------------

router.post('/jobs/:id/cancel', (req, res) => {
  const { reason } = req.body;
  const job = db.prepare('SELECT * FROM cleaning_jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Sipariş bulunamadı.' });
  if (job.status === 'done' || job.status === 'cancelled') {
    return res.status(409).json({ error: 'Bu sipariş zaten tamamlanmış ya da iptal edilmiş.' });
  }
  const newPaymentStatus = job.payment_status === 'held' ? 'refunded' : job.payment_status;
  db.prepare(
    `UPDATE cleaning_jobs SET status = 'cancelled', cancelled_at = datetime('now'), cancel_reason = ?, payment_status = ? WHERE id = ?`
  ).run(reason || null, newPaymentStatus, job.id);
  res.json(db.prepare('SELECT * FROM cleaning_jobs WHERE id = ?').get(job.id));
});

router.get('/cancellations', (req, res) => {
  const period = req.query.period === 'month' ? 'month' : 'week';
  const offset = parseInt(req.query.offset, 10) || 0;
  const { start, end } = getPeriodRange(period, offset);
  const startKey = toDateKey(start), endKey = toDateKey(end);

  const rows = db
    .prepare(
      `SELECT j.id, j.price, j.payment_status, j.payment_method, j.cancelled_at, j.cancel_reason, j.service_key,
              p.name AS property_name, p.city AS property_city, u.name AS customer_name
       FROM cleaning_jobs j
       JOIN properties p ON p.id = j.property_id
       JOIN users u ON u.id = p.owner_id
       WHERE j.status = 'cancelled' AND date(j.cancelled_at) BETWEEN ? AND ?
       ORDER BY j.cancelled_at DESC`
    )
    .all(startKey, endKey);

  const totalLoss = round2(rows.reduce((sum, r) => sum + r.price, 0));
  const refundedCount = rows.filter((r) => r.payment_status === 'refunded').length;

  res.json({ period, offset, startDate: startKey, endDate: endKey, cancellations: rows, totalLoss, count: rows.length, refundedCount });
});

// --- Kartlara tıklayınca açılan işlem listesi (drill-down) ------------------

router.get('/transactions', (req, res) => {
  const category = req.query.category || 'revenue';
  const period = req.query.period === 'month' ? 'month' : 'week';
  const offset = parseInt(req.query.offset, 10) || 0;
  const { start, end } = getPeriodRange(period, offset);
  const startKey = toDateKey(start), endKey = toDateKey(end);

  // "collected"/"pending" üstteki özet kartlarla aynı şekilde TÜM ZAMANLARI
  // kapsıyor (bir bakiye gibi) - bu yüzden bunlarda dönem filtresi
  // uygulanmıyor, diğer kategorilerde (revenue/cancelled) seçilen döneme
  // göre filtreleniyor.
  const isBalanceCategory = category === 'collected' || category === 'pending';
  let where = `j.status = 'done'`;
  let dateField = 'completed_at';
  if (category === 'cancelled') { where = `j.status = 'cancelled'`; dateField = 'cancelled_at'; }

  const dateFilter = isBalanceCategory ? '' : `AND date(j.${dateField}) BETWEEN ? AND ?`;
  const params = isBalanceCategory ? [] : [startKey, endKey];

  const rows = db
    .prepare(
      `SELECT j.id, j.${dateField} AS eventDate, j.service_key, j.price, j.payment_method, j.payment_status, j.cancel_reason,
              j.assigned_staff_id,
              u.name AS customer_name, s.name AS staff_name, p.city AS property_city
       FROM cleaning_jobs j
       JOIN properties p ON p.id = j.property_id
       JOIN users u ON u.id = p.owner_id
       LEFT JOIN users s ON s.id = j.assigned_staff_id
       WHERE ${where} ${dateFilter}
       ORDER BY j.${dateField} DESC`
    )
    .all(...params);

  let filtered = rows;
  if (isBalanceCategory) {
    filtered = rows.filter((r) => {
      const isCash = r.payment_method === 'cash';
      const isCollected = isCash ? isCashJobSettled(r.assigned_staff_id, r.eventDate) : r.payment_status === 'released';
      return category === 'collected' ? isCollected : !isCollected;
    });
  }

  res.json({ category, transactions: filtered.map((r) => ({ ...r, netEarning: calcNetEarning(r.price), commission: round2(r.price - calcNetEarning(r.price)) })) });
});

// --- CSV dışa aktarım (Excel/muhasebe programlarıyla uyumlu) ---------------
router.get('/export', (req, res) => {
  const period = req.query.period === 'month' ? 'month' : 'week';
  const offset = parseInt(req.query.offset, 10) || 0;
  const { start, end } = getPeriodRange(period, offset);
  const startKey = toDateKey(start), endKey = toDateKey(end);

  const jobs = db
    .prepare(
      `SELECT j.completed_at, j.service_key, j.price, j.payment_method, j.payment_status,
              u.name AS customer_name, s.name AS staff_name
       FROM cleaning_jobs j
       JOIN properties p ON p.id = j.property_id
       JOIN users u ON u.id = p.owner_id
       LEFT JOIN users s ON s.id = j.assigned_staff_id
       WHERE j.status = 'done' AND date(j.completed_at) BETWEEN ? AND ?
       ORDER BY j.completed_at ASC`
    )
    .all(startKey, endKey);

  const escapeCsv = (val) => {
    const str = String(val === null || val === undefined ? '' : val);
    return /[",\n]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
  };
  const header = ['Tarih', 'Hizmet', 'Müşteri', 'Personel', 'Tutar (EUR)', 'Komisyon (EUR)', 'Net Ödeme (EUR)', 'Ödeme Yöntemi', 'Ödeme Durumu'];
  const lines = [header.map(escapeCsv).join(',')];
  jobs.forEach((j) => {
    const net = calcNetEarning(j.price);
    const commission = round2(j.price - net);
    lines.push([j.completed_at, j.service_key, j.customer_name, j.staff_name || '', j.price, commission, net, j.payment_method, j.payment_status].map(escapeCsv).join(','));
  });

  const csv = '\uFEFF' + lines.join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="micisto-finans-${startKey}_${endKey}.csv"`);
  res.send(csv);
});

module.exports = router;
