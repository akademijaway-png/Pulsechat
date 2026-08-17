'use strict';

/**
 * Offline → online message delivery.
 * Called whenever a user (re)connects:
 *  1. every message sent to them while offline is marked "delivered" and the
 *     senders are notified in real time (sent → delivered indicator);
 *  2. the reconnecting user receives each undelivered message as a
 *     `message:new` event so open UIs update instantly (they also refetch).
 */
const { db, now } = require('../db');
const { emitToUser } = require('./registry');
const { messageShape, conversationItem } = require('../helpers');

async function markDeliveredFor(userId) {
  const rows = await db
    .prepare(
      `SELECT m.*
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE (c.user_a = ? OR c.user_b = ?)
          AND m.sender_id != ?
          AND m.delivered_at IS NULL`
    )
    .all(userId, userId, userId);

  if (rows.length === 0) return;

  const bySender = new Map();
  for (const r of rows) {
    if (!bySender.has(r.sender_id)) bySender.set(r.sender_id, []);
    bySender.get(r.sender_id).push(r);
  }

  const t = now();
  const upd = await db.prepare(`UPDATE messages SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL`);

  for (const [senderId, msgs] of bySender) {
    const perConv = new Map();
    for (const m of msgs) {
      upd.run(t, m.id);
      if (!perConv.has(m.conversation_id)) perConv.set(m.conversation_id, []);
      perConv.get(m.conversation_id).push(m);
    }
    // Notify each sender that their messages were delivered.
    for (const [conversationId, messageIds] of perConv) {
      emitToUser(senderId, 'message:delivered', {
        conversationId,
        messageIds,
        byUserId: userId,
        at: t,
      });
    }
    // Replay the messages to the reconnecting user (they are the recipient).
    for (const m of msgs) {
      emitToUser(userId, 'message:new', {
        conversation: await conversationItem(m.conversation_id, userId),
        message: messageShape(m),
      });
    }
  }
}

module.exports = { markDeliveredFor };
