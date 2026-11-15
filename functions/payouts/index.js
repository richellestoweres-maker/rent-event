/**
 * RentEvent vendor payouts
 *
 * Customers pay RentEvent, not the vendor. This job is what actually moves each
 * vendor's share to their own bank, two days after their event.
 *
 * Holding the money until after the event is deliberate. A customer who
 * cancels three weeks out is then just a refund, with nothing to claw back out
 * of a vendor's account.
 *
 * Runs once a day from Cloud Scheduler. Running it more often is harmless: it
 * only ever pays bookings whose release date has already passed, and every
 * transfer carries an idempotency key, so the same vendor can never be paid
 * twice for the same booking even if this runs a hundred times.
 *
 * Deployed as its own Cloud Run function with entry point: releaseVendorPayouts
 * Secrets it needs: STRIPE_SECRET_KEY
 */

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const Stripe = require("stripe");

admin.initializeApp();

const STRIPE_SECRET_KEY = defineSecret("STRIPE_SECRET_KEY");

const db = admin.firestore();

/** How many bookings to settle in one run. */
const BATCH_SIZE = 50;

/**
 * Payment states a booking can still owe vendors money in.
 *
 * "partially_refunded" is here because a cancellation that refunds one vendor
 * out of several leaves the rest perfectly payable.
 */
const PAYABLE_STATUSES = ["paid", "partially_refunded", "deposit_paid"];

/** Same admins as the Firestore rules. */
const ADMIN_USER_IDS = ["GBrIifV7FnOnXhXmgmG4lpMg4Lr1"];

function cleanText(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function toMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

/** Marks a booking as needing a human, rather than guessing. */
async function flagForReview(ref, reason, extra = {}) {
  await ref.set(Object.assign({
    payoutStatus: "needs_review",
    payoutNeedsReview: true,
    payoutReviewReason: reason,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, extra), { merge: true });

  console.error("Payout flagged for review:", ref.id, reason);
}

/**
 * Pays every vendor on one booking.
 *
 * Each transfer is drawn from the original charge with source_transaction,
 * which means Stripe accepts it whether or not the money has settled into the
 * platform balance yet, and the vendor receives it as soon as it does.
 */
async function settleBooking(stripe, doc, nowMs) {
  const ref = doc.ref;
  const booking = doc.data() || {};

  // A booking can be partly refunded and still owe money.
  //
  // One vendor cancelling off a five vendor event refunds that vendor's share
  // and leaves the other four to be paid, and Stripe's webhook marks the
  // booking "partially_refunded" the moment that refund lands. Treating that
  // as unpayable would quietly strand four vendors who did the work, with
  // nothing flagged for anyone to notice. Only a booking that was never paid,
  // or was refunded in full, is genuinely not payable.
  if (!PAYABLE_STATUSES.includes(cleanText(booking.paymentStatus, ""))) {
    return { skipped: "not_paid" };
  }

  const releaseMs = toMillis(booking.payoutReleaseAt);

  if (!releaseMs) {
    await flagForReview(ref, "missing_release_date");
    return { skipped: "missing_release_date" };
  }

  if (releaseMs > nowMs) {
    return { skipped: "not_due_yet" };
  }

  const chargeId = cleanText(booking.stripeChargeId, "");

  if (!chargeId) {
    await flagForReview(ref, "missing_charge_id");
    return { skipped: "missing_charge_id" };
  }

  const plan = Array.isArray(booking.payoutPlan) ? booking.payoutPlan : [];

  if (!plan.length) {
    await flagForReview(ref, "empty_payout_plan");
    return { skipped: "empty_payout_plan" };
  }

  // Never pay out more than is actually still on the charge. Money that has
  // been refunded to the customer is gone, so the ceiling is what was collected
  // minus what went back, not what was collected. If the plan wants more than
  // that, the booking was edited after payment and a person should look at it.
  const planTotal = plan.reduce((sum, item) => sum + Number(item.amountCents || 0), 0);
  const collected = Number(booking.stripeAmountCollectedCents || booking.stripeAmountCents || 0) +
    Number(booking.balanceCollectedCents || 0);

  // A deposit booking was paid in two charges. A transfer can only be drawn
  // from one charge, and by now (two days after the event, 16 or more days
  // after the balance was taken) both have long since settled into the
  // platform balance, so these are paid from that balance instead.
  const twoCharges = !!cleanText(booking.balanceChargeId, "");
  const refunded = Math.round(Number(
    booking.stripeAmountRefundedCents || booking.refundedCents || 0));
  const available = collected ? Math.max(0, collected - refunded) : 0;

  if (!planTotal || (collected && planTotal > available)) {
    await flagForReview(ref, "payout_exceeds_collected", {
      payoutPlannedCents: planTotal,
      stripeAmountCollectedCents: collected,
      stripeAmountRefundedCents: refunded,
      payoutAvailableCents: available
    });
    return { skipped: "payout_exceeds_collected" };
  }

  const transferGroup = cleanText(booking.stripeTransferGroup, "booking_" + doc.id);
  const results = [];
  const failures = [];

  for (const item of plan) {
    const vendorId = cleanText(item.vendorId, "");
    const destination = cleanText(item.stripeAccountId, "");
    const amount = Number(item.amountCents || 0);

    if (!vendorId || !destination || amount <= 0) {
      failures.push({ vendorId, error: "incomplete_payout_line" });
      continue;
    }

    try {
      const transfer = await stripe.transfers.create({
        amount,
        currency: cleanText(booking.stripeCurrency, "usd"),
        destination,
        ...(twoCharges ? {} : { source_transaction: chargeId }),
        transfer_group: transferGroup,
        description: "RentEvent booking " + doc.id,
        metadata: {
          bookingRequestId: doc.id,
          vendorId,
          eventId: cleanText(booking.eventId, ""),
          platform: "rentevent"
        }
      }, {
        // The same key always returns the first transfer instead of making a
        // second one, so a retry or a double run cannot pay a vendor twice.
        idempotencyKey: "rentevent_payout_" + doc.id + "_" + vendorId
      });

      results.push({
        vendorId,
        amountCents: amount,
        transferId: transfer.id,
        destination
      });
    } catch (err) {
      console.error("Transfer failed", doc.id, vendorId, err.message);
      failures.push({ vendorId, amountCents: amount, error: cleanText(err.message, "transfer_failed") });
    }
  }

  if (failures.length && !results.length) {
    await flagForReview(ref, "all_transfers_failed", { payoutFailures: failures });
    return { failed: failures.length };
  }

  await ref.set({
    payoutStatus: failures.length ? "partially_paid_out" : "paid_out",
    payoutNeedsReview: failures.length > 0,
    payoutReviewReason: failures.length ? "some_transfers_failed" : "",
    payoutTransfers: results,
    payoutFailures: failures,
    payoutPaidOutCents: results.reduce((sum, item) => sum + item.amountCents, 0),
    payoutPaidAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  console.log("Booking settled:", doc.id, "paid", results.length, "failed", failures.length);

  return { paid: results.length, failed: failures.length };
}

/* ------------------------------------------------------------------ */
/* Balances                                                            */
/*                                                                     */
/* A deposit booking's remaining balance is charged to the customer's  */
/* saved card 14 days before the event. If the card is declined, the   */
/* customer gets a link to pay it themselves, and the vendors and      */
/* Richelle are told, so nobody turns up to an event that is not paid. */
/* ------------------------------------------------------------------ */

async function notify(recipientId, payload) {
  if (!recipientId) return;
  try {
    await db.collection("notifications").add(Object.assign({
      recipientId,
      userId: recipientId,
      senderId: "system",
      read: false,
      isRead: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    }, payload));
  } catch (error) {
    console.warn("Could not write notification:", error.message);
  }
}

function money(cents) {
  return "$" + (Number(cents || 0) / 100).toFixed(2);
}

async function chargeBalance(stripe, doc, nowMs) {
  const ref = doc.ref;
  const booking = doc.data() || {};

  const dueMs = toMillis(booking.balanceDueAt);
  if (!dueMs || dueMs > nowMs) return { skipped: "balance_not_due" };

  const amount = Math.round(Number(booking.balanceCents || 0));
  if (amount <= 0) {
    await ref.set({ balanceStatus: "cancelled", updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return { skipped: "nothing_to_charge" };
  }

  const customer = cleanText(booking.stripeCustomerId, "");
  const paymentMethod = cleanText(booking.stripePaymentMethodId, "");
  const eventName = cleanText(booking.eventName || (booking.eventDetails && booking.eventDetails.eventName), "your event");
  const customerId = cleanText(booking.requestOwnerId || booking.customerId || booking.plannerId, "");
  const payLink = "/checkout.html?bookingRequestId=" + encodeURIComponent(doc.id) +
    "&eventId=" + encodeURIComponent(cleanText(booking.eventId, "")) + "&payBalance=1";

  let failure = "";
  let intent = null;

  if (!customer || !paymentMethod) {
    failure = "no_saved_card";
  } else {
    try {
      intent = await stripe.paymentIntents.create({
        amount,
        currency: cleanText(booking.stripeCurrency, "usd"),
        customer,
        payment_method: paymentMethod,
        off_session: true,
        confirm: true,
        description: "Balance for " + eventName,
        transfer_group: cleanText(booking.stripeTransferGroup, "booking_" + doc.id),
        metadata: {
          bookingRequestId: doc.id,
          eventId: cleanText(booking.eventId, ""),
          kind: "balance",
          source: "rentevent_balance"
        }
      }, {
        // One balance charge per booking, however many times this runs.
        idempotencyKey: "rentevent_balance_" + doc.id
      });
    } catch (error) {
      failure = cleanText(error.code || error.message, "card_declined");
      console.error("Balance charge failed", doc.id, error.message);
    }
  }

  if (intent && intent.status === "succeeded") {
    const chargeId = typeof intent.latest_charge === "string"
      ? intent.latest_charge
      : (intent.latest_charge && intent.latest_charge.id) || "";
    const hasPlan = Array.isArray(booking.payoutPlan) && booking.payoutPlan.length > 0;

    await ref.set({
      balanceStatus: "paid",
      balancePaidAt: admin.firestore.FieldValue.serverTimestamp(),
      balancePaymentIntentId: intent.id,
      balanceChargeId: chargeId,
      balanceCollectedCents: amount,
      paymentStatus: "paid",
      payoutStatus: hasPlan && chargeId ? "scheduled" : "needs_review",
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    await notify(customerId, {
      recipientRole: "customer",
      type: "balance_paid",
      typeLabel: "Balance Paid",
      category: "Booking",
      title: "Your balance is paid",
      body: money(amount) + " for " + eventName + " was charged to your card on file. You're all set.",
      bookingRequestId: doc.id,
      eventId: cleanText(booking.eventId, "")
    });

    return { charged: amount };
  }

  if (!failure && intent) failure = "status_" + intent.status;

  await ref.set({
    balanceStatus: "failed",
    balanceFailureReason: failure,
    balanceFailedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  await notify(customerId, {
    recipientRole: "customer",
    type: "balance_failed",
    typeLabel: "Payment Needed",
    category: "Booking",
    title: "Your balance didn't go through",
    body: "We couldn't charge " + money(amount) + " for " + eventName + ". Tap to pay it now so your vendors stay booked.",
    link: payLink,
    bookingRequestId: doc.id,
    eventId: cleanText(booking.eventId, "")
  });

  const vendorIds = (Array.isArray(booking.payoutPlan) ? booking.payoutPlan : [])
    .map((line) => cleanText(line.vendorId, "")).filter(Boolean);

  for (const vendorId of vendorIds) {
    await notify(vendorId, {
      recipientRole: "vendor",
      type: "balance_failed",
      typeLabel: "Balance Not Paid",
      category: "Booking",
      title: "Balance not paid yet for " + eventName,
      body: "The customer's card was declined for the balance. We've asked them to pay. Your deposit is safe.",
      bookingRequestId: doc.id,
      vendorId
    });
  }

  for (const adminId of ADMIN_USER_IDS) {
    await notify(adminId, {
      recipientRole: "admin",
      type: "balance_failed",
      typeLabel: "Balance Failed",
      category: "Payments",
      title: "Balance failed: " + eventName,
      body: money(amount) + " could not be charged (" + failure + "). Customer has been sent a pay link.",
      link: "/admin-dashboard.html",
      bookingRequestId: doc.id
    });
  }

  return { failed: 1 };
}

async function runBalances(stripe, nowMs, summary) {
  const snap = await db.collection("bookingRequests")
    .where("balanceStatus", "==", "scheduled")
    // Most scheduled balances are weeks away and are skipped cheaply, so this
    // looks at many more than the payout batch to be sure due ones are reached.
    .limit(1000)
    .get();

  summary.balancesExamined = snap.size;
  summary.balancesCharged = 0;
  summary.balancesFailed = 0;

  for (const doc of snap.docs) {
    try {
      const outcome = await chargeBalance(stripe, doc, nowMs);
      if (outcome.charged) summary.balancesCharged += 1;
      if (outcome.failed) summary.balancesFailed += 1;
    } catch (error) {
      console.error("Balance step failed for", doc.id, error.message);
      summary.balancesFailed += 1;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Freezing unreliable vendors                                         */
/*                                                                     */
/* A vendor who cancels two paid bookings within 90 days, or leaves a  */
/* booking request unanswered for 7 days, is frozen: their listings    */
/* come out of search, and customers waiting on them are pointed to    */
/* similar vendors. They can still message and finish bookings that    */
/* are already paid. Richelle unfreezes them from the admin dashboard. */
/* ------------------------------------------------------------------ */

const FREEZE_ADMIN_IDS = ["GBrIifV7FnOnXhXmgmG4lpMg4Lr1"];

async function freezeNotify(recipientId, payload) {
  if (!recipientId) return;
  try {
    await db.collection("notifications").add(Object.assign({
      recipientId,
      userId: recipientId,
      senderId: "system",
      read: false,
      isRead: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    }, payload));
  } catch (error) {
    console.warn("Could not write notification:", error.message);
  }
}

function freezeText(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

/** Where to send a customer looking for someone like this vendor. */
function similarVendorsLink(booking, vendorId) {
  const vendors = Array.isArray(booking.vendors) ? booking.vendors : [];
  const entry = vendors.find((v) => freezeText(v && v.vendorId, "") === vendorId) || {};
  const category = freezeText(entry.category || entry.listingCategory || entry.mainCategory, "");
  const details = booking.eventDetails || {};
  const city = freezeText(details.eventCity || booking.eventCity, "");
  const params = [];
  if (category) params.push("category=" + encodeURIComponent(category));
  if (city) params.push("location=" + encodeURIComponent(city));
  return "/index.html" + (params.length ? "?" + params.join("&") : "");
}

async function freezeVendor(vendorId, reason, detail) {
  if (!vendorId || FREEZE_ADMIN_IDS.includes(vendorId)) return false;

  const userRef = db.collection("users").doc(vendorId);
  const user = (await userRef.get()).data() || {};
  if (user.vendorFrozen === true) return false;

  await userRef.set({
    vendorFrozen: true,
    vendorFrozenReason: reason,
    vendorFrozenDetail: freezeText(detail, ""),
    vendorFrozenAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  // Out of search. Remembered so unfreezing puts back exactly what was live.
  const listings = await db.collection("listings").where("vendorId", "==", vendorId).get();
  for (const doc of listings.docs) {
    if (freezeText((doc.data() || {}).status, "") === "published") {
      await doc.ref.set({ status: "frozen", frozenFromStatus: "published" }, { merge: true });
    }
  }

  const why = reason === "cancellations"
    ? "you've cancelled 2 paid bookings in 90 days"
    : "a booking request went 7 days without a reply";
  const name = freezeText(user.businessName || user.name, "A vendor");

  await freezeNotify(vendorId, {
    recipientRole: "vendor",
    type: "vendor_frozen",
    typeLabel: "Listings Paused",
    category: "Account",
    title: "Your listings are paused",
    body: "Your listings are hidden from search because " + why + ". Your paid bookings and messages still work. Contact support to turn them back on.",
    link: "/support.html"
  });

  for (const adminId of FREEZE_ADMIN_IDS) {
    await freezeNotify(adminId, {
      recipientRole: "admin",
      type: "vendor_frozen",
      typeLabel: "Vendor Frozen",
      category: "Vendors",
      title: name + " was frozen",
      body: name + " was frozen because " + why + (detail ? " (" + detail + ")" : "") + ". Unfreeze them from Users when ready.",
      link: "/admin-dashboard.html",
      vendorId
    });
  }

  // Customers still waiting on this vendor, with no money moved, are pointed
  // to someone else. Paid bookings are left alone: those still happen.
  const open = await db.collection("bookingRequests").where("vendorIds", "array-contains", vendorId).get();
  for (const doc of open.docs) {
    const b = doc.data() || {};
    const status = freezeText(b.requestStatus || b.status, "pending");
    const money = freezeText(b.paymentStatus, "not_collected");
    if (!["pending", "needs_more_info"].includes(status)) continue;
    if (!["not_collected", "checkout_started", "checkout_expired", "payment_failed", ""].includes(money)) continue;

    const customerId = freezeText(b.requestOwnerId || b.customerId || b.plannerId, "");
    await freezeNotify(customerId, {
      recipientRole: "customer",
      type: "vendor_unavailable",
      typeLabel: "Vendor Unavailable",
      category: "Booking",
      title: name + " isn't taking bookings right now",
      body: "See similar vendors for " + freezeText(b.eventName, "your event") + ".",
      link: similarVendorsLink(b, vendorId),
      bookingRequestId: doc.id,
      eventId: freezeText(b.eventId, ""),
      vendorId
    });
  }

  console.log("Vendor frozen:", vendorId, reason, detail || "");
  return true;
}

/**
 * Vendors who have left a booking request unanswered. A reminder at 5 days,
 * frozen at 7. Only requests from the last 30 days count, so old test data
 * and long dead requests never freeze anybody.
 */
async function runNoReplyCheck(nowMs, summary) {
  const snap = await db.collection("bookingRequests")
    .where("requestStatus", "==", "pending")
    .limit(1000)
    .get();

  summary.noReplyWarned = 0;
  summary.vendorsFrozen = 0;

  for (const doc of snap.docs) {
    const b = doc.data() || {};
    const createdMs = toMillis(b.createdAt);
    if (!createdMs) continue;

    const ageDays = (nowMs - createdMs) / 86400000;
    if (ageDays < 5 || ageDays > 30) continue;
    if (!["not_collected", ""].includes(cleanText(b.paymentStatus, "not_collected"))) continue;

    const responses = b.vendorResponses || {};
    const warned = b.noReplyWarned || {};
    const vendorIds = Array.isArray(b.vendorIds) ? b.vendorIds : [];
    const eventName = cleanText(b.eventName, "an event");

    for (const vendorId of vendorIds) {
      if (!vendorId || responses[vendorId]) continue;

      if (ageDays >= 7) {
        if (await freezeVendor(vendorId, "no_reply", eventName)) summary.vendorsFrozen += 1;
      } else if (!warned[vendorId]) {
        await freezeNotify(vendorId, {
          recipientRole: "vendor",
          type: "reply_reminder",
          typeLabel: "Reply Needed",
          category: "Booking Request",
          title: "Reply to " + eventName,
          body: "This request is 5 days old. Reply within 2 days or your listings will be paused.",
          link: "/booking-requests.html?id=" + encodeURIComponent(doc.id),
          bookingRequestId: doc.id,
          vendorId
        });
        await doc.ref.set({ noReplyWarned: { [vendorId]: true } }, { merge: true });
        summary.noReplyWarned += 1;
      }
    }
  }
}

exports.releaseVendorPayouts = onRequest(
  {
    region: "us-central1",
    secrets: [STRIPE_SECRET_KEY],
    timeoutSeconds: 540,
    memory: "512MiB",
    cors: false
  },
  async (req, res) => {
    const stripe = new Stripe(STRIPE_SECRET_KEY.value());
    const nowMs = Date.now();

    const summary = {
      examined: 0,
      settled: 0,
      transfers: 0,
      failed: 0,
      skipped: {}
    };

    try {
      // Balances first, so a booking whose balance lands today is in the
      // right state for every later step.
      await runBalances(stripe, nowMs, summary);

      // Vendors who have gone quiet on a request. Failing here must never
      // stop anybody being paid, so it is fenced off from the payout run.
      await runNoReplyCheck(nowMs, summary).catch((error) =>
        console.error("No-reply check failed:", error.message));

      // A single equality filter, which Firestore indexes automatically, so
      // this needs no composite index. Bookings leave "scheduled" once paid,
      // so the set stays small.
      const snap = await db.collection("bookingRequests")
        .where("payoutStatus", "==", "scheduled")
        .limit(BATCH_SIZE)
        .get();

      summary.examined = snap.size;

      for (const doc of snap.docs) {
        const outcome = await settleBooking(stripe, doc, nowMs);

        if (outcome.skipped) {
          summary.skipped[outcome.skipped] = (summary.skipped[outcome.skipped] || 0) + 1;
          continue;
        }

        if (outcome.paid) {
          summary.settled += 1;
          summary.transfers += outcome.paid;
        }

        summary.failed += outcome.failed || 0;
      }

      console.log("Payout run complete:", JSON.stringify(summary));
      res.status(200).json({ success: true, ...summary });
    } catch (error) {
      console.error("releaseVendorPayouts error:", error);
      res.status(500).json({ success: false, error: error.message || "Payout run failed." });
    }
  }
);
