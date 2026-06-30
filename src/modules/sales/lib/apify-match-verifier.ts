/**
 * LLM-backed match verification for Apify Google Maps results.
 *
 * The fuzzy matcher in google-maps-enrichment.ts is fast but brittle —
 * it can't tell that "TresChicTexas" is the same business as "Tres
 * Chic Boutique" or that "Tootsies Rockridge" is the same as
 * "Tootsie's Boutique Inc." in Oakland. For borderline cases we ask
 * Claude Haiku to make the call.
 *
 * Cost: ~$0.0004 per check (Haiku 4.5 pricing, ~250 tokens per call).
 * Far cheaper than wasted Apify retries on potential matches.
 *
 * Called only for cases the fuzzy matcher classified as "skipped" —
 * accepted matches don't need a second opinion.
 */

interface AnthropicResponse {
  content: Array<{ type: string; text?: string }>;
}

export interface VerifyInput {
  /** Our scraped/stored boutique name (e.g. "TresChicTexas"). */
  companyName: string;
  /** Our city + state. */
  companyCity: string | null;
  companyState: string | null;
  /** Apify's returned title (e.g. "Tres Chic Boutique"). */
  apifyTitle: string;
  /** Apify's full address. */
  apifyAddress: string | null;
  /** Apify's city + state. */
  apifyCity: string | null;
  apifyState: string | null;
  /** Categories Apify reported, joined. */
  apifyCategories: string | null;
}

export interface VerifyVerdict {
  /** "yes" / "no" / "uncertain". */
  decision: "yes" | "no" | "uncertain";
  /** 1-line reason for logging. */
  reason: string;
  /** Raw model output, useful when debugging. */
  raw: string;
}

const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

/**
 * Ask Claude Haiku whether the Apify result and our company are the
 * same business. Conservative — defaults to "uncertain" on any
 * parsing error, never accepts a guess.
 */
export async function verifyApifyMatch(
  input: VerifyInput,
): Promise<VerifyVerdict> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      decision: "uncertain",
      reason: "anthropic_api_key_not_configured",
      raw: "",
    };
  }

  const prompt = buildPrompt(input);

  let res: Response;
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 100,
        system:
          "You verify boutique-business identity matches. You only ever respond with a single JSON object: " +
          '{"match":"yes"|"no"|"uncertain","reason":"<1-sentence>"}. ' +
          "No prose, no markdown fences, no preamble.",
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch (e) {
    return {
      decision: "uncertain",
      reason: `network_error: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200),
      raw: "",
    };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return {
      decision: "uncertain",
      reason: `anthropic_http_${res.status}: ${text.slice(0, 200)}`,
      raw: "",
    };
  }

  let json: AnthropicResponse;
  try {
    json = (await res.json()) as AnthropicResponse;
  } catch (e) {
    return {
      decision: "uncertain",
      reason: `json_parse_failed: ${e instanceof Error ? e.message : String(e)}`,
      raw: "",
    };
  }

  const text = json.content.find((c) => c.type === "text")?.text?.trim() || "";
  if (!text) {
    return { decision: "uncertain", reason: "empty_response", raw: "" };
  }

  // Strip code fences if Haiku wrapped despite instructions.
  const cleaned = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/, "")
    .replace(/\s*```$/, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned) as { match?: string; reason?: string };
    const m = String(parsed.match || "").toLowerCase().trim();
    const decision: "yes" | "no" | "uncertain" =
      m === "yes" ? "yes" : m === "no" ? "no" : "uncertain";
    return {
      decision,
      reason: String(parsed.reason || "no_reason_provided").slice(0, 300),
      raw: text,
    };
  } catch {
    // Last-ditch fallback: scan text for "yes"/"no"/"uncertain".
    const lower = cleaned.toLowerCase();
    if (lower.includes('"match":"yes"') || /\byes\b/.test(lower))
      return { decision: "yes", reason: "fallback_text_scan", raw: text };
    if (lower.includes('"match":"no"') || /\bno\b/.test(lower))
      return { decision: "no", reason: "fallback_text_scan", raw: text };
    return { decision: "uncertain", reason: "unparseable_response", raw: text };
  }
}

function buildPrompt(input: VerifyInput): string {
  return `Are these two records the same business?

OUR RECORD (a boutique we're cold-outreaching):
  Name:  ${input.companyName}
  City:  ${input.companyCity ?? "(unknown)"}, ${input.companyState ?? "(unknown)"}

GOOGLE MAPS RESULT (returned by Apify when we searched for our record):
  Title:      ${input.apifyTitle}
  Address:    ${input.apifyAddress ?? "(unknown)"}
  City/State: ${input.apifyCity ?? "(unknown)"}, ${input.apifyState ?? "(unknown)"}
  Category:   ${input.apifyCategories ?? "(unknown)"}

Consider:
- Common reasons NAMES legitimately differ for the same business:
  * Our scrape has no spaces ("SouthernPineBoutique") and Google has spaces ("Southern Pine Boutique")
  * Our scrape includes a domain suffix (".com", ".co") that Google omits
  * Our scrape includes a neighborhood ("Tootsies Rockridge") and Google has the formal name ("Tootsie's Boutique")
  * Our scrape includes "Online" / "Shop" / "Store" but Google doesn't
  * Apostrophe / capitalization / ampersand differences
- Common reasons they're DIFFERENT businesses:
  * Different town / different state — almost always different (boutique chains are rare)
  * Different category (our record is a clothing boutique, Google says it's a salon/cafe/whatever)
  * Names share only generic words ("Boutique", "Shop") with no distinctive overlap
  * Apify returned just a city name ("Tuscumbia", "Lake Stevens") — that's Apify giving up
- If the names differ but the address is within the same town we asked about and the category is plausibly a boutique, lean YES.
- If you're not confident, say "uncertain".

Respond with one JSON object: {"match":"yes"|"no"|"uncertain","reason":"<1-sentence>"}.`;
}
