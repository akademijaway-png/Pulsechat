'use strict';

/* PulseChat service worker — enables background Web Push notifications. */

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = data.title || 'PulseChat';
  const options = {
    body: data.body || '',
    icon: '/assets/icon-192.png',
    badge: '/assets/badge.png',
    tag: data.tag || 'pulsechat',
    data: { url: data.url || '/' },
    vibrate: [90, 50, 90],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ('focus' in client) {
          try {
            client.navigate(url);
            return client.focus();
          } catch {
            return client.focus();
          }
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
