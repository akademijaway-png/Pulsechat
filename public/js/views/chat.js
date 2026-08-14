'use strict';
/* Chat view: header, message list, composer, image messages, receipts. */

import state from '../state.js';
import { api } from '../api.js';
import { emit } from '../socket.js';
import { el, esc, avatarHtml, clock, dayLabel, formatLastSeen, toast } from '../ui.js';
import { icon } from '../icons.js';
import { pickImage, uploadImage, mediaUrl, openViewer } from '../media.js';

let conv = null; // { id, user }
let loadingMore = false;
let hasMore = false;
let tempCounter = 0;
let hideTypingTimer = null;
let jumpVisible = false;

const dom = { col: null, chat: null, messages: null, input: null };
const nodesByConv = new Map(); // convId -> Map(messageId -> row element)

function cache() {
  if (!state.messagesCache[conv.id]) state.messagesCache[conv.id] = [];
  return state.messagesCache[conv.id];
}
function nodes() {
  if (!nodesByConv.has(conv.id)) nodesByConv.set(conv.id, new Map());
  return nodesByConv.get(conv.id);
}

/* ---------------- open / close ---------------- */

export async function openChat(conversationId) {
  if (conv && conv.id === conversationId) {
    dom.col.classList.add('open');
    markRead();
    return;
  }
  let data = state.conversations.find((c) => c.id === conversationId);
  if (!data) {
    try {
      const res = await api.get(`/conversations/${conversationId}`);
      data = res.conversation;
      state.upsertConversation(data);
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
  }
  conv = { id: data.id, user: data.user };
  state.activeConvId = data.id;
  build();
  await loadInitial();
  markRead();
}

export function closeChat() {
  if (conv) nodesByConv.delete(conv.id);
  conv = null;
  state.activeConvId = null;
  const col = document.getElementById('colChat');
  if (col) col.classList.remove('open');
}

export function isOpen(conversationId) {
  return conv && conv.id === conversationId;
}

/* ---------------- build UI ---------------- */

function build() {
  const user = conv.user;
  dom.col = document.getElementById('colChat');
  dom.chat = el('div', { class: 'chat' });

  const header = el('header', { class: 'chat-header' }, [
    el('button', { class: 'icon-btn chat-back', html: icon('back'), onclick: closeChat }),
    el('span', { class: 'avatar-wrap', html: avatarHtml(user, 'sm') }),
    el('div', { class: 'info' }, [
      el('div', { class: 'name', text: user.displayName }),
      el('div', { class: 'status', id: 'chat-status' }),
    ]),
    el('button', {
      class: 'icon-btn',
      html: icon('video'),
      title: 'Start video call',
      onclick: () => import('../rtc.js').then((m) => m.startCall(user)),
    }),
  ]);
  updateHeaderStatus();

  dom.messages = el('div', { class: 'messages', onscroll: onScroll });

  const composer = el('div', { class: 'composer' }, [
    el('button', { class: 'icon-btn', html: icon('image'), title: 'Send photo from gallery', onclick: () => sendImage(false) }),
    el('button', { class: 'icon-btn', html: icon('camera'), title: 'Take a photo', onclick: () => sendImage(true) }),
    el('textarea', {
      id: 'composer-input',
      rows: 1,
      placeholder: `Message ${user.displayName}…`,
      oninput: () => {
        autosize();
        emitTyping();
      },
      onkeydown: (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendText();
        }
      },
    }),
    el('button', { class: 'icon-btn send', id: 'composer-send', html: icon('send'), title: 'Send', onclick: sendText }),
  ]);
  dom.input = composer.querySelector('#composer-input');

  dom.chat.append(header, dom.messages, composer);
  dom.col.replaceChildren(dom.chat);
  dom.col.classList.add('open');
  setTimeout(() => dom.input && dom.input.focus(), 120);
}

export function updateHeaderStatus() {
  if (!conv) return;
  const elStatus = document.getElementById('chat-status');
  if (!elStatus) return;
  const p = state.presence[conv.user.id];
  const online = p ? p.online : conv.user.online;
  elStatus.textContent = online ? 'Online' : formatLastSeen(conv.user.lastSeen, false);
  elStatus.className = 'status' + (online ? ' online' : '');
}

/* ---------------- history ---------------- */

async function loadInitial() {
  dom.messages.replaceChildren();
  const msgs = cache();
  if (msgs.length) {
    renderBatch(msgs);
    scrollToBottom(true);
  } else {
    await fetchEarlier();
    scrollToBottom(true);
  }
}

async function fetchEarlier() {
  if (loadingMore || !conv) return;
  loadingMore = true;
  const before = cache().length ? cache()[0].id : 0;
  try {
    const res = await api.get(`/conversations/${conv.id}/messages?limit=50${before ? `&before=${before}` : ''}`);
    hasMore = res.hasMore;
    if (!res.messages.length) {
      dom.messages.prepend(el('div', { class: 'day-divider' }, [el('span', { text: 'Start of conversation' })]));
      return;
    }
    cache().unshift(...res.messages);
    renderBatch(res.messages);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    loadingMore = false;
  }
}

function renderBatch(msgs) {
  if (!dom.messages) return;
  const oldHeight = dom.messages.scrollHeight;
  const oldTop = dom.messages.scrollTop;
  let lastDate = null;
  const frag = document.createDocumentFragment();
  for (const m of msgs) {
    const key = new Date(m.createdAt).toDateString();
    if (key !== lastDate) {
      lastDate = key;
      frag.append(el('div', { class: 'day-divider' }, [el('span', { text: dayLabel(m.createdAt) })]));
    }
    const node = renderMessage(m);
    if (node) frag.append(node);
  }
  dom.messages.append(frag);
  const grew = dom.messages.scrollHeight - oldHeight;
  if (oldTop > 0) dom.messages.scrollTop = oldTop + grew;
}

/* ---------------- message rendering ---------------- */

function renderMessage(m) {
  const me = state.me;
  if (!me) return null;
  const out = m.senderId === me.id;
  const row = el('div', { class: `msg-group ${out ? 'out' : 'in'}`, 'data-id': m.id });

  let bubble;
  if (m.kind === 'image' || m.kind === 'image-pending') {
    bubble = el('div', { class: 'bubble image' });
    if (m.kind === 'image-pending') {
      bubble.append(
        el('div', { class: 'img-progress' }, [
          el('div', { class: 'progress-label', text: '0%' }),
          el('div', { class: 'progress-track' }, [el('div', { class: 'progress-fill' })]),
          el('div', { style: 'font-size:12px', text: 'Uploading…' }),
        ])
      );
    } else {
      bubble.append(el('div', { class: 'img-progress' }, [el('div', { class: 'spinner' })]));
      loadImageInto(m, bubble);
    }
  } else {
    bubble = el('div', { class: 'bubble' }, [el('span', { text: m.body })]);
  }
  row.append(bubble);

  row.append(el('div', { class: 'msg-meta' }, metaHtml(m)));

  if (m.status === 'failed') {
    bubble.classList.add('msg-failed');
    row.append(
      el('button', {
        class: 'msg-retry',
        html: icon('retry') + '<span>Tap to retry</span>',
        onclick: () => retryMessage(m),
      })
    );
  }
  nodes().set(String(m.id), row);
  return row;
}

async function loadImageInto(m, bubble) {
  try {
    let url = mediaUrlCache(m.body);
    const box = bubble.querySelector('.img-progress');
    if (!box) return;
    const img = el('img', { src: url, alt: 'Photo', onclick: () => openViewer(url), loading: 'lazy' });
    box.replaceWith(img);
  } catch {
    const box = bubble.querySelector('.img-progress');
    if (box) box.replaceWith(el('div', { style: 'padding:10px;color:var(--danger);font-size:13px', text: 'Image could not be loaded.' }));
  }
}

const mediaUrlCache = (() => {
  const map = new Map();
  return async (filename) => {
    if (map.has(filename)) return map.get(filename);
    const url = await mediaUrl(filename);
    map.set(filename, url);
    return url;
  };
})();

function metaHtml(m) {
  const time = el('span', { text: clock(m.createdAt) });
  if (m.status === 'failed') {
    return [time, el('span', { class: 'tick sent', html: icon('retry') })];
  }
  if (m.status === 'sending' || m.status === 'uploading') {
    return [time, el('span', { style: 'font-size:11px;opacity:.8', text: m.kind === 'image-pending' ? 'Uploading' : 'Sending' })];
  }
  if (m.senderId !== state.me.id) return [time];
  const tick = m.readAt
    ? '<span class="tick read" title="Read">' + icon('doubleCheck') + '</span>'
    : m.deliveredAt
      ? '<span class="tick delivered" title="Delivered">' + icon('doubleCheck') + '</span>'
      : '<span class="tick sent" title="Sent">' + icon('check') + '</span>';
  return [time, el('span', { html: tick })];
}

/* ---------------- incoming messages / receipts / typing ---------------- */

export function appendMessage(msg) {
  if (!conv) return;
  const list = cache();
  if (!list.some((m) => String(m.id) === String(msg.id))) list.push(msg);
  if (!dom.messages) return;
  if (msg.senderId !== state.me.id) markRead();

  const lastNode = dom.messages.lastElementChild;
  const isDivider = lastNode && lastNode.classList.contains('day-divider');
  if (!isDivider && lastNode) {
    const last = list.find((m) => String(m.id) === String(lastNode.dataset.id));
    if (last && new Date(last.createdAt).toDateString() !== new Date(msg.createdAt).toDateString()) {
      dom.messages.append(el('div', { class: 'day-divider' }, [el('span', { text: dayLabel(msg.createdAt) })]));
    }
  }
  const node = renderMessage(msg);
  if (node) dom.messages.append(node);
  scrollIfNearBottom();
}

export function markReadIfActive() {
  if (conv) markRead();
}

function markRead() {
  if (!conv) return;
  api.post(`/conversations/${conv.id}/read`).catch(() => {});
  state.resetConversationUnread(conv.id);
}

export function updateReceipts(conversationId) {
  if (!conv || conv.id !== conversationId) return;
  const map = nodes();
  for (const m of cache()) {
    if (m.senderId !== state.me.id || m.status === 'failed' || m.temp) continue;
    const row = map.get(String(m.id));
    if (!row) continue;
    const meta = row.querySelector('.msg-meta');
    if (meta) meta.replaceChildren(...metaHtml(m));
  }
}

export function showTyping(userId) {
  if (!conv || userId !== conv.user.id) return;
  const old = dom.messages.querySelector('.typing-bubble');
  if (old) old.remove();
  const bubble = el('div', { class: 'msg-group in' }, [
    el('div', { class: 'typing-bubble' }, [el('i'), el('i'), el('i')]),
  ]);
  dom.messages.append(bubble);
  scrollIfNearBottom();
  clearTimeout(hideTypingTimer);
  hideTypingTimer = setTimeout(() => bubble.remove(), 3200);
}

/* ---------------- scroll ---------------- */

function nearBottom() {
  const elm = dom.messages;
  return elm.scrollHeight - elm.scrollTop - elm.clientHeight < 90;
}
function scrollIfNearBottom() {
  if (nearBottom()) scrollToBottom();
}
function scrollToBottom(force = false) {
  if (!dom.messages) return;
  if (force || nearBottom()) {
    dom.messages.scrollTop = dom.messages.scrollHeight;
    hideJump();
  }
}
function onScroll() {
  if (!dom.messages) return;
  if (nearBottom()) hideJump();
  else showJump();
  if (dom.messages.scrollTop < 80 && hasMore) fetchEarlier();
}
function showJump() {
  if (jumpVisible || !dom.chat) return;
  jumpVisible = true;
  const btn = el('button', {
    class: 'btn btn-ghost btn-sm',
    id: 'jump-btn',
    text: '↓ Latest',
    style: 'position:absolute;bottom:96px;left:50%;transform:translateX(-50%);z-index:5',
  });
  btn.onclick = () => scrollToBottom(true);
  dom.chat.style.position = 'relative';
  dom.chat.append(btn);
}
function hideJump() {
  jumpVisible = false;
  const btn = dom.chat && dom.chat.querySelector('#jump-btn');
  if (btn) btn.remove();
}

/* ---------------- composer ---------------- */

function autosize() {
  const t = dom.input;
  if (!t) return;
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 120) + 'px';
}

let typingEmitTimer = null;
function emitTyping() {
  if (!conv) return;
  clearTimeout(typingEmitTimer);
  typingEmitTimer = setTimeout(() => {
    emit('typing', { to: conv.user.id, conversationId: conv.id });
  }, 250);
}

async function sendText() {
  const text = dom.input.value.trim();
  if (!text) return;
  dom.input.value = '';
  autosize();
  const temp = { id: 'tmp-' + ++tempCounter, senderId: state.me.id, kind: 'text', body: text, createdAt: Date.now(), temp: true, status: 'sending' };
  appendMessage(temp);
  try {
    const res = await api.post(`/conversations/${conv.id}/messages`, { kind: 'text', body: text });
    replaceTemp(temp.id, res.message);
    syncConversation(res.message);
  } catch (err) {
    failMessage(temp.id, err.message);
  }
}

/** Keep the Chats list in sync so the conversation appears right after the
 *  first message (not only after a refresh or a socket event). */
function syncConversation(msg) {
  state.upsertConversation({
    id: conv.id,
    user: conv.user,
    lastMessage: msg,
    unreadCount: 0,
  });
}

async function sendImage(capture) {
  let file;
  try {
    file = await pickImage(capture);
  } catch {
    return; // user cancelled
  }
  const tempId = 'tmp-' + ++tempCounter;
  const temp = { id: tempId, senderId: state.me.id, kind: 'image-pending', body: '', createdAt: Date.now(), temp: true, status: 'uploading' };
  appendMessage(temp);
  try {
    const up = await uploadImage(file, { purpose: 'message', conversationId: conv.id }, (pct) => {
      const row = nodes().get(tempId);
      if (!row) return;
      const fill = row.querySelector('.progress-fill');
      const label = row.querySelector('.progress-label');
      if (fill) fill.style.width = pct + '%';
      if (label) label.textContent = pct + '%';
    });
    const res = await api.post(`/conversations/${conv.id}/messages`, { kind: 'image', body: up.filename });
    replaceTemp(tempId, res.message);
    syncConversation(res.message);
  } catch (err) {
    failMessage(tempId, err.message);
  }
}

function replaceTemp(tempId, realMsg) {
  const list = cache();
  const idx = list.findIndex((m) => String(m.id) === String(tempId));
  if (idx !== -1) list[idx] = realMsg;
  const row = nodes().get(tempId);
  if (row) {
    nodes().delete(tempId);
    const fresh = renderMessage(realMsg);
    row.replaceWith(fresh);
  }
}

function failMessage(tempId, message) {
  const list = cache();
  const msg = list.find((m) => String(m.id) === String(tempId));
  if (msg) {
    msg.status = 'failed';
    msg.failReason = message;
  }
  const row = nodes().get(tempId);
  if (row) {
    const bubble = row.querySelector('.bubble');
    if (bubble) bubble.classList.add('msg-failed');
    const meta = row.querySelector('.msg-meta');
    if (meta) meta.replaceChildren(...metaHtml(msg));
    row.append(
      el('button', {
        class: 'msg-retry',
        html: icon('retry') + '<span>Tap to retry</span>',
        onclick: () => retryMessage(msg),
      })
    );
  }
  toast(message || 'Message could not be sent.', 'error');
}

async function retryMessage(msg) {
  if (!msg) return;
  const row = nodes().get(String(msg.id));
  if (row) row.remove();
  nodes().delete(String(msg.id));
  const list = cache();
  const idx = list.findIndex((m) => String(m.id) === String(msg.id));
  if (idx !== -1) list.splice(idx, 1);

  if (msg.kind === 'image-pending') {
    toast('Upload failed — please send the photo again.', 'error');
    return;
  }
  const temp = { ...msg, id: 'tmp-' + ++tempCounter, createdAt: Date.now(), temp: true, status: 'sending' };
  appendMessage(temp);
  try {
    const res = await api.post(`/conversations/${conv.id}/messages`, { kind: msg.kind, body: msg.body });
    replaceTemp(temp.id, res.message);
  } catch (err) {
    failMessage(temp.id, err.message);
  }
}
