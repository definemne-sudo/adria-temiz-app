const express = require('express');
const { SERVICES, COMMON_AREA_SERVICES, ADDONS, SUPPLIES_FEES } = require('../services/catalog');

const router = express.Router();

router.get('/', (req, res) => {
  res.json({ services: SERVICES, commonAreaServices: COMMON_AREA_SERVICES, addons: ADDONS, suppliesFees: SUPPLIES_FEES });
});

module.exports = router;
