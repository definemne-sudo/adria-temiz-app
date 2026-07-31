const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

function detectBrand(cardNumber) {
  const n = cardNumber.replace(/\s/g, '');
  if (/^4/.test(n)) return 'Visa';
  if (/^5[1-5]/.test(n)) return 'Mastercard';
  if (/^3[47]/.test(n)) return 'Amex';
  return 'Kart';
}

router.get('/', (req, res) => {
  const card = db.prepare('SELECT * FROM saved_cards WHERE user_id = ?').get(req.user.id);
  if (!card) return res.json(null);
  res.json({
    brand: card.brand,
    last4: card.last4,
    expMonth: card.exp_month,
    expYear: card.exp_year,
    holderName: card.holder_name,
  });
});

// GÜVENLİK NOTU: cardNumber ve cvc yalnızca bu isteğin işlenmesi sırasında
// bellekte kullanılır, veritabanına ASLA yazılmaz. Gerçek entegrasyonda bu
// endpoint'e kart numarası hiç gelmez - Stripe.js istemci tarafında
// tokenize eder, bize yalnızca payment_method_id gönderilir. Bu MVP'de
// gerçek bir sağlayıcı olmadığı için aynı sonucu (yalnızca maskeli veri
// saklama) simüle ediyoruz.
router.post('/', (req, res) => {
  const { cardNumber, expMonth, expYear, holderName } = req.body;
  const digits = (cardNumber || '').replace(/\s/g, '');

  if (!/^\d{13,19}$/.test(digits)) {
    return res.status(400).json({ error: 'Geçerli bir kart numarası gir.' });
  }
  const em = Number(expMonth);
  const ey = Number(expYear);
  if (!em || em < 1 || em > 12 || !ey || ey < new Date().getFullYear()) {
    return res.status(400).json({ error: 'Son kullanma tarihi geçersiz.' });
  }

  const last4 = digits.slice(-4);
  const brand = detectBrand(digits);

  db.prepare(
    `INSERT INTO saved_cards (user_id, brand, last4, exp_month, exp_year, holder_name)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       brand=excluded.brand, last4=excluded.last4, exp_month=excluded.exp_month,
       exp_year=excluded.exp_year, holder_name=excluded.holder_name`
  ).run(req.user.id, brand, last4, em, ey, holderName || null);

  res.status(201).json({ brand, last4, expMonth: em, expYear: ey, holderName: holderName || null });
});

router.delete('/', (req, res) => {
  db.prepare('DELETE FROM saved_cards WHERE user_id = ?').run(req.user.id);
  res.json({ message: 'Kart kaldırıldı.' });
});

module.exports = router;
