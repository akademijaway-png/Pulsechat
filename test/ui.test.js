'use strict';
/**
 * Browser end-to-end test: two isolated contexts (Alice & Bob) exercise the
 * real UI — registration, search, friend request, messaging, read receipts,
 * presence, image upload, and a video call attempt.
 *
 * Usage: node test/ui.test.js
 */
const puppeteer = require('puppeteer');
const fs = require('fs');

const BASE = 'http://localhost:3000';
let passed = 0;
let failed = 0;
const assert = (cond, name, extra) => {
  if (cond) {
    passed++;
    console.log('  ✔', name);
  } else {
    failed++;
    console.error('  ✘', name, extra !== undefined ? `(${extra})` : '');
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const stamp = Date.now().toString(36);
const ALICE = { email: `ui.alice.${stamp}@pulsechat.test`, pass: 'secret123', name: 'UI Alice' };
const BOB = { email: `ui.bob.${stamp}@pulsechat.test`, pass: 'secret123', name: 'UI Bob' };

/* Puppeteer touch emulation can mis-hit-test; dispatch clicks in-page instead. */
const click = (page, selector) => page.evaluate((s) => { const el = document.querySelector(s); if (el) el.click(); }, selector);
const type = (page, selector, text) => page.focus(selector).then(() => page.type(selector, text));

async function register(page, user) {
  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.auth-card', { timeout: 10000 });
  const tabs = await page.$$('.auth-tabs button');
  await tabs[1].click();
  await page.type('#auth-name', user.name);
  await page.type('#auth-email', user.email);
  await page.type('#auth-pass', user.pass);
  await click(page, '#auth-submit');
  await page.waitForSelector('#shell', { timeout: 12000 });
  return true;
}

async function searchAndRequest(page, email) {
  await click(page, '.tab[data-tab="people"]');
  await page.waitForSelector('#people-search', { timeout: 8000 });
  await type(page, '#people-search', email);
  await page.waitForFunction(
    (em) => {
      const results = document.querySelector('#search-results');
      return results && results.textContent.includes(em);
    },
    { timeout: 9000 },
    email
  );
  // click the Add button of the row matching this exact email
  const clicked = await page.evaluate((em) => {
    const results = document.querySelector('#search-results');
    if (!results) return 'no results box';
    const row = Array.from(results.querySelectorAll('.user-row')).find((r) => r.textContent.includes(em));
    if (!row) return 'row not found';
    const btn = row.querySelector('button');
    if (!btn) return 'no button';
    btn.click();
    return 'clicked';
  }, email);
  if (clicked !== 'clicked') throw new Error('Add click failed: ' + clicked);
  try {
    await page.waitForFunction(() => document.body.textContent.includes('Request sent'), { timeout: 8000 });
  } catch (err) {
    const dump = await page.evaluate(() => document.body.innerText.slice(0, 500).replace(/\n/g, ' | '));
    throw new Error('"Request sent" never appeared. Body: ' + dump);
  }
  return true;
}

async function acceptRequest(page) {
  await click(page, '.tab[data-tab="people"]');
  await page.waitForSelector('.btn-success', { timeout: 8000 });
  await click(page, '.btn-success');
  await sleep(800);
  return true;
}

async function openChatAndSend(page, message) {
  const inChat = await page.evaluate(() => !!document.querySelector('#composer-input'));
  if (!inChat) {
    // open the conversation from the People tab (creates it on first message)
    await click(page, '.tab[data-tab="people"]');
    await page.waitForSelector('.icon-btn[title="Message"]', { timeout: 8000 });
    await page.evaluate(() => document.querySelector('.icon-btn[title="Message"]').click());
    await page.waitForSelector('#composer-input', { timeout: 8000 });
  }
  await type(page, '#composer-input', message);
  await click(page, '#composer-send');
  return waitForBubble(page, message, 6000);
}

async function waitForBubble(page, text, timeout = 10000) {
  return page
    .waitForFunction(
      (t) => Array.from(document.querySelectorAll('.msg-group .bubble')).some((b) => b.textContent.includes(t)),
      { timeout },
      text
    )
    .then(() => true)
    .catch(() => false);
}

async function openChat(page) {
  await click(page, '.tab[data-tab="chats"]');
  await page.waitForSelector('.conv-item', { timeout: 8000 });
  await click(page, '.conv-item');
  await page.waitForSelector('#composer-input', { timeout: 8000 });
  return true;
}

async function main() {
  console.log(`\nPulseChat browser UI test against ${BASE}\n`);
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
    defaultViewport: { width: 420, height: 860, isMobile: true, hasTouch: true },
  });

  const ctxA = await browser.createBrowserContext();
  const ctxB = await browser.createBrowserContext();
  const alice = await ctxA.newPage();
  const bob = await ctxB.newPage();

  const errors = { a: [], b: [] };
  alice.on('pageerror', (e) => errors.a.push(e.message));
  bob.on('pageerror', (e) => errors.b.push(e.message));
  // GSI_LOGGER "origin is not allowed" fires in headless Chrome even when the
  // origin IS authorized (verified via Google's own endpoint) — it's a known
  // headless artifact, not an app bug. Filter it and CSP/Gsi style noise.
  const benign = (t) => /GSI_LOGGER|accounts\.google\.com\/gsi\/style/.test(t);
  alice.on('console', (m) => m.type() === 'error' && !benign(m.text()) && errors.a.push('[console] ' + m.text()));
  bob.on('console', (m) => m.type() === 'error' && !benign(m.text()) && errors.b.push('[console] ' + m.text()));

  // ---- registration ----
  assert(await register(alice, ALICE), 'Alice registers and lands in the app');
  assert(await register(bob, BOB), 'Bob registers and lands in the app');

  // ---- friend request ----
  assert(await searchAndRequest(alice, BOB.email), 'Alice finds Bob via search and sends a request');
  await sleep(700);
  assert(await acceptRequest(bob), 'Bob sees the request and accepts it');
  await sleep(700);

  // ---- online presence ----
  const bobOnlineInAlice = await alice.evaluate(() =>
    Array.from(document.querySelectorAll('.conv-item, .user-row')).some(
      (n) => n.textContent.includes('UI Bob') && n.querySelector('.dot-online')
    )
  );
  assert(bobOnlineInAlice, 'Alice sees Bob as online (green dot)');

  // ---- messaging + read receipt ----
  assert(await openChatAndSend(alice, 'Hello Bob, this is real!'), 'Alice sends a message in the chat');
  assert(await openChat(bob), 'Bob opens the conversation (unread badge drives him there)');
  assert(await waitForBubble(bob, 'Hello Bob, this is real!'), 'Bob sees the message when he opens the chat');

  await sleep(1200);
  const blueTick = await alice.evaluate(() => {
    const bubbles = Array.from(document.querySelectorAll('.msg-group.out'));
    const last = bubbles[bubbles.length - 1];
    return !!(last && last.querySelector('.tick.read'));
  });
  assert(blueTick, 'Alice sees the read receipt (blue double check)');

  // ---- reply + typing indicator ----
  const typingSeen = alice
    .waitForSelector('.typing-bubble', { timeout: 7000 })
    .then(() => true)
    .catch(() => false);
  await type(bob, '#composer-input', 'Typing right now…');
  await sleep(400);
  assert(await typingSeen, 'Alice sees Bob typing in real time');
  await click(bob, '#composer-send');
  await sleep(300);

  // ---- image message ----
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  const tmp = '/tmp/pc-upload.png';
  fs.writeFileSync(tmp, png);
  const chooserPromise = alice.waitForFileChooser({ timeout: 8000 });
  await alice.evaluate(() => {
    const btn = document.querySelector('.composer .icon-btn[title*="gallery"]');
    btn.click();
  });
  const chooser = await chooserPromise;
  await chooser.accept([tmp]);
  const imgLoaded = await alice
    .waitForFunction(() => document.querySelectorAll('.msg-group .bubble.image img').length > 0, { timeout: 12000 })
    .then(() => true)
    .catch(() => false);
  assert(imgLoaded, 'Alice uploads & sends an image (rendered in chat)');
  const bobImg = await bob
    .waitForFunction(() => document.querySelectorAll('.msg-group .bubble.image img').length > 0, { timeout: 12000 })
    .then(() => true)
    .catch(() => false);
  assert(bobImg, 'Bob receives the image message in real time');

  // ---- offline presence ----
  await bob.close();
  await sleep(1200);
  const bobOffline = await alice.evaluate(() => {
    const items = Array.from(document.querySelectorAll('.conv-item'));
    const item = items.find((n) => n.textContent.includes('UI Bob'));
    return !item || !item.querySelector('.dot-online');
  });
  assert(bobOffline, 'Alice sees Bob go offline automatically');

  // ---- offline message delivery ----
  assert(await openChatAndSend(alice, 'Message while you are offline.'), 'Alice sends a message while Bob is offline');

  // ---- video call (callee must be online first) ----
  const bob2 = await ctxB.newPage();
  bob2.on('pageerror', (e) => errors.b.push(e.message));
  await bob2.goto(BASE, { waitUntil: 'networkidle2' });
  await bob2.waitForSelector('#shell', { timeout: 10000 }); // persisted session — auto-logged-in
  await sleep(2500); // wait for socket to register so Alice sees Bob online

  // wait until Alice's UI reflects Bob online before calling
  await alice
    .waitForFunction(() => {
      const items = Array.from(document.querySelectorAll('.conv-item'));
      const item = items.find((n) => n.textContent.includes('UI Bob'));
      return item && item.querySelector('.dot-online');
    }, { timeout: 8000 })
    .catch(() => {});
  await sleep(300);

  await alice.evaluate(() => document.querySelector('.chat-header .icon-btn[title*="video"]').click());
  await alice.waitForSelector('.call-screen', { timeout: 6000 });
  const outgoing = await alice.evaluate(() => document.body.textContent.includes('Ringing'));
  assert(outgoing, 'Alice sees the outgoing ringing call screen');

  const incoming = await bob2
    .waitForSelector('.call-screen .call-btn.accept', { timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  assert(incoming, 'Bob sees the incoming call screen');

  if (incoming) {
    await bob2.evaluate(() => document.querySelector('.call-btn.accept').click());
    await sleep(3000);
    const aliceActive = await alice.evaluate(() => !!document.querySelector('.call-btn.end'));
    const bobActive = await bob2.evaluate(() => !!document.querySelector('.call-btn.end'));
    assert(aliceActive && bobActive, 'Both sides show the active call UI (controls)');
    const remoteVideoAlice = await alice.evaluate(() => {
      const v = document.getElementById('remoteVideo');
      return !!(v && v.srcObject && v.srcObject.getVideoTracks().length);
    });
    assert(remoteVideoAlice, 'Alice receives Bob\'s video track (WebRTC connected)');
    await alice.evaluate(() => {
      const btn = document.querySelector('.call-btn.end');
      if (btn) btn.click();
    });
    await sleep(1200);
    const aliceClosed = await alice.evaluate(() => !document.querySelector('.call-screen'));
    assert(aliceClosed, 'Call ends and the UI closes');
  }

  // ---- call history ----
  await click(alice, '.tab[data-tab="calls"]');
  await sleep(1200);
  const hasHistory = await alice.evaluate(() => document.body.textContent.includes('UI Bob'));
  assert(hasHistory, 'Call history shows the recent call');

  // ---- console / page errors ----
  const uniqueA = [...new Set(errors.a)];
  const uniqueB = [...new Set(errors.b)];
  if (uniqueA.length || uniqueB.length) {
    console.error('  ✘ Page errors:', JSON.stringify({ alice: uniqueA, bob: uniqueB }, null, 1));
    failed++;
  } else {
    assert(true, 'no uncaught errors in either client');
  }

  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('\nUI test crashed:', err.message);
  process.exit(1);
});
