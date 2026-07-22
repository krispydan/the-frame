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
  /** Compact profile of the lead from The Frame (loadLeadContext). */
  leadContext?: string | null;
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
  → email1 = 1-2 warm sentences that reference something SPECIFIC and true from the call (what they said they were looking for, a detail about their shop they mentioned, or the plan you agreed on). It must read as a natural lead-in to "As discussed, you can find our catalog attached." Do NOT open with a bare pleasantry as the whole thought; if you start warmly, tie it to a real detail in the same breath. Do NOT mention the attachment yourself. Soft and friendly.

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
    "currentBrands": ["competitor sunglass brands they already carry, normalized to the REAL brand name (see brand glossary below)"],
    "spokeWith": "owner|staff|<role or name>|null",
    "contact": { "name": "full name of the OWNER / buyer / decision-maker to address (see contact-name rule), or null", "role": "e.g. Director of Operations, or null", "email": "only if literally present, else null" },
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

CONTACT NAME rule — "contact.name" is the person our records and mail should be addressed to: the store OWNER / buyer / decision-maker.
- If the owner/buyer is named, use THEIR full name — even if a different person (staff) answered the phone. Example: "spoke with Michelle, she'll pass it to owner Jeannie DeMarco" → contact.name = "Jeannie DeMarco" (NOT Michelle). Put Michelle in spokeWith instead.
- If only the person who answered is named and no separate owner is mentioned, use that person's name.
- Only use a name that is EXPLICITLY stated in the note/transcript. Never invent, guess, or use the store name as a person's name. If no personal name is stated, use null.
- Transcripts are auto-transcribed and imperfect — only return a name you are confident is a real personal name that was said.

BRAND GLOSSARY — the call transcripts are auto-transcribed from phone audio, so competitor brand names are OFTEN misheard. Map them to the real brand name in currentBrands (and when a competitor is referenced in an opener):
- "I-Sea" is frequently transcribed as: I.C., I see, Icy, Icey, Icee, Eyesea, I-C, ICS. Normalize ALL of these to "I-Sea".
- "Freyrs" is transcribed as: Friars, Frayers, Fryers, Freyers, Freyr. Normalize to "Freyrs".
- Other real boutique sunglass brands to recognize/normalize: DIFF Eyewear, Quay, DAX Eyewear ("Dax"), Peepers, Maui Jim, SunCloud, Z Supply ("Z Supply"/"ZSupply"), WMP Eyewear ("WMP"/"WNP"), Goodr ("Gooder"/"Goober"), Blenders, Crew, 11th Hour, Easy Peasy, Brighton, Salt, Illesteva, DIP.
- If a named brand clearly isn't one of these and isn't obviously a sunglasses brand, use your best judgment on the real name; if genuinely unsure, keep the closest real brand it phonetically matches.

You may also be given a CRM profile of the store (location, size, socials, existing eyewear/competitors, what they're about). Use it to make the openers more relevant and specific (e.g. nod to their locale, their aesthetic, a competitor they stock, that they're a high-volume shop). But the CALL is the primary source of truth, and the structured "analysis" fields must come from the call note/transcript only — never populate analysis from the CRM profile, and never state CRM facts as if they were said on the call.

Opener rules (ALL three):
- Reference only what is genuinely true (from the call, or clearly from the CRM profile). Do NOT invent facts, and do not claim they said something on the call that only appears in the CRM profile.
- When the store's city is known (from the CRM Location), be specific that we're looking to partner with / stock more boutiques in THAT city (e.g. "we're looking to work with more boutiques in Austin"). It sounds targeted and signals we want them specifically because of their location. Prefer the city; if only the state is known, use the state. This is OPTIONAL: land it naturally in AT MOST one of the openers, and only when it genuinely adds warmth. Skip it rather than force it, and never make it a reflex line. Use the plain city name only, do NOT infer a broader region or comment on its weather/seasonality-by-location (never write things like "West Texas" or "summer in full swing there").
- No greeting like 'Hi', no names, no sign-off. Just the line(s).
- NEVER use em-dashes or en-dashes (the — or – characters); use commas, periods, or the word 'and' instead.

VOICE — you JUST got off a friendly phone call with this buyer and set up to send them the catalog. Write like a real person dashing off a warm, personal note the same day, NOT like marketing copy:
- Sound like a quick human note, not a pitch: contractions, plain words, genuine warmth. A buyer should feel like the specific person they spoke to wrote this to them, not a template.
- BANNED phrases and any close variant: "worth a look", "worth exploring", "low-risk", "high-margin", "great addition", "in full swing", "natural fit", "perfect fit", "game changer", "reach out", "touch base", "circle back", "at the end of the day", "elevate", "curated", "seamless", "no-brainer", "level up", "it was great connecting", "great connecting with you", "so nice chatting", "really enjoyed", "it was a pleasure", "hope you're doing well", "hope this finds you well", "I wanted to reach out", "just following up".
- Do NOT open with a bare pleasantry that could be sent to anyone. If you start warmly, attach it to a REAL detail from the call in the same sentence.
- ONE concrete specific at most per opener, and only where it fits. Real specifics we have: "$8 a pair wholesale, sells around $28", "$150 minimum", "4 pairs per color", "polarized or UV400", "ships in 48 hours". Do NOT stack numbers, and never let an opener read like a spec sheet. Put a number where it answers something the buyer actually asked (e.g. they asked the minimum), not as a reflex.
- Never claim to beat, undercut, or out-margin a competitor. You may mention fitting in alongside what they already carry, never replacing or beating it.
- The catalog is our SUMMER line. If you mention season at all it is summer / warm weather; never reference another season.
- If the shop does not carry sunglasses yet, do NOT name a competitor brand; lean on their own customers, foot traffic, or an idea they raised on the call (e.g. a display by the register).
- You may use the buyer's first name once if the call gave it. Never guess a name, a brand, or a fact.
- Cut hedges: no "could be", "might", "maybe", "I think", "possibly". Say it plainly and with quiet confidence.
- All three must differ in shape, opening word, and angle. Never reuse a phrase or repeat the same fact across two of them.
- Length: email1 up to 2 short sentences; email2 and email3 ONE tight sentence each. Keep it conversational and specific; cut every filler word.

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

  const leadContext = (input.leadContext ?? "").trim();
  const userParts = [
    `Store: ${input.companyName ?? "(unknown)"}`,
    input.emailOnFile ? `Email on file: ${input.emailOnFile}` : null,
    leadContext ? "\nWhat we know about this store (from our CRM):\n" + leadContext : "",
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
