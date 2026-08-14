'use strict';

/**
 * PulseChat server configuration.
 * All values can be overridden with environment variables (see .env.example).
 */
const path = require('path');
const fs = require('fs');

const env = process.env.NODE_ENV || 'development';
const isProd = env === 'production';

// Load a .env file in the project root (KEY=VALUE lines) so configuration
// survives restarts without shell environment plumbing. Real env vars win.
const ROOT = path.join(__dirname, '..');
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) {
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      process.env[m[1]] = val;
    }
  }
}

const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');

// Make sure the data directories exist before anything touches them.
const AVATAR_DIR = path.join(DATA_DIR, 'uploads', 'avatars');
const MESSAGE_DIR = path.join(DATA_DIR, 'uploads', 'messages');
fs.mkdirSync(AVATAR_DIR, { recursive: true });
fs.mkdirSync(MESSAGE_DIR, { recursive: true });

const DEV_SECRET = 'pulsechat-dev-only-secret-change-in-production';

const config = {
  env,
  isProd,
  root: ROOT,
  dataDir: DATA_DIR,
  dbFile: process.env.DB_FILE || path.join(DATA_DIR, 'pulsechat.db'),
  avatarDir: AVATAR_DIR,
  messageDir: MESSAGE_DIR,

  port: parseInt(process.env.PORT || '3000', 10),

  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET || DEV_SECRET,
    refreshSecret: process.env.JWT_REFRESH_SECRET || DEV_SECRET,
    accessTtl: process.env.JWT_ACCESS_TTL || '15m',
    refreshTtlDays: parseInt(process.env.JWT_REFRESH_TTL_DAYS || '90', 10),
  },

  smtpUrl: process.env.SMTP_URL || null, // e.g. smtp://user:pass@host:587
  mailFrom: process.env.MAIL_FROM || 'PulseChat <no-reply@pulsechat.local>',
  appBaseUrl: process.env.APP_BASE_URL || '', // used for links inside emails

  google: {
    // Client ID of a "Web application" OAuth client from Google Cloud Console.
    // Sign-in with Google is only enabled when this is set.
    clientId: process.env.GOOGLE_CLIENT_ID || null,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || null,
  },

  // Nine built-in avatar choices users can pick instead of uploading a photo.
  builtinAvatars: [
  {
    "id": "av1",
    "url": "/assets/avatars/av1.svg",
    "name": "smile"
  },
  {
    "id": "av2",
    "url": "/assets/avatars/av2.svg",
    "name": "star"
  },
  {
    "id": "av3",
    "url": "/assets/avatars/av3.svg",
    "name": "heart"
  },
  {
    "id": "av4",
    "url": "/assets/avatars/av4.svg",
    "name": "sun"
  },
  {
    "id": "av5",
    "url": "/assets/avatars/av5.svg",
    "name": "moon"
  },
  {
    "id": "av6",
    "url": "/assets/avatars/av6.svg",
    "name": "flower"
  },
  {
    "id": "av7",
    "url": "/assets/avatars/av7.svg",
    "name": "rocket"
  },
  {
    "id": "av8",
    "url": "/assets/avatars/av8.svg",
    "name": "music"
  },
  {
    "id": "av9",
    "url": "/assets/avatars/av9.svg",
    "name": "bolt_heart"
  }
],

  // Dev/testing: when ALLOW_RESET=1 a "Start fresh" reset is available
  // (wipes all users/data). When RESET_DB_ON_START=1 the DB is wiped on boot
  // — handy while iterating. Both default OFF.
  allowReset: process.env.ALLOW_RESET === '1',
  resetDbOnStart: process.env.RESET_DB_ON_START === '1',

  // Demo accounts are disabled. (Re-enable deliberately via DEMO_ACCOUNTS if
  // you ever want an instant "try it" login on a staging deployment.)
  demoAccounts: (() => {
    if (process.env.DEMO_ACCOUNTS) {
      try {
        const parsed = JSON.parse(process.env.DEMO_ACCOUNTS);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    return [];
  })(),

  uploads: {
    avatarMaxBytes: 5 * 1024 * 1024,
    messageMaxBytes: 8 * 1024 * 1024,
  },

  messageMaxLength: 4000,
  bioMaxLength: 200,
  displayNameMaxLength: 60,
};

if (isProd && (config.jwt.accessSecret === DEV_SECRET || config.jwt.refreshSecret === DEV_SECRET)) {
  console.error('[config] WARNING: running in production with default JWT secrets. Set JWT_ACCESS_SECRET / JWT_REFRESH_SECRET.');
}

module.exports = config;
