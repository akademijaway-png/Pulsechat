'use strict';

/**
 * Call history — recent incoming/outgoing/missed video calls.
 */
const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../auth');
const { userSummary } = require('../helpers');

const router = express.Router();

router.get('/calls', requireAuth, (req, res) => {
  const me = req.user.id;
  const rows = db
    .prepare(
      `SELECT c.* FROM calls c
        WHERE c.caller_id = ? OR c.callee_id = ?
        ORDER BY c.id DESC
        LIMIT 100`
    )
    .all(me, me);

  const items = rows.map((c) => {
    const otherId = c.caller_id === me ? c.callee_id : c.caller_id;
    const other = db.prepare(`SELECT * FROM users WHERE id = ?`).get(otherId);
    return {
      id: c.id,
      kind: c.kind,
      status: c.status,
      direction: c.caller_id === me ? 'outgoing' : 'incoming',
      other: userSummary(other, me),
      initiatedAt: c.initiated_at,
      answeredAt: c.answered_at,
      endedAt: c.ended_at,
      duration: c.answered_at && c.ended_at ? Math.max(0, c.ended_at - c.answered_at) : null,
    };
  });
  res.json({ calls: items });
});

module.exports = router;
