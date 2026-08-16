'use strict';

/**
 * News Feed — social posts with photos, likes and comments.
 *  GET  /api/feed                  → latest posts (with author, like state, comments)
 *  POST /api/feed                  → create a post (text + optional image)
 *  POST /api/feed/:id/like         → toggle a like
 *  POST /api/feed/:id/comments     → add a comment
 */
const express = require('express');
const config = require('../config');
const { db, now } = require('../db');
const { requireAuth } = require('../auth');
const { validateBody, errors } = require('../middleware/validate');
const { userSummary } = require('../helpers');
const { imageUpload, saveImageFile, deleteFileIfExists } = require('../middleware/upload');

const router = express.Router();

const MEDIA_FILE_RE = /^[a-f0-9-]{36}\.(jpg|png|webp|gif)$/;

function postShape(row, meId) {
  const author = db.prepare(`SELECT * FROM users WHERE id = ?`).get(row.author_id);
  const likes = db.prepare(`SELECT COUNT(*) AS n FROM post_likes WHERE post_id = ?`).get(row.id).n;
  const liked = db.prepare(`SELECT 1 FROM post_likes WHERE post_id = ? AND user_id = ?`).get(row.id, meId);
  const comments = db
    .prepare(`SELECT * FROM post_comments WHERE post_id = ? ORDER BY id ASC LIMIT 50`)
    .all(row.id)
    .map((c) => {
      const ca = db.prepare(`SELECT * FROM users WHERE id = ?`).get(c.author_id);
      return {
        id: c.id,
        author: userSummary(ca, meId),
        body: c.body,
        createdAt: c.created_at,
      };
    });
  return {
    id: row.id,
    author: userSummary(author, meId),
    body: row.body,
    image: row.image || null,
    createdAt: row.created_at,
    likes,
    liked: !!liked,
    comments,
  };
}

/* ---------------- feed list ---------------- */

router.get('/feed', requireAuth, (req, res) => {
  let limit = Number.isInteger(Number(req.query.limit)) ? Number(req.query.limit) : 30;
  limit = Math.min(Math.max(limit, 1), 100);
  const before = Number.isInteger(Number(req.query.before)) ? Math.max(0, Number(req.query.before)) : 0;
  const rows = before
    ? db.prepare(`SELECT * FROM posts WHERE id < ? ORDER BY id DESC LIMIT ?`).all(before, limit)
    : db.prepare(`SELECT * FROM posts ORDER BY id DESC LIMIT ?`).all(limit);
  const posts = rows.map((r) => postShape(r, req.user.id));
  res.json({ posts });
});

/* ---------------- create post ---------------- */

router.post('/feed', requireAuth, imageUpload(config.uploads.messageMaxBytes), (req, res) => {
  const me = req.user.id;
  const body = typeof req.body.body === 'string' ? req.body.body.trim() : '';
  if (!body && !req.file) throw errors.unprocessable('Write something to post.');

  let image = null;
  if (req.file) {
    const saved = saveImageFile(req.file, config.messageDir);
    db.prepare(`INSERT INTO media (filename, kind, owner_id, created_at) VALUES (?, 'post', ?, ?)`).run(
      saved.filename,
      me,
      now()
    );
    image = saved.filename;
  }

  const info = db.prepare(`INSERT INTO posts (author_id, body, image, created_at) VALUES (?, ?, ?, ?)`).run(
    me,
    body.slice(0, config.messageMaxLength),
    image,
    now()
  );
  const row = db.prepare(`SELECT * FROM posts WHERE id = ?`).get(info.lastInsertRowid);
  const post = postShape(row, me);

  // Broadcast to everyone so feeds update live.
  const { emitToAll } = require('../realtime/registry');
  emitToAll('feed:new', { post });
  res.status(201).json({ post });
});

/* ---------------- like / unlike ---------------- */

router.post('/feed/:id/like', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw errors.badRequest('Invalid post.');
  const post = db.prepare(`SELECT id FROM posts WHERE id = ?`).get(id);
  if (!post) throw errors.notFound('Post not found.');

  const existing = db.prepare(`SELECT 1 FROM post_likes WHERE post_id = ? AND user_id = ?`).get(id, req.user.id);
  if (existing) {
    db.prepare(`DELETE FROM post_likes WHERE post_id = ? AND user_id = ?`).run(id, req.user.id);
  } else {
    db.prepare(`INSERT INTO post_likes (post_id, user_id, created_at) VALUES (?, ?, ?)`).run(id, req.user.id, now());
  }
  const likes = db.prepare(`SELECT COUNT(*) AS n FROM post_likes WHERE post_id = ?`).get(id).n;
  res.json({ ok: true, postId: id, likes, liked: !existing });
});

/* ---------------- comment ---------------- */

router.post(
  '/feed/:id/comments',
  requireAuth,
  validateBody({ body: { type: 'string', required: true, label: 'Comment', min: 1, max: 1000 } }),
  (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw errors.badRequest('Invalid post.');
    const post = db.prepare(`SELECT id FROM posts WHERE id = ?`).get(id);
    if (!post) throw errors.notFound('Post not found.');

    const info = db
      .prepare(`INSERT INTO post_comments (post_id, author_id, body, created_at) VALUES (?, ?, ?, ?)`)
      .run(id, req.user.id, req.valid.body.trim(), now());
    const c = db.prepare(`SELECT * FROM post_comments WHERE id = ?`).get(info.lastInsertRowid);
    const ca = db.prepare(`SELECT * FROM users WHERE id = ?`).get(c.author_id);
    res.status(201).json({
      comment: { id: c.id, author: userSummary(ca, req.user.id), body: c.body, createdAt: c.created_at },
    });
  }
);

module.exports = router;
