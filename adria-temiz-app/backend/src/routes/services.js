const express = require('express');
const { SERVICES, ADDONS } = require('../services/catalog');

const router = express.Router();

// Kimlik doğrulama gerektirmiyor - kayıt öncesi de gösterilebilir.
router.get('/', (req, res) => {
  res.json({ services: SERVICES, addons: ADDONS });
});

module.exports = router;
