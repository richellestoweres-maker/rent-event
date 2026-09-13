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

  if (booking.paymentStatus !== "paid") {
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

  // Never pay out more than was actually collected. If these disagree, the
  // booking was edited after payment and a person should look at it.
  const planTotal = plan.reduce((sum, item) => sum + Number(item.amountCents || 0), 0);
  const collected = Number(booking.stripeAmountCollectedCents || booking.stripeAmountCents || 0);

  if (!planTotal || (collected && planTotal > collected)) {
    await flagForReview(ref, "payout_exceeds_collected", {
      payoutPlannedCents: planTotal,
      stripeAmountCollectedCents: collected
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
        source_transaction: chargeId,
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
