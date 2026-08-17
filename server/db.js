'use strict';

/**
 * Data layer — supports BOTH:
 *  - PostgreSQL (production / Render): when DATABASE_URL is set. Permanent —
 *    accounts and messages survive every restart and redeploy.
 *  - SQLite (local dev): when no DATABASE_URL. Easy to run anywhere.
 *
 * API kept close to better-sqlite3 so call sites change minimally:
 *   await db.prepare(sql).get(...args)      → one row (or undefined)
 *   await db.prepare(sql).all(...args)      → array of rows
 *   await db.prepare(sql).run(...args)      → { changes, lastInsertRowid, id }
 *   await db.exec(sql)                      → run raw SQL
 * Named params (@x) are not supported — use positional (?) everywhere.
 */
const config = require('./config');

const isPg = !!process.env.DATABASE_URL;
let sqlite = null;
let pool = null;

const now = () => Date.now();

/* ---------------- param / SQL translation ---------------- */

/** Convert sqlite positional ? placeholders into Postgres $1, $2, … */
function toPgPlaceholders(sql) {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

/* ---------------- schema ---------------- */

const SCHEMA_SQLITE = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  bio           TEXT NOT NULL DEFAULT '',
  avatar        TEXT,
  created_at    INTEGER NOT NULL,
  last_seen     INTEGER
);
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device     TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  replaced_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id);
CREATE TABLE IF NOT EXISTS password_resets (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_resets_user ON password_resets(user_id);
CREATE TABLE IF NOT EXISTS contacts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       TEXT NOT NULL CHECK (status IN ('requested','accepted')),
  created_at   INTEGER NOT NULL,
  responded_at INTEGER,
  UNIQUE (user_id, contact_id)
);
CREATE INDEX IF NOT EXISTS idx_contacts_owner ON contacts(user_id, status);
CREATE INDEX IF NOT EXISTS idx_contacts_target ON contacts(contact_id, status);
CREATE TABLE IF NOT EXISTS conversations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_a          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_message_id INTEGER,
  created_at      INTEGER NOT NULL,
  UNIQUE (user_a, user_b)
);
CREATE INDEX IF NOT EXISTS idx_conv_a ON conversations(user_a);
CREATE INDEX IF NOT EXISTS idx_conv_b ON conversations(user_b);
CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','image')),
  body            TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  delivered_at    INTEGER,
  read_at         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);
CREATE TABLE IF NOT EXISTS media (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  filename        TEXT NOT NULL UNIQUE,
  kind            TEXT NOT NULL CHECK (kind IN ('avatar','message','post')),
  owner_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  created_at      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
CREATE TABLE IF NOT EXISTS calls (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  caller_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  callee_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL DEFAULT 'video',
  status       TEXT NOT NULL,
  initiated_at INTEGER NOT NULL,
  answered_at  INTEGER,
  ended_at     INTEGER,
  client_id    TEXT
);
CREATE INDEX IF NOT EXISTS idx_calls_caller ON calls(caller_id, id);
CREATE INDEX IF NOT EXISTS idx_calls_callee ON calls(callee_id, id);
CREATE TABLE IF NOT EXISTS posts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  author_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  image      TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);
CREATE TABLE IF NOT EXISTS post_likes (
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, user_id)
);
CREATE TABLE IF NOT EXISTS post_comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_post ON post_comments(post_id, id);
`;

const SCHEMA_PG = `
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  bio           TEXT NOT NULL DEFAULT '',
  avatar        TEXT,
  created_at    BIGINT NOT NULL,
  last_seen     BIGINT
);
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device     TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  replaced_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id);
CREATE TABLE IF NOT EXISTS password_resets (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  used_at    BIGINT
);
CREATE INDEX IF NOT EXISTS idx_resets_user ON password_resets(user_id);
CREATE TABLE IF NOT EXISTS contacts (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       TEXT NOT NULL CHECK (status IN ('requested','accepted')),
  created_at   BIGINT NOT NULL,
  responded_at BIGINT,
  UNIQUE (user_id, contact_id)
);
CREATE INDEX IF NOT EXISTS idx_contacts_owner ON contacts(user_id, status);
CREATE INDEX IF NOT EXISTS idx_contacts_target ON contacts(contact_id, status);
CREATE TABLE IF NOT EXISTS conversations (
  id              SERIAL PRIMARY KEY,
  user_a          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_message_id INTEGER,
  created_at      BIGINT NOT NULL,
  UNIQUE (user_a, user_b)
);
CREATE INDEX IF NOT EXISTS idx_conv_a ON conversations(user_a);
CREATE INDEX IF NOT EXISTS idx_conv_b ON conversations(user_b);
CREATE TABLE IF NOT EXISTS messages (
  id              SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','image')),
  body            TEXT NOT NULL,
  created_at      BIGINT NOT NULL,
  delivered_at    BIGINT,
  read_at         BIGINT
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);
CREATE TABLE IF NOT EXISTS media (
  id              SERIAL PRIMARY KEY,
  filename        TEXT NOT NULL UNIQUE,
  kind            TEXT NOT NULL CHECK (kind IN ('avatar','message','post')),
  owner_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  created_at      BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
CREATE TABLE IF NOT EXISTS calls (
  id           SERIAL PRIMARY KEY,
  caller_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  callee_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL DEFAULT 'video',
  status       TEXT NOT NULL,
  initiated_at BIGINT NOT NULL,
  answered_at  BIGINT,
  ended_at     BIGINT,
  client_id    TEXT
);
CREATE INDEX IF NOT EXISTS idx_calls_caller ON calls(caller_id, id);
CREATE INDEX IF NOT EXISTS idx_calls_callee ON calls(callee_id, id);
CREATE TABLE IF NOT EXISTS posts (
  id         SERIAL PRIMARY KEY,
  author_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  image      TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);
CREATE TABLE IF NOT EXISTS post_likes (
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (post_id, user_id)
);
CREATE TABLE IF NOT EXISTS post_comments (
  id         SERIAL PRIMARY KEY,
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_post ON post_comments(post_id, id);
`;

async function init() {
  if (isPg) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10, idleTimeoutMillis: 30000 });
    await pool.query(SCHEMA_PG);
    console.log('[db] connected to PostgreSQL (permanent storage)');
  } else {
    const Database = require('better-sqlite3');
    sqlite = new Database(config.dbFile);
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');
    sqlite.pragma('busy_timeout = 5000');
    sqlite.exec(SCHEMA_SQLITE);
    console.log(`[db] using SQLite at ${config.dbFile}`);
  }
}

/* ---------------- query helpers ---------------- */

async function query(sql, params) {
  if (isPg) {
    const res = await pool.query(toPgPlaceholders(sql), params || []);
    return res.rows.map(normalizePgRow);
  }
  return sqlite.prepare(sql).all(params || []);
}

async function queryRow(sql, params) {
  if (isPg) {
    const res = await pool.query(toPgPlaceholders(sql), params || []);
    return normalizePgRow(res.rows[0]);
  }
  return sqlite.prepare(sql).get(params || []);
}

async function execute(sql, params) {
  if (isPg) {
    const pgSql = /^\s*insert/i.test(sql) && !/returning/i.test(sql) ? sql + ' RETURNING id' : sql;
    const res = await pool.query(toPgPlaceholders(pgSql), params || []);
    const id = res.rows && res.rows[0] ? res.rows[0].id : null;
    return { changes: res.rowCount || 0, lastInsertRowid: id, id };
  }
  const info = sqlite.prepare(sql).run(params || []);
  return { changes: info.changes, lastInsertRowid: info.lastInsertRowid, id: info.lastInsertRowid };
}

async function exec(sql) {
  if (isPg) {
    await pool.query(sql);
    return { changes: 0 };
  }
  sqlite.exec(sql);
  return { changes: 0 };
}

/** Postgres returns COUNT/SUM (bigint) as strings — normalize them to numbers. */
function normalizePgRow(row) {
  if (!row) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = typeof v === 'string' && /^-?\d+$/.test(v) && k === 'n' ? Number(v) : v;
  }
  return out;
}

/** Reset sequence counters (used by the dev wipe). */
async function resetSequences() {
  if (isPg) {
    for (const t of ['users', 'contacts', 'conversations', 'messages', 'media', 'calls', 'posts', 'post_comments']) {
      try {
        await pool.query(`ALTER SEQUENCE ${t}_id_seq RESTART WITH 1`);
      } catch {
        /* sequence may not exist yet */
      }
    }
  } else {
    try {
      sqlite.exec(`DELETE FROM sqlite_sequence`);
    } catch {
      /* ignore */
    }
  }
}

const db = {
  prepare(sql) {
    return {
      get: (...args) => queryRow(sql, normalizeParams(args)),
      all: (...args) => query(sql, normalizeParams(args)),
      run: (...args) => execute(sql, normalizeParams(args)),
    };
  },
  exec,
  resetSequences,
  isPg,
};

/** Accept variadic args, a single array, or a single params object. */
function normalizeParams(args) {
  if (args.length === 0) return [];
  if (args.length === 1) {
    const a = args[0];
    if (Array.isArray(a)) return a;
    if (a !== null && typeof a === 'object') return Object.values(a);
    return [a];
  }
  return args;
}

async function close() {
  if (pool) await pool.end();
  if (sqlite) sqlite.close();
}

module.exports = { db, now, init, close, isPg };
