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

import fs from "fs";
import path from "path";
import { emailModel } from "./ai-model";

// ── Brand context loader ────────────────────────────────────────
// Snapshot lives in src/modules/marketing/brand-context/ (copied
// from Google Drive per the migration plan). Read at module load,
// cache for process lifetime.

const BRAND_DIR = path.join(process.cwd(), "src", "modules", "marketing", "brand-context");
const PROMPTS_DIR = path.join(process.cwd(), "src", "modules", "marketing", "prompts");

function readFileSafe(p: string): string {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch (e) {
    console.warn(`[email-ai] missing file: ${p}`, e);
    return "";
  }
}

let cachedBrand: {
  bible: string;
  wholesaleVoice: string;
  visualGuidelines: string;
} | null = null;

function loadBrandContext() {
  if (cachedBrand) return cachedBrand;
  cachedBrand = {
    bible: readFileSafe(path.join(BRAND_DIR, "brand-bible.md")),
    wholesaleVoice: readFileSafe(path.join(BRAND_DIR, "wholesale-voice.md")),
    visualGuidelines: readFileSafe(path.join(BRAND_DIR, "visual-guidelines.md")),
  };
  return cachedBrand;
}

let cachedPrompts: {
  systemBase: string;
  copyGen: string;
  themeGen: string;
  imagePromptGen: string;
  monthPlan: string;
} | null = null;

function loadPrompts() {
  if (cachedPrompts) return cachedPrompts;
  cachedPrompts = {
    systemBase: readFileSafe(path.join(PROMPTS_DIR, "system-prompt-base.md")),
    copyGen: readFileSafe(path.join(PROMPTS_DIR, "copy-generation-prompt.md")),
    themeGen: readFileSafe(path.join(PROMPTS_DIR, "theme-generation-prompt.md")),
    imagePromptGen: readFileSafe(path.join(PROMPTS_DIR, "image-prompt-generation.md")),
    monthPlan: readFileSafe(path.join(PROMPTS_DIR, "month-plan-prompt.md")),
  };
  return cachedPrompts;
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
}

async function callClaude({
  systemPrompt,
  userPrompt,
  tool,
  maxTokens = 4096,
  model = emailModel(),
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

  const body = {
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    tools: [tool],
    // Force the model to use the tool (single-tool, mandatory call).
    tool_choice: { type: "tool", name: tool.name },
    messages: [{ role: "user", content: userPrompt }],
  };

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: `Anthropic API ${res.status}: ${text}` };
    }

    const data = (await res.json()) as AnthropicResponse;
    const toolCall = data.content.find(
      (c): c is AnthropicToolCall => c.type === "tool_use",
    );
    if (!toolCall) {
      return { ok: false, error: "Claude returned no tool_use block" };
    }
    return {
      ok: true,
      output: toolCall.input,
      usage: data.usage ?? { input_tokens: 0, output_tokens: 0 },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
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
}) {
  const { copyGen } = loadPrompts();
  const systemPrompt = buildSystemPrompt(opts.audience);
  let taskPrompt = fillTemplate(extractPromptBody(copyGen), {
    "theme.title": opts.themeTitle,
    "theme.angle": opts.themeAngle,
    "theme.productHook": opts.productHook ?? "(none)",
    "theme.seasonalContext": opts.seasonalContext ?? "(none)",
    audience: opts.audience,
    scheduledDate: opts.scheduledDate,
    heroVariant: opts.heroVariant,
    calendarEvents: opts.calendarEvents ?? "(none)",
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
    tool: {
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
    },
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
}) {
  const { imagePromptGen } = loadPrompts();
  const systemPrompt = buildSystemPrompt(opts.audience);
  const filled = fillTemplate(extractPromptBody(imagePromptGen), {
    "theme.title": opts.themeTitle,
    "theme.angle": opts.themeAngle,
    heroHeadline: opts.heroHeadline ?? "(not yet generated)",
    heroSubtitle: opts.heroSubtitle ?? "(not yet generated)",
    audience: opts.audience,
    heroVariant: opts.heroVariant,
    secondaryImageVariant: opts.secondaryImageVariant,
  });
  // Ground every brief in the actual photography aesthetic doc (the
  // image prompt references it; we inject the real text here).
  const photoAesthetic = readFileSafe(path.join(BRAND_DIR, "photography-aesthetic.md"));
  const taskPrompt = photoAesthetic
    ? `${filled}\n\n────────────────────────────────────────────────────────────\nPHOTOGRAPHY AESTHETIC — every brief must match this\n────────────────────────────────────────────────────────────\n\n${photoAesthetic}`
    : filled;

  return callClaude({
    systemPrompt,
    userPrompt: taskPrompt,
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
