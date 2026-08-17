'use strict';

/**
 * Conversations & messages.
 *  - conversation list with last message + unread counter
 *  - paginated history (stored permanently)
 *  - send text/image messages with real-time delivery + offline storage/push
 *  - mark-as-read with live read receipts
 * Access is strictly limited to the two participants of each conversation.
 */
const express = require('express');
const config = require('../config');
const { db, now } = require('../db');
const { requireAuth } = require('../auth');
const { validateBody, errors } = require('../middleware/validate');
const { otherParty, messageShape, conversationItem, relationWith } = require('../helpers');
const { emitToUser, isOnline } = require('../realtime/registry');
const push = require('../realtime/pushService');

const router = express.Router();

const MEDIA_FILE_RE = /^[a-f0-9-]{36}\.(jpg|png|webp|gif)$/;

async function getConvOr403(convId, userId) {
  const conv = await db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(convId);
  if (!conv) throw errors.notFound('Conversation not found.');
  if (conv.user_a !== userId && conv.user_b !== userId) {
    throw errors.forbidden('You do not have access to this conversation.');
  }
  return conv;
}

/* ---------------- conversation list ---------------- */

router.get('/conversations', requireAuth, async (req, res) => {
  const me = req.user.id;
  const rows = await db.prepare(`SELECT * FROM conversations WHERE user_a = ? OR user_b = ?`).all(me, me);
  const items = (await Promise.all(rows.map(async (r) => conversationItem(r.id, me))))
    .filter(Boolean)
    .sort((a, b) => (b.lastMessage ? b.lastMessage.createdAt : 0) - (a.lastMessage ? a.lastMessage.createdAt : 0));
  res.json({ conversations: items });
});

/* ---------------- get-or-create conversation ---------------- */

router.post(
  '/conversations',
  requireAuth,
  validateBody({ userId: { type: 'integer', required: true, label: 'User id' } }),
  async (req, res) => {
    const me = req.user.id;
    const other = req.valid.userId;
    if (other === me) throw errors.badRequest('You cannot chat with yourself.');
    const otherRow = await db.prepare(`SELECT * FROM users WHERE id = ?`).get(other);
    if (!otherRow) throw errors.notFound('This user does not exist.');
    if (await relationWith(me, other) !== 'accepted') {
      throw errors.forbidden('You can only start chats with your contacts.');
    }
    const a = Math.min(me, other);
    const b = Math.max(me, other);
    let conv = await db.prepare(`SELECT * FROM conversations WHERE user_a = ? AND user_b = ?`).get(a, b);
    if (!conv) {
      const info = await db
        .prepare(`INSERT INTO conversations (user_a, user_b, created_at) VALUES (?, ?, ?)`)
        .run(a, b, now());
      conv = await db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(info.lastInsertRowid);
    }
    res.status(201).json({ conversation: await conversationItem(conv.id, me) });
  }
);

/* ---------------- single conversation ---------------- */

router.get('/conversations/:id', requireAuth, async (req, res) => {
  const conv = await getConvOr403(Number(req.params.id), req.user.id);
  res.json({ conversation: await conversationItem(conv.id, req.user.id) });
});

/* ---------------- message history (paginated) ---------------- */

router.get('/conversations/:id/messages', requireAuth, async (req, res) => {
  const conv = await getConvOr403(Number(req.params.id), req.user.id);
  const before = Number.isInteger(Number(req.query.before)) ? Math.max(0, Number(req.query.before)) : 0;
  let limit = Number.isInteger(Number(req.query.limit)) ? Number(req.query.limit) : 50;
  limit = Math.min(Math.max(limit, 1), 100);

  const rows = before
    ? await db
        .prepare(`SELECT * FROM messages WHERE conversation_id = ? AND id < ? ORDER BY id DESC LIMIT ?`)
        .all(conv.id, before, limit)
    : await db.prepare(`SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?`).all(conv.id, limit);

  rows.reverse();
  const hasMore = rows.length > 0
    ? !!await db.prepare(`SELECT 1 FROM messages WHERE conversation_id = ? AND id < ? LIMIT 1`).get(conv.id, rows[0].id)
    : false;

  res.json({ messages: rows.map(messageShape), hasMore });
});

/* ---------------- send message ---------------- */

router.post(
  '/conversations/:id/messages',
  requireAuth,
  validateBody({
    kind: { type: 'string', required: true, label: 'Message kind', max: 10 },
    body: { type: 'string', required: true, label: 'Message', max: config.messageMaxLength + 100 },
  }),
  async (req, res) => {
    const me = req.user.id;
    const conv = await getConvOr403(Number(req.params.id), me);
    const other = otherParty(conv, me);
    const { kind, body } = req.valid;

    if (await relationWith(me, other) !== 'accepted') {
      throw errors.forbidden('You can only message your contacts.');
    }

    let finalBody = body.trim();
    if (kind === 'text') {
      if (!finalBody) throw errors.unprocessable('Message cannot be empty.');
      if (finalBody.length > config.messageMaxLength) {
        throw errors.unprocessable(`Message must be at most ${config.messageMaxLength} characters.`);
      }
    } else if (kind === 'image') {
      if (!MEDIA_FILE_RE.test(finalBody)) throw errors.badRequest('Invalid image reference.');
      const media = await db
        .prepare(`SELECT * FROM media WHERE filename = ? AND kind = 'message' AND owner_id = ? AND conversation_id = ?`)
        .get(finalBody, me, conv.id);
      if (!media) throw errors.badRequest('Image not found or not uploaded for this conversation.');
    } else {
      throw errors.badRequest('Unsupported message kind.');
    }

    const t = now();
    const online = isOnline(other);

    const info = await db
      .prepare(`INSERT INTO messages (conversation_id, sender_id, kind, body, created_at, delivered_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(conv.id, me, kind, finalBody, t, online ? t : null);
    await db.prepare(`UPDATE conversations SET last_message_id = ? WHERE id = ?`).run(info.lastInsertRowid, conv.id);

    const msgRow = await db.prepare(`SELECT * FROM messages WHERE id = ?`).get(info.lastInsertRowid);
    const message = messageShape(msgRow);

    if (online) {
      emitToUser(other, 'message:new', {
        conversation: await conversationItem(conv.id, other),
        message,
      });
    } else {
      const meRow = await db.prepare(`SELECT * FROM users WHERE id = ?`).get(me);
      push.sendToUser(other, {
        title: `New message from ${meRow.display_name}`,
        body: kind === 'image' ? '📷 Photo' : 'New message',
        tag: `conv-${conv.id}`,
        url: `/chat/${conv.id}`,
      });
    }

    res.status(201).json({ message });
  }
);

/* ---------------- mark as read ---------------- */

router.post('/conversations/:id/read', requireAuth, async (req, res) => {
  const me = req.user.id;
  const conv = await getConvOr403(Number(req.params.id), me);
  const other = otherParty(conv, me);
  const t = now();
  const result = await db
    .prepare(`UPDATE messages SET read_at = ? WHERE conversation_id = ? AND sender_id = ? AND read_at IS NULL`)
    .run(t, conv.id, other);
  if (result.changes > 0) {
    const maxRow = await db
      .prepare(`SELECT MAX(id) AS m FROM messages WHERE conversation_id = ? AND sender_id = ? AND read_at = ?`)
      .get(conv.id, other, t);
    const maxId = maxRow ? maxRow.m : null;
    emitToUser(other, 'message:read', { conversationId: conv.id, byUserId: me, upToMessageId: maxId, at: t });
  }
  res.json({ ok: true });
});

module.exports = router;
