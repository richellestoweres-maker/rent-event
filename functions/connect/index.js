/**
 * RentEvent Stripe Connect
 *
 * This is the piece that lets a vendor get paid. Today every dollar a customer
 * pays lands in the RentEvent Stripe account and stays there, and there is no
 * way to move a vendor's share to their bank without doing it by hand.
 *
 * A vendor sets up payouts once, on Stripe's own hosted pages. Stripe collects
 * their bank account, legal name, and tax details directly. None of it touches
 * the RentEvent database and nobody at RentEvent ever sees it. What comes back
 * is an account id, which is safe to store, and a payouts_enabled flag.
 *
 * It also runs vendor verification billing: the $14.99 a month subscription
 * that keeps an approved vendor's Verified badge switched on.
 *
 * Deployed as its own Cloud Run function with entry point: stripeConnect
 * Secrets it needs: STRIPE_SECRET_KEY
 *
 * Every call must carry a Firebase ID token in the Authorization header, so a
 * vendor can only ever act on their own account.
 */

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const Stripe = require("stripe");

admin.initializeApp();

const STRIPE_SECRET_KEY = defineSecret("STRIPE_SECRET_KEY");

const db = admin.firestore();

/** Where a vendor lands when they come back from Stripe. */
const SITE_ORIGIN = "https://www.rentevent-app.com";
const RETURN_PATH = "/vendor-payouts.html";

const ALLOWED_ORIGINS = [
  "https://www.rentevent-app.com",
  "https://rentevent-app.com",
  "https://renteventapp.com",
  "https://www.renteventapp.com",
  "https://richelle-creator.github.io",
  "http://localhost:5000",
  "http://localhost:5173",
  "http://127.0.0.1:5000",
  "http://127.0.0.1:5173"
];

function setCors(req, res) {
  const origin = req.get("origin") || "";
  const allowed = ALLOWED_ORIGINS.includes(origin) || origin.includes("github.io")
    ? origin
    : ALLOWED_ORIGINS[0];

  res.set("Access-Control-Allow-Origin", allowed);
  res.set("Vary", "Origin");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function cleanText(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

/**
 * Reads the Firebase ID token off the request and proves who is calling.
 * Nothing below runs without this, and the uid it returns is the only identity
 * used, so a caller cannot act on somebody else's account by passing a uid in
 * the body.
 */
async function requireUser(req) {
  const decoded = await requireToken(req);
  return decoded.uid;
}

async function requireToken(req) {
  const header = cleanText(req.get("authorization"), "");

  if (!header.toLowerCase().startsWith("bearer ")) {
    const err = new Error("Please sign in again.");
    err.status = 401;
    throw err;
  }

  try {
    return await admin.auth().verifyIdToken(header.slice(7).trim());
  } catch (e) {
    const err = new Error("Your session expired. Please sign in again.");
    err.status = 401;
    throw err;
  }
}

/**
 * Copies the live state of a Stripe account onto the user document. These are
 * the fields the rest of the app reads, and they are all in the protected list
 * in the Firestore rules, so only this server can write them.
 */
async function syncAccountToFirestore(uid, account) {
  const requirements = account.requirements || {};

  const payload = {
    stripeAccountId: account.id,
    payoutsEnabled: account.payouts_enabled === true,
    chargesEnabled: account.charges_enabled === true,
    stripeDetailsSubmitted: account.details_submitted === true,
    stripeRequirementsDue: [
      ...(requirements.currently_due || []),
      ...(requirements.past_due || [])
    ],
    stripeDisabledReason: cleanText(requirements.disabled_reason, ""),
    stripeAccountUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };

  await db.collection("users").doc(uid).set(payload, { merge: true });

  // Mirror the one flag listings care about, so a listing page does not have to
  // read the user document to know whether this vendor can be booked.
  await db.collection("vendor_profiles").doc(uid).set({
    payoutsEnabled: payload.payoutsEnabled,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  return payload;
}

function publicStatus(account) {
  const requirements = account.requirements || {};
  const due = [
    ...(requirements.currently_due || []),
    ...(requirements.past_due || [])
  ];

  let state = "not_started";
  if (account.payouts_enabled === true) state = "ready";
  else if (account.details_submitted === true) state = "under_review";
  else if (due.length > 0) state = "incomplete";

  return {
    state,
    accountId: account.id,
    payoutsEnabled: account.payouts_enabled === true,
    chargesEnabled: account.charges_enabled === true,
    detailsSubmitted: account.details_submitted === true,
    requirementsDue: due,
    disabledReason: cleanText(requirements.disabled_reason, "")
  };
}

/**
 * Finds this vendor's Stripe account, creating one the first time. The id is
 * written before the onboarding link is made, so a vendor who abandons the form
 * halfway comes back to the same account instead of starting a second one.
 */
async function getOrCreateAccount(stripe, uid) {
  const userRef = db.collection("users").doc(uid);
  const userSnap = await userRef.get();
  const user = userSnap.exists ? userSnap.data() || {} : {};

  const existingId = cleanText(user.stripeAccountId, "");

  if (existingId) {
    try {
      return await stripe.accounts.retrieve(existingId);
    } catch (e) {
      // The stored id points at nothing usable, for example a test mode account
      // left behind after a key change. Fall through and make a fresh one.
      console.warn("Stored stripeAccountId unusable for", uid, e.message);
    }
  }

  const account = await stripe.accounts.create({
    type: "express",
    country: "US",
    email: cleanText(user.email, "") || undefined,
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true }
    },
    business_profile: {
      name: cleanText(user.businessName || user.displayName || user.name, "") || undefined,
      product_description: "Event services booked through RentEvent",
      url: SITE_ORIGIN
    },
    settings: {
      payouts: {
        schedule: { interval: "daily", delay_days: "minimum" }
      }
    },
    metadata: {
      rentEventUserId: uid,
      platform: "rentevent"
    }
  });

  await userRef.set({
    stripeAccountId: account.id,
    payoutsEnabled: false,
    chargesEnabled: false,
    stripeDetailsSubmitted: false,
    stripeAccountCreatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  return account;
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

/** Starts or resumes onboarding. Returns a one-time Stripe URL. */
async function actionOnboard(stripe, uid) {
  const account = await getOrCreateAccount(stripe, uid);

  const link = await stripe.accountLinks.create({
    account: account.id,
    type: "account_onboarding",
    // Stripe sends them here if the link went stale. The page just asks for a
    // fresh one, which is why this points back at the same place.
    refresh_url: SITE_ORIGIN + RETURN_PATH + "?refresh=1",
    return_url: SITE_ORIGIN + RETURN_PATH + "?done=1",
    collection_options: {
      fields: "eventually_due"
    }
  });

  return { url: link.url, status: publicStatus(account) };
}

/** Reads the live account and writes the result back to Firestore. */
async function actionStatus(stripe, uid) {
  const userSnap = await db.collection("users").doc(uid).get();
  const accountId = cleanText((userSnap.data() || {}).stripeAccountId, "");

  if (!accountId) {
    return { status: { state: "not_started", payoutsEnabled: false } };
  }

  let account;
  try {
    account = await stripe.accounts.retrieve(accountId);
  } catch (e) {
    console.warn("Could not retrieve account", accountId, e.message);
    return { status: { state: "not_started", payoutsEnabled: false } };
  }

  await syncAccountToFirestore(uid, account);
  return { status: publicStatus(account) };
}

/** Opens the vendor's own Stripe dashboard, where they see their payouts. */
async function actionDashboard(stripe, uid) {
  const userSnap = await db.collection("users").doc(uid).get();
  const accountId = cleanText((userSnap.data() || {}).stripeAccountId, "");

  if (!accountId) {
    const err = new Error("Set up payouts first.");
    err.status = 400;
    throw err;
  }

  const account = await stripe.accounts.retrieve(accountId);

  if (account.details_submitted !== true) {
    // Stripe refuses a login link before onboarding finishes, so send them back
    // into onboarding rather than showing them an API error.
    return actionOnboard(stripe, uid);
  }

  const link = await stripe.accounts.createLoginLink(accountId);
  return { url: link.url, status: publicStatus(account) };
}


/* ------------------------------------------------------------------ */
/* Vendor verification subscription                                    */
/*                                                                     */
/* The badge needs two things at once: Richelle approved the documents, */
/* and the $14.99 a month subscription is paid up. Approval alone does  */
/* not show it, and paying alone does not show it.                      */
/*                                                                     */
/* Subscription details are stored on the vendor's vendorVerifications */
/* document, which the vendor can read but never write those fields of, */
/* because the Firestore rules only let them touch application fields. */
/* ------------------------------------------------------------------ */

const LIVE_SUBSCRIPTION_STATES = new Set(["active", "trialing"]);

function dayFromUnix(seconds) {
  if (!seconds) return "";
  return new Date(Number(seconds) * 1000).toISOString().slice(0, 10);
}

/** Newer Stripe API versions keep the period end on the item, older ones on the subscription. */
function subscriptionPeriodEnd(sub) {
  if (sub.current_period_end) return sub.current_period_end;
  const item = sub.items && sub.items.data && sub.items.data[0];
  return (item && item.current_period_end) || 0;
}

function insuranceStillGood(verifiedUntil) {
  const m = String(verifiedUntil || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const now = new Date();
  return Date.UTC(+m[1], +m[2] - 1, +m[3]) >=
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

/**
 * Puts the public badge on or takes it off.
 *
 * Off whenever the subscription is not paid up. On when it is paid, the
 * application is approved, and the insurance has not run out. While a paying
 * vendor is being re-reviewed (status "pending") the badge is left as it is,
 * the same way it worked before subscriptions existed.
 */
async function syncVerificationBadge(vendorId, application) {
  const badgeRef = db.collection("verifiedVendors").doc(vendorId);
  const paid = LIVE_SUBSCRIPTION_STATES.has(application.subscriptionStatus || "");

  if (!paid) {
    await badgeRef.delete().catch(() => {});
    return false;
  }

  if (application.status === "approved" && insuranceStillGood(application.verifiedUntil)) {
    const existing = await badgeRef.get();
    const badge = {
      vendorId,
      legalName: application.legalName || "",
      verifiedUntil: application.verifiedUntil
    };
    if (!existing.exists) badge.approvedAt = admin.firestore.FieldValue.serverTimestamp();
    await badgeRef.set(badge, { merge: true });
    return true;
  }

  return false;
}

/** Records a subscription's current state against the vendor and fixes the badge to match. */
async function applyVerificationSubscription(sub) {
  const vendorId = (sub.metadata && sub.metadata.rentEventVendorId) || "";
  if (!vendorId) return null;

  const appRef = db.collection("vendorVerifications").doc(vendorId);
  const snap = await appRef.get();

  if (!snap.exists) {
    console.warn("Verification subscription for a vendor with no application", vendorId, sub.id);
    return null;
  }

  const application = snap.data() || {};
  const storedId = application.subscriptionId || "";

  // An old subscription ending must never switch off a newer one that is paid.
  if (storedId && storedId !== sub.id &&
      LIVE_SUBSCRIPTION_STATES.has(application.subscriptionStatus || "") &&
      !LIVE_SUBSCRIPTION_STATES.has(sub.status)) {
    console.log("Ignoring stale subscription", sub.id, "for", vendorId);
    return application;
  }

  const update = {
    subscriptionId: sub.id,
    subscriptionStatus: sub.status,
    subscriptionPeriodEnd: dayFromUnix(subscriptionPeriodEnd(sub)),
    subscriptionCancelAtPeriodEnd: sub.cancel_at_period_end === true,
    subscriptionUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
  };

  await appRef.set(update, { merge: true });

  const merged = Object.assign({}, application, update);
  await syncVerificationBadge(vendorId, merged);

  console.log("Verification subscription", sub.id, "for", vendorId, "is", sub.status);
  return merged;
}

/* ------------------------------------------------------------------ */
/* Verification billing actions                                        */
/* ------------------------------------------------------------------ */

const VERIFY_LOOKUP_KEY = "rentevent_verified_monthly";
const VERIFY_PRICE_CENTS = 1499;
const VERIFY_PATH = "/vendor-verification.html";

/** Same admins as the Firestore rules. */
const ADMIN_USER_IDS = ["GBrIifV7FnOnXhXmgmG4lpMg4Lr1"];

function isAdminToken(decoded) {
  return decoded.admin === true || ADMIN_USER_IDS.includes(decoded.uid);
}

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * The $14.99 monthly price. Made once in Stripe and remembered, so every vendor
 * is on the same product and it reads cleanly in the Stripe dashboard.
 */
async function getVerificationPriceId(stripe) {
  const cfgRef = db.collection("platformConfig").doc("verificationBilling");
  const cfg = (await cfgRef.get()).data() || {};
  if (cfg.priceId) return cfg.priceId;

  const found = await stripe.prices.list({ lookup_keys: [VERIFY_LOOKUP_KEY], active: true, limit: 1 });
  let price = found.data[0];

  if (!price) {
    const product = await stripe.products.create({
      name: "RentEvent Verified",
      description: "Verified badge on your RentEvent listings, billed monthly.",
      metadata: { platform: "rentevent" }
    });

    price = await stripe.prices.create({
      product: product.id,
      currency: "usd",
      unit_amount: VERIFY_PRICE_CENTS,
      recurring: { interval: "month" },
      lookup_key: VERIFY_LOOKUP_KEY,
      nickname: "Verified monthly"
    });
  }

  await cfgRef.set({
    priceId: price.id,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  return price.id;
}

/** Stripe's billing page settings. Made once through the API so nothing needs setting up by hand. */
async function getPortalConfigId(stripe) {
  const cfgRef = db.collection("platformConfig").doc("verificationBilling");
  const cfg = (await cfgRef.get()).data() || {};
  if (cfg.portalConfigId) return cfg.portalConfigId;

  const config = await stripe.billingPortal.configurations.create({
    business_profile: {
      headline: "RentEvent Verified",
      privacy_policy_url: SITE_ORIGIN + "/privacy.html",
      terms_of_service_url: SITE_ORIGIN + "/terms.html"
    },
    features: {
      payment_method_update: { enabled: true },
      invoice_history: { enabled: true },
      subscription_cancel: { enabled: true, mode: "at_period_end" }
    },
    default_return_url: SITE_ORIGIN + VERIFY_PATH + "?billing=1"
  });

  await cfgRef.set({
    portalConfigId: config.id,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  return config.id;
}

/** The vendor as a Stripe customer, who is the one paying for the subscription. */
async function getOrCreateCustomer(stripe, uid) {
  const userRef = db.collection("users").doc(uid);
  const user = (await userRef.get()).data() || {};
  const existingId = cleanText(user.stripeCustomerId, "");

  if (existingId) {
    try {
      const customer = await stripe.customers.retrieve(existingId);
      if (!customer.deleted) return customer.id;
    } catch (e) {
      console.warn("Stored stripeCustomerId unusable for", uid, e.message);
    }
  }

  const customer = await stripe.customers.create({
    email: cleanText(user.email, "") || undefined,
    name: cleanText(user.businessName || user.displayName || user.name, "") || undefined,
    metadata: { rentEventUserId: uid, platform: "rentevent" }
  });

  await userRef.set({
    stripeCustomerId: customer.id,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  return customer.id;
}

async function readApplication(uid) {
  const snap = await db.collection("vendorVerifications").doc(uid).get();
  return snap.exists ? snap.data() || {} : null;
}

/** Finds a paid verification subscription Stripe has that our records might not know about yet. */
async function findLiveSubscription(stripe, customerId) {
  const subs = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 20 });
  return subs.data.find((s) =>
    s.metadata && s.metadata.purpose === "vendor_verification" &&
    LIVE_SUBSCRIPTION_STATES.has(s.status)
  ) || null;
}

function publicBilling(application) {
  const a = application || {};
  return {
    subscriptionStatus: a.subscriptionStatus || "none",
    periodEnd: a.subscriptionPeriodEnd || "",
    cancelAtPeriodEnd: a.subscriptionCancelAtPeriodEnd === true
  };
}

/** Opens Stripe's billing page, where a vendor changes card, sees receipts or cancels. */
async function actionVerifyManage(stripe, uid) {
  const customerId = await getOrCreateCustomer(stripe, uid);
  const configuration = await getPortalConfigId(stripe);

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    configuration,
    return_url: SITE_ORIGIN + VERIFY_PATH + "?billing=1"
  });

  return { url: session.url };
}

/** Starts the monthly subscription. Only works once the documents are approved. */
async function actionVerifySubscribe(stripe, uid) {
  const application = await readApplication(uid);

  if (!application || application.status !== "approved") {
    throw httpError("You can turn on your badge once we have approved your details.", 400);
  }

  if (!insuranceStillGood(application.verifiedUntil)) {
    throw httpError("Your insurance on file has expired. Send your new certificate first.", 400);
  }

  const customerId = await getOrCreateCustomer(stripe, uid);

  // Never sell somebody a second subscription. If one is already paid, even one
  // the webhook has not told us about yet, send them to manage it instead.
  const live = await findLiveSubscription(stripe, customerId);
  if (live) {
    await applyVerificationSubscription(live);
    return actionVerifyManage(stripe, uid);
  }

  const priceId = await getVerificationPriceId(stripe);
  const metadata = { purpose: "vendor_verification", rentEventVendorId: uid };

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    metadata,
    subscription_data: { metadata },
    success_url: SITE_ORIGIN + VERIFY_PATH + "?subscribed=1",
    cancel_url: SITE_ORIGIN + VERIFY_PATH
  });

  return { url: session.url };
}

/** Reads the subscription straight from Stripe, so the page is right even before the webhook lands. */
async function actionVerifyStatus(stripe, uid) {
  const application = await readApplication(uid);
  if (!application) return { billing: publicBilling(null) };

  let sub = null;

  if (application.subscriptionId) {
    try {
      sub = await stripe.subscriptions.retrieve(application.subscriptionId);
    } catch (e) {
      console.warn("Could not read subscription", application.subscriptionId, e.message);
    }
  }

  if (!sub || !LIVE_SUBSCRIPTION_STATES.has(sub.status)) {
    const user = (await db.collection("users").doc(uid).get()).data() || {};
    const customerId = cleanText(user.stripeCustomerId, "");
    if (customerId) {
      const live = await findLiveSubscription(stripe, customerId);
      if (live) sub = live;
    }
  }

  if (!sub) return { billing: publicBilling(application) };

  const updated = await applyVerificationSubscription(sub);
  return { billing: publicBilling(updated || application) };
}

/**
 * Admin only. Stops the vendor being charged when their badge is removed or
 * their renewal is rejected. Cancels straight away with no refund.
 */
async function actionVerifyAdminCancel(stripe, decoded, body) {
  if (!isAdminToken(decoded)) throw httpError("Admins only.", 403);

  const vendorId = cleanText(body.vendorId, "");
  if (!vendorId) throw httpError("Which vendor?", 400);

  const application = await readApplication(vendorId);
  const subId = application && application.subscriptionId;

  if (!subId) return { cancelled: false, reason: "no_subscription" };

  let sub = await stripe.subscriptions.retrieve(subId);
  if (sub.status !== "canceled" && sub.status !== "incomplete_expired") {
    sub = await stripe.subscriptions.cancel(subId);
  }

  await applyVerificationSubscription(sub);
  return { cancelled: true };
}

/* ------------------------------------------------------------------ */

exports.stripeConnect = onRequest(
  {
    region: "us-central1",
    secrets: [STRIPE_SECRET_KEY],
    timeoutSeconds: 60,
    memory: "512MiB",
    cors: false,
    invoker: "public"
  },
  async (req, res) => {
    setCors(req, res);

    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({ success: false, error: "Method not allowed." });
      return;
    }

    try {
      const decoded = await requireToken(req);
      const uid = decoded.uid;
      const stripe = new Stripe(STRIPE_SECRET_KEY.value());
      const action = cleanText((req.body || {}).action, "status");

      let result;

      switch (action) {
        case "onboard":
          result = await actionOnboard(stripe, uid);
          break;
        case "status":
          result = await actionStatus(stripe, uid);
          break;
        case "dashboard":
          result = await actionDashboard(stripe, uid);
          break;
        case "verifySubscribe":
          result = await actionVerifySubscribe(stripe, uid);
          break;
        case "verifyManage":
          result = await actionVerifyManage(stripe, uid);
          break;
        case "verifyStatus":
          result = await actionVerifyStatus(stripe, uid);
          break;
        case "verifyAdminCancel":
          result = await actionVerifyAdminCancel(stripe, decoded, req.body || {});
          break;
        default:
          res.status(400).json({ success: false, error: "Unknown action: " + action });
          return;
      }

      res.status(200).json({ success: true, ...result });
    } catch (error) {
      const status = error.status || 500;

      if (status >= 500) {
        console.error("stripeConnect error:", error);
      }

      res.status(status).json({
        success: false,
        error: error.message || "Something went wrong setting up payouts."
      });
    }
  }
);
