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
