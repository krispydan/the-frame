/**
 * Email Assistant — Claude integration.
 *
 * Single source of truth for AI calls in the marketing-email
 * pipeline. Both the HTTP API routes and the MCP tools call into
 * this lib so prompt edits land everywhere at once.
 *
 * The prompts themselves live in prompts/*.md as markdown
 * (versioned, refinable). This lib reads them at module load,
 * composes them with brand context, and invokes Claude via the
 * tool-use pattern for structured JSON output.
 *
 * Pattern copied from src/app/api/v1/catalog/copy/generate/route.ts
 * (same ANTHROPIC_API_KEY env, same anthropic-version, same
 * fetch shape) but switched from free-form text → tool-use for
 * the structured response.
 */

import { emailModel } from "./ai-model";
import { getDocContent } from "./prompt-store";

// ── Prompt + brand-context loaders ──────────────────────────────
// Prompts + brand-voice docs are now LIVING documents: editable in the
// app and persisted in the DB (see prompt-store.ts), seeded from the
// .md files in prompts/ + brand-context/. We read the LIVE version on
// every call (no process-lifetime cache) so an in-app edit takes effect
// on the next generation — and getDocContent falls back to the file if
// the DB is ever unavailable.

function loadBrandContext() {
  return {
    bible: getDocContent("brand-bible"),
    wholesaleVoice: getDocContent("wholesale-voice"),
    visualGuidelines: getDocContent("visual-guidelines"),
  };
}

function loadPrompts() {
  return {
    systemBase: getDocContent("system-prompt-base"),
    copyGen: getDocContent("copy-generation-prompt"),
    themeGen: getDocContent("theme-generation-prompt"),
    imagePromptGen: getDocContent("image-prompt-generation"),
    monthPlan: getDocContent("month-plan-prompt"),
  };
}

/**
 * Extract the contents of the prompt's first triple-backtick block
 * (which is the actual prompt text — the markdown around it is
 * documentation). Each prompt file is structured the same way:
 * iteration history + ``` prompt content ``` + output schema +
 * worked examples. We only want the prompt content.
 */
function extractPromptBody(md: string): string {
  const match = md.match(/```\s*([\s\S]*?)```/);
  return match ? match[1].trim() : md;
}

/**
 * Compose the full system prompt — base + audience-specific voice.
 * Placeholders in system-prompt-base.md (e.g. {AUDIENCE} blocks)
 * are resolved here rather than at Claude time.
 */
function buildSystemPrompt(audience: "retail" | "wholesale"): string {
  const { systemBase } = loadPrompts();
  const { bible, wholesaleVoice } = loadBrandContext();

  // The system-prompt-base.md has {IF audience == "..."} pseudocode
  // blocks. We resolve them deterministically here so Claude doesn't
  // have to parse pseudo-conditional syntax.
  const baseBody = extractPromptBody(systemBase);
  const resolved = resolveAudienceBlock(baseBody, audience);

  // Append the full brand voice doc as ground-truth context. Large
  // (~30KB) but inside Claude's context window and gives the model
  // every example + worded principle without us having to summarize.
  const voiceDoc =
    audience === "wholesale"
      ? wholesaleVoice
      : extractBrandBibleVoiceSection(bible);

  return `${resolved}\n\n────────────────────────────────────────────────────────────\nFULL VOICE REFERENCE DOC\n────────────────────────────────────────────────────────────\n\n${voiceDoc}`;
}

/**
 * Replace the `{IF audience == "..."} ... {ELSE IF ...} ... {ENDIF}`
 * blocks in system-prompt-base.md. Single pass, regex-based — keeps
 * it simple. If the prompt template grows more complex we'd swap to
 * Handlebars or similar.
 */
function resolveAudienceBlock(body: string, audience: "retail" | "wholesale"): string {
  // Replace {{AUDIENCE}} → "retail" | "wholesale"
  let out = body.replace(/\{\{?AUDIENCE\}?\}/g, audience);

  // Replace conditional blocks. The pattern:
  //   {IF audience == "retail"} ... {ELSE IF audience == "wholesale"} ... {ENDIF}
  // → keep only the matching branch.
  const pattern = /\{IF\s+audience\s*==\s*"(retail|wholesale)"\}([\s\S]*?)\{ELSE\s+IF\s+audience\s*==\s*"(retail|wholesale)"\}([\s\S]*?)\{ENDIF\}/g;
  out = out.replace(pattern, (_full, cond1, body1, _cond2, body2) => {
    return cond1 === audience ? body1.trim() : body2.trim();
  });

  // Also support {IF audience == "..."} ... {ELSE} ... {ENDIF}
  const ifElsePattern = /\{IF\s+audience\s*==\s*"(retail|wholesale)"\}([\s\S]*?)\{ELSE\}([\s\S]*?)\{ENDIF\}/g;
  out = out.replace(ifElsePattern, (_full, cond, ifBody, elseBody) => {
    return cond === audience ? ifBody.trim() : elseBody.trim();
  });

  return out;
}

/**
 * The brand bible is 770+ lines. The voice section (§5) is ~300
 * lines and the densest signal. Snip just that part for the
 * retail prompt so we don't burn tokens on mission/positioning.
 */
function extractBrandBibleVoiceSection(bible: string): string {
  const start = bible.indexOf("## 5. Brand Voice");
  if (start < 0) return bible;
  const end = bible.indexOf("## 6.", start);
  return end > 0 ? bible.slice(start, end) : bible.slice(start);
}

// ── Anthropic API call ──────────────────────────────────────────

interface AnthropicToolCall {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface AnthropicResponse {
  content: Array<AnthropicToolCall | { type: "text"; text: string }>;
  stop_reason?: string;
  usage?: { input_tokens: number; output_tokens: number };
}

interface CallClaudeOpts {
  systemPrompt: string;
  userPrompt: string;
  /** A single forced tool — Claude must respond by calling it. */
  tool: {
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  };
  maxTokens?: number;
  model?: string;
  /** Optional product/reference images fed to the model as vision
   *  inputs (public URLs). Appended after the text in the user turn. */
  images?: Array<{ url: string }>;
}

async function callClaude({
  systemPrompt,
  userPrompt,
  tool,
  maxTokens = 4096,
  model = emailModel(),
  images,
}: CallClaudeOpts): Promise<{
  ok: true;
  output: Record<string, unknown>;
  usage: { input_tokens: number; output_tokens: number };
} | {
  ok: false;
  error: string;
}> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { ok: false, error: "ANTHROPIC_API_KEY not configured" };
  }
  // Capture narrowed (string) for use inside the nested send() closure —
  // TS doesn't carry the non-null narrowing into a nested function.
  const key: string = apiKey;

  // Text-only stays a plain string; with images the user turn becomes a
  // content array (text first, then image blocks via public URL source).
  const validImages = (images ?? []).filter((i) => i.url && /^https?:\/\//.test(i.url));
  const userContent = validImages.length
    ? [
        { type: "text", text: userPrompt },
        ...validImages.map((i) => ({ type: "image", source: { type: "url", url: i.url } })),
      ]
    : userPrompt;

  // One network attempt for a given user-content payload.
  async function send(content: unknown): Promise<
    | { ok: true; output: Record<string, unknown>; usage: { input_tokens: number; output_tokens: number } }
    | { ok: false; error: string }
  > {
    const body = {
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      tools: [tool],
      // Force the model to use the tool (single-tool, mandatory call).
      tool_choice: { type: "tool", name: tool.name },
      messages: [{ role: "user", content }],
    };
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text();
        return { ok: false, error: `Anthropic API ${res.status}: ${text}` };
      }
      const data = (await res.json()) as AnthropicResponse;
      const toolCall = data.content.find((c): c is AnthropicToolCall => c.type === "tool_use");
      if (!toolCall) return { ok: false, error: "Claude returned no tool_use block" };
      return { ok: true, output: toolCall.input, usage: data.usage ?? { input_tokens: 0, output_tokens: 0 } };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  let result = await send(userContent);

  // Resilience: a bad/unreachable product image must not sink the whole
  // generation. If an image-bearing request fails with an image-shaped
  // error, retry once text-only so the operator still gets copy/briefs.
  const IMAGE_ERR = /\b400\b|image|media_type|\bsource\b|could not (process|fetch|download)|url/i;
  if (!result.ok && validImages.length > 0 && IMAGE_ERR.test(result.error)) {
    console.warn(`[email-ai] image request failed, retrying text-only: ${result.error}`);
    result = await send(userPrompt);
  }
  return result;
}

// ────────────────────────────────────────────────────────────
// PUBLIC API — three generators
// ────────────────────────────────────────────────────────────

/**
 * Theme generation — produces N weekly themes for an audience.
 * Uses the v3 theme-generation-prompt.md.
 */
export async function generateThemes(opts: {
  audience: "retail" | "wholesale";
  weekStart: string;
  count: number;
  recentCampaigns?: Array<{ weekOf: string; theme: string; productHook: string | null }>;
  productContext?: string;
}) {
  const { themeGen } = loadPrompts();
  const systemPrompt = buildSystemPrompt(opts.audience);
  const taskPrompt = fillTemplate(extractPromptBody(themeGen), {
    audience: opts.audience,
    weekStart: opts.weekStart,
    count: String(opts.count),
    recentCampaigns: JSON.stringify(opts.recentCampaigns ?? [], null, 2),
    productContext: opts.productContext ?? "(none provided)",
  });

  return callClaude({
    systemPrompt,
    userPrompt: taskPrompt,
    tool: {
      name: "submit_themes",
      description: `Submit ${opts.count} email themes for the period`,
      input_schema: {
        type: "object",
        required: ["themes"],
        properties: {
          themes: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: [
                "weekOf", "title", "angle", "productHook",
                "seasonalContext", "visualSuggestion", "themeShape",
              ],
              properties: {
                weekOf: { type: "string", description: "ISO Monday" },
                title: { type: "string" },
                angle: { type: "string" },
                productHook: { type: ["string", "null"] },
                seasonalContext: { type: ["string", "null"] },
                visualSuggestion: { type: "string" },
                themeShape: {
                  type: "string",
                  enum: ["product_anchored", "cultural_seasonal", "audience_relationship"],
                },
              },
            },
          },
        },
      },
    },
  });
}

// Shared forced-tool schema for full-email copy — used by BOTH initial
// generation (generateCopy) and natural-language revision (reviseCopy)
// so their outputs are identical and the route persistence is shared.
const EMAIL_COPY_TOOL = {
  name: "submit_email_copy",
  description: "Submit the full email copy for the campaign",
  input_schema: {
    type: "object",
    required: [
      "proposedName",
      "subject", "preheader", "subjectAlt", "preheaderAlt",
      "heroHeadline", "heroSubtitle",
      "heroCtaLabel", "heroCtaUrlSuggestion",
      "sectionAHeading", "sectionABody",
      "sectionBHeading", "sectionBBody",
      "sectionBCtaLabel", "sectionBCtaUrlSuggestion",
      "selfCheckPassed",
    ],
    properties: {
      proposedName: {
        type: "string",
        description: "A short (3-8 word) human-readable name for the campaign — used as the operator's internal label AND the brief title. Examples: 'Sunday Drive in Honey lands', 'Memorial Day readers 30% off', 'Tortoise classics back in stock'. If the user already provided a name in {{theme.title}}, mirror it back exactly. Sentence case, no quotes.",
        maxLength: 80,
      },
      subject: { type: "string", maxLength: 60 },
      preheader: { type: "string", maxLength: 110 },
      subjectAlt: {
        type: "string",
        maxLength: 60,
        description: "A SECOND subject line testing a DIFFERENT angle from `subject` (for A/B). If `subject` leads with the product, make this lead with a feeling/curiosity/benefit — or vice versa. Same voice + length rules. Must be meaningfully different, not a reword.",
      },
      preheaderAlt: {
        type: "string",
        maxLength: 110,
        description: "Preheader that complements `subjectAlt` (not `subject`). Must not duplicate `subjectAlt`.",
      },
      heroHeadline: { type: "string" },
      heroSubtitle: { type: "string" },
      heroCtaLabel: { type: "string" },
      heroCtaUrlSuggestion: { type: "string" },
      sectionAHeading: { type: "string" },
      sectionABody: { type: "string" },
      sectionBHeading: { type: "string" },
      sectionBBody: { type: "string" },
      sectionBCtaLabel: { type: "string" },
      sectionBCtaUrlSuggestion: { type: "string" },
      selfCheckPassed: {
        type: "object",
        properties: {
          subjectPreheaderComplement: { type: "boolean" },
          headlineScreenshotWorthy: { type: "boolean" },
          sectionAReaderIsHero: { type: "boolean" },
          sectionBHasSpecificMoment: { type: "boolean" },
          noBannedWords: { type: "boolean" },
          pronounRatioPasses: { type: "boolean" },
          wholesaleHasNumber: { type: "boolean" },
          wholesaleHasChristina: { type: "boolean" },
        },
      },
    },
  },
};

/**
 * Copy generation — fills every text field of the email template
 * for one campaign. Uses the v5 copy-generation-prompt.md.
 *
 * Returns the structured JSON Claude produced + the gut-check
 * self-report (which can be surfaced to the user as warnings if
 * any check failed).
 */
export async function generateCopy(opts: {
  audience: "retail" | "wholesale";
  scheduledDate: string;
  heroVariant: string;
  themeTitle: string;
  themeAngle: string;
  productHook?: string | null;
  seasonalContext?: string | null;
  /** Pre-formatted marketing-calendar context (holidays / sales /
   *  launches / promotions in the ±14-day window). When omitted
   *  the AI gets "(none)" — no calendar awareness. The caller
   *  (HTTP route or MCP tool) is responsible for loading it via
   *  getCalendarContextForCampaign(). Kept as opts not auto-loaded
   *  so this lib stays pure of DB calls. */
  calendarEvents?: string | null;
  /** The last few subjects + hero headlines sent to this audience, so
   *  the prompt's "avoid sameness across consecutive emails" guidance
   *  actually has data to work with. Without this, every single-campaign
   *  generation is blind to recent emails and the inbox drifts same-y. */
  recentEmails?: Array<{ subject?: string | null; heroHeadline?: string | null }>;
  /** Pre-formatted "featured products" block (from product-selector's
   *  formatProductsForPrompt). Empty/undefined = a non-product email.
   *  Resolved by the caller so this lib stays free of DB calls. */
  featuredProductsText?: string;
  /** Public URLs of the featured products' images, fed to the model as
   *  vision inputs so the copy can reference real visual detail. */
  productImages?: Array<{ url: string }>;
}) {
  const { copyGen } = loadPrompts();
  const systemPrompt = buildSystemPrompt(opts.audience);
  const featuredProducts = (opts.featuredProductsText ?? "").trim();
  let taskPrompt = fillTemplate(extractPromptBody(copyGen), {
    "theme.title": opts.themeTitle,
    "theme.angle": opts.themeAngle,
    "theme.productHook": opts.productHook ?? "(none)",
    "theme.seasonalContext": opts.seasonalContext ?? "(none)",
    audience: opts.audience,
    scheduledDate: opts.scheduledDate,
    heroVariant: opts.heroVariant,
    calendarEvents: opts.calendarEvents ?? "(none)",
    featuredProducts: featuredProducts || "(none — write a non-product brand email)",
  });

  // Inject recent-email context so the soft-variation guidance fires.
  const recent = (opts.recentEmails ?? [])
    .map((e) => [e.subject, e.heroHeadline].filter(Boolean).join(" / "))
    .filter(Boolean)
    .slice(0, 5);
  if (recent.length > 0) {
    taskPrompt += `\n\n────────────────────────────────────────────────────────────\nRECENTLY SENT to this audience (do NOT repeat these openers, headline rhythms, or phrases — deliberately contrast):\n${recent.map((r, i) => `${i + 1}. ${r}`).join("\n")}\n────────────────────────────────────────────────────────────`;
  }

  return callClaude({
    systemPrompt,
    userPrompt: taskPrompt,
    images: featuredProducts ? opts.productImages : undefined,
    tool: EMAIL_COPY_TOOL,
  });
}

/**
 * Revise the FULL email copy from natural-language operator feedback.
 * Powers the editor's "chat to improve the email": the operator says
 * "punchier hero, tie the CTA to the quiz, lose the second paragraph"
 * and the AI returns the WHOLE revised copy — same shape as
 * generateCopy, so the route persists it identically.
 */
export async function reviseCopy(opts: {
  audience: "retail" | "wholesale";
  scheduledDate: string;
  brief: { title?: string | null; angle?: string | null };
  /** The campaign's current copy fields (snake/camel agnostic — pass the row). */
  current: Record<string, unknown>;
  feedback: string;
  calendarEvents?: string | null;
  featuredProductsText?: string;
  productImages?: Array<{ url: string }>;
}) {
  const systemPrompt = buildSystemPrompt(opts.audience);
  const featuredProducts = (opts.featuredProductsText ?? "").trim();
  const c = opts.current;
  const cur = (k: string) => {
    const v = c[k];
    return v == null || v === "" ? "(empty)" : String(v);
  };

  const taskPrompt = `You are REVISING an existing marketing email for the ${opts.audience} audience (send date ${opts.scheduledDate}).

BRIEF
  Title: ${opts.brief.title || "(none)"}
  Angle: ${opts.brief.angle || "(none)"}

CURRENT COPY
  Subject: ${cur("subject")}
  Preheader: ${cur("preheader")}
  Alt subject: ${cur("subjectAlt")}
  Alt preheader: ${cur("preheaderAlt")}
  Hero headline: ${cur("heroHeadline")}
  Hero subtitle: ${cur("heroSubtitle")}
  Hero CTA: ${cur("heroCtaLabel")} → ${cur("heroCtaUrl")}
  Section A heading: ${cur("sectionAHeading")}
  Section A body: ${cur("sectionABody")}
  Section B heading: ${cur("sectionBHeading")}
  Section B body: ${cur("sectionBBody")}
  Section B CTA: ${cur("sectionBCtaLabel")} → ${cur("sectionBCtaUrl")}

${featuredProducts ? `FEATURED PRODUCTS (keep featuring these; reference photos attached)\n${featuredProducts}\n\n` : ""}MARKETING CALENDAR (±14 days of this send)
${opts.calendarEvents ?? "(none)"}

THE OPERATOR'S FEEDBACK — apply this to the WHOLE email:
"""
${opts.feedback.trim()}
"""

Return the COMPLETE revised email copy via the tool — EVERY field, not only the ones you changed. Apply the feedback, keep everything that already works, stay in Jaxy voice and within all length rules. For proposedName, mirror the existing brief title unless the feedback asks to rename. Only suggest CTA URLs if they're currently empty.`;

  return callClaude({
    systemPrompt,
    userPrompt: taskPrompt,
    maxTokens: 4096,
    images: featuredProducts ? opts.productImages : undefined,
    tool: EMAIL_COPY_TOOL,
  });
}

/**
 * Image prompt generation — Higgsfield briefs per variant. Uses
 * v3 image-prompt-generation.md.
 */
export async function generateImagePrompts(opts: {
  audience: "retail" | "wholesale";
  heroVariant: string;
  secondaryImageVariant: string;
  themeTitle: string;
  themeAngle: string;
  heroHeadline?: string | null;
  heroSubtitle?: string | null;
  /** Pre-formatted featured-products block (see generateCopy). When a
   *  campaign features real products, the briefs should depict THOSE
   *  products, so we pass their details + images to the model. */
  featuredProductsText?: string;
  productImages?: Array<{ url: string }>;
}) {
  const { imagePromptGen } = loadPrompts();
  const systemPrompt = buildSystemPrompt(opts.audience);
  const featuredProducts = (opts.featuredProductsText ?? "").trim();
  const filled = fillTemplate(extractPromptBody(imagePromptGen), {
    "theme.title": opts.themeTitle,
    "theme.angle": opts.themeAngle,
    heroHeadline: opts.heroHeadline ?? "(not yet generated)",
    heroSubtitle: opts.heroSubtitle ?? "(not yet generated)",
    audience: opts.audience,
    heroVariant: opts.heroVariant,
    secondaryImageVariant: opts.secondaryImageVariant,
    featuredProducts: featuredProducts || "(none — art-direct around the theme, not a specific product)",
  });
  // Ground every brief in the actual photography aesthetic doc (the
  // image prompt references it; we inject the real text here).
  const photoAesthetic = getDocContent("photography-aesthetic");
  const taskPrompt = photoAesthetic
    ? `${filled}\n\n────────────────────────────────────────────────────────────\nPHOTOGRAPHY AESTHETIC — every brief must match this\n────────────────────────────────────────────────────────────\n\n${photoAesthetic}`
    : filled;

  return callClaude({
    systemPrompt,
    userPrompt: taskPrompt,
    images: featuredProducts ? opts.productImages : undefined,
    tool: {
      name: "submit_image_prompts",
      description: "Submit Higgsfield briefs for hero + secondary images",
      input_schema: {
        type: "object",
        required: ["hero", "secondary"],
        properties: {
          hero: {
            type: "object",
            required: ["prompt", "alt", "recommendedScrim", "dimensions", "notes"],
            properties: {
              prompt: { type: "string" },
              alt: { type: "string" },
              recommendedScrim: {
                type: ["string", "null"],
                enum: ["dark", "light", "none", null],
              },
              dimensions: { type: "string" },
              notes: { type: "string" },
            },
          },
          secondary: {
            type: "object",
            required: ["prompts", "alts", "dimensions", "notes"],
            properties: {
              prompts: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 2 },
              alts: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 2 },
              dimensions: { type: "string" },
              notes: { type: "string" },
            },
          },
        },
      },
    },
  });
}

/**
 * Revise ONE proposed brief from natural-language operator feedback.
 * Powers the planner's per-card "Suggest changes" — the operator types
 * "lean into the honey drop, drop the urgency" and the AI returns a
 * revised brief that honors the same slot (date / cadence / layout /
 * subject-angle). Still the IDEA, not the email copy.
 */
export async function reviseBrief(opts: {
  audience: "retail" | "wholesale";
  scheduledDate: string;
  /** Compact slot descriptor, e.g. "slot 2 · layout=split · image=detail · subject-angle=urgency". */
  slotContext?: string | null;
  calendarEvents?: string | null;
  current: { name: string; angle: string; productHook?: string | null; seasonalContext?: string | null };
  feedback: string;
}) {
  const systemPrompt = buildSystemPrompt(opts.audience);
  const taskPrompt = `You previously proposed this email brief for the ${opts.audience} send on ${opts.scheduledDate}.

CURRENT BRIEF
  Name: ${opts.current.name}
  Angle: ${opts.current.angle}
  Product hook: ${opts.current.productHook || "(none)"}
  Seasonal context: ${opts.current.seasonalContext || "(none)"}
${opts.slotContext ? `  Slot: ${opts.slotContext}\n` : ""}
MARKETING CALENDAR (±14 days of this send)
${opts.calendarEvents ?? "(none)"}

THE OPERATOR'S FEEDBACK — apply this:
"""
${opts.feedback.trim()}
"""

Revise the brief to apply the feedback. Keep what already works, stay in Jaxy voice, and respect the slot's fixed constraints (the send date + cadence; honor the layout + subject-angle if given). This is still the IDEA/brief — do NOT write the email copy. Return the full revised brief: name, angle, optional product hook + seasonal context, and a one-line rationale stating what you changed and why.`;

  return callClaude({
    systemPrompt,
    userPrompt: taskPrompt,
    maxTokens: 1500,
    tool: {
      name: "submit_revised_brief",
      description: "Submit the revised email brief after applying the operator's feedback.",
      input_schema: {
        type: "object",
        required: ["name", "angle", "rationale"],
        properties: {
          name: { type: "string", maxLength: 80, description: "3–8 word campaign name, sentence case, no quotes." },
          angle: { type: "string", maxLength: 600, description: "2–4 sentences: the idea, why now, the framing. Not the headline." },
          productHook: { type: "string", description: "Optional SKU / category / colorway. Empty string if none." },
          seasonalContext: { type: "string", description: "Optional holiday / weather / cultural anchor. Empty string if none." },
          rationale: { type: "string", maxLength: 250, description: "One sentence: what you changed and why, referencing the feedback." },
        },
      },
    },
  });
}

/**
 * Monthly campaign planner. Given an audience + date window +
 * calendar context + slot dimensions from the strategy engine,
 * proposes one BRIEF per slot. Returned briefs are then user-
 * reviewable; on accept they become real campaigns.
 *
 * Daniel: "let's work on the marketing calendar for the next
 * month/2 months. it gives suggestions for themes for each email
 * (different concepts) based on the calendar (if anything). it
 * creates the title and short brief per email."
 */
export async function planMonth(opts: {
  audience: "retail" | "wholesale";
  startDate: string;        // ISO YYYY-MM-DD
  endDate: string;          // ISO YYYY-MM-DD
  slots: Array<{
    date: string;
    slotInWeek: 1 | 2;
    layoutProfile: string;
    imageStyle: string;
    subjectAngle: string;
  }>;
  /** Pre-formatted calendar block from getCalendarContextForRange(). */
  calendarEvents: string;
}) {
  const { monthPlan } = loadPrompts();
  const systemPrompt = buildSystemPrompt(opts.audience);
  const cadence = opts.audience === "retail" ? "Mon + Thu" : "Tue + Fri";

  // Build a compact text table of slots so the AI can reference
  // them by position. Each row: date | slot# | layout | image | angle
  const slotsTable = opts.slots
    .map((s, i) =>
      `  ${i + 1}. ${s.date}  slot${s.slotInWeek}  layout=${s.layoutProfile}  image=${s.imageStyle}  angle=${s.subjectAngle}`,
    )
    .join("\n");

  const taskPrompt = fillTemplate(extractPromptBody(monthPlan), {
    audience: opts.audience,
    startDate: opts.startDate,
    endDate: opts.endDate,
    cadence,
    slotCount: String(opts.slots.length),
    calendarEvents: opts.calendarEvents,
    slotsTable,
  });

  return callClaude({
    systemPrompt,
    userPrompt: taskPrompt,
    // Bumped from 4096 — N briefs × ~150 tokens each + reasoning
    // could overflow on 8-week wholesale plans.
    maxTokens: 6000,
    tool: {
      name: "submit_month_plan",
      description: "Submit the month's planned briefs, one per slot, in slot order.",
      input_schema: {
        type: "object",
        required: ["briefs"],
        properties: {
          briefs: {
            type: "array",
            description: `Array of length ${opts.slots.length}. ORDER MATCHES the input slots array — briefs[0] is for slots[0], etc.`,
            minItems: opts.slots.length,
            maxItems: opts.slots.length,
            items: {
              type: "object",
              required: ["name", "angle", "rationale"],
              properties: {
                name: {
                  type: "string",
                  description: "3–8 word campaign name (sentence case, no quotes). The operator's internal label. Examples: 'Honey colorway lands for Labor Day' / 'Last-chance readers, 30% off'",
                  maxLength: 80,
                },
                angle: {
                  type: "string",
                  description: "2–4 sentences. The IDEA — why this email, why now, what specific moment / product / framing. Don't write the headline.",
                  maxLength: 600,
                },
                productHook: {
                  type: "string",
                  description: "Optional SKU / category / colorway. Empty string if no specific product.",
                },
                seasonalContext: {
                  type: "string",
                  description: "Optional holiday / weather / cultural anchor. Empty string if none.",
                },
                rationale: {
                  type: "string",
                  description: "One sentence explaining which calendar event drove this brief (if any) + why the angle fits the slot's image-style + subject-angle. The AI-to-operator handoff.",
                  maxLength: 250,
                },
              },
            },
          },
        },
      },
    },
  });
}

// ── Template filler ──────────────────────────────────────────────
// Replace {{key}} or {{key.sub}} in a string with values from a map.
// Keys with dots are taken literally (no nested-object resolution
// needed since callers flatten before passing).
function fillTemplate(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [key, val] of Object.entries(vars)) {
    const pattern = new RegExp(`\\{\\{\\s*${escapeRe(key)}\\s*\\}\\}`, "g");
    out = out.replace(pattern, val);
  }
  // Strip any unresolved {{...}} tokens (e.g. the {{SYSTEM_PROMPT_BASE}}
  // marker — injected separately as the system prompt) plus a trailing
  // "← see ..." doc arrow, so they never leak into the user message.
  out = out.replace(/\{\{[^}]*\}\}[ \t]*(←[^\n]*)?/g, "").replace(/[ \t]+\n/g, "\n");
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
