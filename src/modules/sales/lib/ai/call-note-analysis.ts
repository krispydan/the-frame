/**
 * AI analysis of a PhoneBurner cold-call — turns the rep's free-text
 * note (and, when available, the call transcript) into structured
 * follow-up intelligence + a personalized email opening line for the
 * Pipedrive outreach sequence.
 *
 * One Claude call returns BOTH the structured analysis and the opener
 * so they stay consistent and we pay a single round-trip per lead.
 *
 * Graceful: returns null if ANTHROPIC_API_KEY is unset or the model
 * response can't be parsed — callers fall back to notes-only behaviour.
 */
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";

/** What Jaxy is — grounds the opener so it stays on-brand. */
const JAXY_CONTEXT = `Jaxy is a wholesale sunglasses brand selling to boutiques and small retailers.
Each style is either polarized OR UV400 (never both), ships with a case included, and is named "Jaxy <Style>".
Selling points for a boutique buyer: strong wholesale margins, easy to merchandise, fast sell-through, low minimums, trend-forward styles.
The rep just had a phone call and set an appointment to send the buyer a catalog.`;

export interface AlternateEmail {
  value: string;
  /** add_contact = new person; update_primary = replace the send-to */
  action: "add_contact" | "update_primary";
  confidence: number; // 0..1
}

export interface CallAnalysis {
  temperature: "hot" | "warm" | "lukewarm";
  carriesSunglasses: "yes" | "no" | "unknown";
  currentBrands: string[];
  spokeWith: string | null; // "owner" | "staff" | role/name if stated
  contact: { name: string | null; role: string | null; email: string | null };
  /** Only when an email address is LITERALLY present in the text. */
  alternateEmail: AlternateEmail | null;
  /** True when the note says an email was given but no address appears
   *  in the text (it was spoken — recoverable only from the recording). */
  emailReferencedUncaptured: boolean;
  catalogSendTo: string | null; // best email to send the catalog to
  objections: string[];
  repSummary: string; // one-line human summary for the rep
  followUp: string; // recommended next action
}

export interface AnalyzeInput {
  companyName: string | null;
  notes: string | null;
  /** Optional call transcript (when transcription ran). */
  transcript?: string | null;
  emailOnFile?: string | null;
}

export interface EmailOpeners {
  /** Warm intro for email 1 (catalog send). Flows into "As discussed…". */
  email1: string;
  /** Lead-in for email 2 (follow-up). Slightly more push. */
  email2: string;
  /** Opening nudge for email 3 (final). Most direct. */
  email3: string;
}

export interface AnalyzeResult {
  analysis: CallAnalysis;
  /** Per-sequence personalized openers (email 1/2/3). */
  emailOpeners: EmailOpeners;
}

const SYSTEM = `You analyze a boutique cold-call for a wholesale sunglasses brand and produce structured follow-up data plus THREE personalized email opening lines, one for each step of a 3-email outreach sequence.

${JAXY_CONTEXT}

The reps' pitch (facts you may use, but only when relevant to THIS call): sunglasses wholesale at $8/pair, suggested retail ~$28 (strong margin, impulse buy), low $150 minimum with a 4-per-color minimum so it's easy to test the line (vs competitors that force 12-pair cases you can't customize), UV400 or polarized quality, ships within 48h from the US, ~32 styles.

The three openers are dropped into these email templates. Write each so it reads naturally in context:

EMAIL 1 (sent with the catalog):
  "Hi <First>,
   {email1}
   As discussed, you can find our summer sunglasses catalog attached. You can order on Faire or our wholesale Shopify store. I'm happy to answer questions, walk you through bestsellers, or put together a recommended opening order.
   Thanks, <Sender>"
  → email1 = 1-2 warm, specific sentences referencing the call. It must flow INTO "As discussed, you can find our catalog attached." Do NOT mention the attachment yourself. Soft and friendly.

EMAIL 2 (follow-up a few days later):
  "{email2} I just wanted to follow up on the catalog that we sent over. Do you need any help choosing the best styles for your store?"
  → email2 = ONE short sentence that sits directly before "I just wanted to follow up on the catalog we sent over." Slightly more push than email1: reference their specific situation (a competitor they carry, that it's peak sunglasses season, the margin/bestsellers) to remind them why it's worth a look. Do not say "follow up" yourself.

EMAIL 3 (final nudge):
  "{email3} Just a quick ping on this, did you have any questions about our sunglasses or catalog? We would really love to stock them in your store."
  → email3 = ONE short sentence that sits before "Just a quick ping on this…". The most direct of the three: a light, genuine nudge with a concrete reason to act now (peak season, easy low-minimum test, better margin than what they carry). Never pushy or spammy.

Return ONLY minified JSON matching exactly this shape (no markdown, no commentary):
{
  "analysis": {
    "temperature": "hot|warm|lukewarm",
    "carriesSunglasses": "yes|no|unknown",
    "currentBrands": ["competitor sunglass brands they already carry, normalized to proper casing, e.g. Freyrs, DAX, Eyesea"],
    "spokeWith": "owner|staff|<role or name>|null",
    "contact": { "name": null, "role": "e.g. Director of Operations, or null", "email": "only if literally present, else null" },
    "alternateEmail": { "value": "email@x.com", "action": "add_contact|update_primary", "confidence": 0.0 } OR null,
    "emailReferencedUncaptured": true/false,
    "catalogSendTo": "best email to send the catalog to, or null",
    "objections": ["short phrases, e.g. 'already carries Freyrs'"],
    "repSummary": "one concise sentence for the sales rep",
    "followUp": "one concise recommended next action"
  },
  "emailOpeners": {
    "email1": "warm intro, see EMAIL 1 above",
    "email2": "follow-up lead-in, see EMAIL 2 above",
    "email3": "final nudge, see EMAIL 3 above"
  }
}

Opener rules (ALL three):
- Reference only what they actually told us (brands they carry, owner asked to see the catalog, sunglasses are new for them, weekend markets, etc). Do NOT invent facts.
- No greeting like 'Hi', no names, no sign-off. Just the line(s).
- NEVER use em-dashes or en-dashes (the — or – characters); use commas, periods, or the word 'and' instead.
- Keep each to 1-2 sentences. Vary them so the three don't repeat the same phrasing; escalate the pull from email1 (soft) to email3 (most direct).

Rules:
- alternateEmail is non-null ONLY if an actual email ADDRESS appears in the text. If the note merely SAYS an email was given/collected but no address is present, set alternateEmail=null and emailReferencedUncaptured=true.
- action="update_primary" when the note implies this is THE address to send the catalog to; "add_contact" when it's an additional person (e.g. a director/manager).
- confidence reflects how sure you are the extracted address is correct and complete (explicit "new email: x@y.com" ~0.95).
- Never fabricate brands, emails, names, or roles. Empty arrays / null when unknown.`;

function unwrapJson(text: string): string {
  const t = text.trim();
  const fence = t.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  return fence ? fence[1].trim() : t;
}

/** Enforce the no-em-dash rule on generated email copy (models often
 *  ignore the prompt instruction). Em/en dashes → comma; also fixes the
 *  double-punctuation/spacing that leaves behind. */
export function stripDashes(s: string): string {
  return s
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/\s+([,.;!?])/g, "$1")
    .replace(/,\s*,/g, ",")
    .replace(/,\s*([.;!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export async function analyzeCallNote(input: AnalyzeInput): Promise<AnalyzeResult | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn("[call-note-analysis] ANTHROPIC_API_KEY not set — skipping AI analysis");
    return null;
  }
  const noteText = (input.notes ?? "").trim();
  const transcript = (input.transcript ?? "").trim();
  if (!noteText && !transcript) return null;

  const userParts = [
    `Store: ${input.companyName ?? "(unknown)"}`,
    input.emailOnFile ? `Email on file: ${input.emailOnFile}` : null,
    "",
    "Rep note:",
    noteText || "(none)",
    transcript ? "\nCall transcript:\n" + transcript.slice(0, 8000) : "",
  ]
    .filter((x) => x !== null)
    .join("\n");

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: SYSTEM,
        messages: [{ role: "user", content: userParts }],
      }),
    });
    if (!res.ok) {
      console.error("[call-note-analysis] Anthropic", res.status, (await res.text()).slice(0, 300));
      return null;
    }
    const json = (await res.json()) as { content: Array<{ type: string; text?: string }> };
    const raw = json.content.find((c) => c.type === "text")?.text ?? "";
    const parsed = JSON.parse(unwrapJson(raw)) as AnalyzeResult;
    const o = parsed?.emailOpeners;
    if (!parsed?.analysis || !o || typeof o.email1 !== "string" || typeof o.email2 !== "string" || typeof o.email3 !== "string") {
      return null;
    }
    o.email1 = stripDashes(o.email1);
    o.email2 = stripDashes(o.email2);
    o.email3 = stripDashes(o.email3);
    // Defensive normalization
    const a = parsed.analysis;
    a.currentBrands = Array.isArray(a.currentBrands) ? a.currentBrands : [];
    a.objections = Array.isArray(a.objections) ? a.objections : [];
    a.emailReferencedUncaptured = !!a.emailReferencedUncaptured;
    if (a.alternateEmail && typeof a.alternateEmail.value === "string") {
      a.alternateEmail.value = a.alternateEmail.value.trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a.alternateEmail.value)) a.alternateEmail = null;
    } else {
      a.alternateEmail = null;
    }
    return parsed;
  } catch (e) {
    console.error("[call-note-analysis] failed:", e instanceof Error ? e.message : e);
    return null;
  }
}
