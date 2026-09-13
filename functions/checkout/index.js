const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const OpenAI = require("openai");
const Stripe = require("stripe");

admin.initializeApp();

const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");
const STRIPE_SECRET_KEY = defineSecret("STRIPE_SECRET_KEY");

const db = admin.firestore();

function cleanText(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function normalizeArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => cleanText(item, "")).filter(Boolean);
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function roundCentsFromDollars(value) {
  return Math.round(toNumber(value, 0) * 100);
}

function buildSelectedVendorSummary(selectedVendors = []) {
  if (!Array.isArray(selectedVendors) || selectedVendors.length === 0) {
    return "No vendors have been added yet.";
  }

  return selectedVendors.map((vendor, index) => {
    const title = cleanText(vendor.listingTitle || vendor.title, "Untitled Vendor");
    const category = cleanText(vendor.category || vendor.listingCategory || vendor.mainCategory, "Event Service");
    const price = cleanText(vendor.startingPrice || vendor.priceNumber, "Price not listed");

    return `${index + 1}. ${title} — ${category} — ${price}`;
  }).join("\n");
}

function buildAvailableCategorySummary(availableCategories = []) {
  const categories = normalizeArray(availableCategories);

  if (!categories.length) {
    return "No marketplace categories were provided.";
  }

  return categories.join(", ");
}

function getAllowedOrigin(origin = "") {
  const allowedOrigins = [
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

  if (!origin) return "*";
  if (allowedOrigins.includes(origin)) return origin;
  if (origin.includes("github.io")) return origin;

  return allowedOrigins[0];
}

function setCors(req, res) {
  const origin = req.get("origin") || "";
  res.set("Access-Control-Allow-Origin", getAllowedOrigin(origin));
  res.set("Vary", "Origin");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function handleOptions(req, res) {
  if (req.method === "OPTIONS") {
    setCors(req, res);
    res.status(204).send("");
    return true;
  }

  return false;
}

function getRequestUserId(reqBody = {}) {
  return cleanText(
    reqBody.requestOwnerId ||
      reqBody.customerId ||
      reqBody.plannerId ||
      reqBody.submittedBy ||
      "",
    ""
  );
}

function calculateTotalsFromBookingRequest(bookingRequest = {}) {
  const vendors = Array.isArray(bookingRequest.vendors) ? bookingRequest.vendors : [];

  const vendorSubtotal = vendors.reduce((total, vendor) => {
    return total + toNumber(vendor.priceNumber, 0);
  }, 0);

  const serviceFeePercent = toNumber(bookingRequest.serviceFeePercent, 0.10);
  const processingPercent = toNumber(bookingRequest.processingPercent, 0.029);
  const processingFixed = toNumber(bookingRequest.processingFixed, 0.30);

  const serviceFee = vendorSubtotal * serviceFeePercent;
  const baseBeforeProcessing = vendorSubtotal + serviceFee;

  // Stripe takes its cut out of the FINAL amount charged, not out of the
  // subtotal. Charging base * 2.9% here left RentEvent about 25 cents short on
  // every $250 booking. Solving for the total that still nets "base" after
  // Stripe's fee is what keeps the service fee whole.
  const processingFee = baseBeforeProcessing > 0
    ? ((baseBeforeProcessing + processingFixed) / (1 - processingPercent)) - baseBeforeProcessing
    : 0;

  const totalDue = baseBeforeProcessing + processingFee;

  return {
    vendorSubtotal,
    serviceFee,
    processingFee,
    totalDue,
    amountCents: roundCentsFromDollars(totalDue)
  };
}

/** Vendors are paid two days after the event, not at the moment of booking. */
const PAYOUT_DELAY_DAYS = 2;

/** Used only when a booking somehow has no readable event date. */
const PAYOUT_FALLBACK_DAYS = 14;

/**
 * When this booking's vendors should actually be paid.
 *
 * Holding the money until after the event is what makes cancellations simple:
 * a customer who cancels three weeks out is just a refund, with nothing to claw
 * back out of a vendor's bank account.
 */
function payoutReleaseInfo(bookingRequest = {}) {
  const raw = cleanText(bookingRequest.eventDetails?.eventDate, "");
  const parsed = raw ? new Date(raw + "T12:00:00Z") : null;
  const usable = parsed && !Number.isNaN(parsed.getTime());

  const days = usable ? PAYOUT_DELAY_DAYS : PAYOUT_FALLBACK_DAYS;
  const base = usable ? parsed : new Date();

  return {
    releaseAt: new Date(base.getTime() + (days * 24 * 60 * 60 * 1000)),
    estimated: !usable
  };
}

/**
 * Works out who gets paid what, and refuses the whole checkout if any vendor on
 * the booking cannot receive money yet. Taking a payment that has nowhere to go
 * is worse than making the customer wait.
 */
async function buildPayoutPlan(bookingRequest = {}) {
  const vendors = Array.isArray(bookingRequest.vendors) ? bookingRequest.vendors : [];
  const owed = new Map();
  const names = new Map();

  vendors.forEach((vendor) => {
    const vendorId = cleanText(vendor.vendorId, "");
    if (!vendorId) return;

    const cents = roundCentsFromDollars(toNumber(vendor.priceNumber, 0));
    owed.set(vendorId, (owed.get(vendorId) || 0) + cents);
    names.set(vendorId, cleanText(vendor.vendorName || vendor.listingTitle, "This vendor"));
  });

  if (!owed.size) {
    return { payouts: [], notReady: [], noVendors: true };
  }

  const payouts = [];
  const notReady = [];

  for (const [vendorId, amountCents] of owed) {
    const snap = await db.collection("users").doc(vendorId).get();
    const data = snap.exists ? snap.data() || {} : {};
    const stripeAccountId = cleanText(data.stripeAccountId, "");

    if (!stripeAccountId || data.payoutsEnabled !== true) {
      notReady.push(names.get(vendorId) || "This vendor");
      continue;
    }

    if (amountCents > 0) {
      payouts.push({
        vendorId,
        stripeAccountId,
        amountCents,
        vendorName: names.get(vendorId) || ""
      });
    }
  }

  return { payouts, notReady, noVendors: false };
}

function makeCheckoutLineItems(bookingRequest = {}, totals = {}) {
  const eventName = cleanText(bookingRequest.eventName, "RentEvent Booking Request");
  const vendors = Array.isArray(bookingRequest.vendors) ? bookingRequest.vendors : [];
  const vendorCount = vendors.length;

  const descriptionParts = [];

  if (vendorCount) {
    descriptionParts.push(`${vendorCount} selected vendor${vendorCount === 1 ? "" : "s"}`);
  }

  const eventDate = cleanText(bookingRequest.eventDetails?.eventDate, "");
  const eventCity = cleanText(bookingRequest.eventDetails?.eventCity, "");

  if (eventDate) descriptionParts.push(`Date: ${eventDate}`);
  if (eventCity) descriptionParts.push(`Location: ${eventCity}`);

  return [
    {
      quantity: 1,
      price_data: {
        currency: "usd",
        unit_amount: totals.amountCents,
        product_data: {
          name: `RentEvent request: ${eventName}`,
          description: descriptionParts.join(" · ") || "RentEvent event booking request"
        }
      }
    }
  ];
}

exports.generatePlannerSuggestions = onRequest(
  {
    cors: true,
    secrets: [OPENAI_API_KEY],
    timeoutSeconds: 60,
    memory: "512MiB"
  },
  async (req, res) => {
    try {
      if (req.method !== "POST") {
        res.status(405).json({
          error: "Method not allowed. Use POST."
        });
        return;
      }

      const {
        eventDetails = {},
        selectedVendors = [],
        availableCategories = []
      } = req.body || {};

      const eventName = cleanText(eventDetails.eventName, "Unnamed event");
      const eventType = cleanText(eventDetails.eventType, "Event");
      const eventDate = cleanText(eventDetails.eventDate, "Date not provided");
      const eventCity = cleanText(eventDetails.eventCity, "City not provided");
      const eventZip = cleanText(eventDetails.eventZip, "ZIP not provided");
      const guestCount = cleanText(eventDetails.guestCount, "Guest count not provided");
      const eventBudget = cleanText(eventDetails.eventBudget, "Budget not provided");
      const eventNotes = cleanText(eventDetails.eventNotes, "No notes provided");
      const planningStyle = cleanText(eventDetails.planningStyle, "Planning my own event");
      const destinationEvent = cleanText(eventDetails.destinationEvent, "Not specified");
      const styleVibe = cleanText(eventDetails.styleVibe, "Not specified");

      const selectedVendorSummary = buildSelectedVendorSummary(selectedVendors);
      const availableCategorySummary = buildAvailableCategorySummary(availableCategories);

      const client = new OpenAI({
        apiKey: OPENAI_API_KEY.value()
      });

      const prompt = `
You are RentEvent's AI Event Planner.

Your job is to recommend smart vendor categories and event add-ons for a customer planning an event.

Be practical, creative, and specific. Think like a professional event planner.

Important rules:
- Do not recommend only the obvious basics.
- Suggest a variety of useful vendor categories.
- Prioritize based on event type, guest count, budget, destination/local context, and what they already added.
- If they already selected a vendor category, do not over-prioritize that same category unless it needs a companion service.
- Use categories that could realistically exist in the RentEvent marketplace.
- Include wedding-specific needs when relevant, such as officiant, florals, cake, catering, DJ, transportation, lodging support, welcome party, rehearsal dinner, photo/video, hair and makeup.
- Include birthday-specific needs when relevant, such as cake, balloons, bounce house, soft play, entertainment, character appearance, party favors, tables/chairs, catering, setup/cleanup.
- Include shower-specific needs when relevant, such as charcuterie, dessert table, florals, balloon arch, mocktail bar, photo moment, games/printables, tables/chairs.
- Include destination-event suggestions when relevant, such as local planner, travel-friendly vendors, transportation, lodging/welcome bags, local officiant, and arrival-weekend events.
- Transportation recommendations should be professional event logistics providers only, not individual rideshare-style drivers.
- Safety/support recommendations should use professional language like licensed security providers, certified lifeguard providers, valet/parking companies, event staffing companies, and setup/cleanup crews.
- Keep the tone helpful and polished.

Return ONLY valid JSON in this exact shape:
{
  "headline": "string",
  "summary": "string",
  "suggestions": [
    {
      "title": "string",
      "category": "string",
      "why": "string",
      "priority": "High | Medium | Nice-to-have",
      "searchTerms": ["string", "string"]
    }
  ],
  "plannerTip": "string"
}

Event details:
Event Name: ${eventName}
Event Type: ${eventType}
Event Date: ${eventDate}
Event City: ${eventCity}
Event ZIP: ${eventZip}
Guest Count: ${guestCount}
Budget: ${eventBudget}
Planning Style: ${planningStyle}
Destination Event: ${destinationEvent}
Style / Vibe: ${styleVibe}
Notes: ${eventNotes}

Already selected vendors:
${selectedVendorSummary}

Available marketplace categories:
${availableCategorySummary}
      `;

      const completion = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: "You are a professional AI event planner for RentEvent. Return only valid JSON."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        response_format: {
          type: "json_object"
        },
        temperature: 0.7
      });

      const rawContent = completion.choices?.[0]?.message?.content || "{}";

      let parsed;

      try {
        parsed = JSON.parse(rawContent);
      } catch (parseError) {
        parsed = {
          headline: "Planner suggestions are ready",
          summary: "I generated ideas, but the response needed cleanup.",
          suggestions: [],
          plannerTip: rawContent
        };
      }

      res.status(200).json({
        success: true,
        result: parsed
      });

    } catch (error) {
      console.error("generatePlannerSuggestions error:", error);

      res.status(500).json({
        success: false,
        error: error.message || "Something went wrong while generating planner suggestions."
      });
    }
  }
);

exports.createStripeCheckoutSession = onRequest(
  {
    cors: true,
    secrets: [STRIPE_SECRET_KEY],
    timeoutSeconds: 60,
    memory: "512MiB"
  },
  async (req, res) => {
    setCors(req, res);

    if (handleOptions(req, res)) return;

    try {
      if (req.method !== "POST") {
        res.status(405).json({
          success: false,
          error: "Method not allowed. Use POST."
        });
        return;
      }

      const body = req.body || {};
      const bookingRequestId = cleanText(body.bookingRequestId, "");
      const eventId = cleanText(body.eventId, "");
      const requestUserId = getRequestUserId(body);

      if (!bookingRequestId) {
        res.status(400).json({
          success: false,
          error: "Missing bookingRequestId."
        });
        return;
      }

      if (!eventId) {
        res.status(400).json({
          success: false,
          error: "Missing eventId."
        });
        return;
      }

      if (!requestUserId) {
        res.status(400).json({
          success: false,
          error: "Missing request owner."
        });
        return;
      }

      const bookingRef = db.collection("bookingRequests").doc(bookingRequestId);
      const bookingSnap = await bookingRef.get();

      if (!bookingSnap.exists) {
        res.status(404).json({
          success: false,
          error: "Booking request not found."
        });
        return;
      }

      const bookingRequest = {
        id: bookingSnap.id,
        ...bookingSnap.data()
      };

      const allowedOwnerIds = [
        bookingRequest.submittedBy,
        bookingRequest.customerId,
        bookingRequest.plannerId,
        bookingRequest.requestOwnerId
      ].map((value) => cleanText(value, "")).filter(Boolean);

      if (!allowedOwnerIds.includes(requestUserId)) {
        res.status(403).json({
          success: false,
          error: "You do not have permission to start checkout for this request."
        });
        return;
      }

      if (cleanText(bookingRequest.eventId, "") !== eventId) {
        res.status(400).json({
          success: false,
          error: "Booking request does not match this event."
        });
        return;
      }

      if (bookingRequest.paymentStatus === "paid") {
        res.status(400).json({
          success: false,
          error: "This request has already been marked paid."
        });
        return;
      }

      const totals = calculateTotalsFromBookingRequest(bookingRequest);

      if (!totals.amountCents || totals.amountCents < 50) {
        res.status(400).json({
          success: false,
          error: "The checkout total is too low or missing."
        });
        return;
      }

      // Nobody pays for a booking whose vendors cannot be paid out.
      const payoutPlan = await buildPayoutPlan(bookingRequest);

      if (payoutPlan.noVendors) {
        res.status(400).json({
          success: false,
          error: "This request has no vendors attached, so there is nothing to pay for."
        });
        return;
      }

      if (payoutPlan.notReady.length === 1) {
        res.status(409).json({
          success: false,
          error: payoutPlan.notReady[0] + " has not finished setting up payouts yet, so this booking cannot be paid for. Message them, or remove them from this event and check out with the rest.",
          vendorsNotReady: payoutPlan.notReady
        });
        return;
      }

      if (payoutPlan.notReady.length > 1) {
        res.status(409).json({
          success: false,
          error: "These vendors have not finished setting up payouts yet: " + payoutPlan.notReady.join(", ") + ". Message them, or remove them from this event and check out with the rest.",
          vendorsNotReady: payoutPlan.notReady
        });
        return;
      }

      const payoutRelease = payoutReleaseInfo(bookingRequest);
      const transferGroup = "booking_" + bookingRequestId;

      const stripe = new Stripe(STRIPE_SECRET_KEY.value());

      const origin = req.get("origin") || "https://www.rentevent-app.com";
      const returnUrlFromClient = cleanText(body.returnUrl, "");
      const fallbackReturnUrl = `${origin}/checkout.html?eventId=${encodeURIComponent(eventId)}&bookingRequestId=${encodeURIComponent(bookingRequestId)}&stripe_return=true&session_id={CHECKOUT_SESSION_ID}`;
      const returnUrl = returnUrlFromClient && returnUrlFromClient.includes("{CHECKOUT_SESSION_ID}")
        ? returnUrlFromClient
        : fallbackReturnUrl;

      const customerEmail = cleanText(
        bookingRequest.customerEmail ||
          bookingRequest.plannerEmail ||
          body.customerEmail ||
          "",
        ""
      );

      const session = await stripe.checkout.sessions.create({
        ui_mode: "embedded_page",
        mode: "payment",
        submit_type: "book",
        client_reference_id: bookingRequestId,
        customer_email: customerEmail || undefined,
        return_url: returnUrl,
        line_items: makeCheckoutLineItems(bookingRequest, totals),
        metadata: {
          bookingRequestId,
          eventId,
          requestOwnerId: cleanText(bookingRequest.requestOwnerId || requestUserId, ""),
          customerId: cleanText(bookingRequest.customerId, ""),
          plannerId: cleanText(bookingRequest.plannerId, ""),
          source: "rentevent_checkout"
        },
        payment_intent_data: {
          // Ties this charge to the transfers that will pay the vendors later.
          transfer_group: transferGroup,
          metadata: {
            bookingRequestId,
            eventId,
            requestOwnerId: cleanText(bookingRequest.requestOwnerId || requestUserId, ""),
            customerId: cleanText(bookingRequest.customerId, ""),
            plannerId: cleanText(bookingRequest.plannerId, ""),
            source: "rentevent_checkout"
          }
        }
      });

      await bookingRef.set({
        paymentStatus: "checkout_started",
        stripeCheckoutSessionId: session.id,
        stripeClientReferenceId: bookingRequestId,
        stripeAmountCents: totals.amountCents,
        stripeCurrency: "usd",
        stripeLivemode: session.livemode === true,
        stripeCheckoutStartedAt: admin.firestore.FieldValue.serverTimestamp(),
        stripeTransferGroup: transferGroup,
        payoutPlan: payoutPlan.payouts,
        payoutTotalCents: payoutPlan.payouts.reduce((sum, item) => sum + item.amountCents, 0),
        payoutReleaseAt: admin.firestore.Timestamp.fromDate(payoutRelease.releaseAt),
        payoutReleaseEstimated: payoutRelease.estimated === true,
        payoutStatus: "awaiting_payment",
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      res.status(200).json({
        success: true,
        clientSecret: session.client_secret,
        sessionId: session.id
      });

    } catch (error) {
      console.error("createStripeCheckoutSession error:", error);

      res.status(500).json({
        success: false,
        error: error.message || "Something went wrong while creating Stripe checkout."
      });
    }
  }
);