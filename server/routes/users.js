'use strict';

/**
 * User discovery — search and profile lookup. Only registered PulseChat users
 * can ever appear (search runs against the users table).
 */
const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../auth');
const { validateBody, errors } = require('../middleware/validate');
const { userSummary } = require('../helpers');

const router = express.Router();

function escapeLike(s) {
  return s.replace(/[\\%_]/g, (m) => '\\' + m);
}

router.get('/search', requireAuth, (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!q) return res.json({ users: [] });
  if (q.length > 100) throw errors.badRequest('Search query is too long.');

  const like = '%' + escapeLike(q) + '%';
  const rows = db
    .prepare(
      `SELECT * FROM users
        WHERE (display_name LIKE @like ESCAPE '\\' OR email LIKE @like ESCAPE '\\')
          AND id != @me
        ORDER BY display_name COLLATE NOCASE ASC
        LIMIT 40`
    )
    .all({ like, me: req.user.id });

  res.json({ users: rows.map((r) => userSummary(r, req.user.id)) });
});

router.get('/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw errors.badRequest('Invalid user id.');
  const row = db.prepare(`SELECT * FROM users WHERE id = ?`).get(id);
  if (!row) throw errors.notFound('This user does not exist.');
  res.json({ user: userSummary(row, req.user.id) });
});

module.exports = router;
