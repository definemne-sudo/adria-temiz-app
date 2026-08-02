const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { syncPropertyCalendar } = require('../services/icalSync');

const router = express.Router();
router.use(requireAuth);

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
  const { name, address, city, icalUrl, sizeSqm, latitude, longitude, category } = req.body;
  if (!name) return res.status(400).json({ error: 'name zorunlu.' });

  const finalCategory = ['apartment', 'house', 'office'].includes(category) ? category : 'apartment';
  const id = uuid();
  db.prepare(
    `INSERT INTO properties (id, owner_id, name, category, address, city, latitude, longitude, size_sqm, ical_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, req.user.id, name, finalCategory, address || null, city || null,
    latitude ? Number(latitude) : null, longitude ? Number(longitude) : null,
    sizeSqm ? Number(sizeSqm) : null, icalUrl || null
  );

  res.status(201).json(db.prepare('SELECT * FROM properties WHERE id = ?').get(id));
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
