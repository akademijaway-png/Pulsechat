'use strict';
/**
 * Seed demo accounts (real registered users) so the app is instantly
 * testable: alice@pulsechat.test and bob@pulsechat.test (password secret123).
 * They are made contacts and get a short conversation.
 *
 * Usage: npm run seed:demo
 */
const config = require('../server/config');
const { db, now } = require('../server/db');
const { hashPassword } = require('../server/auth');

const DEMO = [
  { email: 'alice@pulsechat.test', password: 'secret123', displayName: 'Alice', bio: 'Hi! I am Alice 👋' },
  { email: 'bob@pulsechat.test', password: 'secret123', displayName: 'Bob', bio: 'Hey there — Bob here.' },
];

function upsertUser(u) {
  const existing = db.prepare(`SELECT * FROM users WHERE email = ? COLLATE NOCASE`).get(u.email);
  if (existing) {
    console.log(`  · ${u.email} already exists (id ${existing.id})`);
    return existing.id;
  }
  const info = db
    .prepare(`INSERT INTO users (email, password_hash, display_name, bio, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(u.email, hashPassword(u.password), u.displayName, u.bio, now());
  console.log(`  ✓ created ${u.displayName} <${u.email}>`);
  return Number(info.lastInsertRowid);
}

function ensureContact(a, b) {
  const row = db
    .prepare(`SELECT id FROM contacts WHERE (user_id = ? AND contact_id = ?) OR (user_id = ? AND contact_id = ?)`)
    .get(a, b, b, a);
  if (row) return;
  db.prepare(`INSERT INTO contacts (user_id, contact_id, status, created_at, responded_at) VALUES (?, ?, 'accepted', ?, ?)`).run(a, b, now(), now());
  console.log(`  ✓ connected ${a} ↔ ${b}`);
}

function ensureConversationAndMessages(a, b) {
  const low = Math.min(a, b);
  const high = Math.max(a, b);
  let conv = db.prepare(`SELECT * FROM conversations WHERE user_a = ? AND user_b = ?`).get(low, high);
  if (!conv) {
    const info = db.prepare(`INSERT INTO conversations (user_a, user_b, created_at) VALUES (?, ?, ?)`).run(low, high, now());
    conv = db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(info.lastInsertRowid);
  }
  const count = db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?`).get(conv.id).n;
  if (count > 0) return;

  const t = now();
  const lines = [
    { sender: a, body: 'Hey Bob! 👋 Welcome to PulseChat.' },
    { sender: b, body: 'Hey Alice! This is a real-time conversation 🚀' },
    { sender: a, body: 'Try sending me a photo, a video call, anything — it all works between real accounts.' },
  ];
  const insert = db.prepare(`INSERT INTO messages (conversation_id, sender_id, kind, body, created_at, delivered_at, read_at) VALUES (?, ?, 'text', ?, ?, ?, ?)`);
  let lastId = null;
  lines.forEach((l, i) => {
    const info = insert.run(conv.id, l.sender, l.body, t + (i + 1) * 1000, t + (i + 1) * 1000, t + (i + 1) * 1000);
    lastId = Number(info.lastInsertRowid);
  });
  if (lastId) db.prepare(`UPDATE conversations SET last_message_id = ? WHERE id = ?`).run(lastId, conv.id);
  console.log('  ✓ conversation with a few welcome messages');
}

console.log('\nSeeding PulseChat demo accounts…\n');
const ids = DEMO.map(upsertUser);
ensureContact(ids[0], ids[1]);
ensureConversationAndMessages(ids[0], ids[1]);
console.log(`\nDone. Log in with:\n  · ${DEMO[0].email}  (password: ${DEMO[0].password})\n  · ${DEMO[1].email}  (password: ${DEMO[1].password})\n`);
