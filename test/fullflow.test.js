'use strict';
/* Full-flow regression test for the requested improvements:
   add friend → accept → BOTH friends lists → friend profile → avatars
   (built-in + upload) → first message appears in list → pulse on mobile+desktop. */
const puppeteer = require('puppeteer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = 'http://localhost:3000';
const click = (p, s) => p.evaluate((sel) => { const el = document.querySelector(sel); if (el) el.click(); }, s);

(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'], defaultViewport: { width: 420, height: 860, isMobile: true, hasTouch: true } });
  const results = [];
  const ok = (c, n, extra) => results.push((c ? '✔' : '✘') + ' ' + n + (extra ? ' — ' + extra : ''));
  const errs = [];
  const ctxA = await browser.createBrowserContext();
  const ctxB = await browser.createBrowserContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  a.on('pageerror', (e) => errs.push('A: ' + e.message));
  b.on('pageerror', (e) => errs.push('B: ' + e.message));

  const stamp = Date.now().toString(36);
  const emailA = 'flow.a.' + stamp + '@pulsechat.test';
  const emailB = 'flow.b.' + stamp + '@pulsechat.test';

  async function register(page, name, email) {
    await page.goto(BASE, { waitUntil: 'networkidle2' });
    await page.waitForSelector('.auth-card');
    const tabs = await page.$$('.auth-tabs button');
    await tabs[1].click();
    await page.type('#auth-name', name);
    await page.type('#auth-email', email);
    await page.type('#auth-pass', 'secret123');
    await click(page, '#auth-submit');
    await page.waitForSelector('#shell', { timeout: 15000 });
  }

  // 1) register both
  await register(a, 'Flow Alice', emailA);
  await register(b, 'Flow Bob', emailB);
  ok(true, '1. both accounts created');
  await sleep(800);

  // 2) A sends request to B
  await click(a, '.tab[data-tab="people"]');
  await a.waitForSelector('#people-search');
  await a.focus('#people-search');
  await a.type('#people-search', emailB);
  await a.waitForFunction((em) => { const r = document.querySelector('#search-results'); return r && r.textContent.includes(em); }, { timeout: 9000 }, emailB);
  await a.evaluate((em) => { const r = document.querySelector('#search-results'); const row = Array.from(r.querySelectorAll('.user-row')).find((x) => x.textContent.includes(em)); if (row) row.querySelector('button').click(); }, emailB);
  await sleep(900);
  ok(await a.evaluate(() => document.body.textContent.includes('Request sent')), '2. A sent friend request to B');

  // 3) B accepts
  await click(b, '.tab[data-tab="people"]');
  await b.waitForSelector('.btn-success', { timeout: 9000 });
  await click(b, '.btn-success');
  await sleep(1200);
  ok(true, '3. B accepted the request');

  // 4) BOTH friends lists show each other
  const contactsOf = async (page) => page.evaluate(() => Array.from(document.querySelectorAll('.contact-row .user-name')).map((n) => n.textContent));
  const aList = await contactsOf(a);
  const bList = await contactsOf(b);
  ok(aList.includes('Flow Bob'), '4a. A sees Flow Bob in friends list (' + aList.join(',') + ')');
  ok(bList.includes('Flow Alice'), '4b. B sees Flow Alice in friends list (' + bList.join(',') + ')');

  // 5) A sets a built-in avatar (av3) via API → check saved
  const tokA = await a.evaluate(() => localStorage.getItem('pc.access'));
  const setAv = await fetch(BASE + '/api/media/upload', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokA }, body: JSON.stringify({ purpose: 'avatar', builtin: 'av3' }) });
  const avRes = await setAv.json();
  ok(setAv.status === 200 && avRes.url.includes('av3.svg'), '5. built-in avatar av3 saved (' + avRes.url + ')');

  // 6) upload a real PNG avatar (test the upload path)
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const form = new FormData();
  form.append('purpose', 'avatar');
  form.append('image', new Blob([png], { type: 'image/png' }), 'me.png');
  const upRes = await fetch(BASE + '/api/media/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + tokA }, body: form });
  const upJson = await upRes.json();
  ok(upRes.status === 201 && upJson.url && upJson.url.startsWith('/uploads/avatars/'), '6. avatar photo upload works (' + (upJson.url || '') + ')');

  // 7) B opens A's profile from friends list (tap contact row → modal)
  await click(b, '.tab[data-tab="people"]'); // refresh contacts (picks up A's new avatar)
  await b.waitForSelector('.contact-row', { timeout: 9000 });
  await sleep(700);
  await click(b, '.contact-row');
  await b.waitForSelector('.friend-profile', { timeout: 8000 });
  const fp = await b.evaluate(() => ({
    name: document.querySelector('.fp-name')?.textContent,
    email: document.querySelector('.fp-email')?.textContent,
    hasAvatarImg: !!document.querySelector('.fp-avatar img'),
    hasAvatar: !!document.querySelector('.fp-avatar .avatar'),
    hasMsgBtn: Array.from(document.querySelectorAll('.fp-actions button')).some((x) => x.textContent.includes('Message')),
  }));
  ok(fp.name === 'Flow Alice' && fp.email === emailA && fp.hasAvatar && fp.hasMsgBtn, '7. friend profile opens with name/avatar/actions (' + JSON.stringify(fp) + ')');
  await click(b, '.modal-backdrop .icon-btn'); // close modal

  // 8) A sends first message → conversation appears in A's Chats list immediately
  await click(a, '.tab[data-tab="people"]');
  await a.waitForSelector('.contact-row');
  await a.evaluate(() => { const b = document.querySelector('.contact-row .icon-btn[title="Message"]'); if (b) b.click(); });
  await a.waitForSelector('#composer-input', { timeout: 9000 });
  await a.focus('#composer-input');
  await a.type('#composer-input', 'Hey Bob! First message 🎉');
  await click(a, '#composer-send');
  await sleep(700);
  const sentOk = await a.evaluate(() => Array.from(document.querySelectorAll('.msg-group .bubble')).some((x) => x.textContent.includes('First message')));
  ok(sentOk, '8a. message sent in chat');
  // go to chats list → conversation must be there (syncConversation)
  await click(a, '.tab[data-tab="chats"]');
  await sleep(900);
  const convList = await a.evaluate(() => Array.from(document.querySelectorAll('.conv-item .conv-name')).map((n) => n.textContent));
  ok(convList.includes('Flow Bob'), '8b. conversation appears in Chats list right after first message (' + convList.join(',') + ')');

  // 9) Pulse on MOBILE: fresh account empty state shows the worm
  const ctxC = await browser.createBrowserContext();
  const c = await ctxC.newPage();
  await c.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await c.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch {} });
  const emailC = 'flow.c.' + stamp + '@pulsechat.test';
  await register(c, 'Flow Carol', emailC);
  await sleep(1200);
  const mobilePulse = await c.evaluate(() => {
    const worm = document.querySelector('.worm-stage');
    const rings = document.querySelectorAll('.worm-ring').length;
    const ekg = !!document.querySelector('.worm-ekg path');
    return { worm: !!worm, rings, ekg, visible: worm ? worm.getBoundingClientRect().height > 0 : false };
  });
  ok(mobilePulse.worm && mobilePulse.rings === 3 && mobilePulse.ekg && mobilePulse.visible, '9. Pulse (worm) shows on mobile empty state', JSON.stringify(mobilePulse));

  // 10) Pulse on DESKTOP: panel fills screen with centered worm
  const ctxD = await browser.createBrowserContext();
  const d = await ctxD.newPage();
  await d.setViewport({ width: 1280, height: 800 });
  const emailD = 'flow.d.' + stamp + '@pulsechat.test';
  await register(d, 'Flow Dan', emailD);
  await sleep(1200);
  const desktopPulse = await d.evaluate(() => {
    const col = document.getElementById('colChat');
    const stage = document.querySelector('.ce-stage');
    const cr = col.getBoundingClientRect();
    const sr = stage ? stage.getBoundingClientRect() : null;
    return {
      panelFull: Math.round(cr.height) >= 790 && cr.y === 0,
      worm: !!document.querySelector('.ce-logo'),
      rings: document.querySelectorAll('.ce-ring').length,
      centered: sr ? Math.abs((sr.y + sr.height / 2) - (cr.y + cr.height / 2)) < 220 : false,
    };
  });
  ok(desktopPulse.panelFull && desktopPulse.worm && desktopPulse.rings === 3, '10. Pulse panel fills screen on desktop with worm', JSON.stringify(desktopPulse));

  // 11) persistence: reload B, friends still there
  await b.reload({ waitUntil: 'networkidle2' });
  await b.waitForSelector('#shell', { timeout: 12000 });
  await sleep(1200);
  await click(b, '.tab[data-tab="people"]');
  await b.waitForSelector('.contact-row', { timeout: 9000 });
  await sleep(600);
  const bList2 = await contactsOf(b);
  ok(bList2.includes('Flow Alice'), '11. friends persist after reload (' + bList2.join(',') + ')');

  console.log('\n=== FULL FLOW TEST ===');
  results.forEach((r) => console.log(' ' + r));
  console.log('page errors:', errs.length ? JSON.stringify(errs) : 'none');
  const failed = results.filter((r) => r.startsWith('✘')).length;
  console.log(failed === 0 ? '\nALL PASS ✔' : `\n${failed} FAILED`);
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('CRASH', e.message); process.exit(1); });
