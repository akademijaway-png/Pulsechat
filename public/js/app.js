'use strict';
/* PulseChat frontend entry: boot, shell, hash router, realtime wiring. */

import { fetchMe, hasSession, clearSession, getAccessToken } from './api.js';
import * as socket from './socket.js';
import state, {
  set, upsertConversation, applyMessageDelivered, applyMessageRead,
  resetConversationUnread, addIncomingRequest, addContact, removeContact, trackPresence,
} from './state.js';
import { el, toast, setTheme, getTheme, playBlip, avatarHtml, safeGet } from './ui.js';
import { icon } from './icons.js';
import { renderAuth } from './views/auth.js';
import * as chatsView from './views/chats.js';
import * as peopleView from './views/people.js';
import * as callsView from './views/calls.js';
import * as profileView from './views/profile.js';
import * as chatView from './views/chat.js';
import * as rtc from './rtc.js';
import { notify } from './notifications.js';

const TABS = [
  { id: 'chats', label: 'Chats', icon: 'chats' },
  { id: 'people', label: 'People', icon: 'people' },
  { id: 'calls', label: 'Calls', icon: 'calls' },
  { id: 'profile', label: 'Profile', icon: 'profile' },
];

let wired = false;

/* ---------------- boot ---------------- */

async function boot() {
  setTheme(getTheme());
  state.soundsOn = safeGet('pc.sounds', '1') !== '0';

  window.addEventListener('hashchange', route);
  window.addEventListener('online', updateConn);
  window.addEventListener('offline', updateConn);
  window.addEventListener('pc:authed', enterMain);

  if (hasSession()) {
    await enterMain();
  } else {
    renderAuthView();
    route();
  }
}

async function enterMain() {
  if (!hasSession()) {
    renderAuthView();
    return;
  }
  try {
    if (!state.me) {
      const me = await fetchMe();
      state.me = me;
      document.body.dataset.meId = String(me.id);
    }
    if (!socket.isConnected() && getAccessToken()) {
      socket.connect();
      wireSocket();
    }
    ensureShell();
    refreshAll();
    const hash = location.hash;
    const onTab = TABS.some((t) => '#' + t.id === hash) || hash.startsWith('#/chat/');
    if (!onTab) location.replace('#/chats');
    route();
  } catch (err) {
    // Only a 401 means the session is genuinely invalid. Anything else (e.g.
    // the server briefly unreachable) must NOT look like a login failure —
    // keep the session, say so, and retry.
    if (err && (err.status === 401 || err.status === 403)) {
      clearSession();
      renderAuthView();
      route();
    } else {
      toast('Could not reach the server — retrying…', 'error', 3000);
      setTimeout(enterMain, 1500);
    }
  }
}

function renderAuthView(opts) {
  const app = document.getElementById('app');
  renderAuth(app, opts || {});
}

/* ---------------- shell ---------------- */

function renderShell() {
  const app = document.getElementById('app');
  const shell = el('div', { class: 'shell', id: 'shell' }, [
    el('div', { class: 'col-list' }, [
      el('header', { class: 'list-header' }, [
        el('div', { class: 'brand' }, [
          el('img', { src: '/assets/logo.svg', alt: '' }),
          el('h1', { text: 'PulseChat Messenger' }),
        ]),
        el('div', { style: 'display:flex;align-items:center;gap:8px' }, [
          el('span', { class: 'conn-pill connecting', id: 'conn-pill' }, [
            el('span', { class: 'dot' }),
            el('span', { id: 'conn-label', text: 'Connecting…' }),
          ]),
          el('button', {
            class: 'icon-btn header-logout',
            html: icon('logout'),
            title: 'Log out',
            ariaLabel: 'Log out',
            onclick: async () => {
              const { logoutRemote } = await import('./api.js');
              await logoutRemote();
              location.hash = '#/login';
            },
          }),
          el('span', {
            class: 'avatar-wrap',
            html: avatarHtml(state.me, 'sm'),
            style: 'cursor:pointer',
            onclick: () => (location.hash = '#/profile'),
          }),
        ]),
      ]),
      el('nav', { class: 'tabs' }, TABS.map(tabButton)),
      el('main', { class: 'tab-content', id: 'tabContent' }),
    ]),
    el('div', { class: 'col-chat', id: 'colChat' }, [
      el('div', { class: 'chat-empty' }, [
        el('div', { class: 'ce-bg' }, [
          el('span', { class: 'ce-bubble b1' }),
          el('span', { class: 'ce-bubble b2' }),
          el('span', { class: 'ce-bubble b3' }),
          el('span', { class: 'ce-bubble b4' }),
          el('span', { class: 'ce-bubble b5' }),
        ]),
        el('div', { class: 'ce-stage' }, [
          el('div', { class: 'ce-rings' }, [el('span', { class: 'ce-ring' }), el('span', { class: 'ce-ring' }), el('span', { class: 'ce-ring' })]),
          el('img', { class: 'ce-logo', src: '/assets/logo.svg', alt: 'PulseChat' }),
          el('div', {
            class: 'ce-ekg',
            html:
              '<svg viewBox="0 0 240 48" width="220" height="40" aria-hidden="true">' +
              '<path class="ce-ekg-path" d="M0 24 H64 L74 24 L80 10 L88 38 L94 24 H126 L134 24 L140 12 L148 36 L154 24 H240"/>' +
              '<circle class="ce-ekg-dot" cx="0" cy="24" r="3.2"/>' +
              '</svg>',
          }),
        ]),
        el('h2', { text: 'Welcome to PulseChat Messenger' }),
        el('p', { text: "Pick a conversation from the list, or find people to connect with. Messages, photos and video calls all live here — it's real, and it's yours." }),
        el('button', { class: 'btn btn-primary', text: 'Find people', onclick: () => (location.hash = '#/people') }),
      ]),
    ]),
    el('nav', { class: 'bottom-nav' }, TABS.map(tabButton)),
  ]);
  app.replaceChildren(shell);
}

function tabButton(tab) {
  return el('button', { class: 'tab', id: 'tab-' + tab.id, 'data-tab': tab.id, onclick: () => (location.hash = '#/' + tab.id) }, [
    el('span', { html: icon(tab.icon) }),
    el('span', { text: tab.label }),
    el('span', { class: 'badge hidden', id: 'badge-' + tab.id }),
  ]);
}

function ensureShell() {
  if (!document.getElementById('shell')) renderShell();
}

function updateTabActive() {
  for (const t of TABS) {
    document.querySelectorAll(`.tab[data-tab="${t.id}"]`).forEach((btn) => btn.classList.toggle('active', state.view === t.id));
  }
  updateBadges();
}

function updateBadges() {
  const setBadge = (tabId, count) => {
    document.querySelectorAll('#badge-' + tabId).forEach((b) => {
      b.textContent = count > 99 ? '99+' : String(count);
      b.classList.toggle('hidden', count === 0);
    });
  };
  setBadge('chats', state.unreadTotal);
  setBadge('people', state.incomingRequests.length);
  const missed = state.calls.filter((c) => (c.status === 'missed' || c.status === 'unanswered') && c.direction === 'incoming').length;
  setBadge('calls', missed);
}

/* ---------------- router ---------------- */

function route() {
  const hash = location.hash || '#/';

  if (hash === '#/' || hash === '') {
    location.replace('#/chats');
    return;
  }
  if (hash.startsWith('#/reset')) {
    const token = new URLSearchParams(hash.split('?')[1] || '').get('token');
    renderAuthView({ mode: 'reset', token });
    return;
  }
  if (['#/login', '#/register', '#/forgot'].includes(hash)) {
    if (hasSession() && state.me) {
      location.replace('#/chats');
    } else {
      renderAuthView({ mode: hash.slice(2) });
    }
    return;
  }
  if (hash.startsWith('#/chat/')) {
    if (!hasSession()) return renderAuthView();
    if (!state.me) return enterMain();
    const id = Number(hash.split('/')[2]);
    if (!Number.isInteger(id)) return location.replace('#/chats');
    ensureShell();
    set('view', 'chats');
    updateTabActive();
    chatView.openChat(id);
    return;
  }

  const view = hash.slice(2);
  if (!TABS.some((t) => t.id === view)) {
    location.replace('#/chats');
    return;
  }
  if (!hasSession()) return renderAuthView();
  if (!state.me) return enterMain();

  ensureShell();
  set('view', view);
  updateTabActive();
  renderTab(view);
}

function renderTab(view) {
  const host = document.getElementById('tabContent');
  if (!host) return;
  if (view === 'chats') {
    chatsView.render(host);
    chatsView.refresh();
  } else if (view === 'people') {
    peopleView.render(host);
    peopleView.refresh();
  } else if (view === 'calls') {
    callsView.render(host);
    callsView.refresh();
  } else if (view === 'profile') {
    profileView.render(host);
  }
}

function refreshAll() {
  chatsView.refresh();
  peopleView.refresh();
  callsView.refresh();
  updateConn();
}

/* ---------------- connection pill ---------------- */

function updateConn() {
  const pill = document.getElementById('conn-pill');
  const label = document.getElementById('conn-label');
  if (!pill || !label) return;
  const offline = !navigator.onLine;
  const connected = socket.isConnected() && navigator.onLine;
  pill.className = 'conn-pill ' + (offline ? 'offline' : connected ? 'connected' : 'connecting');
  label.textContent = offline ? 'Offline' : connected ? 'Online' : 'Reconnecting…';
}

/* ---------------- realtime wiring ---------------- */

function wireSocket() {
  if (wired) return;
  wired = true;

  socket.on('socket:connect', () => {
    set('socketConnected', true);
    updateConn();
    refreshAll();
  });

  socket.on('socket:disconnect', () => {
    set('socketConnected', false);
    updateConn();
  });

  socket.on('socket:error', () => updateConn());

  socket.on('presence', (p) => {
    trackPresence(p);
    chatsView.draw();
    peopleView.draw();
    chatView.updateHeaderStatus();
  });

  socket.on('message:new', (p) => {
    upsertConversation(p.conversation);
    if (chatView.isOpen(p.conversation.id)) {
      chatView.appendMessage(p.message);
      chatView.markReadIfActive();
      resetConversationUnread(p.conversation.id);
    } else {
      const name = p.conversation.user.displayName;
      if (state.soundsOn && !document.hasFocus()) playBlip();
      toast(`New message from ${name}`, 'info', 2600);
      notify('PulseChat Messenger', `New message from ${name}`, `/chat/${p.conversation.id}`);
    }
    chatsView.draw();
    updateBadges();
  });

  socket.on('message:delivered', (p) => {
    applyMessageDelivered(p.conversationId, p.messageIds, p.at);
    chatView.updateReceipts(p.conversationId);
    chatsView.draw();
  });

  socket.on('message:read', (p) => {
    applyMessageRead(p.conversationId, p.byUserId, p.upToMessageId);
    chatView.updateReceipts(p.conversationId);
    chatsView.draw();
    updateBadges();
  });

  socket.on('typing', (p) => {
    if (chatView.isOpen(p.conversationId)) chatView.showTyping(p.userId);
  });

  socket.on('contact:request', (p) => {
    addIncomingRequest(p.from);
    updateBadges();
    if (state.view === 'people') peopleView.refresh();
    toast(`${p.from.displayName} sent you a friend request`, 'info', 3500);
    notify('PulseChat Messenger', `${p.from.displayName} sent you a friend request`, '/people');
  });

  socket.on('contact:accepted', (p) => {
    addContact({ ...p.contact, relation: 'accepted' });
    if (state.view === 'people') peopleView.refresh();
    toast(`${p.contact.displayName} accepted your friend request`, 'success', 3500);
    notify('PulseChat Messenger', `${p.contact.displayName} accepted your request`, '/chats');
  });

  socket.on('contact:declined', () => {
    if (state.view === 'people') peopleView.refresh();
    toast('Your friend request was declined', 'info');
  });

  socket.on('contact:removed', (p) => {
    removeContact(p.userId);
    const conv = state.conversations.find((c) => c.user.id === p.userId);
    if (conv && chatView.isOpen(conv.id)) chatView.closeChat();
    if (state.view === 'people') peopleView.refresh();
    chatsView.draw();
    updateBadges();
    toast('A contact was removed', 'info');
  });

  socket.on('call:incoming', (p) => rtc.onIncoming(p));
  socket.on('call:accepted', (p) => rtc.onAccepted(p));
  socket.on('call:declined', (p) => rtc.onDeclined(p));
  socket.on('call:cancelled', (p) => rtc.onCancelled(p));
  socket.on('call:timeout', (p) => rtc.onTimeout(p));
  socket.on('call:unavailable', (p) => rtc.onUnavailable(p));
  socket.on('call:ended', (p) => rtc.onEnded(p));
  socket.on('call:error', (p) => rtc.onCallError(p));
  socket.on('signal', (p) => rtc.onSignal(p));

  setInterval(() => socket.refreshAuth(), 4 * 60 * 1000);
}

boot();
