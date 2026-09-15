/**
 * Background push for RentEvent.
 *
 * This is a SECOND service worker, separate from sw.js. sw.js handles offline
 * caching at the root scope. Firebase registers this one under its own scope
 * (/firebase-cloud-messaging-push-scope), so the two never collide.
 *
 * It has to sit at the site root and it has to use the compat build. A service
 * worker cannot use ES module imports in Safari, which is exactly the browser
 * this was written for.
 */

importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyBj6kPKcJUGQtfe-WYA9Q5sWRhbXHYo9NU",
  authDomain: "rent-event-f7abd.firebaseapp.com",
  projectId: "rent-event-f7abd",
  storageBucket: "rent-event-f7abd.firebasestorage.app",
  messagingSenderId: "840686040363",
  appId: "1:840686040363:web:3103c8c5b624deecee416e"
});

var messaging = firebase.messaging();

/**
 * Fires when a push arrives and the app is closed or in the background, which
 * on a phone is almost always.
 */
messaging.onBackgroundMessage(function (payload) {
  var data = payload.data || {};
  var note = payload.notification || {};

  var title = note.title || data.title || "RentEvent";
  var body = note.body || data.body || "Someone needs help.";
  // Defaults to the notifications list, not the admin dashboard. Most people
  // receiving these are customers and vendors, and sending them somewhere they
  // are not allowed to go is worse than sending them somewhere plain.
  var link = data.link || "/notifications.html";

  return self.registration.showNotification(title, {
    body: body,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    // Tagging by conversation means five messages from the same person collapse
    // into one notification instead of burying the phone.
    tag: data.tag || "rentevent-support",
    renotify: true,
    data: { link: link }
  });
});

/**
 * Tapping the notification should land on the thing that needs attention, and
 * should reuse an open tab rather than piling up new ones.
 */
self.addEventListener("notificationclick", function (event) {
  event.notification.close();

  var link = (event.notification.data && event.notification.data.link) || "/notifications.html";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].url.indexOf(link) !== -1 && "focus" in list[i]) {
          return list[i].focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(link);
    })
  );
});
