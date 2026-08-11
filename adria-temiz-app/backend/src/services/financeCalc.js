const db = require('../db');
const { calcNetEarning, getPayoutCycleDays } = require('./catalog');

function toDateKey(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function round2(n) { return Math.round(n * 100) / 100; }

function calcStaffRange(staffId, startKey, endKey) {
  const jobs = db
    .prepare(`SELECT price, payment_method FROM cleaning_jobs WHERE assigned_staff_id = ? AND status = 'done' AND date(completed_at) BETWEEN ? AND ?`)
    .all(staffId, startKey, endKey);
  let owedToStaff = 0, owedToBusiness = 0;
  jobs.forEach((j) => {
    const net = calcNetEarning(j.price);
    if (j.payment_method === 'cash') owedToBusiness += (j.price - net);
    else owedToStaff += net;
  });
  return {
    jobCount: jobs.length,
    owedToStaff: round2(owedToStaff),
    owedToBusiness: round2(owedToBusiness),
    netSettlement: round2(owedToStaff - owedToBusiness),
  };
}

// Personelin ilk tamamladığı işten bugüne kadar, 15 günlük pencereler
// halinde ödeme dönemlerini üretir (canlı hesaplanır, saklanmaz - sadece
// "ödendi" işareti staff_payment_marks'ta tutulur). En yeni dönem en başta.
// Bu işaret, admin panelinden ("Ödendi İşaretle") ya da MICISTORad'dan
// ("Ödememi Aldım") - hangisinden gelirse gelsin AYNI kayda yazılır, iki
// taraf da aynı gerçeği görür.
function getStaffPeriods(staffId) {
  const firstJob = db
    .prepare(`SELECT MIN(date(completed_at)) AS d FROM cleaning_jobs WHERE assigned_staff_id = ? AND status = 'done'`)
    .get(staffId);
  if (!firstJob.d) return [];

  const periods = [];
  const cycleDays = getPayoutCycleDays();
  let periodStart = new Date(firstJob.d + 'T00:00:00');
  const today = new Date();
  while (periodStart <= today) {
    const periodEnd = new Date(periodStart);
    periodEnd.setDate(periodEnd.getDate() + cycleDays - 1);
    const startKey = toDateKey(periodStart);
    const endKey = toDateKey(periodEnd);
    const stats = calcStaffRange(staffId, startKey, endKey);
    const mark = db.prepare('SELECT * FROM staff_payment_marks WHERE staff_id = ? AND period_start = ?').get(staffId, startKey);
    periods.push({
      periodStart: startKey, periodEnd: endKey, ...stats,
      isPaid: !!mark, paidAt: mark ? mark.paid_at : null,
    });
    periodStart.setDate(periodStart.getDate() + cycleDays);
  }
  return periods.reverse();
}

function getStaffLifetimeTotal(staffId) {
  const allJobs = db.prepare(`SELECT price FROM cleaning_jobs WHERE assigned_staff_id = ? AND status = 'done'`).all(staffId);
  return round2(allJobs.reduce((sum, j) => sum + calcNetEarning(j.price), 0));
}

module.exports = { toDateKey, round2, calcStaffRange, getStaffPeriods, getStaffLifetimeTotal };
