/**
 * RentEvent Stripe webhook
 *
 * This is the piece that was missing. Today createStripeCheckoutSession sets a
 * booking to "checkout_started" and nothing ever moves it past that, so a
 * customer can pay in full and the booking still looks unpaid to you and to
 * the vendor.
 *
 * Stripe calls this function directly, server to server. A browser cannot fake
 * it, because every request carries a signature made with a secret only Stripe
 * and this function know.
 *
 * Entry point: stripeWebhook
 * Secrets it needs: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
 */

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const Stripe = require("stripe");

admin.initializeApp();

const STRIPE_SECRET_KEY = defineSecret("STRIPE_SECRET_KEY");
const STRIPE_WEBHOOK_SECRET = defineSecret("STRIPE_WEBHOOK_SECRET");

const db = admin.firestore();

/** Events we act on. Stripe sends many more; we ignore the rest. */
const HANDLED = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
  "charge.refunded",
  "account.updated",
]);

function bookingIdFromSession(session) {
  return (
    (session.metadata && session.metadata.bookingRequestId) ||
    session.client_reference_id ||
    ""
  );
}

/**
 * Records the event id before doing any work. If the same event arrives twice,
 * which Stripe does on retries, the second one stops here. Firestore's create()
 * fails if the document already exists, which makes this atomic.
 */
async function claimEvent(event) {
  try {
    await db.collection("stripeEvents").doc(event.id).create({
      type: event.type,
      livemode: event.livemode === true,
      receivedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return true;
  } catch (err) {
    if (err && err.code === 6) return false; // ALREADY_EXISTS
    throw err;
  }
}

async function markPaid(session, event, stripe) {
  const bookingRequestId = bookingIdFromSession(session);
  if (!bookingRequestId) {
    console.error("No bookingRequestId on session", session.id);
    return;
  }

  const ref = db.collection("bookingRequests").doc(bookingRequestId);
  const snap = await ref.get();

  if (!snap.exists) {
    console.error("Booking not found for session", session.id, bookingRequestId);
    return;
  }

  const booking = snap.data() || {};

  // The session id must be the one this booking actually started. Without this
  // check, a session belonging to a different booking could be pointed here.
  if (booking.stripeCheckoutSessionId && booking.stripeCheckoutSessionId !== session.id) {
    console.error(
      "Session mismatch for booking", bookingRequestId,
      "expected", booking.stripeCheckoutSessionId, "got", session.id
    );
    await ref.set({
      paymentReviewReason: "stripe_session_mismatch",
      paymentNeedsReview: true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    return;
  }

  // The amount Stripe collected must match the amount this server quoted.
  const expected = Number(booking.stripeAmountCents || 0);
  const collected = Number(session.amount_total || 0);

  if (expected > 0 && collected !== expected) {
    console.error(
      "Amount mismatch for booking", bookingRequestId,
      "expected", expected, "collected", collected
    );
    await ref.set({
      paymentNeedsReview: true,
      paymentReviewReason: "amount_mismatch",
      stripeAmountCollectedCents: collected,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    return;
  }

  if (booking.paymentStatus === "paid") return; // already settled

  const paymentIntentId =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : (session.payment_intent && session.payment_intent.id) || "";

  // Vendor transfers are drawn from this specific charge, which is what lets
  // them be created later without waiting for the money to clear into the
  // platform balance. Without a charge id there is nothing to pay out from.
  let chargeId = "";

  if (paymentIntentId && stripe) {
    try {
      const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
      chargeId =
        typeof intent.latest_charge === "string"
          ? intent.latest_charge
          : (intent.latest_charge && intent.latest_charge.id) || "";
    } catch (err) {
      console.error("Could not read payment intent", paymentIntentId, err.message);
    }
  }

  const hasPayoutPlan = Array.isArray(booking.payoutPlan) && booking.payoutPlan.length > 0;

  await ref.set({
    paymentStatus: "paid",
    status: "confirmed",
    paidAt: admin.firestore.FieldValue.serverTimestamp(),
    stripePaymentIntentId: paymentIntentId,
    stripeAmountCollectedCents: collected,
    stripeCurrency: session.currency || "usd",
    stripeCustomerEmail:
      (session.customer_details && session.customer_details.email) ||
      session.customer_email ||
      "",
    stripeLivemode: event.livemode === true,
    paymentConfirmedBy: "stripe_webhook",
    paymentNeedsReview: false,
    stripeChargeId: chargeId,
    // "scheduled" is what the payout job looks for. No charge id means no
    // payout is possible, so flag it for a human rather than silently skipping.
    payoutStatus: hasPayoutPlan && chargeId ? "scheduled" : "needs_review",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  console.log("Booking marked paid:", bookingRequestId, "session", session.id);
}

async function markNotPaid(session, status) {
  const bookingRequestId = bookingIdFromSession(session);
  if (!bookingRequestId) return;

  const ref = db.collection("bookingRequests").doc(bookingRequestId);
  const snap = await ref.get();
  if (!snap.exists) return;

  // Never walk a genuinely paid booking backwards.
  if ((snap.data() || {}).paymentStatus === "paid") return;

  await ref.set({
    paymentStatus: status,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  console.log("Booking marked", status + ":", bookingRequestId);
}

async function markRefunded(charge) {
  const bookingRequestId =
    (charge.metadata && charge.metadata.bookingRequestId) || "";
  if (!bookingRequestId) return;

  const ref = db.collection("bookingRequests").doc(bookingRequestId);
  const snap = await ref.get();
  if (!snap.exists) return;

  const fullyRefunded = charge.amount_refunded >= charge.amount;

  const booking = snap.data() || {};
  const alreadyPaidOut = booking.payoutStatus === "paid_out";

  const update = {
    paymentStatus: fullyRefunded ? "refunded" : "partially_refunded",
    stripeAmountRefundedCents: charge.amount_refunded,
    refundedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  // Stop a scheduled payout before it happens. If the vendor has already been
  // paid, that money has to be reversed deliberately, so flag it instead.
  if (fullyRefunded && !alreadyPaidOut) {
    update.payoutStatus = "cancelled_refunded";
  } else if (alreadyPaidOut) {
    update.payoutNeedsReview = true;
    update.payoutReviewReason = "refund_after_payout";
  }

  await ref.set(update, { merge: true });

  console.log("Booking refunded:", bookingRequestId);
}

/**
 * A connected vendor account changed, for example they finished onboarding or
 * Stripe asked them for another document. This keeps payoutsEnabled honest
 * without waiting for the vendor to open the payouts page.
 *
 * Note: this arrives as a Connect event, so the Stripe event destination has to
 * have Connect events turned on or it will never be sent.
 */
async function syncConnectedAccount(account) {
  const uid = (account.metadata && account.metadata.rentEventUserId) || "";

  let userRef = null;

  if (uid) {
    userRef = db.collection("users").doc(uid);
  } else {
    // No metadata, so find the user by the stored account id instead.
    const found = await db.collection("users")
      .where("stripeAccountId", "==", account.id)
      .limit(1)
      .get();

    if (found.empty) {
      console.warn("account.updated for an unknown account", account.id);
      return;
    }

    userRef = found.docs[0].ref;
  }

  const requirements = account.requirements || {};
  const payoutsEnabled = account.payouts_enabled === true;

  await userRef.set({
    stripeAccountId: account.id,
    payoutsEnabled,
    chargesEnabled: account.charges_enabled === true,
    stripeDetailsSubmitted: account.details_submitted === true,
    stripeRequirementsDue: [
      ...(requirements.currently_due || []),
      ...(requirements.past_due || []),
    ],
    stripeDisabledReason: requirements.disabled_reason || "",
    stripeAccountUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  await db.collection("vendor_profiles").doc(userRef.id).set({
    payoutsEnabled,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  console.log("Connected account synced:", account.id, "payouts", payoutsEnabled);
}

exports.stripeWebhook = onRequest(
  {
    region: "us-central1",
    secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET],
    cors: false,
    invoker: "public",
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method not allowed");
      return;
    }

    const stripe = new Stripe(STRIPE_SECRET_KEY.value());
    const signature = req.get("stripe-signature");

    let event;
    try {
      // req.rawBody is required. A parsed body will not verify, because the
      // signature is computed over the exact bytes Stripe sent.
      event = stripe.webhooks.constructEvent(
        req.rawBody,
        signature,
        STRIPE_WEBHOOK_SECRET.value()
      );
    } catch (err) {
      console.error("Signature verification failed:", err.message);
      res.status(400).send(`Webhook Error: ${err.message}`);
      return;
    }

    if (!HANDLED.has(event.type)) {
      res.status(200).json({ received: true, ignored: event.type });
      return;
    }

    try {
      const fresh = await claimEvent(event);
      if (!fresh) {
        res.status(200).json({ received: true, duplicate: true });
        return;
      }

      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object;
          // Card payments arrive here already paid. Slower methods arrive
          // unpaid and settle later via async_payment_succeeded.
          if (session.payment_status === "paid") {
            await markPaid(session, event, stripe);
          } else {
            await markNotPaid(session, "awaiting_payment");
          }
          break;
        }
        case "checkout.session.async_payment_succeeded":
          await markPaid(event.data.object, event, stripe);
          break;
        case "checkout.session.async_payment_failed":
          await markNotPaid(event.data.object, "payment_failed");
          break;
        case "checkout.session.expired":
          await markNotPaid(event.data.object, "checkout_expired");
          break;
        case "charge.refunded":
          await markRefunded(event.data.object);
          break;
        case "account.updated":
          await syncConnectedAccount(event.data.object);
          break;
      }

      res.status(200).json({ received: true });
    } catch (err) {
      // A non-200 tells Stripe to retry, which is what we want on a real fault.
      console.error("Webhook handler error:", err);
      res.status(500).send("Webhook handler failed");
    }
  }
);
