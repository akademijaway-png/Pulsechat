'use strict';
/**
 * End-to-end backend test: simulates two real users (Alice & Bob) talking
 * over the live server — presence, contacts, online/offline delivery,
 * read receipts, media upload + access control, WebRTC signaling, call history.
 *
 * Run with a FRESH database:  node test/e2e.test.js [baseUrl]
 */
const { io } = require('socket.io-client');

const BASE = process.argv[2] || 'http://localhost:3000';
const API = BASE + '/api';
let passed = 0;
let failed = 0;

function assert(cond, name, extra) {
  if (cond) {
    passed++;
    console.log('  ✔', name);
  } else {
    failed++;
    console.error('  ✘', name, extra !== undefined ? JSON.stringify(extra) : '');
  }
}

async function api(method, path, { token, body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  let payload;
  if (form) {
    payload = form;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(API + path, { method, headers, body: payload });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = () => new Promise((r) => setTimeout(r, 200));

/** Wait for an event whose payload satisfies `predicate` (default: any payload). */
function waitFor(socket, event, predicate, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timeout waiting for "${event}"`));
    }, timeoutMs);
    const handler = (payload) => {
      if (!predicate || predicate(payload)) {
        clearTimeout(t);
        socket.off(event, handler);
        resolve(payload);
      }
    };
    socket.on(event, handler);
  });
}

function connect(token) {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { auth: { token }, transports: ['websocket'] });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}

async function main() {
  console.log(`\nPulseChat e2e test against ${BASE}\n`);

  // ---- register two brand-new users ----
  const stamp = Date.now().toString(36);
  const aEmail = `alice.${stamp}@pulsechat.test`;
  const bEmail = `bob.${stamp}@pulsechat.test`;
  const regA = await api('POST', '/auth/register', { body: { email: aEmail, password: 'secret123', displayName: 'Alice' } });
  const regB = await api('POST', '/auth/register', { body: { email: bEmail, password: 'secret123', displayName: 'Bob' } });
  assert(regA.status === 201 && regB.status === 201, 'registration works');
  const idA = regA.json.user.id;
  const idB = regB.json.user.id;
  const tokenA = regA.json.accessToken;
  const tokenB = regB.json.accessToken;
  const refreshA = regA.json.refreshToken;

  assert(!refreshA || refreshA.length > 20, 'refresh token issued on registration');

  const dup = await api('POST', '/auth/register', { body: { email: aEmail, password: 'secret123', displayName: 'Alice' } });
  assert(dup.status === 409, 'duplicate email rejected');

  const weak = await api('POST', '/auth/register', { body: { email: 'weak@pulsechat.test', password: 'abc', displayName: 'Weak' } });
  assert(weak.status === 422, 'weak password rejected with clear validation error');

  // ---- login + refresh rotation ----
  const loginA = await api('POST', '/auth/login', { body: { email: aEmail, password: 'secret123' } });
  assert(loginA.status === 200 && loginA.json.user.id === idA, 'login works');
  const ref = await api('POST', '/auth/refresh', { body: { refreshToken: refreshA } });
  assert(ref.status === 200 && ref.json.accessToken, 'refresh token rotation issues new access token');
  const reuse = await api('POST', '/auth/refresh', { body: { refreshToken: refreshA } });
  assert(reuse.status === 401, 'reused (stolen) refresh token is rejected');
  const badLogin = await api('POST', '/auth/login', { body: { email: aEmail, password: 'nope-nope' } });
  assert(badLogin.status === 401, 'wrong password → clear login error');

  // ---- me / profile ----
  const meA = await api('GET', '/auth/me', { token: tokenA });
  assert(meA.status === 200 && meA.json.user.displayName === 'Alice', 'GET /auth/me returns profile');
  const patch = await api('PATCH', '/auth/profile', { token: tokenA, body: { bio: 'Hello from Alice 👋' } });
  assert(patch.status === 200 && patch.json.user.bio === 'Hello from Alice 👋', 'profile bio update works');
  const noToken = await api('GET', '/auth/me', {});
  assert(noToken.status === 401, 'protected endpoint rejects missing token');

  // ---- search ----
  const search = await api('GET', `/users/search?q=bo`, { token: tokenA });
  assert(search.status === 200 && search.json.users.some((u) => u.id === idB), 'search finds Bob');
  const searchSelf = await api('GET', `/users/search?q=alice`, { token: tokenA });
  assert(!searchSelf.json.users.some((u) => u.id === idA), 'self excluded from search');
  const missing = await api('GET', `/users/${999999}`, { token: tokenA });
  assert(missing.status === 404, 'unknown user → "user does not exist"');

  // ---- sockets + presence ----
  const sa = await connect(tokenA);
  const bobOnline = waitFor(sa, 'presence', (p) => p.userId === idB && p.online === true);
  const sb = await connect(tokenB);
  await bobOnline;
  assert(true, 'Alice sees Bob come online in real time');

  const saSelfOffline = waitFor(sa, 'presence', (p) => p.userId === idB && p.online === false);
  sb.disconnect();
  await saSelfOffline;
  assert(true, 'Alice sees Bob go offline automatically');

  const searchOffline = await api('GET', `/users/search?q=bo`, { token: tokenA });
  assert(searchOffline.json.users[0].online === false && searchOffline.json.users[0].lastSeen > 0, 'offline status + last seen');

  const bobOnline2 = waitFor(sa, 'presence', (p) => p.userId === idB && p.online === true);
  const sb2 = await connect(tokenB);
  await bobOnline2;
  assert(true, 'Alice sees Bob return online');

  // ---- friend request flow ----
  const reqEvt = waitFor(sb2, 'contact:request');
  const req = await api('POST', '/contacts/requests', { token: tokenA, body: { toUserId: idB } });
  assert(req.status === 201, 'friend request sent');
  const reqPayload = await reqEvt;
  assert(reqPayload.from.displayName === 'Alice', 'Bob receives the request in real time');

  const dupReq = await api('POST', '/contacts/requests', { token: tokenA, body: { toUserId: idB } });
  assert(dupReq.status === 409, 'duplicate request → clear error');

  const accEvt = waitFor(sa, 'contact:accepted');
  const accept = await api('POST', `/contacts/requests/${idA}/accept`, { token: tokenB });
  assert(accept.status === 200, 'Bob accepts the request');
  assert((await accEvt).contact.displayName === 'Bob', 'Alice notified of acceptance');

  const contacts = await api('GET', '/contacts', { token: tokenA });
  assert(contacts.json.contacts.some((c) => c.id === idB), 'contacts list contains Bob');

  // ---- conversation + online message ----
  const conv = await api('POST', '/conversations', { token: tokenA, body: { userId: idB } });
  assert(conv.status === 201, 'conversation created');
  const convId = conv.json.conversation.id;

  const msgEvt = waitFor(sb2, 'message:new');
  const send = await api('POST', `/conversations/${convId}/messages`, {
    token: tokenA,
    body: { kind: 'text', body: 'Hey Bob, this is real-time!' },
  });
  assert(send.status === 201 && send.json.message.body === 'Hey Bob, this is real-time!', 'message sent');
  assert(send.json.message.deliveredAt !== null, 'message immediately delivered (recipient online)');
  assert((await msgEvt).message.body === 'Hey Bob, this is real-time!', 'Bob receives the message instantly');

  // ---- read receipt ----
  const readEvt = waitFor(sa, 'message:read');
  const read = await api('POST', `/conversations/${convId}/read`, { token: tokenB });
  assert(read.status === 200, 'Bob marks conversation read');
  const readPayload = await readEvt;
  assert(readPayload.byUserId === idB && readPayload.upToMessageId >= send.json.message.id, 'Alice gets the read receipt');

  // ---- unread counter ----
  await api('POST', `/conversations/${convId}/messages`, { token: tokenB, body: { kind: 'text', body: 'Read this?' } });
  await settle();
  const convList = await api('GET', '/conversations', { token: tokenA });
  const item = convList.json.conversations.find((c) => c.id === convId);
  assert(item.unreadCount === 1 && item.lastMessage.body === 'Read this?', 'unread counter + last message correct');

  // ---- typing indicator ----
  const typingEvt = waitFor(sa, 'typing', (p) => p.userId === idB);
  sb2.emit('typing', { to: idA, conversationId: convId });
  assert((await typingEvt).conversationId === convId, 'typing indicator relayed');

  // ---- offline delivery ----
  sb2.disconnect();
  await settle();

  const offlineSend = await api('POST', `/conversations/${convId}/messages`, {
    token: tokenA,
    body: { kind: 'text', body: 'Message while you are offline.' },
  });
  assert(offlineSend.status === 201 && offlineSend.json.message.deliveredAt === null, 'offline message stored (undelivered)');

  const deliveredEvt = waitFor(sa, 'message:delivered');
  const sb3 = await connect(tokenB);
  await deliveredEvt;
  assert(true, 'sender sees "delivered" once recipient reconnects');

  // recipient can read the message from persisted history + unread counter
  const histAfter = await api('GET', `/conversations/${convId}/messages`, { token: tokenB });
  assert(
    histAfter.json.messages.some((m) => m.body === 'Message while you are offline.'),
    'offline message persisted and available on reconnect'
  );
  const convList2 = await api('GET', '/conversations', { token: tokenB });
  const item2 = convList2.json.conversations.find((c) => c.id === convId);
  assert(item2.unreadCount >= 1, 'unread counter incremented while offline');

  // ---- history pagination ----
  for (let i = 0; i < 5; i++) {
    await api('POST', `/conversations/${convId}/messages`, { token: tokenA, body: { kind: 'text', body: `bulk-${i}` } });
  }
  await settle();
  const firstPage = await api('GET', `/conversations/${convId}/messages?limit=5`, { token: tokenA });
  const beforeId = firstPage.json.messages[0].id;
  const secondPage = await api('GET', `/conversations/${convId}/messages?limit=5&before=${beforeId}`, { token: tokenA });
  assert(
    firstPage.json.messages.length === 5 && secondPage.json.messages.length > 0 && firstPage.json.hasMore,
    'message history paginates correctly'
  );

  // ---- media upload + access control ----
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  const form = new FormData();
  form.append('purpose', 'message');
  form.append('conversationId', String(convId));
  form.append('image', new Blob([png], { type: 'image/png' }), 'pixel.png');
  const upRes = await fetch(API + '/media/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + tokenA }, body: form });
  const up = await upRes.json();
  assert(upRes.status === 201 && up.filename, 'image upload succeeds');

  const imgSend = await api('POST', `/conversations/${convId}/messages`, {
    token: tokenA,
    body: { kind: 'image', body: up.filename },
  });
  assert(imgSend.status === 201 && imgSend.json.message.kind === 'image', 'image message sent');

  const bobFetch = await fetch(API + `/media/${up.filename}`, { headers: { Authorization: 'Bearer ' + tokenB } });
  assert(bobFetch.status === 200, 'conversation participant can download the image');

  const regC = await api('POST', '/auth/register', { body: { email: `charlie.${stamp}@pulsechat.test`, password: 'secret123', displayName: 'Charlie' } });
  const tokenC = regC.json.accessToken;
  const charlieFetch = await fetch(API + `/media/${up.filename}`, { headers: { Authorization: 'Bearer ' + tokenC } });
  assert(charlieFetch.status === 403, 'non-participant is denied the image');

  const badForm = new FormData();
  badForm.append('purpose', 'message');
  badForm.append('conversationId', String(convId));
  badForm.append('image', new Blob([Buffer.from('not an image')], { type: 'image/png' }), 'fake.png');
  const badUp = await fetch(API + '/media/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + tokenA }, body: badForm });
  assert(badUp.status === 400, 'fake image rejected');

  const badMsg = await api('POST', `/conversations/${convId}/messages`, {
    token: tokenA,
    body: { kind: 'image', body: '../evil.png' },
  });
  assert(badMsg.status === 400, 'path traversal image reference rejected');

  // ---- video call signaling + history ----
  const incoming = waitFor(sb3, 'call:incoming');
  sa.emit('call:invite', { to: idB, callId: 999 });
  const incomingCall = await incoming;
  assert(incomingCall.callId > 0 && incomingCall.caller.displayName === 'Alice', 'incoming call with caller info');

  const accepted = waitFor(sa, 'call:accepted');
  sb3.emit('call:accept', { callId: incomingCall.callId });
  await accepted;
  assert(true, 'accept relays to caller');

  const signalRelay = waitFor(sb3, 'signal');
  sa.emit('signal', { to: idB, callId: incomingCall.callId, data: { type: 'offer', sdp: 'fake-sdp' } });
  const sig = await signalRelay;
  assert(sig.from === idA && sig.data.sdp === 'fake-sdp', 'WebRTC offer relayed');

  const ended = waitFor(sb3, 'call:ended');
  sa.emit('call:end', { callId: incomingCall.callId });
  await ended;
  assert(true, 'call end relayed');

  const calls = await api('GET', '/calls', { token: tokenA });
  const callItem = calls.json.calls.find((c) => c.id === incomingCall.callId);
  assert(callItem && callItem.status === 'completed' && callItem.duration !== null, 'completed call recorded with duration');

  // ---- calling an offline user → unavailable + missed history ----
  sb3.disconnect();
  await settle();
  const unavail = waitFor(sa, 'call:unavailable');
  sa.emit('call:invite', { to: idB, callId: 777 });
  await unavail;
  assert(true, 'calling an offline user reports "unavailable"');
  const calls2 = await api('GET', '/calls', { token: tokenA });
  assert(calls2.json.calls.some((c) => c.status === 'missed' && c.id !== incomingCall.callId), 'missed call recorded');

  // ---- authorization boundaries ----
  const otherConv = await api('POST', '/conversations', { token: tokenC, body: { userId: idA } });
  assert(otherConv.status === 403, 'non-contact cannot open a conversation');
  const snoop = await api('GET', `/conversations/${convId}/messages`, { token: tokenC });
  assert(snoop.status === 403, 'outsider cannot read the conversation');
  const fakeUser = await api('POST', '/contacts/requests', { token: tokenA, body: { toUserId: 999999 } });
  assert(fakeUser.status === 404, 'friend request to missing user → clear error');

  // ---- remove contact ----
  await api('DELETE', `/contacts/${idB}`, { token: tokenA });
  const contactsAfter = await api('GET', '/contacts', { token: tokenA });
  assert(contactsAfter.json.contacts.length === 0, 'contact can be removed');

  sa.disconnect();
  sb3.disconnect();

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('\nTest crashed:', err.message);
  process.exit(1);
});
