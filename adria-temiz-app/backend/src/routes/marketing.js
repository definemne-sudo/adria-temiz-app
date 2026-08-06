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

// --- Reklam Kampanyaları -----------------------------------------------------
// NOT: Bu veriler admin tarafından elle giriliyor (reklam panelinden -
// Meta, Google Ads, TikTok vb. - kopyalanan rakamlar). Gerçek zamanlı API
// entegrasyonu yok; belirli bir platforma bağlanmak istersen o platformun
// erişim bilgilerini ayrıca konuşmamız gerekir.

router.get('/ad-campaigns', (req, res) => {
  const campaigns = db.prepare('SELECT * FROM ad_campaigns ORDER BY start_date DESC').all();
  const withMetrics = campaigns.map((c) => ({
    ...c,
    cpc: c.clicks > 0 ? Math.round((c.spend / c.clicks) * 100) / 100 : null,
    cpa: c.signups > 0 ? Math.round((c.spend / c.signups) * 100) / 100 : null,
    ctr: c.impressions > 0 ? Math.round((c.clicks / c.impressions) * 10000) / 100 : null,
  }));
  const totals = campaigns.reduce((acc, c) => ({
    spend: acc.spend + c.spend, impressions: acc.impressions + c.impressions,
    clicks: acc.clicks + c.clicks, signups: acc.signups + c.signups,
  }), { spend: 0, impressions: 0, clicks: 0, signups: 0 });
  res.json({ campaigns: withMetrics, totals });
});

router.post('/ad-campaigns', (req, res) => {
  const { platform, campaignName, startDate, endDate, spend, impressions, clicks, signups, notes } = req.body || {};
  if (!platform || !campaignName || !startDate) {
    return res.status(400).json({ error: 'Platform, kampanya adı ve başlangıç tarihi zorunlu.' });
  }
  const id = uuid();
  db.prepare(
    `INSERT INTO ad_campaigns (id, platform, campaign_name, start_date, end_date, spend, impressions, clicks, signups, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, platform.trim(), campaignName.trim(), startDate, endDate || null, Number(spend) || 0, Number(impressions) || 0, Number(clicks) || 0, Number(signups) || 0, notes || null);
  res.status(201).json(db.prepare('SELECT * FROM ad_campaigns WHERE id = ?').get(id));
});

router.put('/ad-campaigns/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM ad_campaigns WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Kampanya bulunamadı.' });
  const b = req.body || {};
  db.prepare(
    `UPDATE ad_campaigns SET platform=?, campaign_name=?, start_date=?, end_date=?, spend=?, impressions=?, clicks=?, signups=?, notes=? WHERE id=?`
  ).run(
    b.platform ?? existing.platform, b.campaignName ?? existing.campaign_name,
    b.startDate ?? existing.start_date, b.endDate ?? existing.end_date,
    b.spend !== undefined ? Number(b.spend) : existing.spend,
    b.impressions !== undefined ? Number(b.impressions) : existing.impressions,
    b.clicks !== undefined ? Number(b.clicks) : existing.clicks,
    b.signups !== undefined ? Number(b.signups) : existing.signups,
    b.notes ?? existing.notes, req.params.id
  );
  res.json(db.prepare('SELECT * FROM ad_campaigns WHERE id = ?').get(req.params.id));
});

router.delete('/ad-campaigns/:id', (req, res) => {
  db.prepare('DELETE FROM ad_campaigns WHERE id = ?').run(req.params.id);
  res.json({ message: 'Kampanya silindi.' });
});

// Bir kampanyanın tarih aralığında sistemde kaç yeni hesap açıldığını
// gösterir - GERÇEK ATRİBÜSYON DEĞİL (hangi kullanıcının o reklamdan
// geldiğini bilemeyiz), sadece kaba bir zaman çakışması referansı.
router.get('/ad-campaigns/:id/context', (req, res) => {
  const c = db.prepare('SELECT * FROM ad_campaigns WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Kampanya bulunamadı.' });
  const endDate = c.end_date || new Date().toISOString().slice(0, 10);
  const newAccounts = db
    .prepare(`SELECT COUNT(*) AS c FROM users WHERE account_type IN ('individual','company') AND date(created_at) BETWEEN ? AND ?`)
    .get(c.start_date, endDate).c;
  res.json({ newAccountsInWindow: newAccounts, note: 'Bu, gerçek reklam atıfı değil - sadece aynı tarih aralığındaki toplam yeni kayıt sayısıdır.' });
});

// --- Promosyon Kodları --------------------------------------------------------

router.get('/promo-codes', (req, res) => {
  const codes = db.prepare('SELECT * FROM promo_codes ORDER BY created_at DESC').all();
  res.json({ codes });
});

router.post('/promo-codes', (req, res) => {
  const {
    code, discountType, discountValue, startDate, endDate, startHour, endHour,
    city, serviceKey, maxUses, maxUsesPerCustomer,
  } = req.body || {};
  if (!code || !discountType || discountValue === undefined) {
    return res.status(400).json({ error: 'Kod, indirim tipi ve indirim değeri zorunlu.' });
  }
  if (!['percent', 'fixed'].includes(discountType)) {
    return res.status(400).json({ error: 'discountType "percent" ya da "fixed" olmalı.' });
  }
  const normalizedCode = code.trim().toUpperCase();
  const existing = db.prepare('SELECT id FROM promo_codes WHERE code = ?').get(normalizedCode);
  if (existing) return res.status(409).json({ error: 'Bu kod zaten kullanılıyor.' });

  const id = uuid();
  db.prepare(
    `INSERT INTO promo_codes
       (id, code, discount_type, discount_value, start_date, end_date, start_hour, end_hour, city, service_key, max_uses, max_uses_per_customer, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual')`
  ).run(
    id, normalizedCode, discountType, Number(discountValue),
    startDate || null, endDate || null,
    startHour !== undefined && startHour !== '' ? Number(startHour) : null,
    endHour !== undefined && endHour !== '' ? Number(endHour) : null,
    city || null, serviceKey || null,
    maxUses !== undefined && maxUses !== '' ? Number(maxUses) : null,
    maxUsesPerCustomer !== undefined && maxUsesPerCustomer !== '' ? Number(maxUsesPerCustomer) : 1
  );
  res.status(201).json(db.prepare('SELECT * FROM promo_codes WHERE id = ?').get(id));
});

router.put('/promo-codes/:id/toggle', (req, res) => {
  const promo = db.prepare('SELECT * FROM promo_codes WHERE id = ?').get(req.params.id);
  if (!promo) return res.status(404).json({ error: 'Kod bulunamadı.' });
  db.prepare('UPDATE promo_codes SET is_active = ? WHERE id = ?').run(promo.is_active ? 0 : 1, req.params.id);
  res.json({ message: 'Durum güncellendi.' });
});

router.delete('/promo-codes/:id', (req, res) => {
  db.prepare('DELETE FROM promo_codes WHERE id = ?').run(req.params.id);
  res.json({ message: 'Kod silindi.' });
});

router.get('/promo-codes/:id/redemptions', (req, res) => {
  const rows = db
    .prepare(
      `SELECT r.*, u.name AS customer_name FROM promo_code_redemptions r
       JOIN users u ON u.id = r.customer_id WHERE r.promo_code_id = ? ORDER BY r.redeemed_at DESC`
    )
    .all(req.params.id);
  res.json({ redemptions: rows });
});

// --- Sadakat hedefleme --------------------------------------------------------

router.get('/loyalty-customers', (req, res) => {
  const parsed = parseInt(req.query.minOrders, 10);
  const minOrders = Number.isNaN(parsed) ? 5 : Math.max(0, parsed);
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT u.id, u.name, u.phone,
                (SELECT COUNT(*) FROM cleaning_jobs j JOIN properties p ON p.id=j.property_id WHERE p.owner_id=u.id AND j.status='done') AS orderCount
         FROM users u WHERE u.account_type IN ('individual','company')
       ) WHERE orderCount >= ?
       ORDER BY orderCount DESC`
    )
    .all(minOrders);
  res.json({ customers: rows, minOrders });
});

router.post('/promo-codes/generate-loyalty', (req, res) => {
  const { code, discountType, discountValue, minOrders, endDate, maxUsesPerCustomer } = req.body || {};
  if (!code || !discountType || discountValue === undefined || !minOrders) {
    return res.status(400).json({ error: 'Kod, indirim tipi, değeri ve minimum sipariş sayısı zorunlu.' });
  }
  const normalizedCode = code.trim().toUpperCase();
  if (db.prepare('SELECT id FROM promo_codes WHERE code = ?').get(normalizedCode)) {
    return res.status(409).json({ error: 'Bu kod zaten kullanılıyor.' });
  }
  const customers = db
    .prepare(
      `SELECT * FROM (
         SELECT u.id,
                (SELECT COUNT(*) FROM cleaning_jobs j JOIN properties p ON p.id=j.property_id WHERE p.owner_id=u.id AND j.status='done') AS orderCount
         FROM users u WHERE u.account_type IN ('individual','company')
       ) WHERE orderCount >= ?`
    )
    .all(Number(minOrders));
  if (customers.length === 0) return res.status(400).json({ error: 'Bu eşiği karşılayan müşteri bulunamadı.' });

  const id = uuid();
  db.prepare(
    `INSERT INTO promo_codes (id, code, discount_type, discount_value, end_date, max_uses_per_customer, allowed_customer_ids, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'loyalty')`
  ).run(id, normalizedCode, discountType, Number(discountValue), endDate || null, Number(maxUsesPerCustomer) || 1, JSON.stringify(customers.map((c) => c.id)));
  res.status(201).json({ message: `${customers.length} müşteriye özel kod oluşturuldu.`, code: db.prepare('SELECT * FROM promo_codes WHERE id = ?').get(id) });
});

// --- Referans hedefleme --------------------------------------------------------

router.get('/top-referrers', (req, res) => {
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT u.id, u.name, u.phone, u.referral_code,
                (SELECT COUNT(*) FROM users r WHERE r.referred_by_user_id = u.id) AS referralCount
         FROM users u WHERE u.account_type IN ('individual','company') AND u.referral_code IS NOT NULL
       ) WHERE referralCount > 0
       ORDER BY referralCount DESC`
    )
    .all();
  res.json({ referrers: rows });
});

router.post('/promo-codes/generate-referral', (req, res) => {
  const { code, discountType, discountValue, minReferrals, endDate, maxUsesPerCustomer } = req.body || {};
  if (!code || !discountType || discountValue === undefined) {
    return res.status(400).json({ error: 'Kod, indirim tipi ve değeri zorunlu.' });
  }
  const normalizedCode = code.trim().toUpperCase();
  if (db.prepare('SELECT id FROM promo_codes WHERE code = ?').get(normalizedCode)) {
    return res.status(409).json({ error: 'Bu kod zaten kullanılıyor.' });
  }
  const threshold = Math.max(1, Number(minReferrals) || 1);
  const referrers = db
    .prepare(
      `SELECT * FROM (
         SELECT u.id, (SELECT COUNT(*) FROM users r WHERE r.referred_by_user_id = u.id) AS referralCount
         FROM users u WHERE u.account_type IN ('individual','company')
       ) WHERE referralCount >= ?`
    )
    .all(threshold);
  if (referrers.length === 0) return res.status(400).json({ error: 'Bu eşiği karşılayan müşteri kazandırmış kullanıcı bulunamadı.' });

  const id = uuid();
  db.prepare(
    `INSERT INTO promo_codes (id, code, discount_type, discount_value, end_date, max_uses_per_customer, allowed_customer_ids, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'referral')`
  ).run(id, normalizedCode, discountType, Number(discountValue), endDate || null, Number(maxUsesPerCustomer) || 1, JSON.stringify(referrers.map((r) => r.id)));
  res.status(201).json({ message: `${referrers.length} müşteri kazandırmış kullanıcıya özel kod oluşturuldu.`, code: db.prepare('SELECT * FROM promo_codes WHERE id = ?').get(id) });
});

module.exports = router;
