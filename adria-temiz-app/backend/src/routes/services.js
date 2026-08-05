const express = require('express');
const { SERVICES, COMMON_AREA_SUB_OPTIONS, ADDONS, SUPPLIES_FEES, COMMISSION_RATE } = require('../services/catalog');

const router = express.Router();

router.get('/', (req, res) => {
  res.json({
    services: SERVICES,
    commonAreaSubOptions: COMMON_AREA_SUB_OPTIONS,
    addons: ADDONS,
    suppliesFees: SUPPLIES_FEES,
    commissionRate: COMMISSION_RATE,
  });
});

module.exports = router;
