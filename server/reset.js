'use strict';

/**
 * Development/testing data reset.
 * Deletes every user, conversation, message, call, media reference and push
 * subscription so the app can be tested from a completely blank state.
 * Only active when ALLOW_RESET=1 (or RESET_DB_ON_START=1) is set — disabled
 * by default and in production unless deliberately enabled.
 */
const fs = require('fs');
const path = require('path');
const { db } = require('./db');
const config = require('./config');

function wipeAllData() {
  // FK order matters — children first.
  const tables = [
    'messages',
    'conversations',
    'contacts',
    'refresh_tokens',
    'password_resets',
    'push_subscriptions',
    'calls',
    'media',
    'users',
  ];
  const tx = db.transaction(() => {
    for (const t of tables) db.prepare(`DELETE FROM ${t}`).run();
    // Reset auto-increment counters so ids start clean at 1.
    try {
      db.prepare(`DELETE FROM sqlite_sequence`).run();
    } catch {
      /* sqlite_sequence may not exist in some setups */
    }
  });
  tx();

  // Remove uploaded files (avatars + message media).
  for (const dir of [config.avatarDir, config.messageDir]) {
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        try {
          fs.unlinkSync(path.join(dir, f));
        } catch {
          /* ignore */
        }
      }
    }
  }
}

module.exports = { wipeAllData };
