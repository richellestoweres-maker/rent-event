/**
 * Turning on alerts, in a browser or inside the RentEvent app.
 *
 * In the app (iPhone or Android), alerts come through Firebase's native
 * messaging plugin, which the app shell bundles. In a browser they come
 * through web push and firebase-messaging-sw.js. Either way the device's
 * token is saved to pushTokens under the signed in person, which is what
 * the push function looks up when a notification is written.
 *
 * Pages use it like this:
 *   import { pushState, enablePush, isNativeApp } from "./push-setup.js";
 */

import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-auth.js";
import { getFirestore, doc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBj6kPKcJUGQtfe-WYA9Q5sWRhbXHYo9NU",
  authDomain: "rent-event-f7abd.firebaseapp.com",
  projectId: "rent-event-f7abd",
  storageBucket: "rent-event-f7abd.firebasestorage.app",
  messagingSenderId: "840686040363",
  appId: "1:840686040363:web:3103c8c5b624deecee416e",
  measurementId: "G-600Z95K9GX"
};

/** The public half of the web push key. Safe in public code. */
const VAPID_PUBLIC_KEY = "BIY_UKhuOSQa_t_MA4NG5DoPI6B_1liR6CsP_esIZJWKhdrSpgL9eTRs0M6S6w8FULnoKhdj9epQMf5fNSkXbY8";

// Set up lazily so the page's own initializeApp call always runs first.
function firebaseApp() {
  return getApps().length ? getApp() : initializeApp(firebaseConfig);
}

export function isNativeApp() {
  return !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === "function" && window.Capacitor.isNativePlatform());
}

function nativePlatform() {
  return isNativeApp() && typeof window.Capacitor.getPlatform === "function" ? window.Capacitor.getPlatform() : "";
}

function nativeMessaging() {
  return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.FirebaseMessaging;
}

function isIOSBrowser() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
         (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isStandalone() {
  return window.navigator.standalone === true ||
         window.matchMedia("(display-mode: standalone)").matches;
}

async function currentUser() {
  const auth = getAuth(firebaseApp());
  if (auth.currentUser) return auth.currentUser;
  return new Promise((resolve) => {
    const stop = onAuthStateChanged(auth, (user) => { stop(); resolve(user); });
  });
}

async function saveToken(token, platform, native) {
  const user = await currentUser();
  if (!user || !token) return;

  await setDoc(doc(getFirestore(firebaseApp()), "pushTokens", token), {
    token,
    userId: user.uid,
    platform,
    native,
    standalone: isStandalone(),
    userAgent: navigator.userAgent.slice(0, 300),
    updatedAt: serverTimestamp()
  }, { merge: true });
}

/**
 * Where this device stands: "on", "off", "blocked", "unsupported", or
 * "needs-home-screen" for an iPhone browser tab, where Apple only allows
 * alerts once the site is added to the Home Screen.
 */
export async function pushState() {
  if (isNativeApp()) {
    const plugin = nativeMessaging();
    if (!plugin) return "unsupported";
    try {
      const result = await plugin.checkPermissions();
      if (result.receive === "granted") return "on";
      if (result.receive === "denied") return "blocked";
      return "off";
    } catch (error) {
      return "off";
    }
  }

  if (!("Notification" in window) || !("serviceWorker" in navigator) || !window.isSecureContext) {
    return isIOSBrowser() && !isStandalone() ? "needs-home-screen" : "unsupported";
  }
  if (isIOSBrowser() && !isStandalone()) return "needs-home-screen";
  if (Notification.permission === "granted") return "on";
  if (Notification.permission === "denied") return "blocked";
  return "off";
}

/** Asks for permission and registers this device. Returns the new state. */
export async function enablePush() {
  if (isNativeApp()) {
    const plugin = nativeMessaging();
    if (!plugin) return "unsupported";

    const result = await plugin.requestPermissions();
    if (result.receive !== "granted") return "blocked";

    const { token } = await plugin.getToken();
    await saveToken(token, nativePlatform() + "-app", true);
    return "on";
  }

  const state = await pushState();
  if (state === "unsupported" || state === "needs-home-screen") return state;

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "blocked" : "off";

  const { getMessaging, getToken } = await import("https://www.gstatic.com/firebasejs/12.12.1/firebase-messaging.js");

  const registration = await navigator.serviceWorker.register(
    "/firebase-messaging-sw.js",
    { scope: "/firebase-cloud-messaging-push-scope" }
  );

  // Wait for this worker specifically, not whichever one controls the page.
  if (!registration.active) {
    await new Promise((resolve) => {
      const worker = registration.installing || registration.waiting;
      if (!worker) return resolve();
      worker.addEventListener("statechange", () => { if (worker.state === "activated") resolve(); });
    });
  }

  const token = await getToken(getMessaging(firebaseApp()), {
    vapidKey: VAPID_PUBLIC_KEY,
    serviceWorkerRegistration: registration
  });

  if (!token) return "off";
  await saveToken(token, isIOSBrowser() ? "ios-web" : "web", false);
  return "on";
}

/**
 * Inside the app: refresh the saved token quietly on every launch once alerts
 * are on, and open the right page when an alert is tapped.
 */
async function wireUpNativeApp() {
  if (!isNativeApp()) return;
  const plugin = nativeMessaging();
  if (!plugin) return;

  try {
    plugin.addListener("notificationActionPerformed", (event) => {
      const data = (event && event.notification && event.notification.data) || {};
      const link = String(data.link || "");
      if (link.startsWith("/") && !link.startsWith("//")) window.location.href = link;
    });

    if ((await pushState()) === "on") {
      const { token } = await plugin.getToken();
      await saveToken(token, nativePlatform() + "-app", true);
    }
  } catch (error) {
    console.warn("App alert setup:", error.message);
  }
}

setTimeout(wireUpNativeApp, 0);
