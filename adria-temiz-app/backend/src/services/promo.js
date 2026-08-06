const db = require('../db');
const { v4: uuid } = require('uuid');

// Bir promosyon kodunun, belirli bir müşteri/şehir/hizmet/an için geçerli
// olup olmadığını kontrol eder. Geçerliyse { promo } döner, değilse
// { error } - kullanıcıya doğrudan gösterilebilecek bir Türkçe mesajla.
function validatePromoCode({ code, customerId, city, serviceKey, now = new Date() }) {
  if (!code || !code.trim()) return { error: 'Promosyon kodu boş olamaz.' };
  const promo = db.prepare('SELECT * FROM promo_codes WHERE code = ? AND is_active = 1').get(code.trim().toUpperCase());
  if (!promo) return { error: 'Geçersiz ya da pasif promosyon kodu.' };

  const dateKey = now.toISOString().slice(0, 10);
  if (promo.start_date && dateKey < promo.start_date) return { error: 'Bu kod henüz geçerli değil.' };
  if (promo.end_date && dateKey > promo.end_date) return { error: 'Bu kodun süresi dolmuş.' };

  if (promo.start_hour !== null && promo.start_hour !== undefined && promo.end_hour !== null && promo.end_hour !== undefined) {
    const hour = now.getHours();
    if (hour < promo.start_hour || hour >= promo.end_hour) {
      return { error: `Bu kod yalnızca ${String(promo.start_hour).padStart(2,'0')}:00–${String(promo.end_hour).padStart(2,'0')}:00 arasında geçerli.` };
    }
  }
  if (promo.city && city && promo.city.trim().toLowerCase() !== city.trim().toLowerCase()) {
    return { error: `Bu kod yalnızca ${promo.city} için geçerli.` };
  }
  if (promo.service_key && serviceKey && promo.service_key !== serviceKey) {
    return { error: 'Bu kod bu hizmet türü için geçerli değil.' };
  }
  if (promo.max_uses !== null && promo.max_uses !== undefined && promo.used_count >= promo.max_uses) {
    return { error: 'Bu kodun kullanım limiti dolmuş.' };
  }
  if (promo.allowed_customer_ids) {
    let allowed = [];
    try { allowed = JSON.parse(promo.allowed_customer_ids); } catch (e) { allowed = []; }
    if (!allowed.includes(customerId)) return { error: 'Bu kod hesabın için geçerli değil.' };
  }
  const customerUses = db
    .prepare('SELECT COUNT(*) AS c FROM promo_code_redemptions WHERE promo_code_id = ? AND customer_id = ?')
    .get(promo.id, customerId).c;
  if (customerUses >= promo.max_uses_per_customer) {
    return { error: 'Bu kodu daha önce kullandın.' };
  }

  return { promo };
}

function calcDiscount(promo, price) {
  if (promo.discount_type === 'percent') {
    return Math.round(price * (promo.discount_value / 100) * 100) / 100;
  }
  return Math.min(price, promo.discount_value);
}

function redeemPromo(promo, customerId, jobId, discountAmount) {
  db.prepare(
    'INSERT INTO promo_code_redemptions (id, promo_code_id, customer_id, job_id, discount_amount) VALUES (?, ?, ?, ?, ?)'
  ).run(uuid(), promo.id, customerId, jobId, discountAmount);
  db.prepare('UPDATE promo_codes SET used_count = used_count + 1 WHERE id = ?').run(promo.id);
}

module.exports = { validatePromoCode, calcDiscount, redeemPromo };
