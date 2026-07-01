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

export interface AnalyzeResult {
  analysis: CallAnalysis;
  emailOpener: string; // 1–2 sentence personalized opener
}

const SYSTEM = `You analyze a boutique cold-call for a wholesale sunglasses brand and produce structured follow-up data plus a personalized email opening line.

${JAXY_CONTEXT}

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
  "emailOpener": "1-2 warm, specific sentences referencing the call. Natural, not cheesy. Reference what they told us (brands they carry, that owner asked to see the catalog, that sunglasses are new for them, etc). Do NOT invent facts. No greeting like 'Hi' and no signature — just the opening line(s)."
}

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
    if (!parsed?.analysis || typeof parsed.emailOpener !== "string") return null;
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
