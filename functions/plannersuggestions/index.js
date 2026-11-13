const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const OpenAI = require("openai");

admin.initializeApp();

const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");

function cleanText(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function normalizeArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => cleanText(item, "")).filter(Boolean);
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
