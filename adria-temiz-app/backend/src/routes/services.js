const express = require('express');
const { getAllServices, getAllCommonAreaSubOptions, getAllBoatSubOptions, getAllAddons, getSuppliesFees, getCommissionRate, BOAT_QUOTE_REQUIRED_LENGTH_FT } = require('../services/catalog');

const router = express.Router();

// NOT: getAllServices() vb. fonksiyon olarak, her istekte çağrılıyor -
// (SERVICES gibi bir sabite bir kez destructure edip saklamıyoruz) ki admin
// panelinden fiyat değişince bu endpoint HEMEN güncel değeri döndürsün.
//
// "lang" query parametresi checklist maddelerinin hangi dilde döneceğini
// belirler (tr/en/me) - müşteri uygulaması kendi seçili dilini buradan
// gönderir. Gönderilmezse ya da geçersizse catalog.js içinde Türkçe'ye
// düşer (getChecklist fonksiyonundaki güvenli varsayılan).
router.get('/', (req, res) => {
  const lang = req.query.lang;
  res.json({
    services: getAllServices(lang),
    commonAreaSubOptions: getAllCommonAreaSubOptions(lang),
    boatSubOptions: getAllBoatSubOptions(lang),
    boatQuoteRequiredLengthFt: BOAT_QUOTE_REQUIRED_LENGTH_FT,
    addons: getAllAddons(lang),
    suppliesFees: getSuppliesFees(),
    commissionRate: getCommissionRate(),
  });
});

module.exports = router;
