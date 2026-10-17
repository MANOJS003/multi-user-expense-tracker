/* Service worker: shows notification buttons and opens the app when a notification is clicked.
   Works only when the site is opened over https:// or http://localhost */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const tag = event.notification.tag || '';
    const action = event.action || '';
    event.waitUntil((async () => {
        const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        if (all.length) {
            await all[0].focus();
            all[0].postMessage({ type: 'notif-click', tag, action });
        } else {
            await self.clients.openWindow('./index.html?notif=' + encodeURIComponent(tag) + '&action=' + encodeURIComponent(action));
        }
    })());
});
