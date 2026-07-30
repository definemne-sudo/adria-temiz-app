const ical = require('node-ical');
const { v4: uuid } = require('uuid');
const db = require('../db');

/**
 * Şablonun 7.2 bölümündeki en değerli/en ucuz özellik:
 * Airbnb/Booking'in verdiği ücretsiz, herkese açık iCal linkini okuyup
 * her rezervasyonun check-out (DTEND) tarihinde otomatik bir temizlik
 * talebi (cleaning_job) oluşturuyoruz. Aynı rezervasyon iki kere iş
 * yaratmasın diye ical_uid + property_id üzerinde UNIQUE kısıtı var.
 *
 * source: URL'den canlı okuma (prod) veya doğrudan .ics metni (test/demo).
 */
async function syncPropertyCalendar(propertyId, { icsText } = {}) {
  const property = db.prepare('SELECT * FROM properties WHERE id = ?').get(propertyId);
  if (!property) {
    throw new Error('Mülk bulunamadı.');
  }

  let events;
  if (icsText) {
    events = ical.sync.parseICS(icsText);
  } else {
    if (!property.ical_url) {
      throw new Error('Bu mülk için tanımlı bir iCal linki yok.');
    }
    events = await ical.async.fromURL(property.ical_url);
  }

  const insertJob = db.prepare(`
    INSERT OR IGNORE INTO cleaning_jobs
      (id, property_id, checkout_at, status, source, ical_uid, price)
    VALUES (?, ?, ?, 'pending', 'ical_auto', ?, ?)
  `);

  let created = 0;
  let skipped = 0;

  for (const key of Object.keys(events)) {
    const ev = events[key];
    if (ev.type !== 'VEVENT' || !ev.end) continue;

    const checkoutAt = new Date(ev.end).toISOString();
    const icalUid = ev.uid || key;

    const result = insertJob.run(
      uuid(),
      propertyId,
      checkoutAt,
      icalUid,
      property.base_price
    );
    if (result.changes > 0) created += 1;
    else skipped += 1;
  }

  return { created, skipped, totalEvents: Object.keys(events).length };
}

module.exports = { syncPropertyCalendar };
