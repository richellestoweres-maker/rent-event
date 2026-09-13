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
  const header = cleanText(req.get("authorization"), "");

  if (!header.toLowerCase().startsWith("bearer ")) {
    const err = new Error("Please sign in again.");
    err.status = 401;
    throw err;
  }

  try {
    const decoded = await admin.auth().verifyIdToken(header.slice(7).trim());
    return decoded.uid;
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
      const uid = await requireUser(req);
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
