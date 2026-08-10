import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-auth.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-firestore.js";

var suspendFirebaseConfig = {
  apiKey: "AIzaSyBj6kPKcJUGQtfe-WYA9Q5sWRhbXHYo9NU",
  authDomain: "rent-event-f7abd.firebaseapp.com",
  projectId: "rent-event-f7abd",
  storageBucket: "rent-event-f7abd.firebasestorage.app",
  messagingSenderId: "840686040363",
  appId: "1:840686040363:web:3103c8c5b624deecee416e",
  measurementId: "G-600Z95K9GX"
};

var suspendApp = getApps().length ? getApp() : initializeApp(suspendFirebaseConfig);
var suspendAuth = getAuth(suspendApp);
var suspendDb = getFirestore(suspendApp);

function showSuspendedOverlay() {
  if (document.getElementById("suspendedOverlay")) return;
  var overlay = document.createElement("div");
  overlay.id = "suspendedOverlay";
  overlay.style.cssText = "position:fixed;inset:0;background:#f7f2e9;display:flex;align-items:center;justify-content:center;z-index:2147483647;padding:24px;font-family:Inter,sans-serif;";
  var box = document.createElement("div");
  box.style.cssText = "background:#fff;border-radius:28px;padding:32px 26px;max-width:360px;width:100%;box-shadow:0 20px 50px rgba(0,0,0,0.15);text-align:center;";
  var icon = document.createElement("div");
  icon.textContent = "\u26A0";
  icon.style.cssText = "font-size:2rem;margin-bottom:14px;";
  var title = document.createElement("h2");
  title.textContent = "Account Suspended";
  title.style.cssText = "margin:0 0 10px;font-size:1.3rem;font-weight:800;color:#161616;letter-spacing:-.03em;";
  var msg = document.createElement("p");
  msg.textContent = "Your account has been suspended. If you believe this is a mistake, please contact support.";
  msg.style.cssText = "margin:0 0 22px;color:#6a625a;font-size:0.92rem;line-height:1.5;";
  var btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "Return to Sign In";
  btn.style.cssText = "min-height:48px;padding:0 22px;border-radius:999px;border:none;background:linear-gradient(135deg,#ff9a73,#ff7a63 52%,#ff5f67);color:#fff;font-weight:700;font-size:0.92rem;cursor:pointer;font-family:inherit;width:100%;";
  btn.addEventListener("click", function () {
    signOut(suspendAuth).catch(function () {}).then(function () {
      window.location.href = "index.html";
    });
  });
  box.appendChild(icon);
  box.appendChild(title);
  box.appendChild(msg);
  box.appendChild(btn);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

onAuthStateChanged(suspendAuth, async function (user) {
  if (!user) return;
  try {
    var snap = await getDoc(doc(suspendDb, "users", user.uid));
    if (snap.exists() && snap.data().suspended === true) {
      showSuspendedOverlay();
    }
  } catch (error) {
    console.warn("Suspension check failed:", error.message);
  }
});
