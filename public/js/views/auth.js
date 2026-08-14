'use strict';
/* Login / register / forgot-password / reset-password views. */

import { api, setSession, hasSession } from '../api.js';
import { el, toast } from '../ui.js';

let mode = 'login'; // login | register | forgot | reset
let resetToken = null;
let metaCache = null;

export function renderAuth(container, opts = {}) {
  mode = opts.mode || 'login';
  resetToken = opts.token || null;
  container.replaceChildren(buildCard());
}

function buildCard() {
  const card = el('div', { class: 'auth-card' });

  card.append(
    el('div', { class: 'auth-brand' }, [
      el('img', { src: '/assets/logo.svg', class: 'logo', alt: '' }),
      el('div', {}, [
        el('h1', { text: 'PulseChat' }),
        el('p', { text: 'Fast, secure messaging with a pulse.' }),
      ]),
    ])
  );

  const body = el('div', { id: 'auth-body' });
  renderBody(body);
  card.append(body);
  return card;
}

function setMode(next, token) {
  mode = next;
  resetToken = token || null;
  const body = document.getElementById('auth-body');
  if (body) renderBody(body);
}

function renderBody(body) {
  body.replaceChildren();
  if (mode === 'forgot') return renderForgot(body);
  if (mode === 'reset') return renderReset(body);
  renderLoginRegister(body);
}

function renderLoginRegister(body) {
  const isLogin = mode === 'login';

  body.append(
    el('div', { class: 'auth-tabs' }, [
      el('button', { class: isLogin ? 'active' : '', text: 'Log in', onclick: () => setMode('login') }),
      el('button', { class: !isLogin ? 'active' : '', text: 'Create account', onclick: () => setMode('register') }),
    ])
  );

  const errorBox = el('div', { id: 'auth-error', class: 'form-error hidden' });
  body.append(errorBox);

  // Google sign-in (only for login / register modes)
  if (isLogin || mode === 'register') {
    body.append(googleSection());
  }

  const form = el('form', { id: 'auth-form', onsubmit: (e) => e.preventDefault() });
  form.append(
    el('div', { class: 'field' }, [
      el('label', { text: 'Email' }),
      el('input', { class: 'input', type: 'email', id: 'auth-email', placeholder: 'you@example.com', autocomplete: 'email', required: true }),
    ])
  );
  if (!isLogin) {
    form.append(
      el('div', { class: 'field' }, [
        el('label', { text: 'Display name' }),
        el('input', { class: 'input', type: 'text', id: 'auth-name', placeholder: 'How friends will see you', maxlength: '60', required: true }),
      ]),
      el('div', { class: 'field' }, [
        el('label', { text: 'Password' }),
        el('input', { class: 'input', type: 'password', id: 'auth-pass', placeholder: 'At least 8 chars, with letters & numbers', autocomplete: 'new-password', required: true }),
      ])
    );
  } else {
    form.append(
      el('div', { class: 'field' }, [
        el('label', { text: 'Password' }),
        el('input', { class: 'input', type: 'password', id: 'auth-pass', placeholder: 'Your password', autocomplete: 'current-password', required: true }),
      ])
    );
  }
  form.append(
    el('button', { class: 'btn btn-primary btn-block btn-lg', type: 'submit', id: 'auth-submit', text: isLogin ? 'Log in' : 'Create account' })
  );
  form.addEventListener('submit', submitAuth);
  body.append(form);

  body.append(
    el('div', { class: 'auth-alt' }, isLogin
      ? [
          el('span', { text: 'Forgot your password? ' }),
          el('a', { text: 'Reset it', onclick: () => setMode('forgot') }),
        ]
      : [
          el('span', { text: 'Already have an account? ' }),
          el('a', { text: 'Log in', onclick: () => setMode('login') }),
        ])
  );

  initGoogle();
}

/* ---------------- Google sign-in (Gmail) ---------------- */

function googleSection() {
  return el('div', { id: 'google-section', class: 'hidden' }, [
    el('div', { id: 'google-btn' }),
    el('div', { class: 'divider-or' }, [el('span', { text: 'or' })]),
  ]);
}

function loadGsiScript() {
  return new Promise((resolve, reject) => {
    if (window.google && window.google.accounts) return resolve();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error('gsi-load-failed'));
    document.head.appendChild(s);
  });
}

async function loadMeta() {
  if (metaCache) return metaCache;
  try {
    metaCache = await api.get('/auth/meta');
  } catch {
    metaCache = { google: { enabled: false }, demoAccounts: [] };
  }
  return metaCache;
}

let gsiInitialized = false;

async function initGoogle() {
  const meta = await loadMeta();
  const section = document.getElementById('google-section');
  if (!section) return;
  if (!meta.google || !meta.google.enabled) return; // not configured — stay hidden

  try {
    await loadGsiScript();
    if (!gsiInitialized) {
      window.google.accounts.id.initialize({
        client_id: meta.google.clientId,
        callback: handleGoogleCredential,
        auto_select: false,
        cancel_on_tap_outside: true,
      });
      gsiInitialized = true;
    }
    window.google.accounts.id.renderButton(document.getElementById('google-btn'), {
      theme: 'outline',
      size: 'large',
      shape: 'pill',
      text: 'continue_with',
      width: 300,
      logo_alignment: 'left',
    });
    section.classList.remove('hidden');
  } catch {
    // Google's script couldn't load here (e.g. offline or sandboxed preview).
    // Keep the screen clean — the email/password form below is unaffected.
    section.classList.add('hidden');
  }
}

async function handleGoogleCredential(response) {
  const errorBox = document.getElementById('auth-error');
  const showError = (msg) => {
    if (errorBox) {
      errorBox.textContent = msg;
      errorBox.classList.remove('hidden');
    }
  };
  try {
    const data = await api.post('/auth/google', { credential: response.credential });
    setSession(data.accessToken, data.refreshToken);
    toast(`Welcome${data.user.displayName ? ', ' + data.user.displayName : ''}! 🎉`, 'success');
    await afterAuthed();
  } catch (err) {
    showError(err.message);
  }
}

/** Shared post-auth navigation with a visible failsafe (no silent failures). */
async function afterAuthed() {
  window.dispatchEvent(new Event('pc:authed'));
  location.hash = '#/chats';
  // If the app shell still hasn't appeared shortly after, surface the problem.
  await new Promise((r) => setTimeout(r, 2500));
  if (!document.getElementById('shell') && hasSession()) {
    toast('Logged in, but the app couldn\'t finish loading here. Try opening http://localhost:3000 directly.', 'error', 6000);
  }
}

async function submitAuth(e) {
  e.preventDefault();
  const form = e.target;
  const email = form.querySelector('#auth-email').value.trim();
  const pass = form.querySelector('#auth-pass').value;
  const errorBox = document.getElementById('auth-error');
  const btn = form.querySelector('#auth-submit');

  const showError = (msg) => {
    errorBox.textContent = msg;
    errorBox.classList.remove('hidden');
  };

  errorBox.classList.add('hidden');
  btn.disabled = true;
  const original = btn.textContent;
  btn.innerHTML = '<span class="spinner" style="width:18px;height:18px"></span>';

  try {
    if (mode === 'login') {
      const data = await api.post('/auth/login', { email, password: pass });
      setSession(data.accessToken, data.refreshToken);
      await afterAuthed();
    } else {
      const name = form.querySelector('#auth-name').value.trim();
      if (name.length < 2) {
        showError('Display name must be at least 2 characters.');
        btn.disabled = false;
        btn.textContent = original;
        return;
      }
      const data = await api.post('/auth/register', { email, password: pass, displayName: name });
      setSession(data.accessToken, data.refreshToken);
      toast(`Welcome to PulseChat, ${data.user.displayName}! 🎉`, 'success');
      await afterAuthed();
    }
  } catch (err) {
    // A non-API error (e.g. fetch failed) means the server is unreachable —
    // say that clearly instead of a cryptic browser error.
    const msg = err && err.status ? err.message : "Can't reach the server. Check your internet connection and try again.";
    showError(msg);
    btn.disabled = false;
    btn.textContent = original;
  }
}

function renderForgot(body) {
  body.append(
    el('h3', { style: 'font-size:18px;margin-bottom:8px', text: 'Reset your password' }),
    el('p', { style: 'font-size:13.5px;color:var(--text-dim);margin-bottom:16px;line-height:1.5', text: "Enter your account email and we'll send you a reset link." })
  );
  const box = el('div', { id: 'auth-error', class: 'form-error hidden' });
  const okBox = el('div', { id: 'auth-ok', class: 'form-ok hidden' });
  body.append(box, okBox);

  const form = el('form', { onsubmit: (e) => e.preventDefault() }, [
    el('div', { class: 'field' }, [
      el('label', { text: 'Email' }),
      el('input', { class: 'input', type: 'email', id: 'forgot-email', placeholder: 'you@example.com', required: true }),
    ]),
    el('button', { class: 'btn btn-primary btn-block', type: 'submit', id: 'forgot-submit', text: 'Send reset link' }),
  ]);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('#forgot-submit');
    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
      const res = await api.post('/auth/reset/request', { email: form.querySelector('#forgot-email').value.trim() });
      okBox.textContent = res.message || 'If an account exists, a reset link has been sent.';
      okBox.classList.remove('hidden');
      // In development the server exposes a clickable link — show it.
      if (res.devResetUrl) {
        const link = el('div', { style: 'margin-top:8px;font-size:12.5px' }, [
          el('span', { text: 'Dev link: ' }),
          el('a', { href: res.devResetUrl, style: 'color:var(--accent);word-break:break-all', text: res.devResetUrl }),
        ]);
        okBox.append(link);
      }
    } catch (err) {
      box.textContent = err.message;
      box.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Send reset link';
    }
  });
  body.append(form);
  body.append(el('div', { class: 'auth-alt' }, [el('a', { text: '← Back to login', onclick: () => setMode('login') })]));
}

function renderReset(body) {
  body.append(
    el('h3', { style: 'font-size:18px;margin-bottom:8px', text: 'Choose a new password' }),
    el('p', { style: 'font-size:13.5px;color:var(--text-dim);margin-bottom:16px', text: 'Min 8 characters, with at least one letter and one number.' })
  );
  const box = el('div', { id: 'auth-error', class: 'form-error hidden' });
  const okBox = el('div', { id: 'auth-ok', class: 'form-ok hidden' });
  body.append(box, okBox);

  const form = el('form', { onsubmit: (e) => e.preventDefault() }, [
    el('div', { class: 'field' }, [
      el('label', { text: 'New password' }),
      el('input', { class: 'input', type: 'password', id: 'reset-pass', placeholder: 'New password', required: true }),
    ]),
    el('button', { class: 'btn btn-primary btn-block', type: 'submit', text: 'Reset password' }),
  ]);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const res = await api.post('/auth/reset/confirm', {
        token: resetToken,
        newPassword: form.querySelector('#reset-pass').value,
      });
      okBox.textContent = res.message || 'Password updated.';
      okBox.classList.remove('hidden');
      body.querySelector('#auth-ok').append(
        el('div', { style: 'margin-top:10px' }, [
          el('a', { class: 'btn btn-primary btn-sm', text: 'Go to log in', onclick: () => setMode('login') }),
        ])
      );
    } catch (err) {
      box.textContent = err.message;
      box.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Reset password';
    }
  });
  body.append(form);
}
