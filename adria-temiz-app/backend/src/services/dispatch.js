const db = require('../db');
const { sendPushToUser, sendPushToUsers } = require('./push');

// NOT: Kullanıcı tarafından net olarak belirtilen süre sadece "kabul ettikten
// sonra işe başlama" için (10 dakika). Bildirime hiç yanıt verilmezse (ne
// kabul ne red) ne kadar beklenip sıradaki adaya geçileceği belirtilmedi -
// tutarlılık için aynı 10 dakikalık pencereyi kullanıyoruz. Bu bir varsayım,
// istersen ayrı bir süreye ayırabiliriz.
const RESPONSE_TIMEOUT_MINUTES = 10;
const START_TIMEOUT_MINUTES = 10;

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// "Meşgul" = şu anda aktif olarak (in_progress) yaptığı bir iş var demek.
// Sadece "assigned" (henüz başlamamış) olması onu meşgul saymaz.
function isStaffBusy(staffId) {
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM cleaning_jobs WHERE assigned_staff_id = ? AND status = 'in_progress'`)
    .get(staffId);
  return row.c > 0;
}

// Bir işin şehrinde, çevrimiçi, meşgul olmayan ve daha önce bu iş için
// denenmemiş (excludeIds) personeli, mülke olan mesafeye göre sıralı döner.
function findEligibleStaff(city, propertyLat, propertyLng, excludeIds) {
  if (!city) return [];
  const excludeSet = new Set(excludeIds || []);
  const rows = db
    .prepare(`SELECT id, name, current_lat, current_lng FROM users WHERE account_type = 'staff' AND is_online = 1 AND current_city = ?`)
    .all(city);
  return rows
    .filter((r) => !excludeSet.has(r.id))
    .filter((r) => !isStaffBusy(r.id))
    .map((r) => ({
      ...r,
      distanceKm: (r.current_lat != null && r.current_lng != null && propertyLat != null && propertyLng != null)
        ? haversineKm(r.current_lat, r.current_lng, propertyLat, propertyLng)
        : Infinity,
    }))
    .sort((a, b) => a.distanceKm - b.distanceKm);
}

function buildJobPayload(job) {
  return {
    type: 'job_offer',
    jobId: job.id,
    title: 'MICISTO — Yeni iş teklifi',
    body: `${job.property_city || ''} · ${job.price} €${job.urgency === 'urgent' ? ' · Acil' : ''}`,
  };
}

// Ana dağıtım fonksiyonu. Yeni sipariş oluştuğunda, ya da bir aday
// reddettiğinde/zaman aşımına uğradığında tekrar çağrılır.
// - Acil: şehirdeki TÜM uygun personele aynı anda gönderilir, ilk kabul eden alır.
// - Acil değil: sadece EN YAKIN uygun adaya gönderilir; o kabul etmez/reddederse
//   sıradaki en yakın adaya geçilir.
async function dispatchJob(jobId) {
  const job = db
    .prepare(
      `SELECT j.*, p.city AS property_city, p.latitude AS property_latitude, p.longitude AS property_longitude
       FROM cleaning_jobs j JOIN properties p ON p.id = j.property_id WHERE j.id = ?`
    )
    .get(jobId);
  if (!job || job.status !== 'pending') return;
  if (!job.property_city) {
    console.error(`dispatchJob: iş ${jobId} için mülkün şehri boş - dağıtım yapılamıyor. Mülk kaydını kontrol et.`);
    return;
  }

  const notifiedIds = JSON.parse(job.notified_staff_ids || '[]');
  const candidates = findEligibleStaff(job.property_city, job.property_latitude, job.property_longitude, notifiedIds);
  if (candidates.length === 0) return; // şu an müsait kimse yok - sonraki tetiklemede (biri online olunca vb.) tekrar denenir

  const payload = buildJobPayload(job);

  if (job.urgency === 'urgent') {
    const ids = candidates.map((c) => c.id);
    await sendPushToUsers(ids, payload);
    db.prepare(
      `UPDATE cleaning_jobs SET notified_staff_ids = ?, current_candidate_id = NULL, notification_sent_at = datetime('now') WHERE id = ?`
    ).run(JSON.stringify([...notifiedIds, ...ids]), jobId);
  } else {
    const nearest = candidates[0];
    await sendPushToUser(nearest.id, payload);
    db.prepare(
      `UPDATE cleaning_jobs SET notified_staff_ids = ?, current_candidate_id = ?, notification_sent_at = datetime('now') WHERE id = ?`
    ).run(JSON.stringify([...notifiedIds, nearest.id]), nearest.id, jobId);
  }
}

// Periyodik olarak (bkz. server.js) çağrılır: süresi geçmiş kabul/başlama
// durumlarını bulup bir sonraki adaya devreder.
async function checkTimeouts() {
  // 1) Kabul edildi ama START_TIMEOUT_MINUTES içinde başlanmadı.
  const overdueStarts = db
    .prepare(
      `SELECT id FROM cleaning_jobs
       WHERE status = 'assigned' AND accepted_at IS NOT NULL
         AND (strftime('%s','now') - strftime('%s', accepted_at)) > ?`
    )
    .all(START_TIMEOUT_MINUTES * 60);
  for (const row of overdueStarts) {
    db.prepare(`UPDATE cleaning_jobs SET status='pending', assigned_staff_id=NULL, accepted_at=NULL WHERE id = ?`).run(row.id);
    await dispatchJob(row.id);
  }

  // 2) Bildirim gönderildi ama RESPONSE_TIMEOUT_MINUTES içinde kimse kabul etmedi.
  const stalled = db
    .prepare(
      `SELECT id FROM cleaning_jobs
       WHERE status = 'pending' AND notification_sent_at IS NOT NULL
         AND (strftime('%s','now') - strftime('%s', notification_sent_at)) > ?`
    )
    .all(RESPONSE_TIMEOUT_MINUTES * 60);
  for (const row of stalled) {
    await dispatchJob(row.id);
  }
}

module.exports = { dispatchJob, checkTimeouts, findEligibleStaff, isStaffBusy, haversineKm, RESPONSE_TIMEOUT_MINUTES, START_TIMEOUT_MINUTES };
