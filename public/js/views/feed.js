'use strict';
/* News Feed — social posts with photos, likes and comments. */

import state from '../state.js';
import { api } from '../api.js';
import { el, esc, avatarHtml, formatTime, toast } from '../ui.js';
import { icon } from '../icons.js';
import { pickImage, uploadImage, mediaUrl, openViewer } from '../media.js';

let container = null;
let posts = [];

export function render(host) {
  container = host;
  draw();
}

export async function refresh() {
  try {
    const d = await api.get('/feed');
    posts = d.posts;
    draw();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function draw() {
  if (!container || !container.isConnected) return;
  container.replaceChildren(build());
}

function build() {
  return el('div', { class: 'feed fade-swap' }, [
    composer(),
    el('div', { class: 'feed-list', id: 'feed-list' }, posts.length ? posts.map(postCard) : emptyFeed()),
  ]);
}

function emptyFeed() {
  return el('div', { class: 'empty-state minimal' }, [
    el('p', { text: 'No posts yet. Share what\'s on your mind — photos and updates appear here.' }),
  ]);
}

/* ---------------- composer ---------------- */

function composer() {
  const me = state.me;
  const textarea = el('textarea', {
    class: 'feed-input',
    rows: 2,
    placeholder: `What's on your mind, ${me ? me.displayName.split(' ')[0] : 'friend'}?`,
  });
  let picked = null; // { file, url } or null

  const preview = el('div', { class: 'feed-preview hidden' });
  const postBtn = el('button', {
    class: 'btn btn-primary btn-sm',
    html: icon('send') + '<span>Post</span>',
    onclick: async () => {
      const body = textarea.value.trim();
      if (!body && !picked) return toast('Write something to post.', 'error');
      postBtn.disabled = true;
      postBtn.textContent = 'Posting…';
      try {
        let image = null;
        if (picked) {
          const up = await uploadImage(picked.file, { purpose: 'message', conversationId: 0 });
          image = up.filename;
        }
        const res = await api.post('/feed', { body, image });
        posts.unshift(res.post);
        textarea.value = '';
        picked = null;
        preview.classList.add('hidden');
        preview.replaceChildren();
        draw();
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        postBtn.disabled = false;
        postBtn.innerHTML = icon('send') + '<span>Post</span>';
      }
    },
  });

  const pickBtn = el('button', {
    class: 'icon-btn',
    html: icon('image'),
    title: 'Add a photo',
    onclick: async () => {
      try {
        const file = await pickImage(false);
        picked = { file, url: URL.createObjectURL(file) };
        preview.replaceChildren(
          el('img', { src: picked.url, alt: 'Post photo' }),
          el('button', {
            class: 'icon-btn',
            html: icon('close'),
            onclick: () => { picked = null; preview.classList.add('hidden'); preview.replaceChildren(); },
          })
        );
        preview.classList.remove('hidden');
      } catch {
        /* cancelled */
      }
    },
  });

  return el('div', { class: 'feed-composer' }, [
    el('div', { style: 'display:flex;gap:10px' }, [
      el('span', { html: avatarHtml(me, 'sm') }),
      textarea,
    ]),
    preview,
    el('div', { class: 'feed-composer-actions' }, [
      pickBtn,
      el('span', { class: 'spacer' }),
      postBtn,
    ]),
  ]);
}

/* ---------------- post card ---------------- */

function postCard(p) {
  const card = el('div', { class: 'post-card' });

  const head = el('div', { class: 'post-head' }, [
    el('span', { html: avatarHtml(p.author, 'sm') }),
    el('div', { class: 'post-author' }, [
      el('div', { class: 'post-name', text: p.author.displayName }),
      el('div', { class: 'post-time', text: formatTime(p.createdAt) }),
    ]),
  ]);
  card.append(head);

  if (p.body) card.append(el('div', { class: 'post-body', text: p.body }));

  if (p.image) {
    const imgBox = el('div', { class: 'post-image' });
    mediaUrl(p.image)
      .then((url) => {
        const img = el('img', { src: url, alt: 'Post photo', loading: 'lazy', onclick: () => openViewer(url) });
        imgBox.append(img);
      })
      .catch(() => {
        imgBox.append(el('div', { style: 'padding:12px;color:var(--text-faint);font-size:13px', text: 'Image unavailable.' }));
      });
    card.append(imgBox);
  }

  const likeBtn = el('button', {
    class: 'post-action' + (p.liked ? ' liked' : ''),
    html: icon('heart') + `<span>${p.likes || ''}</span>`,
    onclick: async () => {
      try {
        const res = await api.post(`/feed/${p.id}/like`);
        p.liked = res.liked;
        p.likes = res.likes;
        likeBtn.classList.toggle('liked', p.liked);
        likeBtn.innerHTML = icon('heart') + `<span>${p.likes || ''}</span>`;
      } catch (err) {
        toast(err.message, 'error');
      }
    },
  });

  const commentBtn = el('button', {
    class: 'post-action',
    html: icon('comment') + `<span>${p.comments.length || ''}</span>`,
    onclick: () => toggleComments(card, p, commentBtn),
  });

  const actions = el('div', { class: 'post-actions' }, [likeBtn, commentBtn]);
  card.append(actions);

  const commentsBox = el('div', { class: 'post-comments hidden' });
  card.append(commentsBox);

  return card;
}

function toggleComments(card, p, btn) {
  const box = card.querySelector('.post-comments');
  const open = box.classList.contains('hidden');
  if (open) {
    box.classList.remove('hidden');
    renderComments(box, p);
  } else {
    box.classList.add('hidden');
  }
}

function renderComments(box, p) {
  box.replaceChildren();
  for (const c of p.comments) {
    box.append(
      el('div', { class: 'comment' }, [
        el('span', { html: avatarHtml(c.author, 'xs') }),
        el('div', { class: 'comment-bubble' }, [
          el('span', { class: 'comment-name', text: c.author.displayName + ': ' }),
          el('span', { text: c.body }),
        ]),
      ])
    );
  }
  const input = el('input', {
    class: 'input comment-input',
    placeholder: 'Write a comment…',
    onkeydown: async (e) => {
      if (e.key === 'Enter' && input.value.trim()) {
        try {
          const res = await api.post(`/feed/${p.id}/comments`, { body: input.value.trim() });
          p.comments.push(res.comment);
          input.value = '';
          renderComments(box, p);
          const btns = box.closest('.post-card').querySelectorAll('.post-action');
          const cb = btns[1];
          if (cb) cb.innerHTML = icon('comment') + `<span>${p.comments.length}</span>`;
        } catch (err) {
          toast(err.message, 'error');
        }
      }
    },
  });
  box.append(input);
}

/** Insert a freshly broadcast post at the top (real-time feed). */
export function addPostLive(post) {
  posts = posts.filter((x) => x.id !== post.id);
  posts.unshift(post);
  draw();
}

/* avatar size 'xs' support in ui.js */
