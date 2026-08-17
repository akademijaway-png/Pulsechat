'use strict';

/**
 * Account creation, login/logout, session refresh, profile management,
 * password change, password reset and Google (Gmail) sign-in.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { db, now } = require('../db');
const {
  hashPassword,
  verifyPassword,
  signAccessToken,
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllRefreshTokens,
  requireAuth,
  publicUser,
} = require('../auth');
const { isEmail, passwordIssue, validateBody, errors, HttpError } = require('../middleware/validate');
const { imageUpload, saveImageFile, saveImageBuffer, deleteFileIfExists } = require('../middleware/upload');
const { sendResetEmail } = require('../mailer');

const router = express.Router();

async function tokenPair(userId, device) {
  return { accessToken: signAccessToken({ id: userId }), refreshToken: await issueRefreshToken(userId, device) };
}

async function findUserByEmail(email) {
  return await db.prepare(`SELECT * FROM users WHERE LOWER(email) = LOWER(?)`).get(email.trim());
}

/* ---------------- sign-in with Google (Gmail) ---------------- */

const { OAuth2Client } = require('google-auth-library');
let googleClient = null;
if (config.google.clientId) {
  googleClient = new OAuth2Client(config.google.clientId);
}

/** Public app metadata: whether Google sign-in is on, and demo logins (dev). */
router.get('/meta', async (req, res) => {
  res.json({
    google: { enabled: !!config.google.clientId, clientId: config.google.clientId },
    demoAccounts: config.demoAccounts,
    builtinAvatars: config.builtinAvatars,
    allowReset: config.allowReset,
  });
});

/** Download + store a Google profile picture as a regular avatar. */
async function saveGooglePicture(pictureUrl) {
  if (!pictureUrl) return null;
  try {
    const res = await fetch(pictureUrl, { redirect: 'follow', signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > config.uploads.avatarMaxBytes) return null;
    const saved = saveImageBuffer(buf, config.avatarDir);
    return saved ? `/uploads/avatars/${saved.filename}` : null;
  } catch {
    return null;
  }
}

router.post(
  '/google',
  validateBody({ credential: { type: 'string', required: true, label: 'Google credential', min: 20, max: 8192 } }),
  async (req, res, next) => {
    try {
      if (!googleClient) {
        throw errors.unprocessable('Google sign-in is not configured on this server. Use email & password instead.');
      }
      const ticket = await googleClient.verifyIdToken({
        idToken: req.valid.credential,
        audience: config.google.clientId,
      });
      const payload = ticket.getPayload();
      if (!payload) throw errors.unauthorized('Google sign-in failed. Please try again.');
      if (payload.iss !== 'accounts.google.com' && payload.iss !== 'https://accounts.google.com') {
        throw errors.unauthorized('Google sign-in failed. Please try again.');
      }
      if (payload.aud !== config.google.clientId) {
        throw errors.unauthorized('Google sign-in failed. Please try again.');
      }
      if (!payload.email_verified || !isEmail(payload.email)) {
        throw errors.unauthorized('Your Google account email is not verified.');
      }

      const email = payload.email.toLowerCase();
      let user = await findUserByEmail(email);
      if (!user) {
        // New account, created from the Google profile.
        const displayName = (payload.name || email.split('@')[0] || 'PulseChat user')
          .trim()
          .slice(0, config.displayNameMaxLength);
        const avatar = await saveGooglePicture(payload.picture);
        const info = await db
          .prepare(
            `INSERT INTO users (email, password_hash, display_name, bio, created_at, avatar)
             VALUES (?, '', ?, '', ?, ?)`
          )
          .run(email, displayName, now(), avatar);
        user = await db.prepare(`SELECT * FROM users WHERE id = ?`).get(info.lastInsertRowid);
      } else if (!user.avatar && payload.picture) {
        // Backfill a profile picture for existing accounts that don't have one.
        const avatar = await saveGooglePicture(payload.picture);
        if (avatar) await db.prepare(`UPDATE users SET avatar = ? WHERE id = ?`).run(avatar, user.id);
      }

      const pair = await tokenPair(user.id, req.headers['user-agent'] || 'web');
      res.json({ user: publicUser(user), ...pair, googleAccount: true });
    } catch (err) {
      if (err instanceof HttpError) return next(err);
      console.error('[auth/google]', err.message);
      next(errors.unauthorized('Google sign-in failed. Please try again.'));
    }
  }
);

/* ---------------- register ---------------- */

router.post(
  '/register',
  validateBody({
    email: { type: 'string', required: true, label: 'Email', max: 254, pattern: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, patternMessage: 'Please enter a valid email address.' },
    password: { type: 'string', required: true, label: 'Password', max: 128 },
    displayName: { type: 'string', required: true, label: 'Display name', min: 2, max: config.displayNameMaxLength },
  }),
  async (req, res) => {
    const { email, password, displayName } = req.valid;

    const pwIssue = passwordIssue(password);
    if (pwIssue) throw errors.unprocessable(pwIssue, { field: 'password' });

    if (await findUserByEmail(email)) {
      throw errors.conflict('An account with this email already exists. Try logging in instead.');
    }

    const t = now();
    const info = await db
      .prepare(`INSERT INTO users (email, password_hash, display_name, bio, created_at) VALUES (?, ?, ?, '', ?)`)
      .run(email.trim().toLowerCase(), hashPassword(password), displayName, t);

    const user = await db.prepare(`SELECT * FROM users WHERE id = ?`).get(info.lastInsertRowid);
    const pair = await tokenPair(user.id, req.headers['user-agent'] || 'web');
    res.status(201).json({ user: publicUser(user), ...pair });
  }
);

/* ---------------- login ---------------- */

router.post(
  '/login',
  validateBody({
    email: { type: 'string', required: true, label: 'Email', max: 254 },
    password: { type: 'string', required: true, label: 'Password', max: 128 },
  }),
  async (req, res) => {
    const user = await findUserByEmail(req.valid.email);
    if (!user) {
      // No account with this email — tell them, don't guess.
      throw errors.unauthorized("No account found with this email. Tap \"Create account\" to register.");
    }
    if (!user.password_hash) {
      // Google-only account — email+password can never work for it.
      throw errors.unauthorized('This email uses Google sign-in. Tap "Continue with Google" to log in.');
    }
    const ok = verifyPassword(req.valid.password, user.password_hash);
    if (!ok) {
      throw errors.unauthorized('Incorrect password. If you forgot it, use "Reset it" below.');
    }
    const pair = await tokenPair(user.id, req.headers['user-agent'] || 'web');
    res.json({ user: publicUser(user), ...pair });
  }
);

/* ---------------- refresh ---------------- */

router.post(
  '/refresh',
  validateBody({ refreshToken: { type: 'string', required: true, label: 'Refresh token', min: 20, max: 512 } }),
  async (req, res) => {
    const rotated = await rotateRefreshToken(req.valid.refreshToken, req.headers['user-agent'] || 'web');
    if (!rotated) {
      throw errors.unauthorized('Your session has expired. Please log in again.');
    }
    const user = await db.prepare(`SELECT * FROM users WHERE id = ?`).get(rotated.userId);
    if (!user) throw errors.unauthorized('Your session has expired. Please log in again.');
    res.json({ accessToken: signAccessToken({ id: user.id }), refreshToken: rotated.raw });
  }
);

/* ---------------- logout ---------------- */

router.post(
  '/logout',
  validateBody({ refreshToken: { type: 'string', required: true, label: 'Refresh token', min: 20, max: 512 } }),
  async (req, res) => {
    await revokeRefreshToken(req.valid.refreshToken);
    res.json({ ok: true });
  }
);

/* ---------------- me ---------------- */

router.get('/me', requireAuth, async (req, res) => {
  const user = await db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.user.id);
  if (!user) throw errors.notFound('Account not found.');
  res.json({ user: publicUser(user) });
});

/* ---------------- profile update ---------------- */

router.patch(
  '/profile',
  requireAuth,
  validateBody({
    displayName: { type: 'string', required: false, label: 'Display name', min: 2, max: config.displayNameMaxLength },
    bio: { type: 'string', required: false, label: 'Bio', max: config.bioMaxLength },
  }),
  async (req, res) => {
    const fields = req.valid;
    if (!fields.displayName && fields.bio === undefined) {
      throw errors.badRequest('Nothing to update.');
    }
    const user = await db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.user.id);
    if (!user) throw errors.notFound('Account not found.');
    const newName = fields.displayName !== undefined ? fields.displayName : user.display_name;
    const newBio = fields.bio !== undefined ? fields.bio : user.bio;
    await db.prepare(`UPDATE users SET display_name = ?, bio = ? WHERE id = ?`).run(newName, newBio, req.user.id);
    const updated = await db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.user.id);
    res.json({ user: publicUser(updated) });
  }
);

/* ---------------- change password ---------------- */

router.post(
  '/password',
  requireAuth,
  validateBody({
    currentPassword: { type: 'string', required: true, label: 'Current password', max: 128 },
    newPassword: { type: 'string', required: true, label: 'New password', max: 128 },
  }),
  async (req, res) => {
    const user = await db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.user.id);
    if (!verifyPassword(req.valid.currentPassword, user.password_hash)) {
      throw errors.unauthorized('Your current password is incorrect.');
    }
    const issue = passwordIssue(req.valid.newPassword);
    if (issue) throw errors.unprocessable(issue, { field: 'newPassword' });
    if (req.valid.newPassword === req.valid.currentPassword) {
      throw errors.unprocessable('New password must be different from the current one.');
    }
    await db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hashPassword(req.valid.newPassword), req.user.id);
    await revokeAllRefreshTokens(req.user.id);
    res.json({ ok: true });
  }
);

/* ---------------- avatar ---------------- */

router.post('/avatar', requireAuth, imageUpload(config.uploads.avatarMaxBytes), async (req, res) => {
  const saved = saveImageFile(req.file, config.avatarDir);
  const user = await db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.user.id);
  const oldAvatar = user.avatar;
  const avatarUrl = `/uploads/avatars/${saved.filename}`;
  await db.prepare(`UPDATE users SET avatar = ? WHERE id = ?`).run(avatarUrl, req.user.id);
  await db.prepare(`INSERT INTO media (filename, kind, owner_id, created_at) VALUES (?, 'avatar', ?, ?)`).run(
    saved.filename,
    req.user.id,
    now()
  );
  if (oldAvatar && oldAvatar.startsWith('/uploads/avatars/')) {
    deleteFileIfExists(require('path').join(config.avatarDir, oldAvatar.split('/').pop()));
  }
  const updated = await db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.user.id);
  res.json({ user: publicUser(updated) });
});

/* ---------------- password reset ---------------- */

router.post(
  '/reset/request',
  validateBody({ email: { type: 'string', required: true, label: 'Email', max: 254 } }),
  async (req, res) => {
    const email = req.valid.email.trim().toLowerCase();
    if (!isEmail(email)) throw errors.unprocessable('Please enter a valid email address.');

    const user = await findUserByEmail(email);
    if (user) {
      const raw = require('crypto').randomBytes(32).toString('hex');
      const tokenHash = require('crypto').createHash('sha256').update(raw).digest('hex');
      const ttl = 30 * 60 * 1000;
      await db.prepare(`INSERT INTO password_resets (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`).run(
        tokenHash,
        user.id,
        now(),
        now() + ttl
      );
      const base = config.appBaseUrl || req.headers.origin || '';
      const resetUrl = `${base}/reset?token=${raw}`;
      const devUrl = await sendResetEmail(user, resetUrl);
      // Always answer the same way — we don't leak whether the account exists.
      res.json({
        ok: true,
        message: 'If an account exists for that email, a reset link has been sent.',
        ...(config.isProd ? {} : { devResetUrl: devUrl }),
      });
    } else {
      res.json({ ok: true, message: 'If an account exists for that email, a reset link has been sent.' });
    }
  }
);

router.post(
  '/reset/confirm',
  validateBody({
    token: { type: 'string', required: true, label: 'Reset token', min: 20, max: 512 },
    newPassword: { type: 'string', required: true, label: 'New password', max: 128 },
  }),
  async (req, res) => {
    const issue = passwordIssue(req.valid.newPassword);
    if (issue) throw errors.unprocessable(issue, { field: 'newPassword' });
    const tokenHash = require('crypto').createHash('sha256').update(req.valid.token).digest('hex');
    const row = await db.prepare(`SELECT * FROM password_resets WHERE id = ?`).get(tokenHash);
    if (!row || row.used_at || row.expires_at < now()) {
      throw errors.badRequest('This reset link is invalid or has expired. Please request a new one.');
    }
    await db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hashPassword(req.valid.newPassword), row.user_id);
    await db.prepare(`UPDATE password_resets SET used_at = ? WHERE id = ?`).run(now(), tokenHash);
    await revokeAllRefreshTokens(row.user_id);
    res.json({ ok: true, message: 'Your password has been reset. You can now log in.' });
  }
);

module.exports = router;
