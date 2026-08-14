'use strict';

/**
 * Shared query helpers for shaping API / socket payloads.
 */
const { db } = require('./db');
const { isOnline } = require('./realtime/registry');

/** Relation between me and another user, based on the contacts table. */
function relationWith(meId, otherId) {
  if (meId === otherId) return 'self';
  const out = db.prepare(`SELECT status FROM contacts WHERE user_id = ? AND contact_id = ?`).get(meId, otherId);
  if (out) return out.status === 'accepted' ? 'accepted' : 'requested';
  const inc = db.prepare(`SELECT status FROM contacts WHERE user_id = ? AND contact_id = ?`).get(otherId, meId);
  if (inc) return inc.status === 'accepted' ? 'accepted' : 'incoming';
  return 'none';
}

function userSummary(row, meId) {
  return {
    id: row.id,
    displayName: row.display_name,
    email: row.email,
    bio: row.bio || '',
    avatar: row.avatar || null,
    online: isOnline(row.id),
    lastSeen: row.last_seen || null,
    relation: relationWith(meId, row.id),
  };
}

function otherParty(conv, meId) {
  return conv.user_a === meId ? conv.user_b : conv.user_a;
}

function messageShape(m) {
  if (!m) return null;
  return {
    id: m.id,
    conversationId: m.conversation_id,
    senderId: m.sender_id,
    kind: m.kind,
    body: m.body,
    createdAt: m.created_at,
    deliveredAt: m.delivered_at,
    readAt: m.read_at,
  };
}

/**
 * Full conversation item (same shape used by the conversation list).
 * Computed from the perspective of `meId`.
 */
function conversationItem(convId, meId) {
  const c = db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(convId);
  if (!c) return null;
  const otherId = otherParty(c, meId);
  const other = db.prepare(`SELECT * FROM users WHERE id = ?`).get(otherId);
  if (!other) return null;
  const last = c.last_message_id
    ? db.prepare(`SELECT * FROM messages WHERE id = ?`).get(c.last_message_id)
    : null;
  const unread = db
    .prepare(
      `SELECT COUNT(*) AS n FROM messages
        WHERE conversation_id = ? AND sender_id != ? AND read_at IS NULL`
    )
    .get(convId, meId).n;
  return {
    id: c.id,
    user: userSummary(other, meId),
    lastMessage: messageShape(last),
    unreadCount: unread,
  };
}

module.exports = { relationWith, userSummary, otherParty, messageShape, conversationItem };
