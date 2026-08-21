'use strict';
/* Web Push notifications: service worker registration, subscription sync,
   and in-app fallback notifications. */

import { api } from './api.js';
import { toast } from './ui.js';

let swReg = null;
let permissionAsked = false;

function supported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

async function registerSW() {
  if (swReg) return swReg;
  try {
    swReg = await navigator.serviceWorker.register('/sw.js');
  } catch (err) {
    console.warn('[push] service worker unavailable:', err.message);
    swReg = null;
  }
  return swReg;
}

async function getVapidKey() {
  const data = await api.get('/push/vapid');
  return data.publicKey;
}

/** Full opt-in flow (must be triggered by a user gesture). */
export async function enable() {
  if (!supported()) {
    toast('Notifications are not supported by this browser.', 'info');
    return false;
  }
  if (Notification.permission === 'denied') {
    toast('Notifications are blocked in your browser settings.', 'error');
    return false;
  }
  permissionAsked = true;
  const reg = await registerSW();
  if (!reg) {
    toast('Could not register the notification service.', 'error');
    return false;
  }
  if (Notification.permission === 'default') {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      toast('Notification permission was not granted.', 'info');
      return false;
    }
  }
  try {
    const publicKey = await getVapidKey();
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    }
    await api.post('/push/subscribe', {
      endpoint: sub.endpoint,
      p256dh: btoa(String.fromCharCode(...new Uint8Array(sub.getKey('p256dh')))),
      auth: btoa(String.fromCharCode(...new Uint8Array(sub.getKey('auth')))),
    });
    toast('Notifications enabled. You will be notified even when PulseChat is in the background.', 'success');
    return true;
  } catch (err) {
    console.error('[push] subscribe failed', err);
    toast('Could not enable notifications. Try again in a moment.', 'error');
    return false;
  }
}

export async function disable() {
  try {
    const reg = await registerSW();
    const sub = reg && (await reg.pushManager.getSubscription());
    if (sub) {
      await api.post('/push/unsubscribe', { endpoint: sub.endpoint });
      await sub.unsubscribe();
    }
  } catch (err) {
    console.warn('[push] unsubscribe failed', err);
  }
}

/** Best-effort local notification for when the tab is hidden. */
export function notify(title, body, url) {
  try {
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      const n = new Notification(title, { body, icon: '/assets/icon-192.png', badge: '/assets/badge.png', tag: url || 'pulsechat' });
      n.onclick = () => {
        window.focus();
        if (url) location.hash = url;
        n.close();
      };
    }
  } catch {
    /* fall through to toast */
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const output = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) output[i] = rawData.charCodeAt(i);
  return output;
}
