'use strict';
/* API client: JSON fetch wrapper with automatic token refresh on 401. */

const TOKEN_KEY = 'pc.access';
const REFRESH_KEY = 'pc.refresh';

/* Safe storage: sandboxed previews (embedded iframes) can block localStorage,
   so fall back to in-memory storage rather than crashing the app. */
const memStore = {};
function sget(k) {
  try {
    return localStorage.getItem(k);
  } catch {
    return k in memStore ? memStore[k] : null;
  }
}
function sset(k, v) {
  try {
    localStorage.setItem(k, v);
  } catch {
    memStore[k] = v;
  }
}
function sdel(k) {
  try {
    localStorage.removeItem(k);
  } catch {
    delete memStore[k];
  }
}

/* API base: normally same-origin (''); the standalone single-file build sets
   window.PC_SERVER so the downloaded HTML can talk to a running server. */
const API_BASE =
  typeof window !== 'undefined' && window.PC_SERVER ? window.PC_SERVER.replace(/\/+$/, '') + '/api' : '/api';

/** Turn a server-relative path into an absolute one when running standalone. */
export function absPath(p) {
  if (typeof window === 'undefined' || !window.PC_SERVER || !p || !p.startsWith('/')) return p;
  return window.PC_SERVER.replace(/\/+$/, '') + p;
}

let accessToken = sget(TOKEN_KEY);
let refreshToken = sget(REFRESH_KEY);
let meCache = null;

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || 'Something went wrong.');
    this.status = status;
    this.code = code;
  }
}

export function getAccessToken() {
  return accessToken;
}

export function hasSession() {
  return !!(accessToken && refreshToken);
}

export function setSession(access, refresh) {
  accessToken = access;
  refreshToken = refresh;
  sset(TOKEN_KEY, access);
  sset(REFRESH_KEY, refresh);
}

export function clearSession() {
  accessToken = null;
  refreshToken = null;
  meCache = null;
  sdel(TOKEN_KEY);
  sdel(REFRESH_KEY);
}

async function tryRefresh() {
  if (!refreshToken) return false;
  const res = await fetch(API_BASE + '/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  if (!res.ok) return false;
  const data = await res.json();
  setSession(data.accessToken, data.refreshToken);
  return true;
}

export async function request(method, path, { body, form } = {}) {
  const doFetch = () => {
    const headers = {};
    if (accessToken) headers.Authorization = 'Bearer ' + accessToken;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const payload = body !== undefined ? JSON.stringify(body) : form;
    return fetch(API_BASE + path, { method, headers, body: payload });
  };

  let res = await doFetch();
  if (res.status === 401 && refreshToken) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      res = await doFetch();
    } else {
      // Refresh failed — session is gone; return to the login screen.
      clearSession();
      if (location.hash !== '#/login') location.hash = '#/login';
    }
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) {
    throw new ApiError(res.status, data?.error || 'error', data?.message || `Request failed (${res.status}).`);
  }
  return data;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, { body }),
  patch: (path, body) => request('PATCH', path, { body }),
  del: (path) => request('DELETE', path),
};

export async function fetchMe() {
  const data = await api.get('/auth/me');
  meCache = data.user;
  return data.user;
}

export function getMe() {
  return meCache;
}

export async function logoutRemote() {
  try {
    if (refreshToken) await request('POST', '/auth/logout', { body: { refreshToken } });
  } catch {
    /* network error during logout — still clear locally */
  } finally {
    clearSession();
  }
}
