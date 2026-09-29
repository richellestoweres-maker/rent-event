/**
 * Cancelling a paid booking, from either side.
 *
 * A page writes a document into "vendorCancellations" and this picks it up.
 * Doing the work here rather than in the browser is not optional: a refund
 * needs the Stripe secret key, and a browser is the last place that should
 * ever hold it.
 *
 * TWO KINDS OF CANCELLATION, TWO DIFFERENT ANSWERS
 *
 * A vendor pulling out is a failure of the service. The customer gets back
 * everything they paid toward that vendor, fees included, and the vendor is
 * paid nothing. That is the proportional share of the payment.
 *
 * A customer cancelling is a change of plans, and the vendor has already
 * turned down other work to hold the date. So the published tiers apply:
 * 30 or more days out the vendor's price comes back, 14 to 29 days half of
 * it comes back, under 14 days none of it does. The service fee and the
 * processing fee are never returned, because they were spent.
 *
 * WHAT THIS GETS RIGHT THAT A SIMPLER VERSION WOULD NOT
 *
 * An event can have five vendors, and a customer cancelling the whole thing
 * writes five of these documents at once. Every one of them runs at the same
 * moment against the same booking, so the read, the arithmetic and the claim
 * all happen inside one Firestore transaction. Without that, five copies each
 * read "nothing refunded yet" and five refunds go out against a cap that was
 * only ever meant to allow one.
 *
 * The payout plan is adjusted rather than deleted. On a customer cancellation
 * the vendor often keeps something, and a vendor who kept half their fee still
 * has to be paid it.
 */

const { cloudEvent } = require("@google-cloud/functions-framework");
const protobuf = require("protobufjs");
const admin = require("firebase-admin");
const Stripe = require("stripe");
const path = require("path");

admin.initializeApp();
const db = admin.firestore();

/**
 * Refunds at or below this go through on their own. Anything larger waits for
 * a person. A bug that quietly refunds a $2,500 wedding is a far worse day
 * than one that makes somebody tap approve.
 */
const AUTO_REFUND_LIMIT_CENTS = 50000;

/** The published tiers, in days before the event. */
const FULL_REFUND_DAYS = 30;
const HALF_REFUND_DAYS = 14;

/**
 * Days are counted on this clock, on the server and in the browser both.
 *
 * It has to be one fixed zone or the two disagree. A customer in California at
 * eleven at night is already on tomorrow's date in UTC, and at a tier boundary
 * that one day is real money. Whatever zone is chosen, the number the customer
 * is shown before they confirm is the number that gets used.
 */
const POLICY_TIME_ZONE = "America/New_York";

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

/** Today's calendar date on the policy clock, as [year, month, day]. */
function todayOnPolicyClock() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: POLICY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());

  const [y, m, d] = parts.split("-").map(Number);
  return [y, m, d];
}

/**
 * Whole days between today and the event, counted as calendar days.
 *
 * Date.UTC on both sides turns two calendar dates into a clean difference with
 * no clock, no daylight saving and no drift. Returns null when the booking has
 * no usable date, which is deliberately not the same as zero.
 */
function daysUntilEvent(booking) {
  const details = booking.eventDetails || {};
  const raw = cleanText(details.eventDate || booking.eventDate, "");
  if (!raw) return null;

  const plain = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  let y;
  let m;
  let d;

  if (plain) {
    y = Number(plain[1]);
    m = Number(plain[2]);
    d = Number(plain[3]);
  } else {
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return null;
    y = parsed.getUTCFullYear();
    m = parsed.getUTCMonth() + 1;
    d = parsed.getUTCDate();
  }

  const [ty, tm, td] = todayOnPolicyClock();
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(ty, tm - 1, td)) / 86400000);
}

/** What the vendor quoted, in cents. The payout plan is built from this too. */
function vendorPriceCents(booking, vendorId) {
  const amounts = booking.quotedVendorAmounts || {};
  return Math.round(toNumber(amounts[vendorId], 0) * 100);
}

/** Money that is spoken for already: refunded, or earmarked and awaiting approval. */
function spokenForCents(booking) {
  return Math.round(toNumber(booking.refundedCents, 0)) +
         Math.round(toNumber(booking.refundReservedCents, 0));
}

/**
 * A vendor walking away: the customer's whole share of that vendor comes back.
 *
 * Proportional to the vendor's price, which carries their slice of the service
 * fee and the processing fee with it. RentEvent absorbs the processing cost,
 * which is the promise made in the Terms.
 */
function vendorCancelRefund(booking, vendorId) {
  const amounts = booking.quotedVendorAmounts || {};
  const subtotal = Object.keys(amounts).reduce((sum, id) => sum + toNumber(amounts[id], 0), 0);
  if (subtotal <= 0) return { cents: 0, reason: "no_vendor_amounts", tier: "vendor_cancelled" };

  const thisVendor = toNumber(amounts[vendorId], 0);
  if (thisVendor <= 0) return { cents: 0, reason: "vendor_not_in_booking", tier: "vendor_cancelled" };

  const collected = Math.round(toNumber(
    booking.stripeAmountCollectedCents || booking.stripeAmountCents, 0));
  if (collected <= 0) return { cents: 0, reason: "nothing_collected", tier: "vendor_cancelled" };

  const remaining = collected - spokenForCents(booking);
  if (remaining <= 0) return { cents: 0, reason: "already_fully_refunded", tier: "vendor_cancelled" };

  const want = Math.round(collected * (thisVendor / subtotal));
  return {
    cents: Math.max(0, Math.min(want, remaining)),
    reason: "",
    tier: "vendor_cancelled"
  };
}

/**
 * A customer changing their plans: the published tiers, measured in days.
 *
 * Based on the vendor's price rather than the proportional share, because the
 * fees are not coming back. Halves are floored, so the odd half cent stays put
 * instead of being invented.
 */
function customerCancelRefund(booking, vendorId, days) {
  const base = vendorPriceCents(booking, vendorId);
  if (base <= 0) return { cents: 0, reason: "vendor_not_in_booking", tier: "" };

  const collected = Math.round(toNumber(
    booking.stripeAmountCollectedCents || booking.stripeAmountCents, 0));
  if (collected <= 0) return { cents: 0, reason: "nothing_collected", tier: "" };

  const remaining = collected - spokenForCents(booking);
  if (remaining <= 0) return { cents: 0, reason: "already_fully_refunded", tier: "" };

  // Not knowing the date must not quietly become "no refund". That answer
  // happens to favour the house, which is exactly why it needs a person. The
  // most generous tier is put forward so there is a real figure to approve,
  // and the caller holds it rather than sending it.
  if (days === null) {
    return { cents: Math.min(base, remaining), reason: "no_event_date", tier: "unknown" };
  }

  let want = 0;
  let tier = "";

  if (days >= FULL_REFUND_DAYS) {
    tier = "full";
    want = base;
  } else if (days >= HALF_REFUND_DAYS) {
    tier = "half";
    want = Math.floor(base / 2);
  } else {
    tier = "none";
    want = 0;
  }

  return {
    cents: Math.max(0, Math.min(want, remaining)),
    reason: want > 0 ? "" : "policy_no_refund",
    tier
  };
}

/**
 * The payout plan after this cancellation.
 *
 * A vendor who pulled out is taken off it entirely. A vendor the customer
 * cancelled on keeps whatever was not refunded, so their line is reduced by
 * exactly the refund and the two always add back up to what they quoted.
 */
function adjustedPayoutPlan(booking, vendorId, refundCents, byCustomer) {
  const plan = Array.isArray(booking.payoutPlan) ? booking.payoutPlan : [];

  if (!byCustomer) {
    return plan.filter((line) => cleanText(line.vendorId, "") !== vendorId);
  }

  const next = [];

  for (const line of plan) {
    if (cleanText(line.vendorId, "") !== vendorId) {
      next.push(line);
      continue;
    }

    const kept = Math.max(0, Math.round(toNumber(line.amountCents, 0)) - refundCents);
    if (kept > 0) next.push(Object.assign({}, line, { amountCents: kept }));
  }

  return next;
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
  const byCustomer = cleanText(request.initiatedBy, "vendor") === "customer";

  if (!bookingId || !vendorId) {
    console.error("Cancellation is missing a booking or a vendor, ignoring.");
    return;
  }

  const requestRef = requestId ? db.collection("vendorCancellations").doc(requestId) : null;
  const bookingRef = db.collection("bookingRequests").doc(bookingId);

  /**
   * Read, decide and claim in one go.
   *
   * The transaction is what makes five simultaneous cancellations on one
   * booking safe. Whatever this returns has already been written down, so no
   * other copy of this function can spend the same money.
   */
  let claim;

  try {
    claim = await db.runTransaction(async (tx) => {
      const snap = await tx.get(bookingRef);
      if (!snap.exists) return { stop: "booking_not_found" };

      const booking = snap.data() || {};

      // Refusing twice is the whole point of this check. Eventarc retries on
      // failure, and a retry that refunds a second time is real money gone.
      const already = (Array.isArray(booking.cancelledVendorIds) ? booking.cancelledVendorIds : [])
        .map((id) => cleanText(id, ""))
        .includes(vendorId);

      if (already) return { stop: "duplicate_ignored" };

      // The rules let a customer name any vendor id on their own booking. One
      // that is not on this event gets nothing and, more to the point, should
      // not receive a notification telling them a job they never had is off.
      const listed = (Array.isArray(booking.vendorIds) ? booking.vendorIds : [])
        .map((id) => cleanText(id, ""));
      const inVendorList = (Array.isArray(booking.vendors) ? booking.vendors : [])
        .some((v) => cleanText(v && v.vendorId, "") === vendorId);
      const priced = Object.prototype.hasOwnProperty.call(
        booking.quotedVendorAmounts || {}, vendorId);

      // Three places a vendor can appear, because older bookings were written
      // before vendorIds existed and a vendor's own cancel button must keep
      // working on them.
      const onBooking = listed.includes(vendorId) || inVendorList || priced;

      if (!onBooking) return { stop: "vendor_not_on_booking" };

      const days = daysUntilEvent(booking);
      const verdict = byCustomer
        ? customerCancelRefund(booking, vendorId, days)
        : vendorCancelRefund(booking, vendorId);

      const refundCents = verdict.cents;
      const overLimit = refundCents > AUTO_REFUND_LIMIT_CENTS;
      const needsPerson = overLimit || verdict.tier === "unknown";
      const willAttempt = refundCents > 0 && !needsPerson;

      const update = {
        payoutPlan: adjustedPayoutPlan(booking, vendorId, refundCents, byCustomer),
        cancelledVendorIds: admin.firestore.FieldValue.arrayUnion(vendorId),
        lastCancellationAt: admin.firestore.FieldValue.serverTimestamp()
      };

      if (byCustomer) {
        update.customerCancelledVendorIds = admin.firestore.FieldValue.arrayUnion(vendorId);
      } else {
        update.lastVendorCancellationAt = admin.firestore.FieldValue.serverTimestamp();
      }

      // Claimed now, either way. Money about to leave counts as refunded; money
      // waiting on approval is earmarked so the next cancellation on this
      // booking cannot also spend it.
      if (willAttempt) {
        update.refundedCents = Math.round(toNumber(booking.refundedCents, 0)) + refundCents;
      } else if (refundCents > 0) {
        update.refundReservedCents =
          Math.round(toNumber(booking.refundReservedCents, 0)) + refundCents;
      }

      // Everybody is off the plan and nothing is owed, so the payout job has
      // no work here. Left as "scheduled" it would run, find an empty plan and
      // flag the booking for review over nothing.
      if (!update.payoutPlan.length && cleanText(booking.payoutStatus, "") === "scheduled") {
        update.payoutStatus = "cancelled";
        update.payoutCancelledReason = byCustomer ? "customer_cancelled" : "vendor_cancelled";
      }

      tx.set(bookingRef, update, { merge: true });

      return {
        stop: "",
        booking,
        days,
        refundCents,
        tier: verdict.tier,
        blockedReason: verdict.reason,
        needsPerson,
        willAttempt,
        priorRefundedCents: Math.round(toNumber(booking.refundedCents, 0))
      };
    });
  } catch (error) {
    // Nothing was written, so letting Eventarc retry is safe.
    console.error("Could not claim the cancellation:", error.message);
    throw error;
  }

  if (claim.stop) {
    console.log("Stopping:", claim.stop, bookingId, vendorId);
    if (requestRef) {
      await requestRef.set({
        status: claim.stop === "booking_not_found" ? "failed" : claim.stop,
        failure: claim.stop === "booking_not_found" ? "booking_not_found" : "",
        processedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true }).catch(() => {});
    }
    return;
  }

  const booking = claim.booking;
  const refundCents = claim.refundCents;

  let refundId = "";
  let outcome = "";

  if (!refundCents) {
    outcome = claim.tier === "none" ? "no_refund_under_policy" : "no_refund_due";
    console.log("No refund:", claim.blockedReason || claim.tier, "booking", bookingId);
  } else if (claim.needsPerson) {
    // Deliberately stops here. The vendor's payout is already adjusted and the
    // money is still held, so nothing is lost by waiting for a person.
    outcome = "awaiting_approval";
    console.log("Refund of", money(refundCents), "needs approval:",
      claim.tier === "unknown" ? "no event date on the booking" : "over the automatic limit");
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
          metadata: {
            bookingRequestId: bookingId,
            vendorId,
            source: byCustomer ? "customer_cancellation" : "vendor_cancellation",
            tier: claim.tier
          }
        }, {
          // Stripe will not run the same refund twice with this key, which is
          // the second half of the retry protection.
          idempotencyKey: (byCustomer ? "custcancel_" : "vendorcancel_") + bookingId + "_" + vendorId
        });

        refundId = cleanText(refund.id, "");
        outcome = "refunded";
        console.log("Refunded", money(refundCents), "for booking", bookingId, "tier", claim.tier);
      } catch (error) {
        outcome = "refund_failed";
        console.error("Stripe refused the refund:", error.message);

        // The claim counted this as spent. It was not, so hand it back rather
        // than leaving the booking looking more refunded than it is.
        await bookingRef.set({
          refundedCents: admin.firestore.FieldValue.increment(-refundCents),
          refundNeedsReview: true,
          refundReviewReason: "stripe_refused: " + cleanText(error.message, "unknown")
        }, { merge: true }).catch((e) => console.error("Could not release the claim:", e.message));
      }
    }
  }

  // Counted against whoever cancelled, whatever happened with the money. These
  // are the numbers that show who is unreliable.
  const counterId = byCustomer
    ? cleanText(booking.requestOwnerId || booking.customerId || booking.plannerId, "")
    : vendorId;

  if (counterId) {
    const field = byCustomer ? "customerCancellationCount" : "vendorCancellationCount";
    await db.collection("users").doc(counterId).set({
      [field]: admin.firestore.FieldValue.increment(1),
      lastCancellationAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true }).catch((e) => console.warn("Could not record the cancellation:", e.message));
  }

  if (requestRef) {
    await requestRef.set({
      status: outcome,
      refundCents,
      refundId,
      tier: claim.tier,
      daysToEventServer: claim.days,
      processedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true }).catch((e) => console.warn("Could not update the request:", e.message));
  }

  const eventName = cleanText(
    booking.eventName || (booking.eventDetails && booking.eventDetails.eventName), "your event");
  const vendorName = cleanText(request.vendorName, "A vendor");
  const customerId = cleanText(booking.requestOwnerId || booking.customerId || booking.plannerId, "");

  if (byCustomer) {
    const keptCents = Math.max(0, vendorPriceCents(booking, vendorId) - refundCents);

    const customerLine = outcome === "refunded"
      ? money(refundCents) + " is on its way back to you, usually within five to ten days."
      : (outcome === "awaiting_approval"
          ? "Your refund of " + money(refundCents) + " is being checked and you will hear from us shortly."
          : "Under the cancellation policy there is no refund this close to the event.");

    await notify(customerId, {
      recipientRole: "customer",
      type: "booking_cancelled",
      typeLabel: "Booking Cancelled",
      category: "Booking",
      title: "You cancelled " + vendorName,
      body: "You cancelled " + vendorName + " for " + eventName + ". " + customerLine,
      message: "You cancelled " + vendorName + " for " + eventName + ".",
      bookingRequestId: bookingId,
      eventId: cleanText(booking.eventId, ""),
      vendorId
    });

    await notify(vendorId, {
      recipientRole: "vendor",
      type: "customer_cancelled",
      typeLabel: "Customer Cancelled",
      category: "Booking",
      title: "A customer cancelled " + eventName,
      body: keptCents > 0
        ? "The customer cancelled " + eventName + ". You keep " + money(keptCents) +
          " for holding the date, paid out on the usual schedule. Your calendar is free again."
        : "The customer cancelled " + eventName + " with more than 30 days' notice, so it is refunded in full and this booking will not be paid out. Your calendar is free again.",
      message: "A customer cancelled " + eventName + ".",
      bookingRequestId: bookingId,
      eventId: cleanText(booking.eventId, ""),
      vendorId
    });
  } else {
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
  }

  // Richelle hears about every one of these, including the ones that worked.
  // Somebody cancelling a paid booking is something she should know about the
  // same day, not at the end of the month.
  const admins = await db.collection("users").where("role", "==", "admin").get().catch(() => null);

  if (admins) {
    const who = byCustomer ? "A customer" : vendorName;

    for (const adminDoc of admins.docs) {
      await notify(adminDoc.id, {
        recipientRole: "admin",
        type: byCustomer ? "customer_cancelled" : "vendor_cancelled",
        typeLabel: byCustomer ? "Customer Cancelled" : "Vendor Cancelled",
        category: "Booking",
        title: who + " cancelled a paid booking",
        body: who + " cancelled " + vendorName + " on " + eventName + ". Refund " + money(refundCents) +
              " (" + claim.tier + ", " + (claim.days === null ? "no date" : claim.days + " days out") +
              "), status " + outcome + ". Reason given: " + reason,
        message: who + " cancelled a booking.",
        bookingRequestId: bookingId,
        vendorId
      });
    }
  }

  console.log("Cancellation handled:", bookingId, vendorId,
    byCustomer ? "customer" : "vendor", claim.tier, outcome, money(refundCents));
});
