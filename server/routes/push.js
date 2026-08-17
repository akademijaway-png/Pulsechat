'use strict';

/**
 * Web Push subscription management + public VAPID key.
 */
const express = require('express');
const { db, now } = require('../db');
const { requireAuth } = require('../auth');
const { validateBody, errors } = require('../middleware/validate');
const push = require('../realtime/pushService');

const router = express.Router();

router.get('/vapid', async (req, res) => {
  res.json({ publicKey: push.getPublicKey() });
});

router.post(
  '/subscribe',
  requireAuth,
  validateBody({
    endpoint: { type: 'string', required: true, label: 'Push endpoint', max: 512 },
    p256dh: { type: 'string', required: true, label: 'p256dh key', max: 512 },
    auth: { type: 'string', required: true, label: 'auth secret', max: 512 },
  }),
  async (req, res) => {
    const { endpoint, p256dh, auth } = req.valid;
    if (!/^https:\/\//.test(endpoint)) {
      throw errors.badRequest('Push endpoint must be a secure https URL.');
    }
    // One subscription per endpoint — upsert it to the current user.
    await db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).run(endpoint);
    await db.prepare(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)`
    ).run(req.user.id, endpoint, p256dh, auth, now());
    res.status(201).json({ ok: true });
  }
);

router.post(
  '/unsubscribe',
  requireAuth,
  validateBody({ endpoint: { type: 'string', required: true, label: 'Push endpoint', max: 512 } }),
  async (req, res) => {
    await db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?`).run(
      req.valid.endpoint,
      req.user.id
    );
    res.json({ ok: true });
  }
);

module.exports = router;
