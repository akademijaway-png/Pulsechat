'use strict';

/**
 * Contacts / friend requests:
 *  - send request, accept, decline, remove contact
 *  - list contacts and pending requests
 *  - real-time events + push notifications on each transition
 */
const express = require('express');
const { db, now } = require('../db');
const { requireAuth } = require('../auth');
const { validateBody, errors } = require('../middleware/validate');
const { userSummary } = require('../helpers');
const { emitToUser, isOnline } = require('../realtime/registry');
const push = require('../realtime/pushService');

const router = express.Router();

async function userRow(id) {
  return await db.prepare(`SELECT * FROM users WHERE id = ?`).get(id);
}

/** List accepted contacts (friends), with live presence info. */
router.get('/contacts', requireAuth, async (req, res) => {
  const rows = await db
    .prepare(
      `SELECT u.* FROM contacts c JOIN users u ON u.id = c.contact_id
        WHERE c.user_id = ? AND c.status = 'accepted'
        ORDER BY u.display_name ASC`
    )
    .all(req.user.id);
  res.json({ contacts: await Promise.all(rows.map(async (r) => userSummary(r, req.user.id))) });
});

/** Incoming + outgoing pending requests. */
router.get('/contacts/requests', requireAuth, async (req, res) => {
  const me = req.user.id;
  const incomingRows = await db
    .prepare(
      `SELECT u.* FROM contacts c JOIN users u ON u.id = c.user_id
        WHERE c.contact_id = ? AND c.status = 'requested'
        ORDER BY c.created_at DESC`
    )
    .all(me);
  const outgoingRows = await db
    .prepare(
      `SELECT u.* FROM contacts c JOIN users u ON u.id = c.contact_id
        WHERE c.user_id = ? AND c.status = 'requested'
        ORDER BY c.created_at DESC`
    )
    .all(me);
  const incoming = await Promise.all(incomingRows.map(async (r) => userSummary(r, me)));
  const outgoing = await Promise.all(outgoingRows.map(async (r) => userSummary(r, me)));
  res.json({ incoming, outgoing });
});

/** Send a friend request. */
router.post(
  '/contacts/requests',
  requireAuth,
  validateBody({ toUserId: { type: 'integer', required: true, label: 'User id' } }),
  async (req, res) => {
    const me = req.user.id;
    const target = req.valid.toUserId;
    if (target === me) throw errors.badRequest('You cannot send a request to yourself.');

    const other = await userRow(target);
    if (!other) throw errors.notFound('This user does not exist.');

    const existing = await db
      .prepare(
        `SELECT * FROM contacts WHERE (user_id = ? AND contact_id = ?) OR (user_id = ? AND contact_id = ?)`
      )
      .get(me, target, target, me);

    if (existing) {
      if (existing.status === 'accepted') throw errors.conflict('You are already connected with this user.');
      if (existing.user_id === me) throw errors.conflict('You already sent a request to this user.');
      throw errors.conflict('This user has already sent you a request. Accept it instead.');
    }

    await db.prepare(`INSERT INTO contacts (user_id, contact_id, status, created_at) VALUES (?, ?, 'requested', ?)`).run(
      me,
      target,
      now()
    );

    const fromSummary = await userSummary(await db.prepare(`SELECT * FROM users WHERE id = ?`).get(me), target);
    emitToUser(target, 'contact:request', { from: fromSummary });
    push.sendToUser(target, {
      title: 'New friend request',
      body: `${fromSummary.displayName} sent you a friend request.`,
      tag: 'contact-request',
      url: '/people',
    });

    res.status(201).json({ ok: true, from: await userSummary(await userRow(me), target) });
  }
);

/** Accept an incoming request. */
router.post('/contacts/requests/:fromUserId/accept', requireAuth, async (req, res) => {
  const me = req.user.id;
  const fromId = Number(req.params.fromUserId);
  const row = await db
    .prepare(`SELECT * FROM contacts WHERE user_id = ? AND contact_id = ? AND status = 'requested'`)
    .get(fromId, me);
  if (!row) throw errors.notFound('No pending request from this user.');

  await db.prepare(`UPDATE contacts SET status = 'accepted', responded_at = ? WHERE id = ?`).run(now(), row.id);

  // CRITICAL: persist the friendship in BOTH directions. The requester's row
  // is already accepted; the accepter needs their own row too, otherwise the
  // friendship disappears from the accepter's friends list after a restart.
  const reverse = await db
    .prepare(`SELECT id FROM contacts WHERE user_id = ? AND contact_id = ?`)
    .get(me, fromId);
  if (!reverse) {
    await db.prepare(`INSERT INTO contacts (user_id, contact_id, status, created_at, responded_at) VALUES (?, ?, 'accepted', ?, ?)`)
      .run(me, fromId, now(), now());
  }

  const mySummary = await userSummary(await userRow(me), fromId);
  emitToUser(fromId, 'contact:accepted', { contact: mySummary });
  push.sendToUser(fromId, {
    title: 'Request accepted',
    body: `${mySummary.displayName} accepted your friend request.`,
    tag: 'contact-accepted',
    url: '/chats',
  });

  res.json({ ok: true, contact: mySummary });
});

/** Decline an incoming request. */
router.post('/contacts/requests/:fromUserId/decline', requireAuth, async (req, res) => {
  const me = req.user.id;
  const fromId = Number(req.params.fromUserId);
  const row = await db
    .prepare(`SELECT * FROM contacts WHERE user_id = ? AND contact_id = ? AND status = 'requested'`)
    .get(fromId, me);
  if (!row) throw errors.notFound('No pending request from this user.');

  await db.prepare(`DELETE FROM contacts WHERE id = ?`).run(row.id);
  emitToUser(fromId, 'contact:declined', { fromUserId: me });
  res.json({ ok: true });
});

/** Remove an existing contact (deletes both direction rows). */
router.delete('/contacts/:userId', requireAuth, async (req, res) => {
  const me = req.user.id;
  const otherId = Number(req.params.userId);
  const row = await db
    .prepare(
      `SELECT * FROM contacts
        WHERE (user_id = ? AND contact_id = ?) OR (user_id = ? AND contact_id = ?)`
    )
    .get(me, otherId, otherId, me);
  if (!row) throw errors.notFound('This user is not in your contacts.');

  // Delete BOTH direction rows so the removal is consistent for both users.
  await db.prepare(`DELETE FROM contacts WHERE (user_id = ? AND contact_id = ?) OR (user_id = ? AND contact_id = ?)`).run(
    me, otherId, otherId, me
  );
  emitToUser(otherId, 'contact:removed', { userId: me });
  emitToUser(me, 'contact:removed', { userId: otherId });
  res.json({ ok: true });
});

module.exports = router;
