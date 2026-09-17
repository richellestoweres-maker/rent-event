/**
 * A vendor pulling out of a booking they were already paid for.
 *
 * The vendor's page writes a document into "vendorCancellations" and this picks
 * it up. Doing the work here rather than in the browser is not optional: a
 * refund needs the Stripe secret key, and the customer's browser is the last
 * place that should ever hold it.
 *
 * WHAT THIS GETS RIGHT THAT A SIMPLER VERSION WOULD NOT
 *
 * An event can have five vendors. When one cancels, the customer is owed that
 * vendor's share and nothing more, so this refunds proportionally rather than
 * refunding the whole booking. The shares sum to exactly what was collected,
 * and every refund is capped at what has not already been refunded, so repeated
 * cancellations on one booking can never pay out more than came in.
 *
 * It also removes the vendor from the payout plan. The payout job already
 * refuses any booking that is not exactly "paid", but a booking with four other
 * vendors stays "paid", so without this the cancelling vendor would still be
 * paid two days after an event they did not work.
 */

const { cloudEvent } = require("@google-cloud/functions-framework");
const protobuf = require("protobufjs");
const admin = require("firebase-admin");
const Stripe = require("stripe");
const path = require("path");

admin.initializeApp();
const db = admin.firestore();

/**
 * Refunds at or below this go through on their own. Anything larger waits for a
 * person. A bug that quietly refunds a $2,500 wedding is a far worse day than
 * one that makes somebody tap approve.
 */
const AUTO_REFUND_LIMIT_CENTS = 50000;

let eventType = null;
async function getEventType() {
  if (eventType) return eventType;
  const root = await protobuf.load(path.join(__dirname, "data.proto"));
  eventType = root.lookupType("google.events.cloud.firestore.v1.DocumentEventData");
  return eventType;
}

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
    case "arrayValue": return ((field.arrayValue && field.arrayValue.values) || []).map(unwrap);
    default:
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

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function money(cents) {
  return "$" + (cents / 100).toFixed(2);
}

/**
 * What this vendor's share of the customer's payment comes to.
 *
 * Proportional to their price, which carries their share of the service fee and
 * the processing fee with it. Capped at whatever has not been refunded yet, so
 * rounding across several cancellations can never push the total over what was
 * collected. A stray cent stays with RentEvent rather than being conjured up.
 */
function refundCentsFor(booking, vendorId) {
  const amounts = booking.quotedVendorAmounts || {};
  const subtotal = Object.keys(amounts).reduce((sum, id) => sum + toNumber(amounts[id], 0), 0);

  if (subtotal <= 0) return { cents: 0, reason: "no_vendor_amounts" };

  const thisVendor = toNumber(amounts[vendorId], 0);
  if (thisVendor <= 0) return { cents: 0, reason: "vendor_not_in_booking" };

  const collected = Math.round(toNumber(
    booking.stripeAmountCollectedCents || booking.stripeAmountCents, 0));
  if (collected <= 0) return { cents: 0, reason: "nothing_collected" };

  const alreadyRefunded = Math.round(toNumber(booking.refundedCents, 0));
  const remaining = collected - alreadyRefunded;
  if (remaining <= 0) return { cents: 0, reason: "already_fully_refunded" };

  const want = Math.round(collected * (thisVendor / subtotal));
  return { cents: Math.max(0, Math.min(want, remaining)), reason: "" };
}

/** Everything the vendor was holding, minus the vendor who just walked. */
function payoutPlanWithout(booking, vendorId) {
  const plan = Array.isArray(booking.payoutPlan) ? booking.payoutPlan : [];
  return plan.filter((line) => cleanText(line.vendorId, "") !== vendorId);
}

async function notify(recipientId, payload) {
  if (!recipientId) return;
  try {
    await db.collection("notifications").add(Object.assign({
      recipientId,
      userId: recipientId,
      read: false,
      isRead: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    }, payload));
  } catch (error) {
    // A missing notification must never undo a refund that already happened.
    console.warn("Could not write notification:", error.message);
  }
}

cloudEvent("vendorCancelBooking", async (event) => {
  let request;
  let requestId = "";

  try {
    const DocumentEventData = await getEventType();
    const decoded = DocumentEventData.decode(event.data);
    request = unwrapFields(decoded.value && decoded.value.fields);
    requestId = cleanText((decoded.value && decoded.value.name) || "", "").split("/").pop();
  } catch (error) {
    console.error("Could not decode the cancellation event:", error.message);
    return;
  }

  const bookingId = cleanText(request.bookingRequestId, "");
  const vendorId = cleanText(request.vendorId, "");
  const reason = cleanText(request.reason, "No reason given");

  if (!bookingId || !vendorId) {
    console.error("Cancellation is missing a booking or a vendor, ignoring.");
    return;
  }

  const requestRef = requestId ? db.collection("vendorCancellations").doc(requestId) : null;
  const bookingRef = db.collection("bookingRequests").doc(bookingId);

  let booking;
  try {
    const snap = await bookingRef.get();
    if (!snap.exists) {
      console.error("No such booking:", bookingId);
      if (requestRef) await requestRef.set({ status: "failed", failure: "booking_not_found" }, { merge: true });
      return;
    }
    booking = snap.data() || {};
  } catch (error) {
    console.error("Could not read the booking:", error.message);
    return;
  }

  // Refusing twice is the whole point of this check. Eventarc retries on
  // failure, and a retry that refunds a second time is real money gone.
  const alreadyHandled = (Array.isArray(booking.cancelledVendorIds) ? booking.cancelledVendorIds : [])
    .map((id) => cleanText(id, ""))
    .includes(vendorId);

  if (alreadyHandled) {
    console.log("This vendor was already cancelled off this booking, nothing to do.");
    if (requestRef) await requestRef.set({ status: "duplicate_ignored" }, { merge: true });
    return;
  }

  const { cents: refundCents, reason: blockedReason } = refundCentsFor(booking, vendorId);

  // Whatever happens with the money, the vendor comes off the payout plan
  // immediately. Leaving them on it is how somebody gets paid for a wedding
  // they did not turn up to.
  const bookingUpdate = {
    payoutPlan: payoutPlanWithout(booking, vendorId),
    cancelledVendorIds: admin.firestore.FieldValue.arrayUnion(vendorId),
    lastVendorCancellationAt: admin.firestore.FieldValue.serverTimestamp()
  };

  let refundId = "";
  let outcome = "";

  if (!refundCents) {
    outcome = "no_refund_due";
    console.warn("No refund calculated:", blockedReason, "booking", bookingId);
  } else if (refundCents > AUTO_REFUND_LIMIT_CENTS) {
    // Deliberately stops here. The vendor is off the payout plan and the money
    // is still held, so nothing is lost by waiting for a person.
    outcome = "awaiting_approval";
    console.log("Refund of", money(refundCents), "is over the automatic limit, holding for approval.");
  } else {
    const chargeId = cleanText(booking.stripeChargeId, "");
    const paymentIntentId = cleanText(booking.stripePaymentIntentId, "");

    if (!chargeId && !paymentIntentId) {
      outcome = "missing_charge";
      console.error("Cannot refund, the booking has no Stripe charge recorded.");
    } else {
      try {
        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
        const refund = await stripe.refunds.create({
          amount: refundCents,
          reason: "requested_by_customer",
          ...(chargeId ? { charge: chargeId } : { payment_intent: paymentIntentId }),
          metadata: { bookingRequestId: bookingId, vendorId, source: "vendor_cancellation" }
        }, {
          // Stripe will not run the same refund twice with this key, which is
          // the second half of the retry protection.
          idempotencyKey: "vendorcancel_" + bookingId + "_" + vendorId
        });

        refundId = cleanText(refund.id, "");
        outcome = "refunded";

        bookingUpdate.refundedCents = Math.round(toNumber(booking.refundedCents, 0)) + refundCents;
        console.log("Refunded", money(refundCents), "to the customer for booking", bookingId);
      } catch (error) {
        outcome = "refund_failed";
        console.error("Stripe refused the refund:", error.message);
      }
    }
  }

  try {
    await bookingRef.set(bookingUpdate, { merge: true });
  } catch (error) {
    console.error("Could not update the booking:", error.message);
  }

  // Counted against the vendor whatever happened with the money. This is the
  // number that tells Richelle who is unreliable.
  try {
    await db.collection("users").doc(vendorId).set({
      vendorCancellationCount: admin.firestore.FieldValue.increment(1),
      lastCancellationAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  } catch (error) {
    console.warn("Could not record the cancellation against the vendor:", error.message);
  }

  if (requestRef) {
    await requestRef.set({
      status: outcome,
      refundCents,
      refundId,
      processedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true }).catch((e) => console.warn("Could not update the request:", e.message));
  }

  const eventName = cleanText(booking.eventName || (booking.eventDetails && booking.eventDetails.eventName), "your event");
  const vendorName = cleanText(request.vendorName, "A vendor");
  const customerId = cleanText(booking.requestOwnerId || booking.customerId || booking.plannerId, "");

  const refundLine = outcome === "refunded"
    ? " " + money(refundCents) + " is on its way back to you, usually within five to ten days."
    : (outcome === "awaiting_approval"
        ? " Your refund of " + money(refundCents) + " is being processed and you will hear from us shortly."
        : " We are sorting out your refund and will be in touch.");

  await notify(customerId, {
    recipientRole: "customer",
    type: "vendor_cancelled",
    typeLabel: "Vendor Cancelled",
    category: "Booking",
    title: vendorName + " cancelled",
    body: vendorName + " has pulled out of " + eventName + "." + refundLine,
    message: vendorName + " cancelled " + eventName + ".",
    bookingRequestId: bookingId,
    eventId: cleanText(booking.eventId, ""),
    vendorId
  });

  // Richelle hears about every one of these, including the ones that worked.
  // A vendor cancelling on a customer is something she should know about the
  // same day, not at the end of the month.
  const admins = await db.collection("users").where("role", "==", "admin").get().catch(() => null);
  if (admins) {
    for (const adminDoc of admins.docs) {
      await notify(adminDoc.id, {
        recipientRole: "admin",
        type: "vendor_cancelled",
        typeLabel: "Vendor Cancelled",
        category: "Booking",
        title: vendorName + " cancelled a paid booking",
        body: vendorName + " cancelled " + eventName + ". Refund " + money(refundCents) +
              ", status " + outcome + ". Reason given: " + reason,
        message: vendorName + " cancelled a booking.",
        bookingRequestId: bookingId,
        vendorId
      });
    }
  }

  console.log("Cancellation handled:", bookingId, vendorId, outcome, money(refundCents));
});
