'use strict';

/**
 * Media: secure image upload + access-controlled serving.
 * Avatars are viewable by any authenticated user (they are public profile
 * pictures by design). Message media is only streamable to conversation
 * participants.
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const config = require('../config');
const { db, now } = require('../db');
const { requireAuth } = require('../auth');
const { validateBody, errors } = require('../middleware/validate');
const { imageUpload, saveImageFile, deleteFileIfExists } = require('../middleware/upload');

const router = express.Router();

const MIME = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
const SAFE_NAME = /^[a-f0-9-]{36}\.(jpg|png|webp|gif)$/;

/* ---------------- upload ---------------- */

router.post(
  '/media/upload',
  requireAuth,
  imageUpload(config.uploads.messageMaxBytes),
  (req, res) => {
    const me = req.user.id;
    const purpose = typeof req.body.purpose === 'string' ? req.body.purpose : '';
    const convId = Number(req.body.conversationId);

    if (purpose === 'avatar') {
      // Built-in avatar (9 choices) — no file needed.
      const builtin = typeof req.body.builtin === 'string' ? req.body.builtin : '';
      if (builtin) {
        const av = config.builtinAvatars.find((a) => a.id === builtin);
        if (!av) throw errors.badRequest('Unknown avatar choice.');
        const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(me);
        const oldAvatar = user.avatar;
        db.prepare(`UPDATE users SET avatar = ? WHERE id = ?`).run(av.url, me);
        if (oldAvatar && oldAvatar.startsWith('/uploads/avatars/')) {
          deleteFileIfExists(path.join(config.avatarDir, path.basename(oldAvatar)));
        }
        return res.status(200).json({ url: av.url, kind: 'avatar', builtin: true });
      }
      const saved = saveImageFile(req.file, config.avatarDir);
      const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(me);
      const oldAvatar = user.avatar;
      db.prepare(`UPDATE users SET avatar = ? WHERE id = ?`).run(`/uploads/avatars/${saved.filename}`, me);
      db.prepare(`INSERT INTO media (filename, kind, owner_id, created_at) VALUES (?, 'avatar', ?, ?)`).run(
        saved.filename,
        me,
        now()
      );
      if (oldAvatar && oldAvatar.startsWith('/uploads/avatars/')) {
        deleteFileIfExists(path.join(config.avatarDir, path.basename(oldAvatar)));
      }
      return res.status(201).json({ filename: saved.filename, url: `/uploads/avatars/${saved.filename}`, kind: 'avatar' });
    }

    if (purpose !== 'message') {
      throw errors.badRequest("purpose must be 'avatar' or 'message'.");
    }
    if (!Number.isInteger(convId) || convId <= 0) {
      throw errors.badRequest('conversationId is required for message media.');
    }
    const conv = db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(convId);
    if (!conv || (conv.user_a !== me && conv.user_b !== me)) {
      throw errors.forbidden('You do not have access to this conversation.');
    }

    const saved = saveImageFile(req.file, config.messageDir);
    db.prepare(
      `INSERT INTO media (filename, kind, owner_id, conversation_id, created_at) VALUES (?, 'message', ?, ?, ?)`
    ).run(saved.filename, me, convId, now());

    res.status(201).json({ filename: saved.filename, url: `/api/media/${saved.filename}`, kind: 'message' });
  }
);

/* ---------------- access-controlled download ---------------- */

router.get('/media/:filename', requireAuth, (req, res) => {
  const filename = req.params.filename;
  if (!SAFE_NAME.test(filename)) throw errors.badRequest('Invalid file name.');

  const media = db.prepare(`SELECT * FROM media WHERE filename = ?`).get(filename);
  if (!media) throw errors.notFound('File not found.');

  let filePath;
  if (media.kind === 'message') {
    const conv = db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(media.conversation_id);
    if (!conv || (conv.user_a !== req.user.id && conv.user_b !== req.user.id)) {
      throw errors.forbidden('You do not have access to this file.');
    }
    filePath = path.join(config.messageDir, filename);
  } else if (media.kind === 'post') {
    // Feed images are visible to all registered users (like any social feed).
    filePath = path.join(config.messageDir, filename);
  } else {
    filePath = path.join(config.avatarDir, filename);
  }

  if (!fs.existsSync(filePath)) throw errors.notFound('File not found.');

  const ext = path.extname(filename);
  res.set('Content-Type', MIME[ext] || 'application/octet-stream');
  res.set('Cache-Control', 'private, max-age=86400');
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
});

module.exports = router;
