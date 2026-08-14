'use strict';
/* Image picking (gallery / camera), authenticated upload with progress,
   protected downloads and a fullscreen image viewer. */

import { getAccessToken, absPath, ApiError } from './api.js';
import { toast, el, esc } from './ui.js';

const blobCache = new Map(); // filename -> object URL

/** Fetch a protected media file with auth, return an object URL (cached). */
export async function mediaUrl(filename) {
  if (!filename) return null;
  if (blobCache.has(filename)) return blobCache.get(filename);
  const res = await fetch(absPath('/api/media/' + encodeURIComponent(filename)), {
    headers: { Authorization: 'Bearer ' + getAccessToken() },
  });
  if (!res.ok) throw new ApiError(res.status, 'media_error', 'Could not load media.');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  blobCache.set(filename, url);
  return url;
}

/** Pick an image from gallery, or take one with the camera. */
export function pickImage(capture = false) {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    if (capture) input.setAttribute('capture', 'environment');
    input.onchange = () => {
      const file = input.files && input.files[0];
      if (!file) return reject(new Error('No file selected.'));
      resolve(file);
    };
    input.onerror = () => reject(new Error('Could not open the file picker.'));
    input.click();
  });
}

/**
 * Upload an image with progress reporting.
 * @returns Promise<{filename, url, kind}>
 */
export function uploadImage(file, { purpose, conversationId }, onProgress) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('purpose', purpose);
    if (conversationId) form.append('conversationId', String(conversationId));
    form.append('image', file, file.name || 'photo.jpg');

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/media/upload');
    xhr.setRequestHeader('Authorization', 'Bearer ' + getAccessToken());

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* fallthrough */
      }
      if (xhr.status >= 200 && xhr.status < 300 && data) {
        resolve(data);
      } else {
        reject(new ApiError(xhr.status, data?.error || 'upload_error', data?.message || 'Image upload failed.'));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, 'network_error', 'Image upload failed — check your connection.'));
    xhr.send(form);
  });
}

/* ---------------- fullscreen viewer ---------------- */
export function openViewer(url) {
  const backdrop = el('div', { class: 'viewer' }, [
    el('button', {
      class: 'icon-btn close',
      html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>',
    }),
    el('img', { src: url, alt: 'Photo' }),
  ]);
  const close = () => backdrop.remove();
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop || e.target.closest('.close')) close();
  });
  document.getElementById('modal-root').append(backdrop);
}

export { esc };
