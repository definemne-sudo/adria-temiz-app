const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { syncPropertyCalendar } = require('../services/icalSync');

const router = express.Router();
router.use(requireAuth);

// Şu an sadece bu 4 şehirde hizmet veriyoruz - müşteriler sadece bu
// şehirlerdeki mülkler için sipariş verebilsin diye mülk ekleme/düzenleme
// burada kısıtlanıyor. Büyük/küçük harf ve baştaki/sondaki boşluk farkları
// tolere ediliyor (ör. "tivat ", "TIVAT" -> "Tivat").
const ACTIVE_CITIES = ['Tivat', 'Budva', 'Kotor', 'Podgorica'];
function normalizeActiveCity(city) {
  if (!city) return null;
  const trimmed = String(city).trim();
  const match = ACTIVE_CITIES.find((c) => c.toLowerCase() === trimmed.toLowerCase());
  return match || null;
}

// Kullanıcının erişebildiği mülkler: kendi sahip olduğu + delege olarak
// kabul edildiği mülkler (yönetim şirketi senaryosu, şablon 7.1).
router.get('/', (req, res) => {
  const owned = db
    .prepare('SELECT * FROM properties WHERE owner_id = ?')
    .all(req.user.id);

  const delegated = db
    .prepare(
      `SELECT p.* FROM properties p
       JOIN property_delegates d ON d.property_id = p.id
       WHERE d.delegate_user_id = ? AND d.status = 'accepted'`
    )
    .all(req.user.id);

  res.json({ owned, delegated });
});

router.post('/', (req, res) => {
  const {
    name, address, city, icalUrl, sizeSqm, latitude, longitude, category, buildingName,
    floorCount, sqmPerFloor, elevatorCapacity,
  } = req.body;
  if (!name) return res.status(400).json({ error: 'name zorunlu.' });

  // Şu an sadece Tivat/Budva/Kotor/Podgorica'da hizmet veriyoruz - bu
  // şehirlerin dışında bir mülk eklenmeye çalışılırsa reddediliyor (sessizce
  // kabul edip sonra dağıtımın hiçbir personele ulaşmaması yerine, en
  // başta net bir hata dönmek daha doğru).
  const normalizedCity = normalizeActiveCity(city);
  if (!normalizedCity) {
    return res.status(400).json({
      error: `Şu an sadece şu şehirlerde hizmet veriyoruz: ${ACTIVE_CITIES.join(', ')}.`,
      allowedCities: ACTIVE_CITIES,
    });
  }

  const finalCategory = ['apartment', 'house', 'office', 'common_area'].includes(category) ? category : 'apartment';
  const id = uuid();
  db.prepare(
    `INSERT INTO properties
       (id, owner_id, name, category, building_name, address, city, latitude, longitude,
        size_sqm, floor_count, sqm_per_floor, elevator_capacity, ical_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, req.user.id, name, finalCategory, buildingName || null, address || null, normalizedCity,
    latitude ? Number(latitude) : null, longitude ? Number(longitude) : null,
    sizeSqm ? Number(sizeSqm) : null,
    floorCount ? Number(floorCount) : null,
    sqmPerFloor ? Number(sqmPerFloor) : null,
    elevatorCapacity ? Number(elevatorCapacity) : null,
    icalUrl || null
  );

  res.status(201).json(db.prepare('SELECT * FROM properties WHERE id = ?').get(id));
});

// Toplu mülk ekleme - yönetim şirketlerinin aynı lokasyonda (bina/site) veya
// farklı lokasyonlarda sahip olduğu birden fazla mülkü tek istekte, hızlıca
// eklemesi için. Her satır kendi tip+m²+konumunu taşıyor, ortak alanları
// (adres/şehir) her satırda ayrı ayrı da verebilir - liste esnek.
// NOT: Bulk eklemede geçersiz şehirli tek bir satır yüzünden TÜM isteği
// reddetmek yerine (yönetim şirketi 20 satır girip birinde yazım hatası
// yapınca hepsini kaybetmesin diye), sadece o satır atlanıyor ve
// `skipped` listesinde nedeniyle birlikte geri dönülüyor - cevap şekli bu
// yüzden artık düz dizi değil, { properties, skipped } nesnesi.
router.post('/bulk', (req, res) => {
  const { properties } = req.body;
  if (!Array.isArray(properties) || properties.length === 0) {
    return res.status(400).json({ error: 'En az bir mülk satırı gerekli.' });
  }

  const insert = db.prepare(
    `INSERT INTO properties
       (id, owner_id, name, category, building_name, address, city, latitude, longitude,
        size_sqm, floor_count, sqm_per_floor, elevator_capacity, ical_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const created = [];
  const skipped = [];
  const insertMany = db.transaction((rows) => {
    rows.forEach((row, index) => {
      if (!row || !row.name) {
        skipped.push({ index, name: row ? row.name : null, reason: 'İsim zorunlu.' });
        return;
      }
      const normalizedCity = normalizeActiveCity(row.city);
      if (!normalizedCity) {
        skipped.push({
          index, name: row.name,
          reason: `Geçersiz/desteklenmeyen şehir ("${row.city || ''}"). Şu an sadece: ${ACTIVE_CITIES.join(', ')}.`,
        });
        return;
      }
      const finalCategory = ['apartment', 'house', 'office', 'common_area'].includes(row.category) ? row.category : 'apartment';
      const id = uuid();
      insert.run(
        id, req.user.id, row.name, finalCategory, row.buildingName || null,
        row.address || null, normalizedCity,
        row.latitude ? Number(row.latitude) : null, row.longitude ? Number(row.longitude) : null,
        row.sizeSqm ? Number(row.sizeSqm) : null,
        row.floorCount ? Number(row.floorCount) : null,
        row.sqmPerFloor ? Number(row.sqmPerFloor) : null,
        row.elevatorCapacity ? Number(row.elevatorCapacity) : null,
        row.icalUrl || null
      );
      created.push(id);
    });
  });
  insertMany(properties);

  const placeholders = created.map(() => '?').join(',');
  const rows = created.length
    ? db.prepare(`SELECT * FROM properties WHERE id IN (${placeholders})`).all(...created)
    : [];
  res.status(201).json({ properties: rows, skipped });
});

function canAccessProperty(userId, propertyId) {
  const owned = db
    .prepare('SELECT id FROM properties WHERE id = ? AND owner_id = ?')
    .get(propertyId, userId);
  if (owned) return true;
  const delegated = db
    .prepare(
      `SELECT id FROM property_delegates
       WHERE property_id = ? AND delegate_user_id = ? AND status = 'accepted'`
    )
    .get(propertyId, userId);
  return !!delegated;
}

// Bir mülkü düzenler - yalnızca SAHİBİ değiştirebilir (delege edilmiş
// yönetim şirketi mülkün bilgilerini değiştiremez, sadece görebilir).
// Bu, özellikle şehir gibi kritik alanların yanlış/boş girilmesi durumunda
// (ki bu, sipariş dağıtımının sessizce hiç kimseye ulaşmamasına yol açar)
// düzeltme imkânı sağlamak için eklendi.
router.put('/:id', (req, res) => {
  const { id } = req.params;
  const existing = db.prepare('SELECT * FROM properties WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Mülk bulunamadı.' });
  if (existing.owner_id !== req.user.id) {
    return res.status(403).json({ error: 'Sadece mülk sahibi düzenleyebilir.' });
  }
  const {
    name, address, city, sizeSqm, latitude, longitude, buildingName,
    floorCount, sqmPerFloor, elevatorCapacity, bedroomCount, bathroomCount,
  } = req.body;

  // Şehir alanı gönderildiyse (değiştirilmek isteniyorsa) 4 aktif şehirden
  // biri olmalı - göndermezse (COALESCE ile) mevcut değeri korunuyor,
  // eski/legacy kayıtlar bu yüzden burada bozulmuyor.
  let normalizedCity = null;
  if (city) {
    normalizedCity = normalizeActiveCity(city);
    if (!normalizedCity) {
      return res.status(400).json({
        error: `Şu an sadece şu şehirlerde hizmet veriyoruz: ${ACTIVE_CITIES.join(', ')}.`,
        allowedCities: ACTIVE_CITIES,
      });
    }
  }

  db.prepare(
    `UPDATE properties SET
       name = COALESCE(?, name), address = COALESCE(?, address), city = COALESCE(?, city),
       size_sqm = COALESCE(?, size_sqm), latitude = COALESCE(?, latitude), longitude = COALESCE(?, longitude),
       building_name = COALESCE(?, building_name), floor_count = COALESCE(?, floor_count),
       sqm_per_floor = COALESCE(?, sqm_per_floor), elevator_capacity = COALESCE(?, elevator_capacity),
       bedroom_count = COALESCE(?, bedroom_count), bathroom_count = COALESCE(?, bathroom_count)
     WHERE id = ?`
  ).run(
    name || null, address || null, normalizedCity,
    sizeSqm ? Number(sizeSqm) : null, latitude ? Number(latitude) : null, longitude ? Number(longitude) : null,
    buildingName || null, floorCount ? Number(floorCount) : null,
    sqmPerFloor ? Number(sqmPerFloor) : null, elevatorCapacity ? Number(elevatorCapacity) : null,
    bedroomCount ? Number(bedroomCount) : null, bathroomCount ? Number(bathroomCount) : null,
    id
  );
  res.json(db.prepare('SELECT * FROM properties WHERE id = ?').get(id));
});

// Bir mülkü siler - üzerinde AKTİF (tamamlanmamış) siparişi varsa silinemez,
// veri bütünlüğünü bozmamak için.
router.delete('/:id', (req, res) => {
  const { id } = req.params;
  const existing = db.prepare('SELECT * FROM properties WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Mülk bulunamadı.' });
  if (existing.owner_id !== req.user.id) {
    return res.status(403).json({ error: 'Sadece mülk sahibi silebilir.' });
  }
  const activeJobs = db
    .prepare(`SELECT COUNT(*) AS c FROM cleaning_jobs WHERE property_id = ? AND status IN ('pending','assigned','in_progress')`)
    .get(id).c;
  if (activeJobs > 0) {
    return res.status(409).json({ error: 'Bu mülkün aktif/bekleyen siparişleri var, önce onları tamamlat ya da iptal et.' });
  }
  db.prepare('DELETE FROM properties WHERE id = ?').run(id);
  res.json({ message: 'Mülk silindi.' });
});

// Bir yönetim şirketinin, bireysel ev sahibine ait bir mülke erişim talebi
// göndermesi (davet linki modelinin backend karşılığı, şablon 7.1).
router.post('/:id/delegates', (req, res) => {
  const { id: propertyId } = req.params;
  const { delegateUserEmail } = req.body;

  const property = db.prepare('SELECT * FROM properties WHERE id = ?').get(propertyId);
  if (!property) return res.status(404).json({ error: 'Mülk bulunamadı.' });
  if (property.owner_id !== req.user.id) {
    return res.status(403).json({ error: 'Sadece mülk sahibi delege ekleyebilir.' });
  }

  const delegateUser = db.prepare('SELECT * FROM users WHERE email = ?').get(delegateUserEmail);
  if (!delegateUser) return res.status(404).json({ error: 'Bu e-postayla kayıtlı kullanıcı yok.' });

  const delegateId = uuid();
  db.prepare(
    `INSERT INTO property_delegates (id, property_id, delegate_user_id, status)
     VALUES (?, ?, ?, 'accepted')`
  ).run(delegateId, propertyId, delegateUser.id);

  res.status(201).json({ message: 'Delege erişimi eklendi.', delegateId });
});

// Takvim senkronu tetikleme. Body'de gerçek bir Airbnb/Booking iCal linki
// (icalUrl) gönderilirse önce mülke kaydedilir, sonra o linkten gerçek
// senkron yapılır. Test/demo amaçlı ham .ics metni (icsText) de kabul edilir.
router.post('/:id/sync', async (req, res) => {
  const { id: propertyId } = req.params;
  if (!canAccessProperty(req.user.id, propertyId)) {
    return res.status(403).json({ error: 'Bu mülke erişim yetkiniz yok.' });
  }
  if (req.body.icalUrl) {
    db.prepare('UPDATE properties SET ical_url = ? WHERE id = ?').run(req.body.icalUrl, propertyId);
  }
  try {
    const result = await syncPropertyCalendar(propertyId, {
      icsText: req.body.icsText,
      paymentMethod: req.body.paymentMethod,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
