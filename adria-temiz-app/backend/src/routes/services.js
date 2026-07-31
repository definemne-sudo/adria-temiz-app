const express = require('express');
const { SERVICES } = require('../services/catalog');

const router = express.Router();

// Kimlik doğrulama gerektirmiyor - kayıt öncesi de gösterilebilir (örn. pazarlama sayfası).
router.get('/', (req, res) => {
  res.json(SERVICES);
});

module.exports = router;
