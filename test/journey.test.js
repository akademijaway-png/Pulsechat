'use strict';
/* New-user journey: create a REAL account, land in the app, get the
   onboarding, find someone, send a request, accept it, and chat. */
const puppeteer = require('puppeteer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 420, height: 860, isMobile: true, hasTouch: true },
  });
  const results = [];
  const ok = (c, n) => results.push((c ? '✔' : '✘') + ' ' + n);
  const errs = [];

  const ctxA = await browser.createBrowserContext();
  const ctxB = await browser.createBrowserContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  a.on('pageerror', (e) => errs.push('A: ' + e.message));
  b.on('pageerror', (e) => errs.push('B: ' + e.message));
  const click = (p, s) => p.evaluate((sel) => { const el = document.querySelector(sel); if (el) el.click(); }, s);

  // ---- Alice creates her OWN account (register tab) ----
  const email = 'new.user.' + Date.now().toString(36) + '@pulsechat.test';
  await a.goto('http://localhost:3000/', { waitUntil: 'networkidle2' });
  await a.waitForSelector('.auth-card');
  await sleep(2000);
  // demo box is present but tucked; go straight to Create account tab
  const tabs = await a.$$('.auth-tabs button');
  await tabs[1].click(); // Create account
  await a.type('#auth-name', 'New User Alice');
  await a.type('#auth-email', email);
  await a.type('#auth-pass', 'secret123');
  await click(a, '#auth-submit');
  try {
    await a.waitForSelector('#shell', { timeout: 15000 });
    ok(true, '1. New account created → app shell appears');
  } catch {
    ok(false, '1. Shell FAILED — body: ' + (await a.evaluate(() => document.body.innerText.slice(0, 200))));
  }
  await sleep(1500);
  ok(
    await a.evaluate(() => document.body.textContent.includes('Welcome,') && document.body.textContent.includes('Find people')),
    '2. Onboarding welcome shows with next steps'
  );

  // ---- Bob registers too ----
  const bobEmail = 'new.bob.' + Date.now().toString(36) + '@pulsechat.test';
  await b.goto('http://localhost:3000/', { waitUntil: 'networkidle2' });
  await b.waitForSelector('.auth-card');
  const tabsB = await b.$$('.auth-tabs button');
  await tabsB[1].click();
  await b.type('#auth-name', 'New User Bob');
  await b.type('#auth-email', bobEmail);
  await b.type('#auth-pass', 'secret123');
  await click(b, '#auth-submit');
  await b.waitForSelector('#shell', { timeout: 15000 });

  // ---- Alice finds Bob and sends a request ----
  await click(a, '.tab[data-tab="people"]');
  await a.waitForSelector('#people-search');
  await a.focus('#people-search');
  await a.type('#people-search', bobEmail);
  await a.waitForFunction(
    (em) => { const r = document.querySelector('#search-results'); return r && r.textContent.includes(em); },
    { timeout: 9000 },
    bobEmail
  );
  await a.evaluate((em) => {
    const r = document.querySelector('#search-results');
    const row = Array.from(r.querySelectorAll('.user-row')).find((x) => x.textContent.includes(em));
    if (row) row.querySelector('button').click();
  }, bobEmail);
  await sleep(900);
  ok(
    await a.evaluate(() => document.body.textContent.includes('Request sent')),
    '3. Alice searched for Bob and sent a friend request'
  );

  // ---- Bob accepts ----
  await click(b, '.tab[data-tab="people"]');
  await b.waitForSelector('.btn-success', { timeout: 8000 });
  await click(b, '.btn-success');
  await sleep(1200);
  ok(true, '4. Bob saw and accepted the request');

  // ---- Alice starts chatting from People ----
  await a.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('.icon-btn[title="Message"]'));
    if (btns[0]) btns[0].click();
  });
  await a.waitForSelector('#composer-input', { timeout: 9000 });
  await a.focus('#composer-input');
  await a.type('#composer-input', 'Hi Bob, my first real message! 🎉');
  await click(a, '#composer-send');
  await sleep(700);
  ok(
    await a.evaluate(() => Array.from(document.querySelectorAll('.msg-group .bubble')).some((x) => x.textContent.includes('my first real message'))),
    '5. Alice sent her first real message in the chat'
  );
  // Bob opens the conversation (unread badge in Chats) and sees the message
  await click(b, '.tab[data-tab="chats"]');
  await b.waitForSelector('.conv-item', { timeout: 8000 });
  const unreadShown = await b.evaluate(() => !!document.querySelector('.conv-item .badge'));
  ok(unreadShown, '6a. Bob\'s Chats shows the new conversation with an unread badge');
  await click(b, '.conv-item');
  await b.waitForSelector('#composer-input', { timeout: 8000 });
  ok(
    await b.waitForFunction(
      () => Array.from(document.querySelectorAll('.msg-group .bubble')).some((x) => x.textContent.includes('my first real message')),
      { timeout: 10000 }
    ).then(() => true).catch(() => false),
    '6b. Bob opens the chat and sees the message in real time'
  );

  console.log('\n=== NEW-USER JOURNEY ===');
  results.forEach((r) => console.log(' ' + r));
  console.log('page errors:', errs.length ? JSON.stringify(errs) : 'none');
  const failed = results.filter((r) => r.startsWith('✘')).length;
  console.log(failed === 0 ? '\nALL PASS ✔ — account creation → chatting works end to end' : `\n${failed} FAILED`);
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('CRASH', e.message);
  process.exit(1);
});
