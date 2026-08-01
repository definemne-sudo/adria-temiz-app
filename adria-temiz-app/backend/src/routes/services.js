const express = require('express');
const { SERVICES, ADDONS, SUPPLIES_FEES } = require('../services/catalog');

const router = express.Router();

router.get('/', (req, res) => {
  res.json({ services: SERVICES, addons: ADDONS, suppliesFees: SUPPLIES_FEES });
});

module.exports = router;
