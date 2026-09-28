self.addEventListener('push', event => {
  let data = {};
  try { data = event.data?.json() || {}; } catch { data = {}; }
  event.waitUntil(self.registration.showNotification(data.title || 'New email', {
    body: data.body || 'Open DCX to review it.',
    icon: '/icons/dcx-192.png',
    badge: '/icons/dcx-192.png',
    tag: data.tag || undefined,
    data: { url: data.url || '/#notifications' }
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/#notifications', self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async clients => {
    const open = clients.find(client => new URL(client.url).origin === self.location.origin);
    if (open) { await open.navigate(target); return open.focus(); }
    return self.clients.openWindow(target);
  }));
});
