'use strict';

/**
 * Presence registry + real-time event emitter.
 * Tracks which sockets belong to which user and broadcasts to them.
 * A user is considered ONLINE while at least one socket is attached.
 */
const { db, now } = require('../db');

let io = null;
const socketUser = new Map(); // socketId -> userId
const userSockets = new Map(); // userId -> Set<socketId>

function setIO(instance) {
  io = instance;
}

function attach(socket, userId) {
  socketUser.set(socket.id, userId);
  if (!userSockets.has(userId)) userSockets.set(userId, new Set());
  userSockets.get(userId).add(socket.id);
}

/** Returns the detached userId (or null if the socket wasn't tracked). */
function detach(socket) {
  const userId = socketUser.get(socket.id);
  if (userId === undefined) return null;
  socketUser.delete(socket.id);
  const set = userSockets.get(userId);
  if (set) {
    set.delete(socket.id);
    if (set.size === 0) userSockets.delete(userId);
  }
  return userId;
}

function isOnline(userId) {
  const set = userSockets.get(userId);
  return !!set && set.size > 0;
}

function onlineSocketCount(userId) {
  const set = userSockets.get(userId);
  return set ? set.size : 0;
}

function socketsOf(userId) {
  const set = userSockets.get(userId);
  return set ? Array.from(set) : [];
}

/** Emit to every socket of a user. Returns the number of sockets reached (0 = offline). */
function emitToUser(userId, event, payload) {
  if (!io) return 0;
  const ids = socketsOf(userId);
  if (ids.length === 0) return 0;
  for (const sid of ids) io.to(sid).emit(event, payload);
  return ids.length;
}

/** Emit to every socket of a user except one socket id (used to avoid echoes). */
function emitToUserExcept(userId, exceptSocketId, event, payload) {
  if (!io) return 0;
  let n = 0;
  for (const sid of socketsOf(userId)) {
    if (sid === exceptSocketId) continue;
    io.to(sid).emit(event, payload);
    n++;
  }
  return n;
}

/** Emit to every connected socket. */
function emitToAll(event, payload) {
  if (!io) return 0;
  io.emit(event, payload);
  return 1;
}

function userExists(userId) {
  return !!db.prepare(`SELECT id FROM users WHERE id = ?`).get(userId);
}

module.exports = {
  setIO,
  attach,
  detach,
  isOnline,
  onlineSocketCount,
  socketsOf,
  emitToUser,
  emitToUserExcept,
  emitToAll,
  userExists,
  now,
};
