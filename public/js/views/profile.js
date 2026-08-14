'use strict';
/* Profile: avatar, display name, bio, preferences, security, logout. */

import state from '../state.js';
import { api, logoutRemote } from '../api.js';
import { el, esc, avatarHtml, toast, setTheme } from '../ui.js';
import { icon } from '../icons.js';
import { pickImage, uploadImage } from '../media.js';
import { enable as enablePush, disable as disablePush } from '../notifications.js';
import { closeModal, openModal } from './calls.js';

let container = null;

export function render(host) {
  container = host;
  draw();
}

export function refresh() {
  draw();
}

function draw() {
  if (!container) return;
  const me = state.me;
  if (!me) return;
  container.replaceChildren(
    el('div', { class: 'fade-swap' }, [
      hero(me),
      accountGroup(me),
      prefsGroup(),
      securityGroup(),
      aboutGroup(),
      el('div', { style: 'padding: 6px 14px 30px' }, [
        el('button', {
          class: 'btn btn-danger btn-block',
          html: icon('logout') + '<span>Log out</span>',
          onclick: doLogout,
        }),
      ]),
    ])
  );
}

function hero(me) {
  return el('div', { class: 'profile-hero' }, [
    el('span', { class: 'avatar-edit', onclick: changeAvatar }, [
      el('span', { class: 'avatar avatar-xl', html: me.avatar ? `<img src="${esc(me.avatar)}" alt="">` : esc(initials(me.displayName)) }),
      el('span', { class: 'camera-chip', html: icon('camera') }),
    ]),
    el('div', { class: 'profile-name', text: me.displayName }),
    el('div', { class: 'profile-email', text: me.email }),
    el('div', { class: 'profile-bio', text: me.bio || 'Tap edit to add a status.' }),
  ]);
}

function initials(name) {
  const p = String(name || '?').trim().split(/\s+/);
  return ((p[0]?.[0] || '?') + (p[1]?.[0] || '')).toUpperCase();
}

async function changeAvatar() {
  try {
    const file = await pickImage(false);
    const up = await uploadImage(file, { purpose: 'avatar' });
    state.me = { ...state.me, avatar: up.url };
    toast('Profile picture updated', 'success');
    draw();
    document.dispatchEvent(new CustomEvent('pc:me-updated'));
  } catch (err) {
    toast(err.message, 'error');
  }
}

function accountGroup(me) {
  return el('div', { class: 'settings-group' }, [
    el('div', { class: 'set-title', text: 'Account' }),
    el('div', {
      class: 'set-row',
      onclick: () =>
        editModal('Display name', me.displayName, 60, async (val) => {
          const d = await api.patch('/auth/profile', { displayName: val });
          state.me = { ...state.me, displayName: d.user.displayName };
          document.dispatchEvent(new CustomEvent('pc:me-updated'));
        }),
    }, [
      el('span', { class: 'set-icon primary', html: icon('profile') }),
      el('div', { class: 'set-label', text: 'Display name' }),
      el('span', { class: 'set-value', text: me.displayName }),
    ]),
    el('div', {
      class: 'set-row',
      onclick: () =>
        editModal('Status / bio', me.bio || '', 200, async (val) => {
          const d = await api.patch('/auth/profile', { bio: val });
          state.me = { ...state.me, bio: d.user.bio };
        }, true),
    }, [
      el('span', { class: 'set-icon accent', html: icon('zap') }),
      el('div', { class: 'set-label', text: 'Bio / status' }),
      el('span', { class: 'set-value', text: me.bio ? 'Set' : 'Empty' }),
    ]),
    el('div', { class: 'set-row' }, [
      el('span', { class: 'set-icon primary', html: icon('lock') }),
      el('div', { class: 'set-label', text: 'Email' }),
      el('span', { class: 'set-value', text: me.email }),
    ]),
  ]);
}

function prefsGroup() {
  return el('div', { class: 'settings-group' }, [
    el('div', { class: 'set-title', text: 'Notifications & appearance' }),
    el('div', { class: 'set-row' }, [
      el('span', { class: 'set-icon primary', html: icon('bell') }),
      el('div', { class: 'set-label' }, [
        el('div', { text: 'Push notifications' }),
        el('div', { class: 'set-sub', text: 'Alerts even when PulseChat is in the background' }),
      ]),
      el('span', {
        class: 'switch' + (state.notificationsEnabled ? ' on' : ''),
        onclick: togglePush,
      }),
    ]),
    el('div', { class: 'set-row' }, [
      el('span', { class: 'set-icon accent', html: icon('zap') }),
      el('div', { class: 'set-label' }, [
        el('div', { text: 'Message sounds' }),
        el('div', { class: 'set-sub', text: 'Play a subtle sound for new messages' }),
      ]),
      el('span', {
        class: 'switch' + (state.soundsOn ? ' on' : ''),
        onclick: function () {
          state.soundsOn = !state.soundsOn;
          this.className = 'switch' + (state.soundsOn ? ' on' : '');
          try {
            localStorage.setItem('pc.sounds', state.soundsOn ? '1' : '0');
          } catch {
            /* storage unavailable — ignore */
          }
        },
      }),
    ]),
    el('div', {
      class: 'set-row',
      onclick: function () {
        const next = state.theme === 'dark' ? 'light' : 'dark';
        state.theme = next;
        setTheme(next);
        this.querySelector('.set-value').textContent = next === 'dark' ? 'Dark' : 'Light';
      },
    }, [
      el('span', { class: 'set-icon primary', html: icon(state.theme === 'dark' ? 'moon' : 'sun') }),
      el('div', { class: 'set-label', text: 'Theme' }),
      el('span', { class: 'set-value', text: state.theme === 'dark' ? 'Dark' : 'Light' }),
    ]),
  ]);
}

async function togglePush() {
  const toggle = this;
  if (!state.notificationsEnabled) {
    const ok = await enablePush();
    if (ok) {
      state.notificationsEnabled = true;
      toggle.classList.add('on');
    }
  } else {
    await disablePush();
    state.notificationsEnabled = false;
    toggle.classList.remove('on');
    toast('Notifications disabled', 'info');
  }
}

function securityGroup() {
  return el('div', { class: 'settings-group' }, [
    el('div', { class: 'set-title', text: 'Security' }),
    el('div', { class: 'set-row', onclick: changePasswordModal }, [
      el('span', { class: 'set-icon danger', html: icon('lock') }),
      el('div', { class: 'set-label', text: 'Change password' }),
      el('span', { class: 'icon-btn', html: icon('chevron') }),
    ]),
    el('div', { class: 'set-row' }, [
      el('span', { class: 'set-icon accent', html: icon('shield') }),
      el('div', { class: 'set-label' }, [
        el('div', { text: 'Private by default' }),
        el('div', { class: 'set-sub', text: 'Conversations, media and presence are only visible to you' }),
      ]),
    ]),
  ]);
}

function aboutGroup() {
  return el('div', { class: 'settings-group' }, [
    el('div', { class: 'set-title', text: 'About' }),
    el('div', { class: 'set-row' }, [
      el('span', { class: 'set-icon primary', html: icon('info') }),
      el('div', { class: 'set-label', text: 'PulseChat' }),
      el('span', { class: 'set-value', text: 'v1.0.0' }),
    ]),
  ]);
}

function editModal(title, initial, max, onSave, multiline = false) {
  const input = multiline
    ? el('textarea', { class: 'input', id: 'edit-value', rows: 3, maxlength: String(max) })
    : el('input', { class: 'input', id: 'edit-value', maxlength: String(max), value: initial });
  if (multiline) input.value = initial;
  const body = el('div', {}, [
    el('div', { class: 'field' }, [el('label', { text: title }), input]),
    el('div', { style: 'display:flex;gap:10px;justify-content:flex-end' }, [
      el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: closeModal }),
      el('button', {
        class: 'btn btn-primary',
        text: 'Save',
        onclick: async () => {
          const val = input.value.trim();
          if (!val) return toast(`${title} cannot be empty.`, 'error');
          try {
            await onSave(val);
            toast('Saved', 'success');
            closeModal();
            draw();
          } catch (err) {
            toast(err.message, 'error');
          }
        },
      }),
    ]),
  ]);
  openModal(title, body);
  setTimeout(() => input.focus(), 50);
}

function changePasswordModal() {
  const cur = el('input', { class: 'input', type: 'password', id: 'pw-cur', placeholder: 'Current password', autocomplete: 'current-password' });
  const next = el('input', { class: 'input', type: 'password', id: 'pw-new', placeholder: 'New password (min 8, letters + numbers)', autocomplete: 'new-password' });
  const confirm = el('input', { class: 'input', type: 'password', id: 'pw-conf', placeholder: 'Repeat new password', autocomplete: 'new-password' });
  const body = el('div', {}, [
    el('div', { class: 'field' }, [el('label', { text: 'Current password' }), cur]),
    el('div', { class: 'field' }, [el('label', { text: 'New password' }), next]),
    el('div', { class: 'field' }, [el('label', { text: 'Confirm new password' }), confirm]),
    el('div', { style: 'display:flex;gap:10px;justify-content:flex-end' }, [
      el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: closeModal }),
      el('button', {
        class: 'btn btn-primary',
        text: 'Update password',
        onclick: async (e) => {
          const btn = e.currentTarget;
          if (next.value !== confirm.value) return toast('New passwords do not match.', 'error');
          btn.disabled = true;
          btn.textContent = 'Saving…';
          try {
            await api.post('/auth/password', { currentPassword: cur.value, newPassword: next.value });
            closeModal();
            toast('Password updated — please log in again.', 'success');
            setTimeout(doLogout, 900);
          } catch (err) {
            toast(err.message, 'error');
            btn.disabled = false;
            btn.textContent = 'Update password';
          }
        },
      }),
    ]),
  ]);
  openModal('Change password', body);
}

async function doLogout() {
  await logoutRemote();
  location.hash = '#/login';
}

export { openModal, closeModal };
