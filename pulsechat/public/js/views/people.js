'use strict';
/* People: search users, friend requests (incoming/outgoing), contacts. */

import state from '../state.js';
import { api } from '../api.js';
import { el, esc, avatarHtml, debounce, toast, formatLastSeen } from '../ui.js';
import { icon } from '../icons.js';
import { closeModal, openModal } from './calls.js';

let container = null;
let searchResults = null;
let lastQuery = '';

export function render(host) {
  container = host;
  draw();
}

export function refresh() {
  return Promise.all([loadRequests(), loadContacts(), loadDiscover()]);
}

export function refreshIfActive() {
  if (container && container.isConnected) refresh();
}

async function loadRequests() {
  try {
    const data = await api.get('/contacts/requests');
    state.incomingRequests = data.incoming;
    state.outgoingRequests = data.outgoing;
    draw();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function loadContacts() {
  try {
    const data = await api.get('/contacts');
    state.contacts = data.contacts;
    draw();
  } catch (err) {
    toast(err.message, 'error');
  }
}

export function draw() {
  if (!container) return;
  container.replaceChildren(build());
}

function build() {
  return el('div', { class: 'fade-swap' }, [
    searchBar(),
    el('div', { id: 'search-results' }),
    el('div', { id: 'discover-section' }),
    requestsSection(),
    contactsSection(),
  ]);
}

/* Show registered users (recent) so people can find & add each other easily. */
async function loadDiscover() {
  if (!container || !container.isConnected) return;
  const box = container.querySelector('#discover-section');
  if (!box) return;
  try {
    const data = await api.get('/users/discover');
    const others = data.users.filter((u) => u.relation !== 'accepted' && u.relation !== 'self');
    if (!others.length) {
      box.replaceChildren();
      return;
    }
    box.replaceChildren(
      el('div', { class: 'section-title', text: 'Registered on PulseChat' }),
      ...others.slice(0, 8).map(userRow)
    );
  } catch {
    box.replaceChildren();
  }
}

function searchBar() {
  return el('div', { class: 'search-bar' }, [
    el('span', { html: icon('search') }),
    el('input', {
      class: 'input',
      id: 'people-search',
      type: 'search',
      placeholder: 'Search people by name or email…',
      autocomplete: 'off',
      oninput: debounce((e) => runSearch(e.target.value), 280),
    }),
  ]);
}

async function runSearch(q) {
  const resultsBox = container.querySelector('#search-results');
  const query = q.trim();
  const discover = container.querySelector('#discover-section');
  if (query.length < 2) {
    resultsBox.replaceChildren();
    if (discover) discover.style.display = '';
    return;
  }
  if (discover) discover.style.display = 'none';
  lastQuery = query;
  resultsBox.replaceChildren(el('div', { class: 'skeleton', style: 'height:64px;margin:8px 0' }));
  try {
    const data = await api.get('/users/search?q=' + encodeURIComponent(query));
    searchResults = data.users;
    resultsBox.replaceChildren(...searchResults.map(userRow));
    if (!searchResults.length) {
      resultsBox.append(
        el('div', { class: 'empty-state', style: 'padding:26px 10px' }, [
          el('p', { text: 'No PulseChat users found. Only registered users appear here.' }),
        ])
      );
    }
  } catch (err) {
    resultsBox.replaceChildren(el('p', { class: 'error-text', style: 'padding:12px', text: err.message }));
  }
}

function userRow(u) {
  const p = state.presence[u.id];
  const online = p ? p.online : u.online;
  return el('div', { class: 'user-row' }, [
    el('span', { class: 'avatar-wrap', html: avatarHtml(u, 'md') + (online ? '<span class="dot dot-online"></span>' : '') }),
    el('div', { class: 'user-info' }, [
      el('div', { class: 'user-name', text: u.displayName }),
      el('div', { class: 'user-sub', text: u.email + (u.bio ? ' · ' + u.bio : '') }),
    ]),
    el('div', { class: 'user-actions' }, actionButtons(u)),
  ]);
}

function openChatWith(u) {
  return async () => {
    const id = await getOrCreateConv(u.id, u);
    if (id) location.hash = '#/chat/' + id;
  };
}

function actionButtons(u) {
  if (u.relation === 'accepted') {
    return [
      el('button', { class: 'btn btn-ghost btn-sm', html: icon('chats') + '<span>Chat</span>', onclick: openChatWith(u) }),
      el('button', {
        class: 'btn btn-ghost btn-sm',
        html: icon('video'),
        onclick: () => import('../rtc.js').then((m) => m.startCall(u)),
      }),
      el('button', {
        class: 'icon-btn',
        html: icon('trash'),
        title: 'Remove contact',
        onclick: () => removeContact(u),
      }),
    ];
  }
  if (u.relation === 'requested') {
    return [el('span', { class: 'chip', text: 'Request sent' })];
  }
  if (u.relation === 'incoming') {
    return [
      el('button', { class: 'btn btn-success btn-sm', text: 'Accept', onclick: () => acceptRequest(u) }),
      el('button', { class: 'btn btn-ghost btn-sm', text: 'Decline', onclick: () => declineRequest(u) }),
    ];
  }
  return [
    el('button', {
      class: 'btn btn-primary btn-sm',
      html: icon('plus') + '<span>Add</span>',
      onclick: () => sendRequest(u),
    }),
  ];
}

async function getOrCreateConv(userId, user) {
  try {
    const data = await api.post('/conversations', { userId });
    const conv = data.conversation;
    state.upsertConversation(conv);
    return conv.id;
  } catch (err) {
    toast(err.message, 'error');
    return '';
  }
}

async function sendRequest(u) {
  try {
    await api.post('/contacts/requests', { toUserId: u.id });
    u.relation = 'requested';
    state.addOutgoingRequest(u);
    toast(`Request sent to ${u.displayName}`, 'success');
    draw();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function acceptRequest(u) {
  try {
    await api.post(`/contacts/requests/${u.id}/accept`);
    state.addContact({ ...u, relation: 'accepted' });
    state.incomingRequests = state.incomingRequests.filter((x) => x.id !== u.id);
    toast(`You are now connected with ${u.displayName}`, 'success');
    draw();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function declineRequest(u) {
  try {
    await api.post(`/contacts/requests/${u.id}/decline`);
    state.incomingRequests = state.incomingRequests.filter((x) => x.id !== u.id);
    toast(`Request from ${u.displayName} declined`, 'info');
    draw();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function removeContact(u) {
  try {
    await api.del(`/contacts/${u.id}`);
    state.removeContact(u.id);
    toast(`${u.displayName} removed from contacts`, 'info');
    draw();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function requestsSection() {
  const parts = [];
  if (state.incomingRequests.length) {
    parts.push(el('div', { class: 'section-title', text: 'Friend requests' }));
    parts.push(
      ...state.incomingRequests.map((u) =>
        el('div', { class: 'user-row' }, [
          el('span', { class: 'avatar-wrap', html: avatarHtml(u, 'md') }),
          el('div', { class: 'user-info' }, [
            el('div', { class: 'user-name', text: u.displayName }),
            el('div', { class: 'user-sub', text: u.email }),
          ]),
          el('div', { class: 'user-actions' }, [
            el('button', { class: 'btn btn-success btn-sm', text: 'Accept', onclick: () => acceptRequest(u) }),
            el('button', { class: 'btn btn-ghost btn-sm', text: 'Decline', onclick: () => declineRequest(u) }),
          ]),
        ])
      )
    );
  }
  if (state.outgoingRequests.length) {
    parts.push(el('div', { class: 'section-title', text: 'Pending requests' }));
    parts.push(
      ...state.outgoingRequests.map((u) =>
        el('div', { class: 'user-row' }, [
          el('span', { class: 'avatar-wrap', html: avatarHtml(u, 'md') }),
          el('div', { class: 'user-info' }, [
            el('div', { class: 'user-name', text: u.displayName }),
            el('div', { class: 'user-sub', text: u.email }),
          ]),
          el('span', { class: 'chip', text: 'Waiting for response' }),
        ])
      )
    );
  }
  return el('div', {}, parts);
}

function contactsSection() {
  const parts = [el('div', { class: 'section-title', text: 'Contacts' })];
  if (!state.contacts.length) {
    parts.push(
      el('div', { class: 'empty-state', style: 'padding:20px 10px' }, [
        el('p', { text: 'No contacts yet — search for people above and send a friend request.' }),
      ])
    );
    return el('div', {}, parts);
  }
  parts.push(...state.contacts.map(contactRow));
  return el('div', {}, parts);
}

function contactRow(u) {
  const p = state.presence[u.id];
  const online = p ? p.online : u.online;
  return el('div', { class: 'user-row contact-row', onclick: () => openFriendProfile(u) }, [
    el('span', { class: 'avatar-wrap', html: avatarHtml(u, 'md') + (online ? '<span class="dot dot-online"></span>' : '<span class="dot dot-offline"></span>') }),
    el('div', { class: 'user-info' }, [
      el('div', { class: 'user-name', text: u.displayName }),
      el('div', { class: 'user-sub', text: u.bio || (online ? 'Online' : 'Offline') }),
    ]),
    el('div', { class: 'user-actions' }, [
      el('button', {
        class: 'icon-btn',
        html: icon('chats'),
        title: 'Message',
        onclick: (e) => { e.stopPropagation(); openChatWith(u)(); },
      }),
      el('button', {
        class: 'icon-btn',
        html: icon('video'),
        title: 'Video call',
        onclick: (e) => { e.stopPropagation(); import('../rtc.js').then((m) => m.startCall(u)); },
      }),
      el('button', {
        class: 'icon-btn',
        html: icon('trash'),
        title: 'Remove contact',
        onclick: (e) => { e.stopPropagation(); removeContact(u); },
      }),
    ]),
  ]);
}

/* ---------------- friend profile modal ---------------- */

function openFriendProfile(u) {
  const p = state.presence[u.id];
  const online = p ? p.online : u.online;
  const body = el('div', { class: 'friend-profile' }, [
    el('div', { class: 'fp-avatar', html: avatarHtml(u, 'xl') + (online ? '<span class="dot dot-online fp-dot"></span>' : '<span class="dot dot-offline fp-dot"></span>') }),
    el('div', { class: 'fp-name', text: u.displayName }),
    el('div', { class: 'fp-status' + (online ? ' online' : ''), text: online ? 'Online' : formatLastSeen(u.lastSeen, false) }),
    el('div', { class: 'fp-email', text: u.email }),
    el('div', { class: 'fp-bio', text: u.bio || 'No status yet.' }),
    el('div', { class: 'fp-actions' }, [
      el('button', { class: 'btn btn-primary', html: icon('chats') + '<span>Message</span>', onclick: () => { closeModal(); openChatWith(u)(); } }),
      el('button', { class: 'btn btn-ghost', html: icon('video') + '<span>Video call</span>', onclick: () => { closeModal(); import('../rtc.js').then((m) => m.startCall(u)); } }),
      el('button', { class: 'btn btn-ghost btn-danger-ghost', html: icon('trash') + '<span>Remove</span>', onclick: () => { closeModal(); removeContact(u); } }),
    ]),
  ]);
  openModal(u.displayName, body);
}

export { userRow };
