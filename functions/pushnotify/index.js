/**
 * Push notifications for RentEvent.
 *
 * The whole design rests on one observation: fifteen pages of this app already
 * write a document into the "notifications" collection whenever something
 * happens that a person should know about. Rather than teach every one of those
 * pages to also send a push, this watches that collection. Anything the app
 * already considers notification-worthy becomes a push for free, and any new
 * notification added later is covered without touching this file.
 */

const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { setGlobalOptions } = require("firebase-functions/v2");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

admin.initializeApp();
setGlobalOptions({ region: "us-central1", maxInstances: 10 });

const db = admin.firestore();

function cleanText(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

/**
 * Where tapping the notification should land.
 *
 * Getting this wrong is worse than having no notification at all, because it
 * interrupts somebody and then wastes their time. When there is no sensible
 * specific destination, the notifications list is always honest.
 */
function linkForNotification(data) {
  const conversationId = cleanText(data.conversationId || (data.relatedCollection === "conversations" ? data.relatedId : ""), "");
  const eventId = cleanText(data.eventId, "");
  const type = cleanText(data.type, "");

  if (conversationId) return `/chat-thread.html?conversation=${encodeURIComponent(conversationId)}`;

  if (type === "booking_request" || type === "new_request") return "/booking-requests.html";
  if (type === "vendor_quote" || type === "vendor_response") return "/my-requests.html";
  if (type === "payout" || type === "payment") return "/vendor-payouts.html";
  if (eventId) return `/event-builder.html?event=${encodeURIComponent(eventId)}`;

  return "/notifications.html";
}

function titleFor(data) {
  if (cleanText(data.type, "") === "message" && cleanText(data.senderName, "")) {
    return `New message from ${cleanText(data.senderName, "")}`;
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
 * Tokens die. A person reinstalls the app, clears data, or the browser rotates
 * the token, and the old one lingers in Firestore forever.
 *
 * Firebase tells us exactly which ones are dead in its response, so we delete
 * those. Without this the collection fills with corpses and every send burns
 * time on addresses that will never answer.
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
      logger.warn("Could not delete dead token", { message: error.message });
    })
  ));

  return dead.length;
}

exports.sendPushOnNotification = onDocumentCreated("notifications/{notificationId}", async (event) => {
  const snap = event.data;
  if (!snap) return;

  const data = snap.data() || {};

  // Both field names are in use across the app, so accept either.
  const recipientId = cleanText(data.recipientId || data.userId, "");

  if (!recipientId) {
    logger.info("Notification has no recipient, nothing to send", { id: event.params.notificationId });
    return;
  }

  let tokens = [];
  try {
    const snapshot = await db.collection("pushTokens").where("userId", "==", recipientId).get();
    // A person can have several devices, and the same device can appear twice
    // if it re-registered before the old row was cleaned up.
    tokens = [...new Set(snapshot.docs.map((d) => cleanText(d.get("token") || d.id, "")).filter(Boolean))];
  } catch (error) {
    logger.error("Could not read push tokens", { message: error.message, recipientId });
    return;
  }

  if (!tokens.length) {
    // Entirely normal. Most people will never turn notifications on, and the
    // in-app notifications list still has everything.
    logger.info("Recipient has no registered devices", { recipientId });
    return;
  }

  const link = linkForNotification(data);

  const message = {
    tokens,
    // Sent as data only, on purpose. With a notification block, the browser
    // displays the message itself and our service worker never runs, so the
    // tap would not land on the right page. Data only means the service worker
    // decides, which is where the link handling lives.
    data: {
      title: titleFor(data),
      body: bodyFor(data),
      link,
      // Tagging by conversation collapses a burst of messages from one person
      // into a single notification rather than burying the phone.
      tag: cleanText(data.conversationId || data.type, "rentevent")
    },
    webpush: {
      fcmOptions: { link: `https://www.rentevent-app.com${link}` },
      headers: {
        // Four hours. A support ping that arrives the next morning is noise,
        // and the in-app list already holds the permanent copy.
        TTL: "14400",
        Urgency: "high"
      }
    }
  };

  try {
    const response = await admin.messaging().sendEachForMulticast(message);
    const removed = await removeDeadTokens(tokens, response.responses);

    logger.info("Push sent", {
      recipientId,
      type: cleanText(data.type, ""),
      sent: response.successCount,
      failed: response.failureCount,
      deadTokensRemoved: removed
    });

    // Surface real failures rather than letting them disappear into a count.
    response.responses.forEach((r, i) => {
      if (!r.success) {
        logger.warn("One device failed", {
          code: r.error && r.error.code,
          message: r.error && r.error.message,
          tokenTail: tokens[i].slice(-8)
        });
      }
    });
  } catch (error) {
    // A failed push must never break whatever wrote the notification. The
    // in-app record is already saved, which is the part that matters.
    logger.error("Push send failed outright", { message: error.message, recipientId });
  }
});
