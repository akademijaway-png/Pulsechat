'use strict';
/* DOM helpers, formatting, toasts. */

import { absPath } from './api.js';

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  const kids = Array.isArray(children) ? children : [children];
  for (const c of kids) {
    if (c === null || c === undefined) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/);
  return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
}

export function avatarHtml(user, size = 'sm') {
  const cls = `avatar avatar-${size}`;
  if (user && user.avatar) {
    return `<span class="${cls}"><img src="${esc(absPath(user.avatar))}" alt="" loading="lazy"></span>`;
  }
  return `<span class="${cls}">${esc(initials(user ? user.displayName : '?'))}</span>`;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

export function clock(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return clock(ts);
  const yesterday = new Date(now.getTime() - 864e5);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function dayLabel(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  const yesterday = new Date(now.getTime() - 864e5);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

export function formatLastSeen(lastSeen, online) {
  if (online) return 'Online';
  if (!lastSeen) return 'Offline';
  const diff = Date.now() - lastSeen;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Last seen just now';
  if (mins < 60) return `Last seen ${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `Last seen ${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Last seen yesterday';
  if (days < 7) return `Last seen ${days} days ago`;
  return `Last seen ${formatTime(lastSeen)}`;
}

export function callDurationLabel(ms) {
  if (ms == null) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return `${m}m ${rest}s`;
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/* ---------------- toasts ---------------- */
export function toast(message, type = 'info', timeout = 3200) {
  const root = document.getElementById('toasts');
  if (!root) return;
  const icons = { info: 'info', success: 'check', error: 'retry' };
  const node = el('div', { class: `toast ${type}` }, [
    el('span', { class: 't-icon', html: iconSvg(icons[type] || 'info') }),
    el('span', { text: message }),
  ]);
  root.append(node);
  setTimeout(() => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 320);
  }, timeout);
}

import { icon as iconSvg } from './icons.js';

/* ---------------- misc ---------------- */
export function safeGet(key, fallback = null) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v;
  } catch {
    return fallback;
  }
}
export function safeSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable (sandboxed preview) — ignore */
  }
}

export function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  safeSet('pc.theme', theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === 'dark' ? '#0b0e1a' : '#f3f5fb';
}

export function getTheme() {
  return safeGet('pc.theme', 'dark');
}

/* WebAudio notification blip (no asset files needed). */
let audioCtx = null;
export function playBlip() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime;
    [660, 880].forEach((freq, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t + i * 0.12);
      gain.gain.linearRampToValueAtTime(0.08, t + i * 0.12 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.12 + 0.22);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t + i * 0.12);
      osc.stop(t + i * 0.12 + 0.25);
    });
  } catch {
    /* audio unavailable */
  }
}

export function playRing() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime;
    for (let i = 0; i < 4; i++) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 620;
      gain.gain.setValueAtTime(0, t + i * 0.4);
      gain.gain.linearRampToValueAtTime(0.1, t + i * 0.4 + 0.03);
      gain.gain.linearRampToValueAtTime(0.05, t + i * 0.4 + 0.35);
      gain.gain.setValueAtTime(0, t + i * 0.4 + 0.38);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t + i * 0.4);
      osc.stop(t + i * 0.4 + 0.4);
    }
  } catch {
    /* audio unavailable */
  }
}
