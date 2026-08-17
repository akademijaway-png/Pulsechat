'use strict';

/**
 * Development/testing tools. The reset endpoint is only active when the
 * server is started with ALLOW_RESET=1 — it lets you wipe all data so the
 * app can be tested from a blank slate (no stale accounts blocking signup).
 */
const express = require('express');
const config = require('../config');
const { wipeAllData } = require('../reset');
const { errors } = require('../middleware/validate');

const router = express.Router();

router.post('/reset', async (req, res) => {
  if (!config.allowReset) {
    throw errors.forbidden('Data reset is disabled on this server.');
  }
  wipeAllData();
  res.json({ ok: true, message: 'All data cleared. You can now create a fresh account.' });
});

module.exports = router;
