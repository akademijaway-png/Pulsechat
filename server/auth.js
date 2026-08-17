'use strict';

/**
 * Authentication helpers: password hashing, JWT access tokens,
 * rotating refresh tokens (hashed at rest), and the express guard.
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const config = require('./config');
const { db, now } = require('./db');

const BCRYPT_ROUNDS = 12;

/* ---------------- passwords ---------------- */

function hashPassword(plain) {
  return bcrypt.hashSync(plain, BCRYPT_ROUNDS);
}

function verifyPassword(plain, hash) {
  return bcrypt.compareSync(plain, hash);
}

/* ---------------- access tokens (JWT) ---------------- */

function signAccessToken(user) {
  return jwt.sign(
    { sub: String(user.id), typ: 'access' },
    config.jwt.accessSecret,
    { expiresIn: config.jwt.accessTtl, issuer: 'pulsechat' }
  );
}

/* ---------------- refresh tokens (rotating, stored hashed) ---------------- */

function newRefreshTokenRaw() {
  return crypto.randomBytes(48).toString('base64url');
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

async function issueRefreshToken(userId, device) {
  const raw = newRefreshTokenRaw();
  const ttlMs = config.jwt.refreshTtlDays * 24 * 60 * 60 * 1000;
  await db.prepare(
    `INSERT INTO refresh_tokens (id, user_id, device, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(hashToken(raw), userId, device || 'web', now(), now() + ttlMs);
  return raw;
}

/**
 * Validate + rotate a refresh token. Returns { userId, raw } for the new pair
 * or null when the token is unknown, expired, or already replaced.
 */
async function rotateRefreshToken(rawToken, device) {
  const id = hashToken(rawToken);
  const row = await db.prepare(
    `SELECT id, user_id, expires_at, replaced_by FROM refresh_tokens WHERE id = ?`
  ).get(id);
  if (!row) return null;
  if (row.replaced_by || row.expires_at < now()) {
    // Reuse of an already-rotated (stolen) token: revoke the whole chain.
    revokeTokenChain(row.user_id, row.id);
    return null;
  }
  await db.prepare(`DELETE FROM refresh_tokens WHERE id = ?`).run(id);
  const raw = await issueRefreshToken(row.user_id, device);
  return { userId: row.user_id, raw };
}

async function revokeRefreshToken(rawToken) {
  if (!rawToken) return;
  await db.prepare(`DELETE FROM refresh_tokens WHERE id = ?`).run(hashToken(rawToken));
}

async function revokeAllRefreshTokens(userId) {
  await db.prepare(`DELETE FROM refresh_tokens WHERE user_id = ?`).run(userId);
}

/** Delete the token + everything that replaced it (used when reuse is detected). */
async function revokeTokenChain(userId, firstId) {
  const q = await db.prepare(`SELECT id, replaced_by FROM refresh_tokens WHERE user_id = ?`);
  const del = await db.prepare(`DELETE FROM refresh_tokens WHERE id = ?`);
  const seen = new Set([firstId]);
  let cur = firstId;
  while (cur) {
    const row = q.get(userId) && await db.prepare(`SELECT id, replaced_by FROM refresh_tokens WHERE id = ?`).get(cur);
    if (!row) break;
    del.run(row.id);
    if (row.replaced_by && !seen.has(row.replaced_by)) {
      seen.add(row.replaced_by);
      cur = row.replaced_by;
    } else cur = null;
  }
}

/* ---------------- express guard ---------------- */

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'auth_required', message: 'You must be logged in.' });
  }
  try {
    const payload = jwt.verify(token, config.jwt.accessSecret, { issuer: 'pulsechat' });
    if (payload.typ !== 'access') throw new Error('wrong token type');
    req.user = { id: Number(payload.sub) };
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'invalid_token', message: 'Your session has expired. Please log in again.' });
  }
}

/* ---------------- profile row -> public shape ---------------- */

function publicUser(row) {
  return {
    id: row.id,
    displayName: row.display_name,
    email: row.email,
    bio: row.bio || '',
    avatar: row.avatar || null,
    createdAt: row.created_at,
  };
}

module.exports = {
  hashPassword,
  verifyPassword,
  signAccessToken,
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllRefreshTokens,
  requireAuth,
  publicUser,
};
