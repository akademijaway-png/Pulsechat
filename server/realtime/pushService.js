'use strict';

/**
 * Web Push (VAPID) delivery service.
 * Push is only attempted when the recipient is fully offline — if they have a
 * live socket, the realtime channel already delivered the event.
 * Notification payloads never contain message content (privacy).
 */
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');
const config = require('../config');
const { db } = require('../db');
const { isOnline } = require('./registry');

const VAPID_FILE = path.join(config.dataDir, 'vapid.json');
const CONTACT = 'mailto:admin@pulsechat.local';

let publicKey = null;
let privateKey = null;

function ensureKeys() {
  if (publicKey) return;
  if (fs.existsSync(VAPID_FILE)) {
    const saved = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
    publicKey = saved.publicKey;
    privateKey = saved.privateKey;
  } else {
    const keys = webpush.generateVAPIDKeys();
    fs.writeFileSync(VAPID_FILE, JSON.stringify(keys, null, 2));
    publicKey = keys.publicKey;
    privateKey = keys.privateKey;
    console.log('[push] Generated new VAPID key pair (saved to data/vapid.json).');
  }
  webpush.setVapidDetails(CONTACT, publicKey, privateKey);
}

function getPublicKey() {
  ensureKeys();
  return publicKey;
}

/**
 * @param userId recipient
 * @param payload {title, body, tag, url} — body must never include message text
 * @returns number of push notifications actually sent
 */
async function sendToUser(userId, payload) {
  if (isOnline(userId)) return 0;
  ensureKeys();
  const subs = db
    .prepare(`SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?`)
    .all(userId);
  if (subs.length === 0) return 0;

  let sent = 0;
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload));
      sent++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        // Subscription expired / no longer valid — drop it.
        db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).run(sub.endpoint);
      } else {
        console.error('[push] delivery failed:', err.statusCode || '', err.message);
      }
    }
  }
  return sent;
}

module.exports = { getPublicKey, sendToUser };
