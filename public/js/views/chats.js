'use strict';
/* Chats: conversation list with presence, last message, time, unread badge. */

import state, { computeUnread } from '../state.js';
import { api } from '../api.js';
import { el, esc, avatarHtml, formatTime, toast } from '../ui.js';
import { icon } from '../icons.js';

let container = null;

/** Animated worm mascot — shared by the mobile empty state and desktop panel. */
function animatedWorm() {
  return el('div', { class: 'worm-stage' }, [
    el('div', { class: 'worm-rings' }, [el('span', { class: 'worm-ring' }), el('span', { class: 'worm-ring' }), el('span', { class: 'worm-ring' })]),
    el('img', { class: 'worm-logo', src: '/assets/logo.svg', alt: 'PulseChat' }),
    el('div', {
      class: 'worm-ekg',
      html:
        '<svg viewBox="0 0 240 48" width="190" height="34" aria-hidden="true">' +
        '<path class="worm-ekg-path" d="M0 24 H64 L74 24 L80 10 L88 38 L94 24 H126 L134 24 L140 12 L148 36 L154 24 H240"/>' +
        '</svg>',
    }),
  ]);
}

export function render(host) {
  container = host;
  draw();
}

export async function refresh() {
  try {
    const d = await api.get('/conversations');
    state.conversations = d.conversations;
    computeUnread();
    draw();
  } catch (err) {
    toast(err.message, 'error');
  }
}

export function draw() {
  if (container && container.isConnected) container.replaceChildren(build());
}

function build() {
  if (!state.conversations.length) {
    const fresh = !state.contacts.length;
    return el('div', { class: 'empty-state' }, [
      animatedWorm(),
      el('h3', { text: fresh ? `Welcome, ${state.me ? state.me.displayName.split(' ')[0] : ''}! 👋` : 'No conversations yet' }),
      el('p', {
        text: fresh
          ? 'You\'re all set. Now find your friends: search for them in People, send a friend request, and start chatting.'
          : 'Find friends in People, send a friend request, and start chatting. Messages appear here.',
      }),
      fresh
        ? el('div', { class: 'empty-steps' }, [
            el('div', { class: 'empty-step' }, [el('span', { class: 'step-num', text: '1' }), el('span', { text: 'Search for someone by name or email' })]),
            el('div', { class: 'empty-step' }, [el('span', { class: 'step-num', text: '2' }), el('span', { text: 'Send a friend request — they accept it' })]),
            el('div', { class: 'empty-step' }, [el('span', { class: 'step-num', text: '3' }), el('span', { text: 'Chat, share photos and video call 🎥' })]),
          ])
        : null,
      el('button', { class: 'btn btn-primary', text: 'Find people', onclick: () => (location.hash = '#/people') }),
    ]);
  }
  return el('div', { class: 'conv-list fade-swap' }, state.conversations.map(itemHtml));
}

function itemHtml(conv) {
  const user = conv.user;
  const p = state.presence[user.id];
  const online = p ? p.online : user.online;
  const last = conv.lastMessage;
  const mine = last && last.senderId === (state.me && state.me.id);

  let preview = '';
  let time = '';
  if (last) {
    const text = last.kind === 'image' ? '📷 Photo' : last.body;
    const tick =
      mine && !last.temp
        ? last.readAt
          ? '<span class="tick read">' + icon('doubleCheck') + '</span>'
          : last.deliveredAt
            ? '<span class="tick delivered">' + icon('doubleCheck') + '</span>'
            : '<span class="tick sent">' + icon('check') + '</span>'
        : '';
    preview = tick + esc(text);
    time = formatTime(last.createdAt);
  } else {
    preview = 'Start chatting';
  }

  const muted = conv.unreadCount === 0;
  return el('div', {
    class: 'conv-item' + (muted ? ' conv-muted' : ''),
    onclick: () => (location.hash = '#/chat/' + conv.id),
  }, [
    el('span', { class: 'avatar-wrap', html: avatarHtml(user, 'md') + (online ? '<span class="dot dot-online"></span>' : '') }),
    el('div', { class: 'conv-mid' }, [
      el('div', { class: 'conv-name' }, [el('span', { text: user.displayName })]),
      el('div', { class: 'conv-preview', html: preview }),
    ]),
    el('div', { class: 'conv-right' }, [
      el('span', { class: 'conv-time', text: time }),
      conv.unreadCount > 0 ? el('span', { class: 'badge', text: conv.unreadCount > 99 ? '99+' : conv.unreadCount }) : null,
    ]),
  ]);
}
