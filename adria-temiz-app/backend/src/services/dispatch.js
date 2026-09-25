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

// "Meşgul" = şu anda aktif olarak (in_progress) bir işte GERÇEKTEN atanmış
// olarak yer alıyor demek. Çok personelli işlerde tek doğru kaynak
// job_staff_assignments - assigned_staff_id sadece "birincil" personeli
// tutuyor, ikinci/üçüncü personelin meşguliyeti eskiden hiç kontrol
// edilmiyordu (tek personelli dönemde önemi yoktu, artık önemli).
function isStaffBusy(staffId) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c
       FROM job_staff_assignments jsa
       JOIN cleaning_jobs j ON j.id = jsa.job_id
       WHERE jsa.staff_id = ? AND j.status = 'in_progress'`
    )
    .get(staffId);
  return row.c > 0;
}

// Bir işe şu ana kadar fiilen kabul etmiş (job_staff_assignments'taki)
// personelin id listesi.
function getAcceptedStaffIds(jobId) {
  return db
    .prepare(`SELECT staff_id FROM job_staff_assignments WHERE job_id = ?`)
    .all(jobId)
    .map((r) => r.staff_id);
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

function buildJobPayload(job, remainingSlots) {
  const teamNote = job.required_staff_count > 1 ? ` · ${remainingSlots}/${job.required_staff_count} personel aranıyor` : '';
  return {
    type: 'job_offer',
    jobId: job.id,
    title: 'MICISTO — Yeni iş teklifi',
    body: `${job.property_city || ''} · ${job.price} €${job.urgency === 'urgent' ? ' · Acil' : ''}${teamNote}`,
  };
}

// Ana dağıtım fonksiyonu. Yeni sipariş oluştuğunda, bir aday
// reddettiğinde/zaman aşımına uğradığında, ya da (çok personelli işlerde)
// bir personel kabul edip hâlâ boş yer kaldığında tekrar çağrılır.
// - Acil: şehirdeki TÜM uygun personele aynı anda gönderilir, ilk
//   required_staff_count kişi kabul edene kadar herkes aday sayılır.
// - Acil değil: sadece EN YAKIN (kalan yer kadar) uygun adaylara
//   gönderilir; biri kabul etmez/reddederse sıradaki en yakın adaya geçilir.
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

  const requiredCount = Math.max(1, job.required_staff_count || 1);
  const acceptedIds = getAcceptedStaffIds(jobId);
  const remainingSlots = requiredCount - acceptedIds.length;
  if (remainingSlots <= 0) return; // zaten tam kadro - normalde status artık 'assigned' olmalı, güvenlik amaçlı

  const notifiedIds = JSON.parse(job.notified_staff_ids || '[]');
  // Kabul etmiş personeli de dışlıyoruz - notifiedIds'te olmaları gerekirdi
  // ama manuel "Bekleyen İşler" listesinden bildirimsiz kabul edilmiş bir
  // senaryoda çift bildirim gitmesin diye ekstra güvenlik.
  const excludeIds = [...new Set([...notifiedIds, ...acceptedIds])];
  const candidates = findEligibleStaff(job.property_city, job.property_latitude, job.property_longitude, excludeIds);
  if (candidates.length === 0) return; // şu an müsait kimse yok - sonraki tetiklemede (biri online olunca vb.) tekrar denenir

  const payload = buildJobPayload(job, remainingSlots);

  if (job.urgency === 'urgent') {
    // Acilde her zaman bulunan HERKESE bildirim gider - kalan yer sayısı
    // kadar kişi kabul edene kadar herkes aday. current_candidate_id tekil
    // bir aday anlamına geldiği için burada anlamsız, NULL bırakılıyor.
    const ids = candidates.map((c) => c.id);
    await sendPushToUsers(ids, payload);
    db.prepare(
      `UPDATE cleaning_jobs SET notified_staff_ids = ?, current_candidate_id = NULL, notification_sent_at = datetime('now') WHERE id = ?`
    ).run(JSON.stringify([...notifiedIds, ...ids]), jobId);
  } else {
    // Acil değilse: kalan yer kadar EN YAKIN adaya bildirim gider. Tek
    // yer kaldıysa (eski/tek-personelli davranış) current_candidate_id o
    // tek kişiyi tutar - reject akışı bunu kullanıyor. Birden fazla yer
    // kaldıysa (çok personelli iş, ilk dağıtım) current_candidate_id NULL
    // bırakılır, reject akışı notified_staff_ids listesine bakar.
    const picked = candidates.slice(0, remainingSlots);
    const ids = picked.map((c) => c.id);
    await sendPushToUsers(ids, payload);
    db.prepare(
      `UPDATE cleaning_jobs SET notified_staff_ids = ?, current_candidate_id = ?, notification_sent_at = datetime('now') WHERE id = ?`
    ).run(JSON.stringify([...notifiedIds, ...ids]), ids.length === 1 ? ids[0] : null, jobId);
  }
}

// Periyodik olarak (bkz. server.js) çağrılır: süresi geçmiş kabul/başlama
// durumlarını bulup bir sonraki adaya devreder.
async function checkTimeouts() {
  // 1) Kabul edildi (tam kadro tamamlandı, status='assigned') ama
  // START_TIMEOUT_MINUTES içinde başlanmadı - tüm kadro sıfırlanıp yeniden
  // dağıtılıyor (çok personelli işlerde de baştan, tutarlılık için).
  const overdueStarts = db
    .prepare(
      `SELECT id FROM cleaning_jobs
       WHERE status = 'assigned' AND accepted_at IS NOT NULL
         AND (strftime('%s','now') - strftime('%s', accepted_at)) > ?`
    )
    .all(START_TIMEOUT_MINUTES * 60);
  for (const row of overdueStarts) {
    db.prepare(`DELETE FROM job_staff_assignments WHERE job_id = ?`).run(row.id);
    db.prepare(`UPDATE cleaning_jobs SET status='pending', assigned_staff_id=NULL, accepted_at=NULL WHERE id = ?`).run(row.id);
    await dispatchJob(row.id);
  }

  // 2) Bildirim gönderildi ama RESPONSE_TIMEOUT_MINUTES içinde kimse kabul
  // etmedi (ya da çok personelli işte hâlâ boş yer var) - kalan yer için
  // tekrar dağıtım denenir.
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

module.exports = {
  dispatchJob, checkTimeouts, findEligibleStaff, isStaffBusy, getAcceptedStaffIds,
  haversineKm, RESPONSE_TIMEOUT_MINUTES, START_TIMEOUT_MINUTES,
};
