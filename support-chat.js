/**
 * RentEvent support chat.
 *
 * One file, included by every page, that puts a help bubble in the corner.
 *
 * HOW IT ANSWERS
 *
 * Everything the bot says is written down in ANSWERS below. It never invents a
 * sentence, which matters more here than anywhere else on the site: this thing
 * is quoting a refund policy to somebody who has already paid. A bot that
 * guesses at a tier and gets it wrong creates a dispute out of nothing.
 *
 * When it does not recognise a question it says so plainly and offers to fetch
 * a person, rather than answering with the closest thing it has. That is the
 * whole design. Being unhelpful is recoverable, being confidently wrong about
 * somebody's money is not.
 *
 * EDITING THE ANSWERS
 *
 * The ANSWERS list is meant to be edited without touching any other code. Each
 * entry needs a topic, an answer, and some words to match on. Add one by
 * copying the shape of its neighbours.
 */

import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  addDoc,
  collection,
  serverTimestamp,
  onSnapshot,
  query,
  orderBy,
  limit
} from "https://www.gstatic.com/firebasejs/12.12.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBj6kPKcJUGQtfe-WYA9Q5sWRhbXHYo9NU",
  authDomain: "rent-event-f7abd.firebaseapp.com",
  projectId: "rent-event-f7abd",
  storageBucket: "rent-event-f7abd.firebasestorage.app",
  messagingSenderId: "840686040363",
  appId: "1:840686040363:web:3103c8c5b624deecee416e",
  measurementId: "G-600Z95K9GX"
};

// Every page already starts Firebase for itself. Starting a second copy with
// the same name throws, so this joins the one that is already running and only
// creates one when the widget is the first thing on the page to need it.
const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

/* ------------------------------------------------------------------ *
 * The answer book
 * ------------------------------------------------------------------ */

/**
 * phrases are whole fragments and count for a lot. keywords are single words
 * grouped by meaning, and a question has to hit two different groups before
 * anything matches. That bar is deliberately high: an unmatched question goes
 * to a person, which is a far better outcome than a near miss.
 */
const ANSWERS = [
  {
    id: "how-it-works",
    topic: "How booking works",
    audience: "customer",
    phrases: ["how does this work", "how do i book", "how do i get started", "how does booking work"],
    keywords: [["book", "booking", "hire", "start"], ["how", "work", "works", "begin", "first"]],
    answer:
      "Build your event first, then send it to the vendors you like.\n\n" +
      "1. Create your event with the date, place and guest count.\n" +
      "2. Browse listings and add the ones you want to your event.\n" +
      "3. Send the request. Each vendor replies with a real price for your event.\n" +
      "4. Accept the prices you are happy with, then pay once for the whole booking.\n\n" +
      "Nothing is charged until you accept a price and choose to pay.",
    links: [
      { label: "Start an event", href: "event-builder.html" },
      { label: "Browse vendors", href: "index.html" }
    ]
  },
  {
    id: "when-charged",
    topic: "When am I charged",
    audience: "customer",
    phrases: ["when am i charged", "when do i pay", "when does it charge", "do i pay now", "pay upfront"],
    keywords: [["charge", "charged", "pay", "payment", "billed"], ["when", "now", "upfront", "later", "time"]],
    answer:
      "Your card is charged when you tap pay, not when you send the request.\n\n" +
      "Browsing, sending requests and getting prices back are all free. A vendor's price is only a quote until you accept it, and you can decline it or walk away at any point before paying.\n\n" +
      "Your money is then held until two days after your event, which is when the vendor is paid. That gap is what protects you if something goes wrong.",
    links: [{ label: "My requests", href: "my-requests.html" }]
  },
  {
    id: "fees",
    topic: "What are the fees",
    audience: "customer",
    phrases: ["what are the fees", "why is the total higher", "what is the service fee", "extra charge", "hidden fee"],
    keywords: [["fee", "fees", "charge", "cost", "total", "extra"], ["what", "why", "how much", "service", "processing", "higher"]],
    answer:
      "Two things sit on top of the vendor's price, and both are shown separately before you pay.\n\n" +
      "The RentEvent service fee is 10% of the vendor total. That is what keeps the platform running.\n\n" +
      "Card processing is what the card networks charge to take the payment. It is passed straight through.\n\n" +
      "There is nothing else. The number you see at checkout is the number that leaves your account.",
    links: []
  },
  {
    id: "cancel-policy",
    topic: "Cancelling and refunds",
    audience: "customer",
    phrases: ["cancel my booking", "can i cancel", "cancellation policy", "get a refund", "want to cancel", "how much do i get back"],
    keywords: [["cancel", "cancelling", "cancellation", "refund", "money back"], ["policy", "how much", "can i", "get back", "booking", "want"]],
    answer:
      "How much comes back depends on how close you are to the event, because vendors turn down other work to hold your date.\n\n" +
      "30 or more days before: the vendor's full price is refunded.\n" +
      "14 to 29 days before: half the vendor's price is refunded.\n" +
      "Fewer than 14 days before: the booking is not refundable.\n\n" +
      "The service fee and the card processing fee are not refunded.\n\n" +
      "These apply to each vendor separately, so cancelling one vendor does not change what is owed to the others. Open My Requests and tap Cancel Booking, and you will see exactly what comes back before you confirm anything.",
    links: [
      { label: "My requests", href: "my-requests.html" },
      { label: "Read the full policy", href: "terms.html" }
    ]
  },
  {
    id: "vendor-cancelled",
    topic: "A vendor cancelled on me",
    audience: "customer",
    phrases: ["vendor cancelled", "vendor pulled out", "vendor backed out", "they cancelled on me", "vendor cant make it"],
    keywords: [["vendor", "they", "photographer", "caterer", "dj"], ["cancelled", "canceled", "pulled out", "backed out", "dropped"]],
    answer:
      "You are refunded in full for that vendor, including the service fee and the processing fee, whenever it happens. You are never charged for a vendor who did not turn up.\n\n" +
      "The refund is sent automatically and usually reaches your card within five to ten days.\n\n" +
      "Your other vendors are unaffected, and your request page will show you other vendors in the same category for your event so you can fill the gap quickly.",
    links: [{ label: "My requests", href: "my-requests.html" }]
  },
  {
    id: "reschedule",
    topic: "Changing my event date",
    audience: "customer",
    phrases: ["change the date", "move the date", "reschedule", "postpone", "different date"],
    keywords: [["reschedule", "postpone", "move", "change", "different"], ["date", "day", "event", "time"]],
    answer:
      "Moving your event is not a cancellation. If your vendor agrees to the new date, nothing is refunded and the booking moves with it.\n\n" +
      "Message the vendor first and agree the new date with them, then update the event.\n\n" +
      "One thing worth knowing: if you end up cancelling later, the refund timings are always counted from your original event date, not the new one.",
    links: [
      { label: "Messages", href: "messages.html" },
      { label: "Edit my event", href: "event-builder.html" }
    ]
  },
  {
    id: "no-reply",
    topic: "A vendor is not replying",
    audience: "customer",
    phrases: ["not replying", "no response", "hasnt replied", "has not replied", "ignoring me", "no answer"],
    keywords: [["reply", "replied", "replying", "response", "respond", "answer", "ignoring"], ["not", "no", "never", "havent", "hasnt", "waiting", "still"]],
    answer:
      "If a vendor has not replied for three days, go ahead and book someone else for that service. You are not stuck waiting on them.\n\n" +
      "Nothing has been charged while you wait, so there is nothing to undo. Just add another vendor in the same category to your event and send the request.\n\n" +
      "Response times are recorded, and accounts that repeatedly go quiet or cancel confirmed bookings can be limited or suspended.",
    links: [{ label: "Browse vendors", href: "index.html" }]
  },
  {
    id: "refund-timing",
    topic: "Where is my refund",
    audience: "customer",
    phrases: ["where is my refund", "refund hasnt arrived", "havent got my refund", "how long does a refund take", "refund still pending"],
    keywords: [["refund", "money back", "repayment"], ["where", "how long", "arrived", "pending", "waiting", "still", "late", "yet"]],
    answer:
      "Refunds usually land back on your card within five to ten days. The exact timing is set by your bank, not by us.\n\n" +
      "It goes back to the same card you paid with, and it can show up as a reversal of the original charge rather than as a new line.\n\n" +
      "If it has been longer than ten days, tell me and I will put you through to a person who can look at the actual payment.",
    links: []
  },
  {
    id: "vendor-payouts",
    topic: "When do I get paid",
    audience: "vendor",
    phrases: ["when do i get paid", "when will i be paid", "how do i get paid", "when does the money arrive", "my payout"],
    keywords: [["paid", "payout", "payment", "money", "deposit"], ["when", "how", "receive", "arrive", "get"]],
    answer:
      "You are paid two days after the event, automatically. You never have to invoice anybody or chase a customer.\n\n" +
      "The customer pays when they book, the money is held, and two days after the event date it is sent to your connected account. From there it follows your own bank's payout schedule.\n\n" +
      "You keep the price you quoted. The platform fee comes out of what the customer pays on top, not out of your price.",
    links: [{ label: "My payouts", href: "vendor-payouts.html" }]
  },
  {
    id: "payout-setup",
    topic: "Setting up payouts",
    audience: "vendor",
    phrases: ["set up payouts", "connect my bank", "payout setup", "cant be booked", "why cant customers book me", "stripe setup"],
    keywords: [["payout", "payouts", "bank", "stripe", "account", "connect"], ["set up", "setup", "cant", "cannot", "why", "need", "finish"]],
    answer:
      "Until your payout account is finished, customers cannot check out with you. That is deliberate, because nobody should be able to pay for a vendor who cannot be paid.\n\n" +
      "Open My Payouts and complete the setup. It is handled by Stripe and takes a few minutes. You will need your business details and a bank account.\n\n" +
      "Once it says payouts enabled, you are bookable straight away. Nothing else is needed.",
    links: [{ label: "My payouts", href: "vendor-payouts.html" }]
  },
  {
    id: "add-listing",
    topic: "Adding a listing",
    audience: "vendor",
    phrases: ["add a listing", "create a listing", "list my service", "post my service", "new listing"],
    keywords: [["listing", "listings", "service", "profile", "post"], ["add", "create", "new", "make", "set up", "list"]],
    answer:
      "Add Listing is on your vendor dashboard. One listing per service you offer.\n\n" +
      "Put a real starting price on it. That is the number customers browse by, and listings without one get skipped.\n\n" +
      "The starting price is not what you have to charge. When a request comes in you send a real price for that specific event, and that is what the customer pays.",
    links: [
      { label: "Add a listing", href: "add-listing.html" },
      { label: "My listings", href: "my-listings.html" }
    ]
  },
  {
    id: "quoting",
    topic: "Replying to a request",
    audience: "vendor",
    phrases: ["send a price", "how do i quote", "reply to a request", "respond to a request", "booking request came in"],
    keywords: [["quote", "quoting", "price", "respond", "reply", "request"], ["how", "send", "give", "set", "new", "do i"]],
    answer:
      "Open Booking Requests, choose Available, and enter your price for that event.\n\n" +
      "The customer can only accept or decline it, so the number you type is the number they pay. You can change it any time until they pay.\n\n" +
      "If you need details before you can price it, message them first. Plenty of services cannot be priced without a conversation, and that is fine.",
    links: [
      { label: "Booking requests", href: "booking-requests.html" },
      { label: "Messages", href: "messages.html" }
    ]
  },
  {
    id: "vendor-cancel",
    topic: "Cancelling a booking I took",
    audience: "vendor",
    phrases: ["i need to cancel", "cancel a booking i accepted", "cant do the job", "cannot make the event", "double booked"],
    keywords: [["cancel", "cancelling", "pull out", "back out"], ["i", "my", "need", "have to", "cant", "cannot"]],
    answer:
      "Open the booking in Booking Requests and use Cancel This Booking. You will be asked why, and the customer reads what you write.\n\n" +
      "The customer is refunded in full for your part of their event, including fees, and you are not paid for it.\n\n" +
      "Cancellations are recorded on your account. One emergency is understood. A pattern of them affects whether you keep receiving requests.",
    links: [{ label: "Booking requests", href: "booking-requests.html" }]
  },
  {
    id: "customer-cancelled-on-vendor",
    topic: "A customer cancelled on me",
    audience: "vendor",
    phrases: ["customer cancelled", "client cancelled", "they cancelled", "customer backed out"],
    keywords: [["customer", "client", "they"], ["cancelled", "canceled", "backed out", "called it off"]],
    answer:
      "You keep part of the money depending on how much notice they gave, because you held that date.\n\n" +
      "Cancelled 30 or more days out, the booking is refunded in full and is not paid out.\n" +
      "Cancelled 14 to 29 days out, you keep half your price.\n" +
      "Cancelled under 14 days out, you keep your full price.\n\n" +
      "Anything you keep is paid out on the usual schedule, two days after the original event date. Your calendar is free again either way.",
    links: [{ label: "Booking requests", href: "booking-requests.html" }]
  },
  {
    id: "off-platform",
    topic: "Sharing contact details",
    audience: "all",
    phrases: ["phone number", "email address", "outside the app", "off platform", "pay directly", "contact details"],
    keywords: [["phone", "number", "email", "text", "whatsapp", "instagram", "contact", "directly"], ["share", "send", "give", "outside", "off", "can i", "allowed"]],
    answer:
      "Keep booking conversations and payments inside RentEvent. Sharing phone numbers, emails or social handles to move a booking off the platform is not allowed.\n\n" +
      "This is not about fees. Once a booking leaves the platform there is no record of what was agreed, no held payment, and nothing anyone can do for either side when something goes wrong.\n\n" +
      "Everything you need, such as messages, prices, payment and payouts, is already here.",
    links: [{ label: "Community guidelines", href: "community-guidelines.html" }]
  },
  {
    id: "safety",
    topic: "Reporting a problem",
    audience: "all",
    phrases: ["report someone", "report a problem", "feel unsafe", "harassment", "scam", "something went wrong"],
    keywords: [["report", "unsafe", "safety", "harassment", "scam", "fraud", "abuse", "threat"], ["someone", "problem", "concern", "feel", "how", "vendor", "customer"]],
    answer:
      "Please report it. Reports go straight to the RentEvent team and are not shown to the person being reported.\n\n" +
      "If anyone is in immediate danger, contact your local emergency services first. We are not an emergency service.\n\n" +
      "For anything else, including a vendor who did not turn up, a message that crossed a line, or a listing that is not what it claims, use the report form and we will look at it.",
    links: [
      { label: "Report a concern", href: "report.html" },
      { label: "Safety", href: "safety.html" }
    ]
  },
  {
    id: "notifications",
    topic: "Phone notifications",
    audience: "all",
    phrases: ["phone notifications", "push notifications", "notify me", "alerts on my phone", "turn on notifications"],
    keywords: [["notification", "notifications", "alert", "alerts", "push"], ["phone", "turn on", "enable", "get", "receive", "set up"]],
    answer:
      "Add RentEvent to your home screen first, then turn on notifications from your profile. You will get an alert when a vendor replies, when a price arrives, and when something needs your attention.\n\n" +
      "On an iPhone it only works from the home screen app, not from the browser. Open the site in Safari, tap Share, then Add to Home Screen.",
    links: [{ label: "Notification settings", href: "push-test.html" }]
  },
  {
    id: "account",
    topic: "Account and login",
    audience: "all",
    phrases: ["reset my password", "cant log in", "cannot log in", "change my email", "delete my account", "forgot password"],
    keywords: [["password", "login", "log in", "sign in", "account", "email"], ["reset", "forgot", "cant", "cannot", "change", "delete", "close"]],
    answer:
      "Password resets happen from the sign in page. Tap Forgot Password and a reset link is emailed to you, and that works whether or not you can get in.\n\n" +
      "Account Settings is where you turn roles on, choose which emails you get, and deactivate or delete your account.\n\n" +
      "If you have a booking that has been paid for, sort that out before closing the account. Closing it does not cancel the booking or refund it.",
    links: [
      { label: "Account settings", href: "account-settings.html" },
      { label: "Sign in", href: "login.html" }
    ]
  },
  {
    id: "messages",
    topic: "Finding my messages",
    audience: "all",
    phrases: ["where are my messages", "cant find messages", "message a vendor", "talk to the vendor", "contact the vendor"],
    keywords: [["message", "messages", "chat", "conversation", "talk"], ["where", "find", "cant", "how", "vendor", "customer", "contact"]],
    answer:
      "Tap Inbox in the bar at the bottom of any page. A conversation is created for each vendor as soon as you send them a request, so you never have to start one yourself.\n\n" +
      "There is also a Message Vendor button on every booking request, which opens the right conversation directly.",
    links: [{ label: "Messages", href: "messages.html" }]
  }
];

/* ------------------------------------------------------------------ *
 * Matching
 * ------------------------------------------------------------------ */

/** Admin accounts that get told when somebody asks for a person.
 *
 *  This is the same list as the admin allowlist in the Firestore rules. If an
 *  admin is ever added there, add them here too or they will not be paged.
 */
const ADMIN_USER_IDS = ["GBrIifV7FnOnXhXmgmG4lpMg4Lr1"];

const PANEL_ID = "reSupportPanel";
const BUBBLE_ID = "reSupportBubble";

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[''`]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The closest written answer, or nothing.
 *
 * A whole phrase is worth three, a keyword group is worth one, and two points
 * are needed to say anything at all. So one recognised phrase answers, two
 * different kinds of keyword answer, and a single stray word never does. When
 * this returns nothing the bot admits it and offers a person, which is the
 * right outcome far more often than a near miss would be.
 */
function findAnswer(text) {
  const question = " " + normalize(text) + " ";
  if (question.trim().length < 2) return null;

  let best = null;
  let bestScore = 0;

  for (const entry of ANSWERS) {
    let score = 0;

    for (const phrase of entry.phrases || []) {
      if (question.includes(" " + normalize(phrase))) score += 3;
    }

    for (const group of entry.keywords || []) {
      if (group.some((word) => question.includes(" " + normalize(word)))) score += 1;
    }

    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }

  return bestScore >= 2 ? best : null;
}

/* ------------------------------------------------------------------ *
 * The widget
 * ------------------------------------------------------------------ */

let currentUser = null;
let currentUserData = null;
let threadUnsubscribe = null;
let escalated = false;
let seenMessageIds = new Set();

function escapeHtml(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function injectStyles() {
  if (document.getElementById("reSupportStyles")) return;

  const style = document.createElement("style");
  style.id = "reSupportStyles";
  style.textContent = `
    #${BUBBLE_ID} {
      position: fixed;
      right: 16px;
      bottom: var(--re-support-bottom, 20px);
      z-index: 70;
      width: 56px;
      height: 56px;
      border: none;
      border-radius: 999px;
      background: linear-gradient(160deg, #ff9a73 0%, #ff7a63 52%, #ff5f67 100%);
      color: #fff;
      box-shadow: 0 14px 30px rgba(255, 108, 98, 0.34);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
    }

    #${BUBBLE_ID}:focus-visible { outline: 3px solid #161616; outline-offset: 3px; }
    #${BUBBLE_ID} svg { width: 26px; height: 26px; display: block; }

    #${BUBBLE_ID} .re-dot {
      position: absolute;
      top: 2px;
      right: 2px;
      min-width: 18px;
      height: 18px;
      border-radius: 999px;
      background: #161616;
      color: #fff;
      font: 800 0.68rem/18px system-ui, sans-serif;
      display: none;
    }

    #${BUBBLE_ID}.has-reply .re-dot { display: block; }

    #${PANEL_ID} {
      position: fixed;
      right: 16px;
      bottom: calc(var(--re-support-bottom, 20px) + 66px);
      z-index: 71;
      width: min(360px, calc(100vw - 32px));
      max-height: min(560px, calc(100vh - 140px));
      background: #fff;
      border-radius: 26px;
      box-shadow: 0 26px 70px rgba(22, 22, 22, 0.26);
      display: none;
      flex-direction: column;
      overflow: hidden;
      font-family: inherit;
    }

    #${PANEL_ID}.show { display: flex; }

    .re-head {
      padding: 15px 16px;
      background: linear-gradient(160deg, #ff9a73 0%, #ff7a63 52%, #ff5f67 100%);
      color: #fff;
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 10px;
    }

    .re-head h2 { margin: 0; font-size: 1.05rem; font-weight: 800; letter-spacing: -0.02em; }
    .re-head p { margin: 3px 0 0; font-size: 0.78rem; opacity: 0.94; line-height: 1.4; }

    .re-close {
      border: none;
      background: rgba(255, 255, 255, 0.24);
      color: #fff;
      width: 30px;
      height: 30px;
      border-radius: 999px;
      font-size: 1.1rem;
      line-height: 1;
      cursor: pointer;
      flex: none;
    }

    .re-log {
      flex: 1;
      overflow-y: auto;
      padding: 14px 14px 4px;
      background: #faf5ee;
      -webkit-overflow-scrolling: touch;
    }

    .re-msg {
      max-width: 86%;
      margin-bottom: 10px;
      padding: 10px 13px;
      border-radius: 18px;
      font-size: 0.87rem;
      line-height: 1.5;
      white-space: pre-wrap;
      word-wrap: break-word;
    }

    .re-msg.bot, .re-msg.admin { background: #fff; color: #161616; border: 1px solid #ece2d3; }
    .re-msg.admin { border-color: #ff9a73; }
    .re-msg.user { background: #161616; color: #fff; margin-left: auto; }

    .re-who {
      display: block;
      margin-bottom: 3px;
      font-size: 0.68rem;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.07em;
      color: #c74f4d;
    }

    .re-links { display: flex; flex-wrap: wrap; gap: 7px; margin: 0 0 12px; }

    .re-links a {
      display: inline-flex;
      align-items: center;
      min-height: 32px;
      padding: 0 12px;
      border-radius: 999px;
      background: #fff;
      border: 1px solid #ece2d3;
      color: #161616;
      font-size: 0.79rem;
      font-weight: 700;
      text-decoration: none;
    }

    .re-chips { display: flex; flex-wrap: wrap; gap: 7px; padding: 0 14px 12px; background: #faf5ee; }

    .re-chip {
      border: 1px solid #ece2d3;
      background: #fff;
      color: #161616;
      border-radius: 999px;
      min-height: 34px;
      padding: 0 13px;
      font: 700 0.79rem system-ui, sans-serif;
      font-family: inherit;
      cursor: pointer;
    }

    .re-chip.person { background: #161616; color: #fff; border-color: #161616; }

    .re-foot {
      display: flex;
      gap: 8px;
      padding: 11px 12px;
      border-top: 1px solid #ece2d3;
      background: #fff;
    }

    .re-foot input {
      flex: 1;
      min-width: 0;
      border: 1px solid #ece2d3;
      border-radius: 999px;
      padding: 10px 14px;
      font-family: inherit;
      font-size: 0.88rem;
      background: #faf5ee;
      color: #161616;
      outline: none;
    }

    .re-send {
      border: none;
      border-radius: 999px;
      width: 40px;
      height: 40px;
      flex: none;
      background: #ff7a63;
      color: #fff;
      font-size: 1rem;
      cursor: pointer;
    }

    @media (prefers-reduced-motion: no-preference) {
      #${PANEL_ID}.show { animation: reSupportIn 0.16s ease-out; }
      @keyframes reSupportIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
    }
  `;

  document.head.appendChild(style);
}

function buildWidget() {
  if (document.getElementById(BUBBLE_ID)) return;

  // Most pages carry a fixed bottom nav. Sitting on top of it would cover the
  // thing people use to get around, so the bubble steps up out of its way.
  const hasBottomNav = !!document.querySelector(".bottom-nav");
  document.documentElement.style.setProperty("--re-support-bottom", hasBottomNav ? "94px" : "20px");

  const bubble = document.createElement("button");
  bubble.id = BUBBLE_ID;
  bubble.type = "button";
  bubble.setAttribute("aria-label", "Open help");
  bubble.innerHTML =
    '<span class="re-dot" aria-hidden="true">1</span>' +
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="M21 11.5a8.5 8.5 0 1 1-4.2-7.3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
    '<path d="M3.2 20.8 4.6 16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
    '<circle cx="12" cy="11.5" r="1.3" fill="currentColor"/>' +
    '<circle cx="8" cy="11.5" r="1.3" fill="currentColor"/>' +
    '<circle cx="16" cy="11.5" r="1.3" fill="currentColor"/>' +
    "</svg>";

  const panel = document.createElement("section");
  panel.id = PANEL_ID;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "RentEvent help");
  panel.setAttribute("aria-hidden", "true");
  panel.innerHTML =
    '<div class="re-head">' +
      "<div><h2>Need a hand?</h2><p>Pick a topic or type a question. A person is one tap away.</p></div>" +
      '<button class="re-close" type="button" aria-label="Close help">&times;</button>' +
    "</div>" +
    '<div class="re-log" id="reSupportLog" aria-live="polite"></div>' +
    '<div class="re-chips" id="reSupportChips"></div>' +
    '<form class="re-foot" id="reSupportForm">' +
      '<input id="reSupportInput" type="text" autocomplete="off" placeholder="Type your question" aria-label="Type your question">' +
      '<button class="re-send" type="submit" aria-label="Send">&rarr;</button>' +
    "</form>";

  document.body.appendChild(bubble);
  document.body.appendChild(panel);

  bubble.addEventListener("click", togglePanel);
  panel.querySelector(".re-close").addEventListener("click", closePanel);
  panel.querySelector("#reSupportForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = document.getElementById("reSupportInput");
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    ask(text);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && panel.classList.contains("show")) closePanel();
  });
}

function addMessage(from, text, links) {
  const log = document.getElementById("reSupportLog");
  if (!log) return;

  // Sometimes there is nothing to say and only somewhere to go, such as the
  // sign in and support links. An empty speech bubble above them looks broken.
  if (String(text || "").trim()) {
    const wrap = document.createElement("div");
    wrap.className = "re-msg " + from;

    if (from === "admin") {
      wrap.innerHTML = '<span class="re-who">RentEvent</span>' + escapeHtml(text);
    } else {
      wrap.textContent = text;
    }

    log.appendChild(wrap);
  }

  if (links && links.length) {
    const row = document.createElement("div");
    row.className = "re-links";
    row.innerHTML = links
      .map((l) => '<a href="' + escapeHtml(l.href) + '">' + escapeHtml(l.label) + "</a>")
      .join("");
    log.appendChild(row);
  }

  log.scrollTop = log.scrollHeight;
}

/** Topic buttons, so nobody has to guess what it knows about. */
function renderChips() {
  const row = document.getElementById("reSupportChips");
  if (!row) return;

  // A vendor and a customer want different things, and showing somebody six
  // topics that do not apply to them is just noise.
  const role = String((currentUserData && (currentUserData.activeRole || currentUserData.role)) || "");
  const forVendor = role === "vendor";

  const picked = ANSWERS.filter((entry) =>
    entry.audience === "all" || entry.audience === (forVendor ? "vendor" : "customer")
  ).slice(0, 6);

  row.innerHTML = picked
    .map((entry) => '<button class="re-chip" type="button" data-topic="' + escapeHtml(entry.id) + '">' +
      escapeHtml(entry.topic) + "</button>")
    .join("") +
    '<button class="re-chip person" type="button" data-person="1">Talk to a person</button>';

  row.querySelectorAll("[data-topic]").forEach((button) => {
    button.addEventListener("click", () => {
      const entry = ANSWERS.find((a) => a.id === button.dataset.topic);
      if (!entry) return;
      addMessage("user", entry.topic);
      addMessage("bot", entry.answer, entry.links);
    });
  });

  row.querySelector("[data-person]").addEventListener("click", () => escalate(""));
}

function ask(text) {
  addMessage("user", text);

  // Once a person is on the thread the bot stops answering over the top of
  // them. Nothing is worse than a human typing a reply while a robot talks.
  if (escalated) {
    sendToThread(text);
    return;
  }

  const entry = findAnswer(text);

  if (entry) {
    addMessage("bot", entry.answer, entry.links);
    addMessage("bot", "Did that cover it? If not, tap Talk to a person and I will pass you over.");
    return;
  }

  addMessage("bot",
    "I do not have a written answer for that one, and I would rather not guess at something that might cost you money.\n\n" +
    "Tap Talk to a person and I will pass this straight to the RentEvent team with what you have typed.");
}

/* ------------------------------------------------------------------ *
 * Handing over to a person
 * ------------------------------------------------------------------ */

function firstLine(text) {
  return String(text || "").split("\n")[0].slice(0, 140);
}

/**
 * Opens a real conversation with the RentEvent team.
 *
 * Signed in only, and the thread id is the person's own account id, which is
 * what makes the security rules simple enough to be obviously right: you can
 * read and write exactly one thread, your own. Somebody who cannot sign in is
 * often the person who most needs help, so they are sent to the support form
 * instead, which has always taken messages from anybody.
 */
async function escalate(firstMessage) {
  if (escalated) {
    if (firstMessage) sendToThread(firstMessage);
    return;
  }

  if (!currentUser) {
    addMessage("bot",
      "To chat here you need to be signed in, so the conversation stays attached to your account and nobody else can read it.\n\n" +
      "If you cannot sign in, the support form takes messages from anybody and reaches the same place.");
    addMessage("bot", "", [
      { label: "Sign in", href: "login.html" },
      { label: "Support form", href: "support.html" }
    ]);
    return;
  }

  escalated = true;
  addMessage("bot", "Passing you to the RentEvent team now. Your messages appear here, and you will get a notification when somebody replies.");

  const chatId = currentUser.uid;
  const name = String((currentUserData && currentUserData.name) || currentUser.displayName || currentUser.email || "Someone");

  const transcript = Array.from(document.querySelectorAll("#reSupportLog .re-msg"))
    .map((el) => (el.classList.contains("user") ? "Them: " : "Bot: ") + el.textContent)
    .slice(-8)
    .join("\n")
    .slice(0, 1500);

  try {
    await setDoc(doc(db, "supportChats", chatId), {
      userId: currentUser.uid,
      name,
      email: String(currentUser.email || ""),
      role: String((currentUserData && (currentUserData.activeRole || currentUserData.role)) || "customer"),
      status: "open",
      page: String(location.pathname || ""),
      lastMessage: firstLine(firstMessage || "Asked to speak to someone"),
      lastFrom: "user",
      lastMessageAt: serverTimestamp(),
      unreadForAdmin: true,
      updatedAt: serverTimestamp(),
      createdAt: serverTimestamp()
    }, { merge: true });

    // What they already typed goes with them, so nobody has to repeat
    // themselves to a human after explaining it once to a bot.
    await addDoc(collection(db, "supportChats", chatId, "messages"), {
      from: "user",
      senderId: currentUser.uid,
      text: (firstMessage || "I would like to talk to someone.") +
            (transcript ? "\n\nWhat I asked the help bot first:\n" + transcript : ""),
      createdAt: serverTimestamp()
    });

    await notifyAdmins(name, firstMessage || "wants to talk to someone", chatId);
    watchThread(chatId);
  } catch (error) {
    console.warn("Support chat could not start:", error.message);
    escalated = false;
    addMessage("bot",
      "That did not go through, which is exactly the wrong moment for it. Please use the support form and it will reach the same team.");
    addMessage("bot", "", [{ label: "Support form", href: "support.html" }]);
  }
}

async function sendToThread(text) {
  if (!currentUser) return;

  try {
    await addDoc(collection(db, "supportChats", currentUser.uid, "messages"), {
      from: "user",
      senderId: currentUser.uid,
      text: String(text).slice(0, 4000),
      createdAt: serverTimestamp()
    });

    await setDoc(doc(db, "supportChats", currentUser.uid), {
      lastMessage: firstLine(text),
      lastFrom: "user",
      lastMessageAt: serverTimestamp(),
      unreadForAdmin: true,
      status: "open",
      updatedAt: serverTimestamp()
    }, { merge: true });

    const name = String((currentUserData && currentUserData.name) || currentUser.email || "Someone");
    await notifyAdmins(name, text, currentUser.uid);
  } catch (error) {
    console.warn("Could not send:", error.message);
    addMessage("bot", "That message did not send. Please try again, or use the support form.");
  }
}

/**
 * Pages Richelle.
 *
 * This writes an ordinary notification, which the push function already
 * watches, so the alert reaches her phone without anything new being deployed.
 */
async function notifyAdmins(name, text, chatId) {
  for (const adminId of ADMIN_USER_IDS) {
    try {
      await addDoc(collection(db, "notifications"), {
        recipientId: adminId,
        userId: adminId,
        recipientRole: "admin",
        type: "support_chat",
        typeLabel: "Live Chat",
        category: "Support",
        title: name + " needs help",
        body: firstLine(text) || "Someone asked to talk to a person.",
        message: name + " started a live chat.",
        link: "/admin-dashboard.html#supportChatSection",
        chatId,
        read: false,
        isRead: false,
        createdAt: serverTimestamp()
      });
    } catch (error) {
      // A missed notification must never stop the message itself being sent.
      console.warn("Could not page an admin:", error.message);
    }
  }
}

/** Live replies, so the conversation happens in the same box. */
function watchThread(chatId) {
  if (threadUnsubscribe) threadUnsubscribe();

  const messages = query(
    collection(db, "supportChats", chatId, "messages"),
    orderBy("createdAt", "asc"),
    limit(100)
  );

  threadUnsubscribe = onSnapshot(messages, (snapshot) => {
    snapshot.docChanges().forEach((change) => {
      if (change.type !== "added") return;
      if (seenMessageIds.has(change.doc.id)) return;
      seenMessageIds.add(change.doc.id);

      const data = change.doc.data() || {};
      if (data.from !== "admin") return;

      addMessage("admin", String(data.text || ""));

      // A reply that arrives while the panel is shut should be noticed.
      const panel = document.getElementById(PANEL_ID);
      if (panel && !panel.classList.contains("show")) {
        const bubble = document.getElementById(BUBBLE_ID);
        if (bubble) bubble.classList.add("has-reply");
      }
    });
  }, (error) => console.warn("Support thread listener stopped:", error.message));
}

/* ------------------------------------------------------------------ *
 * Opening and closing
 * ------------------------------------------------------------------ */

function openPanel() {
  const panel = document.getElementById(PANEL_ID);
  const bubble = document.getElementById(BUBBLE_ID);
  if (!panel) return;

  panel.classList.add("show");
  panel.setAttribute("aria-hidden", "false");
  if (bubble) bubble.classList.remove("has-reply");

  const log = document.getElementById("reSupportLog");
  if (log && !log.children.length) {
    addMessage("bot",
      "Hi, I can help with booking, payments, cancellations and payouts.\n\n" +
      "Pick a topic below or type your question. If I do not know the answer I will pass you to a person rather than guess.");
    renderChips();
  }

  const input = document.getElementById("reSupportInput");
  if (input && window.matchMedia("(min-width: 700px)").matches) input.focus();
}

function closePanel() {
  const panel = document.getElementById(PANEL_ID);
  if (!panel) return;
  panel.classList.remove("show");
  panel.setAttribute("aria-hidden", "true");
}

function togglePanel() {
  const panel = document.getElementById(PANEL_ID);
  if (!panel) return;
  panel.classList.contains("show") ? closePanel() : openPanel();
}

/* ------------------------------------------------------------------ *
 * Start
 * ------------------------------------------------------------------ */

function start() {
  // The admin dashboard has its own console for these conversations. Richelle
  // does not need a help bubble to talk to herself.
  if (/admin-dashboard/.test(location.pathname)) return;

  injectStyles();
  buildWidget();

  onAuthStateChanged(auth, async (user) => {
    currentUser = user || null;

    if (!user) {
      currentUserData = null;
      return;
    }

    try {
      const snap = await getDoc(doc(db, "users", user.uid));
      currentUserData = snap.exists() ? snap.data() : null;
    } catch (error) {
      currentUserData = null;
    }

    renderChips();

    // Pick up a conversation that was already going, so a reply sent while
    // they were away is waiting for them rather than lost.
    try {
      const existing = await getDoc(doc(db, "supportChats", user.uid));
      if (existing.exists() && (existing.data() || {}).status === "open") {
        escalated = true;
        watchThread(user.uid);
      }
    } catch (error) {
      // No thread, or no permission to look. Either way the bot still works.
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start);
} else {
  start();
}
