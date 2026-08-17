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

router.get('/search', requireAuth, async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!q) return res.json({ users: [] });
  if (q.length > 100) throw errors.badRequest('Search query is too long.');

  const like = '%' + escapeLike(q) + '%';
  const rows = await db
    .prepare(
      `SELECT * FROM users
        WHERE (LOWER(display_name) LIKE LOWER(?) OR LOWER(email) LIKE LOWER(?))
          AND id != ?
        ORDER BY display_name ASC
        LIMIT 40`
    )
    .all(like, like, req.user.id);

  res.json({ users: await Promise.all(rows.map(async (r) => userSummary(r, req.user.id))) });
});

/** Recent registered users — shows who's already on PulseChat so people can
 *  find and add each other without knowing an exact name/email. */
router.get('/discover', requireAuth, async (req, res) => {
  const rows = await db
    .prepare(`SELECT * FROM users WHERE id != ? ORDER BY id DESC LIMIT 30`)
    .all(req.user.id);
  res.json({ users: await Promise.all(rows.map(async (r) => userSummary(r, req.user.id))) });
});

router.get('/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw errors.badRequest('Invalid user id.');
  const row = await db.prepare(`SELECT * FROM users WHERE id = ?`).get(id);
  if (!row) throw errors.notFound('This user does not exist.');
  res.json({ user: await userSummary(row, req.user.id) });
});

module.exports = router;
