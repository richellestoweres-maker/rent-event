/**
 * Push notifications for RentEvent.
 *
 * The design rests on one observation: fifteen pages of this app already write
 * a document into the "notifications" collection whenever something happens
 * that a person should know about. Rather than teach every one of those pages
 * to also send a push, this watches that collection. Anything the app already
 * considers notification-worthy becomes a push, and any notification type added
 * later is covered without touching this file.
 *
 * WHY THIS IS WRITTEN THE LONG WAY
 *
 * The first version used firebase-functions v2 onDocumentCreated, which is far
 * shorter. Deployed through the Cloud Run console rather than Firebase's own
 * deploy tool, it never ran: every invocation hung for the full 300 second
 * timeout and returned 504, with not one line of application logging, because
 * the handler was never actually wired to the incoming request.
 *
 * This version uses the plain functions-framework API, which is what this
 * deployment path expects. The cost is having to decode the Firestore event
 * ourselves, which is what the protobuf work below is for.
 */

const { cloudEvent } = require("@google-cloud/functions-framework");
const protobuf = require("protobufjs");
const admin = require("firebase-admin");
const path = require("path");

admin.initializeApp();
const db = admin.firestore();

// Loaded once and reused. Parsing the schema on every invocation would add
// needless latency to something meant to feel instant.
let documentEventDataType = null;
async function getEventType() {
  if (documentEventDataType) return documentEventDataType;
  const root = await protobuf.load(path.join(__dirname, "data.proto"));
  documentEventDataType = root.lookupType("google.events.cloud.firestore.v1.DocumentEventData");
  return documentEventDataType;
}

/**
 * Firestore sends every field wrapped in a type, so "hello" arrives as
 * { stringValue: "hello" }. This unwraps one value back to something ordinary.
 */
function unwrap(field) {
  if (!field) return null;

  switch (field.valueType) {
    case "stringValue": return field.stringValue;
    case "booleanValue": return field.booleanValue;
    case "integerValue": return Number(field.integerValue);
    case "doubleValue": return field.doubleValue;
    case "nullValue": return null;
    case "timestampValue": return field.timestampValue;
    case "mapValue": return unwrapFields(field.mapValue && field.mapValue.fields);
    case "arrayValue":
      return ((field.arrayValue && field.arrayValue.values) || []).map(unwrap);
    default:
      // Older payloads do not always set valueType, so fall back to whichever
      // key is actually present rather than returning nothing.
      if (typeof field.stringValue === "string" && field.stringValue !== "") return field.stringValue;
      if (typeof field.booleanValue === "boolean") return field.booleanValue;
      return null;
  }
}

function unwrapFields(fields) {
  const out = {};
  for (const key of Object.keys(fields || {})) out[key] = unwrap(fields[key]);
  return out;
}

function cleanText(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

/**
 * Where tapping the notification should land.
 *
 * Getting this wrong is worse than sending nothing, because it interrupts
 * somebody and then wastes their time. When there is no sensible specific
 * destination, the notifications list is always honest.
 */
function linkForNotification(data) {
  const own = cleanText(data.link, "");
  if (own.startsWith("/") && !own.startsWith("//")) return own;

  const conversationId = cleanText(
    data.conversationId || (data.relatedCollection === "conversations" ? data.relatedId : ""), "");
  const eventId = cleanText(data.eventId, "");
  const type = cleanText(data.type, "");

  if (conversationId) return "/chat-thread.html?conversation=" + encodeURIComponent(conversationId);
  if (type === "booking_request" || type === "new_request") return "/booking-requests.html";
  if (type === "vendor_quote" || type === "vendor_response") return "/my-requests.html";
  if (type === "payout" || type === "payment") return "/vendor-payouts.html";
  if (eventId) return "/event-builder.html?event=" + encodeURIComponent(eventId);

  return "/notifications.html";
}

function titleFor(data) {
  if (cleanText(data.type, "") === "message" && cleanText(data.senderName, "")) {
    return "New message from " + cleanText(data.senderName, "");
  }
  return cleanText(data.title, "RentEvent");
}

function bodyFor(data) {
  const text = cleanText(data.body || data.message || data.text, "You have a new update.");
  // A lock screen truncates anyway, and a long body pushes the useful part off
  // the end of the line.
  return text.length > 160 ? text.slice(0, 157) + "..." : text;
}

/**
 * Tokens die. Somebody reinstalls, clears data, or the browser rotates the
 * token, and the old one lingers forever. Firebase names the dead ones in its
 * response, so we delete those rather than let the collection fill with
 * addresses that will never answer.
 */
async function removeDeadTokens(tokens, responses) {
  const dead = [];

  responses.forEach((response, index) => {
    if (response.success) return;
    const code = response.error && response.error.code;
    if (code === "messaging/registration-token-not-registered" ||
        code === "messaging/invalid-registration-token" ||
        code === "messaging/invalid-argument") {
      dead.push(tokens[index]);
    }
  });

  if (!dead.length) return 0;

  await Promise.all(dead.map((token) =>
    db.collection("pushTokens").doc(token).delete().catch((error) => {
      console.warn("Could not delete dead token:", error.message);
    })
  ));

  return dead.length;
}

/* ------------------------------------------------------------------ */
/* Email alerts                                                        */
/*                                                                     */
/* Every notification also goes out by email through Resend, to anyone */
/* who has "Email updates" switched on in Account Settings (on by      */
/* default at signup). Chat messages are limited to one email per       */
/* conversation every 30 minutes, so a busy thread does not flood an    */
/* inbox. Nothing happens until a RESEND_API_KEY is set on this         */
/* service, so this is safe to deploy before the Resend account exists. */
/* ------------------------------------------------------------------ */

const SITE = "https://www.rentevent-app.com";
const MESSAGE_EMAIL_GAP_MS = 30 * 60 * 1000;

function escapeHtml(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function emailHtml(title, body, href) {
  return '<!doctype html><html><body style="margin:0;padding:0;background:#f7f2e9;font-family:Helvetica,Arial,sans-serif;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f2e9;padding:28px 12px;"><tr><td align="center">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:24px;padding:28px;">' +
    '<tr><td style="font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#ff5f67;padding-bottom:10px;">RentEvent</td></tr>' +
    '<tr><td style="font-size:20px;font-weight:800;color:#161616;padding-bottom:10px;">' + escapeHtml(title) + '</td></tr>' +
    '<tr><td style="font-size:15px;line-height:1.55;color:#4a433d;padding-bottom:22px;">' + escapeHtml(body) + '</td></tr>' +
    '<tr><td><a href="' + escapeHtml(href) + '" style="display:inline-block;padding:13px 22px;border-radius:999px;background:#ff5f67;color:#ffffff;font-weight:700;font-size:15px;text-decoration:none;">Open RentEvent</a></td></tr>' +
    '</table>' +
    '<p style="font-size:12px;color:#8a8079;margin:16px 0 0;">You get these because Email updates is on. ' +
    '<a href="' + SITE + '/account-settings.html" style="color:#8a8079;">Turn them off</a></p>' +
    '</td></tr></table></body></html>';
}

async function sendEmailAlert(recipientId, data, link) {
  const apiKey = cleanText(process.env.RESEND_API_KEY, "");
  if (!apiKey) return;

  const userRef = db.collection("users").doc(recipientId);
  const user = (await userRef.get()).data() || {};

  if (user.emailOptIn === false) return;

  const to = cleanText(user.email, "");
  if (!to || !to.includes("@")) return;

  const conversationId = cleanText(data.conversationId, "");
  if (cleanText(data.type, "") === "message" && conversationId) {
    const last = Number((user.lastMessageEmailAt || {})[conversationId] || 0);
    if (Date.now() - last < MESSAGE_EMAIL_GAP_MS) return;
    await userRef.set({ lastMessageEmailAt: { [conversationId]: Date.now() } }, { merge: true });
  }

  const title = titleFor(data);
  const body = cleanText(data.body || data.message || data.text, "You have a new update.");
  const href = SITE + link;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": "Bearer " + apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: cleanText(process.env.RESEND_FROM, "RentEvent <alerts@rentevent-app.com>"),
      to: [to],
      subject: title,
      html: emailHtml(title, body, href),
      text: title + "\n\n" + body + "\n\n" + href + "\n\nTurn off email updates: " + SITE + "/account-settings.html"
    })
  });

  if (!response.ok) {
    console.error("Email not sent:", response.status, (await response.text()).slice(0, 300));
  } else {
    console.log("Email sent to", recipientId);
  }
}

cloudEvent("sendPushOnNotification", async (event) => {
  let data;

  try {
    const DocumentEventData = await getEventType();
    const decoded = DocumentEventData.decode(event.data);
    data = unwrapFields(decoded.value && decoded.value.fields);
  } catch (error) {
    // Throwing here would make Eventarc retry a message we can never read.
    console.error("Could not decode the Firestore event:", error.message);
    return;
  }

  // Both field names are in use across the app, so accept either.
  const recipientId = cleanText(data.recipientId || data.userId, "");

  if (!recipientId) {
    console.log("Notification has no recipient, nothing to send.");
    return;
  }

  // Email first. It does not depend on the person having push turned on, and
  // a failure here must never stop the push.
  try {
    await sendEmailAlert(recipientId, data, linkForNotification(data));
  } catch (error) {
    console.error("Email alert failed:", error.message);
  }

  let tokens = [];
  try {
    const snapshot = await db.collection("pushTokens").where("userId", "==", recipientId).get();
    // One person can have several devices, and the same device can appear twice
    // if it re-registered before the old row was cleaned up.
    tokens = [...new Set(snapshot.docs.map((d) => cleanText(d.get("token") || d.id, "")).filter(Boolean))];
  } catch (error) {
    console.error("Could not read push tokens:", error.message);
    return;
  }

  if (!tokens.length) {
    // Entirely normal. Most people never turn notifications on, and the in-app
    // notifications list still holds everything.
    console.log("Recipient has no registered devices:", recipientId);
    return;
  }

  const link = linkForNotification(data);

  try {
    const response = await admin.messaging().sendEachForMulticast({
      tokens,
      // Data only, on purpose. With a notification block the browser displays
      // the message itself and our service worker never runs, so the tap would
      // not land on the right page.
      data: {
        title: titleFor(data),
        body: bodyFor(data),
        link,
        // Tagging collapses a burst from one conversation into a single
        // notification rather than burying the phone.
        tag: cleanText(data.conversationId || data.type, "rentevent")
      },
      webpush: {
        fcmOptions: { link: "https://www.rentevent-app.com" + link },
        headers: {
          // Four hours. A support ping arriving the next morning is noise, and
          // the in-app list already holds the permanent copy.
          TTL: "14400",
          Urgency: "high"
        }
      }
    });

    const removed = await removeDeadTokens(tokens, response.responses);

    console.log("Push sent to " + recipientId +
      " | delivered " + response.successCount +
      " | failed " + response.failureCount +
      " | dead tokens removed " + removed);

    response.responses.forEach((r, i) => {
      if (!r.success) {
        console.warn("Device failed:", r.error && r.error.code, "token ending", tokens[i].slice(-8));
      }
    });
  } catch (error) {
    // A failed push must never break anything. The in-app notification is
    // already saved, which is the part that matters.
    console.error("Push send failed outright:", error.message);
  }
});
