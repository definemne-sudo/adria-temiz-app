const express = require('express');
const { SERVICES, COMMON_AREA_SUB_OPTIONS, ADDONS, SUPPLIES_FEES } = require('../services/catalog');

const router = express.Router();

router.get('/', (req, res) => {
  res.json({ services: SERVICES, commonAreaSubOptions: COMMON_AREA_SUB_OPTIONS, addons: ADDONS, suppliesFees: SUPPLIES_FEES });
});

module.exports = router;
