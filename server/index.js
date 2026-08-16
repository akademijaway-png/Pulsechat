'use strict';

/**
 * PulseChat server — Express + Socket.IO.
 *  - REST API under /api (auth, users, contacts, messages, media, calls, push)
 *  - Real-time channel: presence, message delivery/read receipts, WebRTC signaling
 *  - Static frontend from /public
 */
const http = require('http');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');

const config = require('./config');
const { db, now } = require('./db');
const { userSummary, otherParty } = require('./helpers');
const { errors, notFoundHandler, errorHandler } = require('./middleware/validate');
const registry = require('./realtime/registry');
const { markDeliveredFor } = require('./realtime/delivery');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const contactRoutes = require('./routes/contacts');
const messageRoutes = require('./routes/messages');
const mediaRoutes = require('./routes/media');
const callRoutes = require('./routes/calls');
const pushRoutes = require('./routes/push');
const feedRoutes = require('./routes/feed');
const devRoutes = require('./routes/dev');
const { wipeAllData } = require('./reset');

// Optional: start every boot from a blank database (testing only).
if (config.resetDbOnStart) {
  wipeAllData();
  console.log('[dev] RESET_DB_ON_START — all data wiped at boot.');
}

const app = express();
app.disable('x-powered-by');

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        scriptSrc: ["'self'", 'https://accounts.google.com'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://accounts.google.com', 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'blob:', 'https://ssl.gstatic.com', 'https://fonts.gstatic.com'],
        mediaSrc: ["'self'", 'blob:'],
        connectSrc: ["'self'", 'ws:', 'wss:', 'https://accounts.google.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        objectSrc: ["'none'"],
        formAction: ["'self'"],
        frameSrc: ["'self'", 'https://accounts.google.com'],
      },
    },
    // Allow the app to be embedded (live preview / kiosk). CSP deliberately
    // does not restrict frame-ancestors; that must be tightened in production
    // if embedding is unwanted.
    crossOriginEmbedderPolicy: false,
    frameguard: false,
  })
);

app.use(express.json({ limit: '1mb' }));

/* CORS — lets the standalone single-file client (PulseChat.html, which can be
   downloaded and opened from anywhere) talk to this API. Auth uses bearer
   tokens in headers (no cookies), so a wildcard origin is safe. */
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* ---------------- rate limiting ---------------- */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: config.isProd ? 30 : 120, // friendlier in dev so repeated tries don't lock anyone out
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited', message: 'Too many attempts. Please wait a few minutes and try again.' },
});
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited', message: 'Too many requests. Please slow down.' },
});

/* ---------------- routes ---------------- */
app.get('/api/health', (req, res) => res.json({ ok: true, name: 'pulsechat', time: now() }));
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/users', apiLimiter, userRoutes);
app.use('/api/push', apiLimiter, pushRoutes);
app.use('/api/dev', apiLimiter, devRoutes);
app.use('/api', apiLimiter, contactRoutes, messageRoutes, mediaRoutes, callRoutes, feedRoutes);

/* ---------------- static frontend ---------------- */
// The standalone single-file build contains inline scripts, so it needs a
// relaxed CSP of its own (the app's strict CSP stays for everything else).
app.get('/PulseChat.html', (req, res) => {
  res.set(
    'Content-Security-Policy',
    "default-src 'self' data: blob: 'unsafe-inline' http: https: ws: wss:; connect-src *; img-src * data: blob:; media-src * blob:; style-src 'self' 'unsafe-inline' https:; frame-ancestors *"
  );
  res.sendFile(path.join(config.root, 'public', 'PulseChat.html'));
});

// In development, serve frontend assets without caching so updates reach the
// browser immediately (no stale-app login bugs). Cache in production.
app.use(
  express.static(path.join(config.root, 'public'), {
    index: 'index.html',
    maxAge: config.isProd ? '1h' : 0,
    etag: !config.isProd,
  })
);
// Profile pictures are public by design (users choose to share them).
app.use('/uploads/avatars', express.static(config.avatarDir, { maxAge: '7d' }));

// SPA fallback (Express 5: catch-all via middleware, not the `*` route pattern).
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io/') || req.path.startsWith('/uploads/')) {
    return next();
  }
  res.sendFile(path.join(config.root, 'public', 'index.html'));
});

app.use(notFoundHandler);
app.use(errorHandler);

/* ---------------- HTTP + Socket.IO ---------------- */
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e6,
  pingTimeout: 20000,
  pingInterval: 15000,
  cors: { origin: '*' },
});

registry.setIO(io);

/* Socket auth: every connection must present a valid access token. */
io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  if (!token) return next(new Error('auth_required'));
  try {
    const payload = jwt.verify(token, config.jwt.accessSecret, { issuer: 'pulsechat' });
    if (payload.typ !== 'access') throw new Error('wrong token type');
    socket.data.userId = Number(payload.sub);
    return next();
  } catch {
    return next(new Error('invalid_token'));
  }
});

/* ---------------- call state ---------------- */
const RING_TIMEOUT_MS = 45 * 1000;
const callTimers = new Map(); // callId -> timeout handle

function clearCallTimer(callId) {
  const t = callTimers.get(callId);
  if (t) {
    clearTimeout(t);
    callTimers.delete(callId);
  }
}

function getCall(callId) {
  return db.prepare(`SELECT * FROM calls WHERE id = ?`).get(callId);
}

/** Resolve a call by numeric db id, or by the caller's client-generated id. */
function findCallRow(data) {
  const num = Number(data && data.callId);
  if (Number.isInteger(num) && num > 0) return getCall(num);
  const cid = data && typeof data.clientId === 'string' ? data.clientId : null;
  if (cid && cid.length <= 64) return db.prepare(`SELECT * FROM calls WHERE client_id = ?`).get(cid);
  return null;
}

function isCallParticipant(call, userId) {
  return call && (call.caller_id === userId || call.callee_id === userId);
}

/** clientId → include in socket payloads so callers can correlate events. */
function callClientId(call) {
  return call.client_id || undefined;
}

/* ---------------- socket handlers ---------------- */
function registerCallHandlers(socket) {
  const userId = socket.data.userId;

  socket.on('call:invite', (data) => {
    const to = Number(data && data.to);
    const clientId = data && typeof data.clientId === 'string' ? data.clientId : null;
    if (!Number.isInteger(to) || to <= 0 || to === userId) {
      return socket.emit('call:error', { message: 'Invalid call request.' });
    }
    if (clientId && clientId.length > 64) {
      return socket.emit('call:error', { message: 'Invalid call request.' });
    }
    const target = db.prepare(`SELECT * FROM users WHERE id = ?`).get(to);
    if (!target) return socket.emit('call:error', { message: 'This user does not exist.' });
    if (!registry.isOnline(to)) {
      const missed = db
        .prepare(`INSERT INTO calls (caller_id, callee_id, kind, status, initiated_at, ended_at, client_id) VALUES (?, ?, 'video', 'missed', ?, ?, ?)`)
        .run(userId, to, now(), now(), clientId);
      return socket.emit('call:unavailable', { callId: missed.lastInsertRowid, clientId, calleeId: to });
    }
    // Only contacts can call each other.
    const relation = db
      .prepare(`SELECT 1 FROM contacts WHERE ((user_id = ? AND contact_id = ?) OR (user_id = ? AND contact_id = ?)) AND status = 'accepted'`)
      .get(userId, to, to, userId);
    if (!relation) {
      return socket.emit('call:error', { message: 'You can only call your contacts.' });
    }
    const info = db
      .prepare(`INSERT INTO calls (caller_id, callee_id, kind, status, initiated_at, client_id) VALUES (?, ?, 'video', 'ringing', ?, ?)`)
      .run(userId, to, now(), clientId);
    const callIdDb = info.lastInsertRowid;

    registry.emitToUser(to, 'call:incoming', {
      callId: callIdDb,
      clientId,
      caller: userSummary(db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId), to),
    });
    pushNotifyCall(to, `${target.display_name}`);

    callTimers.set(callIdDb, setTimeout(() => {
      const call = getCall(callIdDb);
      if (call && call.status === 'ringing') {
        db.prepare(`UPDATE calls SET status = 'missed', ended_at = ? WHERE id = ?`).run(now(), callIdDb);
        registry.emitToUser(userId, 'call:timeout', { callId: callIdDb, clientId: callClientId(call) });
        registry.emitToUser(to, 'call:timeout', { callId: callIdDb, clientId: callClientId(call) });
      }
      callTimers.delete(callIdDb);
    }, RING_TIMEOUT_MS));
  });

  socket.on('call:accept', (data) => {
    const call = findCallRow(data);
    if (!call || !isCallParticipant(call, userId)) return;
    if (call.callee_id !== userId || call.status !== 'ringing') return;
    clearCallTimer(call.id);
    db.prepare(`UPDATE calls SET status = 'active', answered_at = ? WHERE id = ?`).run(now(), call.id);
    registry.emitToUser(call.caller_id, 'call:accepted', { callId: call.id, clientId: callClientId(call) });
  });

  socket.on('call:decline', (data) => {
    const call = findCallRow(data);
    if (!call || !isCallParticipant(call, userId)) return;
    if (call.callee_id !== userId || call.status !== 'ringing') return;
    clearCallTimer(call.id);
    db.prepare(`UPDATE calls SET status = 'declined', ended_at = ? WHERE id = ?`).run(now(), call.id);
    registry.emitToUser(call.caller_id, 'call:declined', { callId: call.id, clientId: callClientId(call) });
  });

  socket.on('call:cancel', (data) => {
    const call = findCallRow(data);
    if (!call || !isCallParticipant(call, userId)) return;
    if (call.caller_id !== userId || call.status !== 'ringing') return;
    clearCallTimer(call.id);
    db.prepare(`UPDATE calls SET status = 'cancelled', ended_at = ? WHERE id = ?`).run(now(), call.id);
    registry.emitToUser(call.callee_id, 'call:cancelled', { callId: call.id, clientId: callClientId(call) });
  });

  socket.on('call:end', (data) => {
    const call = findCallRow(data);
    if (!call || !isCallParticipant(call, userId)) return;
    clearCallTimer(call.id);
    if (call.status === 'active') {
      db.prepare(`UPDATE calls SET status = 'completed', ended_at = ? WHERE id = ?`).run(now(), call.id);
    } else if (!call.ended_at) {
      db.prepare(`UPDATE calls SET ended_at = ? WHERE id = ?`).run(now(), call.id);
    }
    const other = call.caller_id === userId ? call.callee_id : call.caller_id;
    registry.emitToUser(other, 'call:ended', { callId: call.id, clientId: callClientId(call), by: userId });
  });

  /* WebRTC signaling relay (offer / answer / ICE) */
  socket.on('signal', (data) => {
    const call = findCallRow(data);
    if (!call || !isCallParticipant(call, userId)) return;
    const to = Number(data && data.to);
    if (to !== call.caller_id && to !== call.callee_id) return;
    if (to === userId) return;
    registry.emitToUser(to, 'signal', { callId: call.id, clientId: callClientId(call), from: userId, data: data.data || null });
  });

  socket.on('typing', (data) => {
    const to = Number(data && data.to);
    const conversationId = Number(data && data.conversationId);
    if (!Number.isInteger(to) || to === userId || !Number.isInteger(conversationId)) return;
    const conv = db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(conversationId);
    if (!conv) return;
    if (!(conv.user_a === userId && conv.user_b === to) && !(conv.user_a === to && conv.user_b === userId)) return;
    registry.emitToUser(to, 'typing', { conversationId, userId, at: now() });
  });
}

function pushNotifyCall(calleeId, callerName) {
  const push = require('./realtime/pushService');
  push.sendToUser(calleeId, {
    title: 'Incoming video call',
    body: `${callerName} is calling you…`,
    tag: 'incoming-call',
    url: '/calls',
  });
}

io.on('connection', (socket) => {
  const userId = socket.data.userId;
  const wasOnline = registry.onlineSocketCount(userId) > 0;

  registry.attach(socket, userId);

  // Deliver anything that arrived while the user was offline.
  markDeliveredFor(userId);

  if (!wasOnline) {
    db.prepare(`UPDATE users SET last_seen = NULL WHERE id = ?`).run(userId);
    io.emit('presence', { userId, online: true, lastSeen: null });
  }

  socket.on('disconnect', () => {
    const uid = registry.detach(socket);
    if (uid === null) return;
    const stillOnline = registry.onlineSocketCount(uid) > 0;
    if (!stillOnline) {
      const lastSeen = now();
      db.prepare(`UPDATE users SET last_seen = ? WHERE id = ?`).run(lastSeen, uid);
      io.emit('presence', { userId: uid, online: false, lastSeen });
    }
  });

  registerCallHandlers(socket);
});

/* ---------------- boot ---------------- */
server.listen(config.port, '0.0.0.0', () => {
  console.log(`\n  ⚡ PulseChat server running`);
  console.log(`  ➜ http://localhost:${config.port}  (env: ${config.env})\n`);
});
