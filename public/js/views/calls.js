'use strict';
/* Calls: recent call history + start a new call from contacts. */

import state from '../state.js';
import { api } from '../api.js';
import { el, esc, avatarHtml, formatTime, callDurationLabel, toast } from '../ui.js';
import { icon } from '../icons.js';

let container = null;

export function render(host) {
  container = host;
  draw();
}

export async function refresh() {
  try {
    const data = await api.get('/calls');
    state.calls = data.calls;
    draw();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function draw() {
  if (!container) return;
  container.replaceChildren(build());
}

function build() {
  return el('div', { class: 'fade-swap' }, [
    el('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin:6px 2px 10px' }, [
      el('h2', { style: 'font-size:19px', text: 'Calls' }),
      el('button', {
        class: 'btn btn-primary btn-sm',
        html: icon('video') + '<span>New call</span>',
        onclick: openPicker,
      }),
    ]),
    callsList(),
  ]);
}

function callsList() {
  if (!state.calls.length) {
    return el('div', { class: 'empty-state minimal' }, [
      el('p', { text: 'No calls yet. Start a video call from a chat or a contact.' }),
    ]);
  }
  return el('div', { class: 'fade-swap' }, [
    ...state.calls.map((c) => {
      const missed = c.status === 'missed' || c.status === 'unanswered';
      const arrow = c.direction === 'outgoing' ? 'phoneOut' : missed ? 'phoneMissed' : 'phoneIn';
      return el('div', { class: 'call-item' }, [
        el('span', { class: `call-arrow ${c.direction}${missed ? ' missed' : ''}`, html: icon(arrow) }),
        el('span', { html: avatarHtml(c.other, 'sm') }),
        el('div', { class: 'call-info' }, [
          el('div', { class: 'call-name' }, [
            el('span', { text: c.other.displayName }),
            missed ? el('span', { class: 'missed-tag', text: 'Missed' }) : null,
          ]),
          el('div', {
            class: 'call-sub',
            text:
              (c.direction === 'outgoing' ? 'Outgoing · ' : 'Incoming · ') +
              (c.status === 'completed' && c.duration != null ? `Duration ${callDurationLabel(c.duration)} · ` : '') +
              formatTime(c.initiatedAt),
          }),
        ]),
        el('button', {
          class: 'icon-btn',
          html: icon('video'),
          title: 'Call back',
          onclick: () => import('../rtc.js').then((m) => m.startCall(c.other)),
        }),
      ]);
    }),
  ]);
}

function openPicker() {
  if (!state.contacts.length) {
    toast('Add contacts first to start a call.', 'info');
    return;
  }
  const list = el('div', { class: 'list' }, [
    ...state.contacts.map((u) =>
      el('div', { class: 'user-row', style: 'cursor:pointer', onclick: () => { closeModal(); import('../rtc.js').then((m) => m.startCall(u)); } }, [
        el('span', { html: avatarHtml(u, 'md') }),
        el('div', { class: 'user-info' }, [
          el('div', { class: 'user-name', text: u.displayName }),
          el('div', { class: 'user-sub', text: u.email }),
        ]),
        el('span', { class: 'icon-btn', html: icon('video') }),
      ])
    ),
  ]);
  openModal('Start a video call', list);
}

function openModal(title, body) {
  const root = document.getElementById('modal-root');
  const modal = el('div', { class: 'modal-backdrop' }, [
    el('div', { class: 'modal' }, [
      el('div', { class: 'modal-header' }, [
        el('h3', { text: title }),
        el('button', { class: 'icon-btn', html: icon('close'), onclick: closeModal }),
      ]),
      el('div', { class: 'modal-body' }, [body]),
    ]),
  ]);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });
  root.append(modal);
}

function closeModal() {
  const root = document.getElementById('modal-root');
  root.replaceChildren();
}

export { openModal, closeModal };
