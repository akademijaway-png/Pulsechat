'use strict';
/* Usability gate: proves login/register work in a normal browser AND in a
   sandboxed-preview simulation where localStorage, sessionStorage and
   cookies are all blocked (the embedded preview environment). */
const puppeteer = require('puppeteer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 420, height: 860 },
  });
  const results = [];
  const ok = (c, n) => results.push((c ? '✔' : '✘') + ' ' + n);

  const BLOCK_STORAGE = `
    const block = () => { throw new Error('storage blocked'); };
    try {
      Object.defineProperty(window, 'localStorage', { get: block, configurable: true });
      Object.defineProperty(window, 'sessionStorage', { get: block, configurable: true });
      Object.defineProperty(document, 'cookie', { get: block, set: block, configurable: true });
    } catch (e) {}
  `;

  // ===== TEST A: normal browser — no demo box, manual login works =====
  const ctxA = await browser.createBrowserContext();
  const pa = await ctxA.newPage();
  const errsA = [];
  pa.on('pageerror', (e) => errsA.push(e.message));
  await pa.goto('http://localhost:3000/', { waitUntil: 'networkidle2' });
  await pa.waitForSelector('.auth-card');
  await sleep(2500);
  ok(
    await pa.evaluate(() => !document.querySelector('#demo-hint')),
    'A1 no demo-account box on the login screen'
  );
  ok(
    await pa.evaluate(() => !!document.querySelector('#auth-form') && !!document.querySelector('.auth-tabs button:nth-child(2)')),
    'A2 login form + Create account tab present'
  );

  // ===== TEST B: storage-blocked — Google warns, manual login works =====
  // Create a real account first (via the API) so login has credentials to use.
  const creds = await (async () => {
    const email = 'login.' + Date.now().toString(36) + '@pulsechat.test';
    const r = await fetch('http://localhost:3000/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'secret123', displayName: 'Login Tester' }),
    });
    return { email };
  })();
  const ctxB = await browser.createBrowserContext();
  const pb = await ctxB.newPage();
  const errsB = [];
  pb.on('pageerror', (e) => errsB.push(e.message));
  await pb.evaluateOnNewDocument(BLOCK_STORAGE);
  await pb.goto('http://localhost:3000/', { waitUntil: 'networkidle2' });
  await pb.waitForSelector('.auth-card');
  await sleep(2500);
  ok(
    await pb.evaluate(() => {
      const s = document.querySelector('#google-status');
      return s && s.className.includes('warn');
    }),
    'B1 storage-blocked: Google shows clear warning (no silent fail)'
  );
  await pb.type('#auth-email', creds.email);
  await pb.type('#auth-pass', 'secret123');
  await pb.evaluate(() => document.querySelector('#auth-submit').click());
  try {
    await pb.waitForSelector('#shell', { timeout: 15000 });
    ok(true, 'B2 storage-blocked: manual login → shell works');
  } catch {
    ok(false, 'B2 storage-blocked: manual login FAILED');
  }

  // ===== TEST C: storage-blocked — register new account =====
  const pb2 = await ctxB.newPage();
  const errsC = [];
  pb2.on('pageerror', (e) => errsC.push(e.message));
  await pb2.evaluateOnNewDocument(BLOCK_STORAGE);
  await pb2.goto('http://localhost:3000/', { waitUntil: 'networkidle2' });
  await pb2.waitForSelector('.auth-card');
  const tabs = await pb2.$$('.auth-tabs button');
  await tabs[1].click();
  await pb2.type('#auth-name', 'Fresh User');
  await pb2.type('#auth-email', 'fresh.' + Date.now().toString(36) + '@pulsechat.test');
  await pb2.type('#auth-pass', 'secret123');
  await pb2.evaluate(() => document.querySelector('#auth-submit').click());
  try {
    await pb2.waitForSelector('#shell', { timeout: 15000 });
    ok(true, 'C1 storage-blocked: register new account → shell works');
  } catch {
    ok(false, 'C1 register FAILED');
  }

  console.log('\n=== USABILITY GATE ===');
  results.forEach((r) => console.log(' ' + r));
  console.log('page errors A:', errsA.length ? JSON.stringify(errsA) : 'none');
  console.log('page errors B:', errsB.length ? JSON.stringify(errsB) : 'none');
  console.log('page errors C:', errsC.length ? JSON.stringify(errsC) : 'none');
  const failed = results.filter((r) => r.startsWith('✘')).length;
  console.log(failed === 0 ? '\nALL PASS ✔' : `\n${failed} FAILED ✘`);
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('CRASH', e.message);
  process.exit(1);
});
