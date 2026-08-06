const express = require('express');
const { getAllServices, getAllCommonAreaSubOptions, getAllAddons, getSuppliesFees, COMMISSION_RATE } = require('../services/catalog');

const router = express.Router();

// NOT: getAllServices() vb. fonksiyon olarak, her istekte çağrılıyor -
// (SERVICES gibi bir sabite bir kez destructure edip saklamıyoruz) ki admin
// panelinden fiyat değişince bu endpoint HEMEN güncel değeri döndürsün.
router.get('/', (req, res) => {
  res.json({
    services: getAllServices(),
    commonAreaSubOptions: getAllCommonAreaSubOptions(),
    addons: getAllAddons(),
    suppliesFees: getSuppliesFees(),
    commissionRate: COMMISSION_RATE,
  });
});

module.exports = router;
