'use strict';
/* Realtime transport (Socket.IO). Pure transport — events are wired in app.js. */

import { getAccessToken } from './api.js';

let socket = null;
const handlers = new Map(); // event -> Set<fn>

export function on(event, fn) {
  if (!handlers.has(event)) handlers.set(event, new Set());
  handlers.get(event).add(fn);
  return () => handlers.get(event)?.delete(fn);
}

function dispatch(event, payload) {
  const set = handlers.get(event);
  if (set) set.forEach((fn) => fn(payload));
}

export function connect() {
  if (socket && socket.connected) return socket;
  if (socket) socket.disconnect();

  const base = typeof window !== 'undefined' && window.PC_SERVER ? window.PC_SERVER.replace(/\/+$/, '') : undefined;
  socket = io(base, { auth: { token: getAccessToken() }, transports: ['websocket', 'polling'] });

  socket.on('connect', () => dispatch('socket:connect'));
  socket.on('disconnect', (reason) => dispatch('socket:disconnect', reason));
  socket.on('connect_error', (err) => dispatch('socket:error', err));

  for (const event of [
    'presence',
    'message:new',
    'message:delivered',
    'message:read',
    'typing',
    'contact:request',
    'contact:accepted',
    'contact:declined',
    'contact:removed',
    'call:incoming',
    'call:accepted',
    'call:declined',
    'call:cancelled',
    'call:timeout',
    'call:unavailable',
    'call:ended',
    'call:error',
    'signal',
  ]) {
    socket.on(event, (payload) => dispatch(event, payload));
  }
  return socket;
}

export function disconnect() {
  if (socket) socket.disconnect();
}

export function emit(event, payload) {
  if (socket && socket.connected) socket.emit(event, payload);
}

export function isConnected() {
  return !!(socket && socket.connected);
}

/** socket.io may re-auth with a fresh token after refresh. */
export function refreshAuth() {
  if (socket) socket.auth = { token: getAccessToken() };
}
