'use strict';
/* Tiny reactive store + conversation/message helpers. */

const state = {
  me: null,
  socketConnected: false,
  view: 'chats',            // chats | people | calls | profile
  conversations: [],        // conversation items (see API shape)
  contacts: [],             // accepted contacts
  incomingRequests: [],
  outgoingRequests: [],
  calls: [],                // call history
  activeConvId: null,       // open chat
  messagesCache: {},        // convId -> [message,...] (cached loaded history)
  typing: {},               // convId -> timestamp of last typing event
  presence: {},             // userId -> { online, lastSeen }
  onlineContactIds: new Set(),
  unreadTotal: 0,
  notificationsEnabled: false,
  soundsOn: true,
  theme: 'dark',
  lastMessageAt: null,
};

const listeners = new Map();

export function subscribe(key, fn) {
  if (!listeners.has(key)) listeners.set(key, new Set());
  listeners.get(key).add(fn);
  return () => listeners.get(key)?.delete(fn);
}

export function set(key, value) {
  state[key] = value;
  const set = listeners.get(key);
  if (set) set.forEach((fn) => fn(value));
}

export function patch(partial) {
  for (const [k, v] of Object.entries(partial)) set(k, v);
}

export function computeUnread() {
  const total = state.conversations.reduce((n, c) => n + (c.unreadCount || 0), 0);
  if (total !== state.unreadTotal) set('unreadTotal', total);
}

export function upsertConversation(conv) {
  const list = state.conversations.slice();
  const idx = list.findIndex((c) => c.id === conv.id);
  if (idx === -1) list.unshift(conv);
  else list[idx] = { ...list[idx], ...conv };
  list.sort((a, b) => (b.lastMessage ? b.lastMessage.createdAt : 0) - (a.lastMessage ? a.lastMessage.createdAt : 0));
  set('conversations', list);
  computeUnread();
}

export function applyMessageDelivered(conversationId, messageIds, at) {
  const msgs = state.messagesCache[conversationId];
  if (msgs) {
    for (const m of msgs) {
      if (messageIds.includes(m.id) && !m.deliveredAt) m.deliveredAt = at;
    }
  }
  const list = state.conversations.map((c) => {
    if (c.id !== conversationId || !c.lastMessage || !messageIds.includes(c.lastMessage.id)) return c;
    return { ...c, lastMessage: { ...c.lastMessage, deliveredAt: at } };
  });
  set('conversations', list);
  computeUnread();
}

export function applyMessageRead(conversationId, byUserId, upToMessageId) {
  const msgs = state.messagesCache[conversationId];
  if (msgs) {
    for (const m of msgs) {
      if (m.senderId !== byUserId && m.id <= upToMessageId && !m.readAt) m.readAt = Date.now();
    }
  }
  const list = state.conversations.map((c) => {
    if (c.id !== conversationId) return c;
    const unread = c.lastMessage && c.lastMessage.senderId !== byUserId && c.lastMessage.id <= upToMessageId ? 0 : c.unreadCount;
    return {
      ...c,
      unreadCount: unread,
      lastMessage: c.lastMessage && c.lastMessage.id <= upToMessageId && c.lastMessage.senderId !== byUserId
        ? { ...c.lastMessage, readAt: Date.now() }
        : c.lastMessage,
    };
  });
  set('conversations', list);
  computeUnread();
}

export function resetConversationUnread(conversationId) {
  const list = state.conversations.map((c) => (c.id === conversationId ? { ...c, unreadCount: 0 } : c));
  set('conversations', list);
  computeUnread();
}

export function addIncomingRequest(user) {
  set('incomingRequests', [user, ...state.incomingRequests.filter((u) => u.id !== user.id)]);
}

export function addOutgoingRequest(user) {
  set('outgoingRequests', [user, ...state.outgoingRequests.filter((u) => u.id !== user.id)]);
}

export function addContact(user) {
  set('contacts', [user, ...state.contacts.filter((u) => u.id !== user.id)]);
}

export function removeContact(userId) {
  set('contacts', state.contacts.filter((u) => u.id !== userId));
  set('incomingRequests', state.incomingRequests.filter((u) => u.id !== userId));
  set('outgoingRequests', state.outgoingRequests.filter((u) => u.id !== userId));
  // Remove their conversation from the list (UI) — data stays server-side.
  set('conversations', state.conversations.filter((c) => c.user.id !== userId));
  computeUnread();
}

export function trackPresence(payload) {
  state.presence[payload.userId] = { online: payload.online, lastSeen: payload.lastSeen };
  if (payload.online) state.onlineContactIds.add(payload.userId);
  else state.onlineContactIds.delete(payload.userId);
  set('presence', { ...state.presence });
}

export function setTyping(conversationId) {
  state.typing[conversationId] = Date.now();
  set('typing', { ...state.typing });
}

/* Action helpers are also exposed on the state object for convenience. */
state.computeUnread = computeUnread;
state.upsertConversation = upsertConversation;
state.resetConversationUnread = resetConversationUnread;
state.addIncomingRequest = addIncomingRequest;
state.addOutgoingRequest = addOutgoingRequest;
state.addContact = addContact;
state.removeContact = removeContact;
state.trackPresence = trackPresence;
state.applyMessageDelivered = applyMessageDelivered;
state.applyMessageRead = applyMessageRead;
state.setTyping = setTyping;

export default state;
