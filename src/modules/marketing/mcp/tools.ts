/**
 * Marketing Module MCP Tools
 *
 * Two surfaces:
 *
 *  1. Legacy content-calendar tools (list_content / add_content /
 *     get_seo_rankings / list_influencers / get_ad_stats /
 *     generate_ideas / analyze_seo). Kept as-is.
 *
 *  2. Email Assistant tools — the chat-with-Claude-and-it-builds-
 *     the-email surface. Both atomic primitives (CRUD-ish, narrow
 *     scope) and orchestration shortcuts (multi-step common flows).
 *
 *     Two AI modes per chat user preference:
 *      - save_my_draft: chat-Claude wrote the copy in conversation,
 *        this just persists + runs server-side validation.
 *      - generate_with_v5_prompt: server-side Claude regen via the
 *        locked v5 copy-generation-prompt.md.
 *
 *     A `get_brand_context` resource-like tool returns the brand
 *     voice docs so chat-Claude can stay in voice while riffing.
 */
import { sqlite, db } from "@/lib/db";
import type { McpTool } from "@/modules/core/mcp/server";
import { generateContentIdeas } from "../agents/content-idea-generator";
import { analyzeContent } from "../agents/seo-optimizer";
import { emailCampaigns, emailThemes } from "../schema";
import { and, eq, desc, gte, lte } from "drizzle-orm";
import {
  generateCopy,
  generateImagePrompts,
} from "../lib/email-ai";
import {
  recommendForSlot,
  recommendForWeek,
  IMAGE_STYLES,
  SUBJECT_ANGLES,
  LAYOUT_PROFILES,
} from "../lib/email-strategy";
import { lintCopy, lintGeneratedCopy } from "../lib/copy-quality";
import { planWeeks } from "../lib/plan-week";
import { loadBrandContext } from "../brand-context";
import fs from "fs";
import path from "path";

export const marketingMcpTools: McpTool[] = [
  {
    name: "marketing.list_content",
    description: "List content calendar items with optional filters",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["idea", "planned", "draft", "scheduled", "published"] },
        platform: { type: "string" },
        limit: { type: "number", default: 25 },
      },
    },
    handler: async (input: Record<string, unknown>) => {
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (input.status) { conditions.push("status = ?"); params.push(input.status); }
      if (input.platform) { conditions.push("platform = ?"); params.push(input.platform); }
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const limit = (input.limit as number) || 25;
      const rows = sqlite.prepare(`SELECT * FROM content_calendar ${where} ORDER BY scheduled_date DESC LIMIT ?`).all(...params, limit);
      return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
    },
  },
  {
    name: "marketing.add_content",
    description: "Add a new content calendar item",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        type: { type: "string", enum: ["blog", "social", "email", "ad"] },
        platform: { type: "string" },
        scheduled_date: { type: "string" },
        content: { type: "string" },
      },
      required: ["title", "type", "platform"],
    },
    handler: async (input: Record<string, unknown>) => {
      const id = crypto.randomUUID();
      sqlite.prepare(
        "INSERT INTO content_calendar (id, title, type, platform, status, scheduled_date, content, created_at) VALUES (?, ?, ?, ?, 'idea', ?, ?, datetime('now'))"
      ).run(id, input.title, input.type, input.platform, input.scheduled_date || null, input.content || null);
      return { content: [{ type: "text", text: `Created content item ${id}: ${input.title}` }] };
    },
  },
  {
    name: "marketing.get_seo_rankings",
    description: "Get current SEO keyword rankings",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const rows = sqlite.prepare("SELECT * FROM seo_rankings ORDER BY current_rank ASC LIMIT 50").all();
      return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
    },
  },
  {
    name: "marketing.list_influencers",
    description: "List tracked influencers",
    inputSchema: {
      type: "object",
      properties: { status: { type: "string" } },
    },
    handler: async (input: Record<string, unknown>) => {
      const where = input.status ? "WHERE status = ?" : "";
      const params = input.status ? [input.status] : [];
      const rows = sqlite.prepare(`SELECT * FROM influencers ${where} ORDER BY followers DESC`).all(...params);
      return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
    },
  },
  {
    name: "marketing.get_ad_stats",
    description: "Get ad campaign performance stats",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const rows = sqlite.prepare("SELECT * FROM ad_campaigns ORDER BY start_date DESC").all();
      const totalSpend = rows.reduce((sum: number, r: Record<string, unknown>) => sum + ((r.spend as number) || 0), 0);
      const totalRevenue = rows.reduce((sum: number, r: Record<string, unknown>) => sum + ((r.revenue as number) || 0), 0);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ campaigns: rows, summary: { totalSpend, totalRevenue, roas: totalSpend > 0 ? totalRevenue / totalSpend : 0 } }, null, 2),
        }],
      };
    },
  },
  {
    name: "marketing.generate_ideas",
    description: "Generate content ideas based on trends and calendar",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const ideas = await generateContentIdeas();
      return { content: [{ type: "text", text: JSON.stringify(ideas, null, 2) }] };
    },
  },
  {
    name: "marketing.analyze_seo",
    description: "Analyze content for SEO quality",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        metaDescription: { type: "string" },
        targetKeyword: { type: "string" },
      },
      required: ["title", "body"],
    },
    handler: async (input: Record<string, unknown>) => {
      const analysis = analyzeContent({
        title: input.title as string,
        body: input.body as string,
        metaDescription: input.metaDescription as string | undefined,
        targetKeyword: input.targetKeyword as string | undefined,
      });
      return { content: [{ type: "text", text: JSON.stringify(analysis, null, 2) }] };
    },
  },

  // ──────────────────────────────────────────────────────────────
  // EMAIL ASSISTANT — atomic primitives
  // ──────────────────────────────────────────────────────────────

  {
    name: "marketing.email.get_brand_context",
    description:
      "Returns the Jaxy brand voice docs (BRAND-BIBLE.md voice section + WHOLESALE-VOICE.md) plus the current v5 copy-generation prompt template. Chat-Claude should fetch this ONCE at the start of an email-drafting conversation so every line it writes stays in voice. ALSO returns the banned-word list and the audience-specific gut-check questions.",
    inputSchema: {
      type: "object",
      properties: {
        audience: {
          type: "string",
          enum: ["retail", "wholesale"],
          description: "Which voice doc to load: retail (DTC, BRAND-BIBLE.md §5) or wholesale (Christina, WHOLESALE-VOICE.md)",
        },
      },
      required: ["audience"],
    },
    handler: async (input: Record<string, unknown>) => {
      const audience = input.audience as "retail" | "wholesale";
      const promptsDir = path.join(process.cwd(), "src", "modules", "marketing", "prompts");

      // Voice docs via the central brand-context loader (single reader).
      const ctx = loadBrandContext();
      const voice = audience === "wholesale" ? ctx.wholesaleVoice : ctx.brandBible;
      const systemBase = fs.readFileSync(path.join(promptsDir, "system-prompt-base.md"), "utf-8");
      const copyGen = fs.readFileSync(path.join(promptsDir, "copy-generation-prompt.md"), "utf-8");

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            audience,
            voice_doc: voice,
            system_prompt_template: systemBase,
            copy_generation_prompt_v5: copyGen,
            notes:
              "Use the system_prompt_template to construct your voice. Cite the copy_generation_prompt_v5 hard-shape constraints (subject ≤45 char, headline ≤6 words, etc.) when drafting. The banned-word list is in system_prompt_template — every line you write must pass.",
          }, null, 2),
        }],
      };
    },
  },

  {
    name: "marketing.email.list_campaigns",
    description: "List email campaigns. Filter by audience, status, weekOf, or date range.",
    inputSchema: {
      type: "object",
      properties: {
        audience: { type: "string", enum: ["retail", "wholesale"] },
        status: {
          type: "string",
          enum: ["idea", "themed", "copy_pending", "copy_review", "image_pending", "image_review", "preview_ready", "exported", "sent", "analyzed"],
        },
        weekOf: { type: "string", description: "ISO Monday date for exact-match weekly filter" },
        from: { type: "string", description: "ISO date — start of scheduled_date range" },
        to: { type: "string", description: "ISO date — end of scheduled_date range" },
        limit: { type: "number", default: 25 },
      },
    },
    handler: async (input: Record<string, unknown>) => {
      const conditions = [];
      if (input.audience) conditions.push(eq(emailCampaigns.audience, input.audience as "retail" | "wholesale"));
      if (input.status)   conditions.push(eq(emailCampaigns.status, input.status as never));
      if (input.weekOf)   conditions.push(eq(emailCampaigns.weekOf, input.weekOf as string));
      if (input.from)     conditions.push(gte(emailCampaigns.scheduledDate, input.from as string));
      if (input.to)       conditions.push(lte(emailCampaigns.scheduledDate, input.to as string));

      const rows = await (conditions.length
        ? db.select().from(emailCampaigns).where(and(...conditions)).orderBy(desc(emailCampaigns.scheduledDate)).limit((input.limit as number) || 25)
        : db.select().from(emailCampaigns).orderBy(desc(emailCampaigns.scheduledDate)).limit((input.limit as number) || 25));

      return { content: [{ type: "text", text: JSON.stringify({ campaigns: rows }, null, 2) }] };
    },
  },

  {
    name: "marketing.email.get_campaign",
    description: "Get a single email campaign by id, including every content + variant + AI-metadata field.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    handler: async (input: Record<string, unknown>) => {
      const [row] = await db.select().from(emailCampaigns).where(eq(emailCampaigns.id, input.id as string)).limit(1);
      if (!row) return { content: [{ type: "text", text: JSON.stringify({ error: "Not found" }) }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(row, null, 2) }] };
    },
  },

  {
    name: "marketing.email.create_campaign",
    description: "Create a new email campaign slot. Returns the id. Most fields default — set them later via save_draft or generate_copy.",
    inputSchema: {
      type: "object",
      properties: {
        audience: { type: "string", enum: ["retail", "wholesale"] },
        scheduledDate: { type: "string", description: "ISO date YYYY-MM-DD" },
        weekOf: { type: "string", description: "ISO Monday — optional, auto-computed if omitted" },
        themeId: { type: "string", description: "optional theme to link" },
        heroVariant: { type: "string", enum: ["full_bleed_overlay", "image_75_solid", "split_50_50"] },
        sectionAVariant: { type: "string", enum: ["centered", "with_pullquote"] },
        secondaryImageVariant: { type: "string", enum: ["full_bleed", "centered_75", "grid_2up"] },
        sectionBVariant: { type: "string", enum: ["centered_with_cta", "two_column_with_cta"] },
      },
      required: ["audience", "scheduledDate"],
    },
    handler: async (input: Record<string, unknown>) => {
      if (input.audience !== "retail" && input.audience !== "wholesale") {
        return { content: [{ type: "text", text: "audience must be 'retail' or 'wholesale'" }], isError: true };
      }
      const id = crypto.randomUUID();
      const scheduled = input.scheduledDate as string;
      const weekOf = (input.weekOf as string | undefined) ?? mondayOf(scheduled);
      sqlite.prepare(
        `INSERT INTO marketing_email_campaigns
           (id, audience, scheduled_date, week_of, theme_id, status,
            hero_variant, section_a_variant, secondary_image_variant, section_b_variant,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'idea', ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      ).run(
        id,
        input.audience,
        scheduled,
        weekOf,
        (input.themeId as string | undefined) ?? null,
        (input.heroVariant as string) ?? "full_bleed_overlay",
        (input.sectionAVariant as string) ?? "centered",
        (input.secondaryImageVariant as string) ?? "full_bleed",
        (input.sectionBVariant as string) ?? "centered_with_cta",
      );
      return { content: [{ type: "text", text: JSON.stringify({ id, weekOf, scheduledDate: scheduled }) }] };
    },
  },

  {
    name: "marketing.email.save_draft",
    description:
      "Chat-Claude wrote the email copy in conversation — this tool persists it to a campaign. Runs SERVER-SIDE validation against the banned-word list and the gut-check rules; returns warnings as 'failedChecks' which you should show the user. Use this when YOU drafted the copy; use generate_with_v5_prompt if you want the SERVER to draft using the locked prompt.",
    inputSchema: {
      type: "object",
      properties: {
        campaignId: { type: "string" },
        subject: { type: "string" },
        preheader: { type: "string" },
        heroHeadline: { type: "string" },
        heroSubtitle: { type: "string" },
        heroCtaLabel: { type: "string" },
        heroCtaUrl: { type: "string" },
        heroScrim: { type: "string", enum: ["dark", "light", "none"] },
        sectionAHeading: { type: "string" },
        sectionABody: { type: "string" },
        sectionBHeading: { type: "string" },
        sectionBBody: { type: "string" },
        sectionBCtaLabel: { type: "string" },
        sectionBCtaUrl: { type: "string" },
      },
      required: ["campaignId"],
    },
    handler: async (input: Record<string, unknown>) => {
      const campaignId = input.campaignId as string;
      const [existing] = await db.select().from(emailCampaigns).where(eq(emailCampaigns.id, campaignId)).limit(1);
      if (!existing) return { content: [{ type: "text", text: "Campaign not found" }], isError: true };

      const FIELD_MAP: Record<string, string> = {
        subject: "subject", preheader: "preheader",
        heroHeadline: "hero_headline", heroSubtitle: "hero_subtitle",
        heroCtaLabel: "hero_cta_label", heroCtaUrl: "hero_cta_url",
        heroScrim: "hero_scrim",
        sectionAHeading: "section_a_heading", sectionABody: "section_a_body",
        sectionBHeading: "section_b_heading", sectionBBody: "section_b_body",
        sectionBCtaLabel: "section_b_cta_label", sectionBCtaUrl: "section_b_cta_url",
      };
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, col] of Object.entries(FIELD_MAP)) {
        if (input[k] !== undefined) { sets.push(`${col} = ?`); vals.push(input[k]); }
      }
      if (sets.length === 0) return { content: [{ type: "text", text: "No fields to save" }] };

      sets.push("status = CASE WHEN status IN ('idea','themed','copy_pending') THEN 'copy_review' ELSE status END");
      sets.push("ai_copy_prompt_version = 'chat-Claude-draft'");
      sets.push("updated_at = datetime('now')");
      vals.push(campaignId);
      sqlite.prepare(`UPDATE marketing_email_campaigns SET ${sets.join(", ")} WHERE id = ?`).run(...vals);

      // Deterministic server-side QA — the full copy-quality linter
      // (brand banned words, char/word limits, emoji, exclamation
      // count, preheader≠subject, pronoun ratio, wholesale-number…).
      // Lints the MERGED final row so it catches issues across fields
      // the draft didn't touch.
      const [merged] = await db.select().from(emailCampaigns).where(eq(emailCampaigns.id, campaignId)).limit(1);
      const lint = lintCopy(merged ?? {}, (merged?.audience ?? "retail") as "retail" | "wholesale");

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            campaignId,
            lint,
            warning:
              lint.errors.length > 0
                ? "Server QA found hard errors. The copy IS saved — revise and call save_draft again."
                : null,
          }, null, 2),
        }],
      };
    },
  },

  {
    name: "marketing.email.generate_with_v5_prompt",
    description:
      "Server-side AI generation using the LOCKED v5 copy-generation prompt. Use when the user says 'just do it' or wants the guaranteed-on-brand version. Returns the generated copy + persists it to the campaign + reports any self-check failures. This is the MORE CONSERVATIVE path; save_draft is the conversational path.",
    inputSchema: {
      type: "object",
      properties: {
        campaignId: { type: "string" },
        themeTitle: { type: "string", description: "Optional override — defaults to the campaign's linked theme" },
        themeAngle: { type: "string" },
        productHook: { type: "string" },
        seasonalContext: { type: "string" },
      },
      required: ["campaignId"],
    },
    handler: async (input: Record<string, unknown>) => {
      const campaignId = input.campaignId as string;
      const [campaign] = await db.select().from(emailCampaigns).where(eq(emailCampaigns.id, campaignId)).limit(1);
      if (!campaign) return { content: [{ type: "text", text: "Campaign not found" }], isError: true };

      let themeTitle = input.themeTitle as string | undefined;
      let themeAngle = input.themeAngle as string | undefined;
      let productHook = (input.productHook as string | undefined) ?? null;
      let seasonalContext = (input.seasonalContext as string | undefined) ?? null;

      if ((!themeTitle || !themeAngle) && campaign.themeId) {
        const [theme] = await db.select().from(emailThemes).where(eq(emailThemes.id, campaign.themeId)).limit(1);
        if (theme) {
          themeTitle = themeTitle ?? theme.title;
          themeAngle = themeAngle ?? theme.angle ?? "";
          productHook = productHook ?? theme.productHook;
          seasonalContext = seasonalContext ?? theme.seasonalContext;
        }
      }

      const result = await generateCopy({
        audience: campaign.audience as "retail" | "wholesale",
        scheduledDate: campaign.scheduledDate,
        heroVariant: campaign.heroVariant,
        themeTitle: themeTitle ?? "(unspecified)",
        themeAngle: themeAngle ?? "(unspecified)",
        productHook,
        seasonalContext,
      });
      if (!result.ok) return { content: [{ type: "text", text: `AI error: ${result.error}` }], isError: true };
      const out = result.output as Record<string, unknown>;

      sqlite.prepare(
        `UPDATE marketing_email_campaigns SET
           subject = ?, preheader = ?,
           hero_headline = ?, hero_subtitle = ?,
           hero_cta_label = ?, hero_cta_url = COALESCE(NULLIF(hero_cta_url, ''), ?),
           section_a_heading = ?, section_a_body = ?,
           section_b_heading = ?, section_b_body = ?,
           section_b_cta_label = ?, section_b_cta_url = COALESCE(NULLIF(section_b_cta_url, ''), ?),
           ai_copy_prompt_version = 'v5',
           ai_copy_raw_json = ?,
           status = CASE WHEN status IN ('idea','themed','copy_pending') THEN 'copy_review' ELSE status END,
           updated_at = datetime('now')
         WHERE id = ?`,
      ).run(
        out.subject, out.preheader,
        out.heroHeadline, out.heroSubtitle,
        out.heroCtaLabel, out.heroCtaUrlSuggestion,
        out.sectionAHeading, out.sectionABody,
        out.sectionBHeading, out.sectionBBody,
        out.sectionBCtaLabel, out.sectionBCtaUrlSuggestion,
        JSON.stringify(out),
        campaignId,
      );

      const checks = (out.selfCheckPassed ?? {}) as Record<string, boolean>;
      const failed = Object.entries(checks).filter(([, v]) => v === false).map(([k]) => k);
      const lint = lintGeneratedCopy(out, campaign.audience as "retail" | "wholesale");

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ ok: true, campaignId, generated: out, failedChecks: failed, lint }, null, 2),
        }],
      };
    },
  },

  {
    name: "marketing.email.generate_image_prompts",
    description:
      "Generates Higgsfield-ready briefs for the hero + secondary images of a campaign. Uses the v3 image-prompt prompt. Persists the prompts + recommended scrim onto the campaign. Designer reads them from the queue + renders manually in Higgsfield's web UI.",
    inputSchema: {
      type: "object",
      properties: { campaignId: { type: "string" } },
      required: ["campaignId"],
    },
    handler: async (input: Record<string, unknown>) => {
      const campaignId = input.campaignId as string;
      const [campaign] = await db.select().from(emailCampaigns).where(eq(emailCampaigns.id, campaignId)).limit(1);
      if (!campaign) return { content: [{ type: "text", text: "Campaign not found" }], isError: true };

      let themeTitle = "(no theme)", themeAngle = "(no theme)";
      if (campaign.themeId) {
        const [theme] = await db.select().from(emailThemes).where(eq(emailThemes.id, campaign.themeId)).limit(1);
        if (theme) { themeTitle = theme.title; themeAngle = theme.angle ?? "(no angle)"; }
      }

      const result = await generateImagePrompts({
        audience: campaign.audience as "retail" | "wholesale",
        heroVariant: campaign.heroVariant,
        secondaryImageVariant: campaign.secondaryImageVariant,
        themeTitle, themeAngle,
        heroHeadline: campaign.heroHeadline,
        heroSubtitle: campaign.heroSubtitle,
      });
      if (!result.ok) return { content: [{ type: "text", text: `AI error: ${result.error}` }], isError: true };
      const out = result.output as { hero: { prompt: string; alt: string; recommendedScrim: "dark"|"light"|"none"|null; dimensions: string; notes: string }; secondary: { prompts: string[]; alts: string[]; dimensions: string; notes: string }; };

      sqlite.prepare(
        `UPDATE marketing_email_campaigns SET
           hero_image_prompt = ?, hero_image_alt = COALESCE(NULLIF(hero_image_alt, ''), ?),
           hero_scrim = COALESCE(?, hero_scrim),
           secondary_image_prompt = ?, secondary_image_alt = COALESCE(NULLIF(secondary_image_alt, ''), ?),
           secondary_image_prompt_2 = ?, secondary_image_alt_2 = COALESCE(NULLIF(secondary_image_alt_2, ''), ?),
           ai_image_prompt_raw_json = ?,
           status = CASE WHEN status IN ('idea','themed','copy_pending','copy_review') THEN 'image_pending' ELSE status END,
           updated_at = datetime('now')
         WHERE id = ?`,
      ).run(
        out.hero.prompt, out.hero.alt, out.hero.recommendedScrim,
        out.secondary.prompts[0] ?? "", out.secondary.alts[0] ?? "",
        out.secondary.prompts[1] ?? null, out.secondary.alts[1] ?? null,
        JSON.stringify(out),
        campaignId,
      );

      return { content: [{ type: "text", text: JSON.stringify({ ok: true, campaignId, generated: out }, null, 2) }] };
    },
  },

  {
    name: "marketing.email.list_themes",
    description: "List themes for an audience and/or weekOf. Useful to pick from existing themes before creating a campaign.",
    inputSchema: {
      type: "object",
      properties: {
        audience: { type: "string", enum: ["retail", "wholesale"] },
        weekOf: { type: "string", description: "ISO Monday date" },
      },
    },
    handler: async (input: Record<string, unknown>) => {
      const conditions = [];
      if (input.audience) conditions.push(eq(emailThemes.audience, input.audience as "retail" | "wholesale"));
      if (input.weekOf)   conditions.push(eq(emailThemes.weekOf, input.weekOf as string));
      const rows = await (conditions.length
        ? db.select().from(emailThemes).where(and(...conditions)).orderBy(desc(emailThemes.createdAt))
        : db.select().from(emailThemes).orderBy(desc(emailThemes.createdAt)));
      return { content: [{ type: "text", text: JSON.stringify({ themes: rows }, null, 2) }] };
    },
  },

  // ──────────────────────────────────────────────────────────────
  // ORCHESTRATION SHORTCUTS — common multi-step flows
  // ──────────────────────────────────────────────────────────────

  {
    name: "marketing.email.plan_week",
    description:
      "Plan a week (or N weeks) of emails for an audience in one call. Uses the v3 theme-generation prompt to propose themes, persists them, then optionally creates campaign slots on the cadence days (retail Mon/Thu, wholesale Tue/Fri). Returns the themes + the created campaign slots.",
    inputSchema: {
      type: "object",
      properties: {
        audience: { type: "string", enum: ["retail", "wholesale"] },
        weekStart: { type: "string", description: "ISO Monday — defaults to next Monday" },
        weeks: { type: "number", description: "How many weeks to plan (default 4)" },
        createCampaigns: { type: "boolean", description: "Also create campaign slots for each theme (default true)" },
      },
      required: ["audience"],
    },
    handler: async (input: Record<string, unknown>) => {
      // Delegates to the shared planWeeks() lib so the MCP tool and the
      // HTTP /plan-week route never drift.
      const result = await planWeeks({
        audience: input.audience as "retail" | "wholesale",
        weekStart: input.weekStart as string | undefined,
        weeks: input.weeks as number | undefined,
        createCampaigns: input.createCampaigns as boolean | undefined,
      });
      if (!result.ok) {
        return { content: [{ type: "text", text: `Plan error: ${result.error}` }], isError: true };
      }
      const note = result.campaignsCreated.length
        ? `Created ${result.campaignsCreated.length} campaign slots. Each slot got its own brief (slot 1 ≠ slot 2 even within the same week — different image style + subject angle). Edit briefs at /marketing/email/campaigns/[id] before generate-copy. Cadence: ${result.audience === "retail" ? "Mon + Thu" : "Tue + Fri"}.`
        : "Themes only — no campaigns created.";
      return { content: [{ type: "text", text: JSON.stringify({ ...result, note }, null, 2) }] };
    },
  },

  {
    name: "marketing.email.build_campaign_from_idea",
    description:
      "One-shot 'build a campaign from an idea' flow. Given an audience, a date, and a description of the idea, this: (1) creates a theme row, (2) creates a campaign slot, (3) generates copy via v5 prompt, (4) generates image prompts. Returns the fully-populated campaign id. Use when the user says something like 'build me a wholesale email about the Faire Summer Market for next Tuesday' — call this once and you're done.",
    inputSchema: {
      type: "object",
      properties: {
        audience: { type: "string", enum: ["retail", "wholesale"] },
        scheduledDate: { type: "string", description: "ISO date YYYY-MM-DD" },
        themeTitle: { type: "string", description: "3-8 word theme title" },
        themeAngle: { type: "string", description: "1-2 sentence angle — why now, who it's for" },
        productHook: { type: "string", description: "Optional — SKU/category" },
        seasonalContext: { type: "string", description: "Optional — holiday/season/weather anchor" },
        heroVariant: { type: "string", enum: ["full_bleed_overlay", "image_75_solid", "split_50_50"] },
        secondaryImageVariant: { type: "string", enum: ["full_bleed", "centered_75", "grid_2up"] },
      },
      required: ["audience", "scheduledDate", "themeTitle", "themeAngle"],
    },
    handler: async (input: Record<string, unknown>) => {
      const audience = input.audience as "retail" | "wholesale";
      const scheduled = input.scheduledDate as string;
      const weekOf = mondayOf(scheduled);

      // 1. Theme
      const themeId = crypto.randomUUID();
      sqlite.prepare(
        `INSERT INTO marketing_email_themes
          (id, week_of, audience, title, angle, product_hook, seasonal_context, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      ).run(
        themeId, weekOf, audience,
        input.themeTitle as string,
        input.themeAngle as string,
        (input.productHook as string | undefined) ?? null,
        (input.seasonalContext as string | undefined) ?? null,
      );

      // 2. Campaign — variants default to the strategy engine's
      // recommendation for this audience × week × slot. The caller
      // can override by passing heroVariant/secondaryImageVariant
      // explicitly; otherwise we let the rotation decide.
      // For a single one-shot campaign we don't know slot 1 vs 2 —
      // infer from the send day (retail Mon = slot 1, Thu = slot 2;
      // wholesale Tue = slot 1, Fri = slot 2). If the date doesn't
      // match a cadence day, default to slot 1.
      const inferredSlot = inferSlotFromDate(audience, scheduled);
      const recommendation = recommendForSlot(audience, weekOf, inferredSlot);
      const campaignId = crypto.randomUUID();
      const heroVariant = (input.heroVariant as string) ?? recommendation.layoutVariants.heroVariant;
      const secondaryImageVariant = (input.secondaryImageVariant as string) ?? recommendation.layoutVariants.secondaryImageVariant;
      const sectionAVariant = recommendation.layoutVariants.sectionAVariant;
      const sectionBVariant = recommendation.layoutVariants.sectionBVariant;
      const designerNote = `STRATEGY: ${recommendation.rationale}\n\nIMAGE STYLE: ${recommendation.imageStyleDirective}\n\nSUBJECT ANGLE: ${recommendation.subjectAngleHint}`;
      sqlite.prepare(
        `INSERT INTO marketing_email_campaigns
          (id, audience, scheduled_date, week_of, theme_id, status,
           hero_variant, section_a_variant, secondary_image_variant, section_b_variant,
           brief_title, brief_angle, brief_product_hook, brief_seasonal_context,
           designer_notes,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'copy_pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      ).run(
        campaignId, audience, scheduled, weekOf, themeId,
        heroVariant, sectionAVariant, secondaryImageVariant, sectionBVariant,
        input.themeTitle as string,
        input.themeAngle as string,
        (input.productHook as string | undefined) ?? null,
        (input.seasonalContext as string | undefined) ?? null,
        designerNote,
      );

      // 3. Copy via v5 prompt
      const copyRes = await generateCopy({
        audience, scheduledDate: scheduled, heroVariant,
        themeTitle: input.themeTitle as string,
        themeAngle: input.themeAngle as string,
        productHook: (input.productHook as string | undefined) ?? null,
        seasonalContext: (input.seasonalContext as string | undefined) ?? null,
      });
      if (!copyRes.ok) {
        return { content: [{ type: "text", text: `Copy AI error: ${copyRes.error}. Campaign + theme created (id=${campaignId}) but copy generation failed.` }], isError: true };
      }
      const c = copyRes.output as Record<string, unknown>;
      sqlite.prepare(
        `UPDATE marketing_email_campaigns SET
           subject = ?, preheader = ?,
           hero_headline = ?, hero_subtitle = ?,
           hero_cta_label = ?, hero_cta_url = ?,
           section_a_heading = ?, section_a_body = ?,
           section_b_heading = ?, section_b_body = ?,
           section_b_cta_label = ?, section_b_cta_url = ?,
           ai_copy_prompt_version = 'v5',
           ai_copy_raw_json = ?,
           status = 'copy_review',
           updated_at = datetime('now')
         WHERE id = ?`,
      ).run(
        c.subject, c.preheader,
        c.heroHeadline, c.heroSubtitle,
        c.heroCtaLabel, c.heroCtaUrlSuggestion,
        c.sectionAHeading, c.sectionABody,
        c.sectionBHeading, c.sectionBBody,
        c.sectionBCtaLabel, c.sectionBCtaUrlSuggestion,
        JSON.stringify(c),
        campaignId,
      );

      // 4. Image prompts
      const imageRes = await generateImagePrompts({
        audience, heroVariant, secondaryImageVariant,
        themeTitle: input.themeTitle as string,
        themeAngle: input.themeAngle as string,
        heroHeadline: c.heroHeadline as string,
        heroSubtitle: c.heroSubtitle as string,
      });
      if (imageRes.ok) {
        const i = imageRes.output as { hero: { prompt: string; alt: string; recommendedScrim: "dark"|"light"|"none"|null; }; secondary: { prompts: string[]; alts: string[]; }; };
        sqlite.prepare(
          `UPDATE marketing_email_campaigns SET
             hero_image_prompt = ?, hero_image_alt = ?,
             hero_scrim = COALESCE(?, hero_scrim),
             secondary_image_prompt = ?, secondary_image_alt = ?,
             secondary_image_prompt_2 = ?, secondary_image_alt_2 = ?,
             ai_image_prompt_raw_json = ?,
             status = 'image_pending',
             updated_at = datetime('now')
           WHERE id = ?`,
        ).run(
          i.hero.prompt, i.hero.alt, i.hero.recommendedScrim,
          i.secondary.prompts[0] ?? "", i.secondary.alts[0] ?? "",
          i.secondary.prompts[1] ?? null, i.secondary.alts[1] ?? null,
          JSON.stringify(i),
          campaignId,
        );
      }

      const [final] = await db.select().from(emailCampaigns).where(eq(emailCampaigns.id, campaignId)).limit(1);
      const failedChecks = Object.entries((c.selfCheckPassed ?? {}) as Record<string, boolean>)
        .filter(([, v]) => v === false).map(([k]) => k);
      const lint = lintGeneratedCopy(c, audience);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            campaignId,
            themeId,
            campaign: final,
            failedChecks,
            lint,
            previewUrl: `https://theframe.getjaxy.com/marketing/email/campaigns/${campaignId}`,
            note: "Campaign built end-to-end. Designer renders the images per the hero/secondary prompts, uploads via the editor or the upload endpoint, then user reviews + exports.",
          }, null, 2),
        }],
      };
    },
  },

  {
    name: "marketing.email.refine_campaign",
    description:
      "Re-generate one section of an existing campaign with a specific instruction. E.g. 'make the subject more urgent' or 'rewrite section A to lead with the price instead of the feeling'. Pulls the existing campaign + the instruction into a focused prompt, returns the new copy for that section only.",
    inputSchema: {
      type: "object",
      properties: {
        campaignId: { type: "string" },
        section: { type: "string", enum: ["subject_preheader", "hero", "section_a", "section_b", "all"] },
        instruction: { type: "string", description: "What to change and why" },
      },
      required: ["campaignId", "section", "instruction"],
    },
    handler: async (input: Record<string, unknown>) => {
      // For v1 we route refine to a re-run of generate_with_v5_prompt
      // with the instruction appended to the theme angle. Future
      // versions will support per-section regeneration with a more
      // surgical prompt — for now it's a full regen scoped by intent.
      const campaignId = input.campaignId as string;
      const instruction = input.instruction as string;
      const [campaign] = await db.select().from(emailCampaigns).where(eq(emailCampaigns.id, campaignId)).limit(1);
      if (!campaign) return { content: [{ type: "text", text: "Campaign not found" }], isError: true };

      let themeTitle = "(no theme)", themeAngle = "";
      if (campaign.themeId) {
        const [theme] = await db.select().from(emailThemes).where(eq(emailThemes.id, campaign.themeId)).limit(1);
        if (theme) { themeTitle = theme.title; themeAngle = theme.angle ?? ""; }
      }
      // Append the refinement instruction to the angle so the v5
      // prompt incorporates it without changing the prompt template.
      const refinedAngle = `${themeAngle}\n\nREFINEMENT REQUEST (${input.section as string}): ${instruction}`;

      const res = await generateCopy({
        audience: campaign.audience as "retail" | "wholesale",
        scheduledDate: campaign.scheduledDate,
        heroVariant: campaign.heroVariant,
        themeTitle,
        themeAngle: refinedAngle,
        productHook: null, seasonalContext: null,
      });
      if (!res.ok) return { content: [{ type: "text", text: `AI error: ${res.error}` }], isError: true };
      const out = res.output as Record<string, unknown>;

      // Apply ONLY the requested section's fields.
      const section = input.section as string;
      const writes: Record<string, string> = {};
      if (section === "subject_preheader" || section === "all") {
        writes.subject = out.subject as string;
        writes.preheader = out.preheader as string;
      }
      if (section === "hero" || section === "all") {
        writes.hero_headline = out.heroHeadline as string;
        writes.hero_subtitle = out.heroSubtitle as string;
        writes.hero_cta_label = out.heroCtaLabel as string;
      }
      if (section === "section_a" || section === "all") {
        writes.section_a_heading = out.sectionAHeading as string;
        writes.section_a_body = out.sectionABody as string;
      }
      if (section === "section_b" || section === "all") {
        writes.section_b_heading = out.sectionBHeading as string;
        writes.section_b_body = out.sectionBBody as string;
        writes.section_b_cta_label = out.sectionBCtaLabel as string;
      }
      const sets = Object.keys(writes).map(k => `${k} = ?`).concat(["updated_at = datetime('now')"]).join(", ");
      const vals = [...Object.values(writes), campaignId];
      sqlite.prepare(`UPDATE marketing_email_campaigns SET ${sets} WHERE id = ?`).run(...vals);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ ok: true, campaignId, section, applied: writes, fullResponse: out }, null, 2),
        }],
      };
    },
  },

  // ──────────────────────────────────────────────────────────────
  // STRATEGY ENGINE — surfaces the methodic rotation as a tool
  // ──────────────────────────────────────────────────────────────

  {
    name: "marketing.email.get_strategy_recommendation",
    description:
      "Returns the methodic recommendation for a given audience × week × slot: layout variants, image style (product-flatlay vs on-model lifestyle), subject angle to test. Driven by the deterministic rotation engine (LAYOUT_PROFILES + SUBJECT_ANGLES in lib/email-strategy.ts). Use this BEFORE building a campaign to see what the strategy says you should do — then override only the bits the moment requires. Slot 1 = first email of the week, Slot 2 = second.",
    inputSchema: {
      type: "object",
      properties: {
        audience: { type: "string", enum: ["retail", "wholesale"] },
        weekOf: { type: "string", description: "ISO Monday date" },
        slotInWeek: { type: "number", enum: [1, 2], description: "1 = first email of week, 2 = second" },
        bothSlots: { type: "boolean", description: "If true, return recommendations for BOTH slots of the week (default: only the requested slot)" },
      },
      required: ["audience", "weekOf"],
    },
    handler: async (input: Record<string, unknown>) => {
      const audience = input.audience as "retail" | "wholesale";
      const weekOf = input.weekOf as string;
      if (input.bothSlots) {
        const recs = recommendForWeek(audience, weekOf);
        return { content: [{ type: "text", text: JSON.stringify({ recommendations: recs }, null, 2) }] };
      }
      const slot = (input.slotInWeek as 1 | 2) ?? 1;
      const rec = recommendForSlot(audience, weekOf, slot);
      return { content: [{ type: "text", text: JSON.stringify(rec, null, 2) }] };
    },
  },

  {
    name: "marketing.email.list_strategy_catalog",
    description:
      "Returns the full strategy vocabulary — every LAYOUT_PROFILE, every IMAGE_STYLE, every SUBJECT_ANGLE with their descriptions + examples. Use this when the user asks 'what are my options' or you want to explain why the engine picked X.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            layoutProfiles: LAYOUT_PROFILES,
            imageStyles: IMAGE_STYLES,
            subjectAngles: SUBJECT_ANGLES,
            notes:
              "v1 = static rotation rules. v2 will weight rotation by open/click data. See lib/email-strategy.ts for the recommendForSlot() rules.",
          }, null, 2),
        }],
      };
    },
  },
];

// ── Helpers ─────────────────────────────────────────────────────

function mondayOf(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const dayOfWeek = d.getUTCDay();
  const offset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

/**
 * Given a scheduled date + audience, figure out whether this slot
 * is the first (Mon retail / Tue wholesale) or second (Thu / Fri).
 * Defaults to slot 1 if the date isn't on a cadence day.
 */
function inferSlotFromDate(audience: "retail" | "wholesale", iso: string): 1 | 2 {
  const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
  if (audience === "retail") {
    if (dow === 4) return 2;   // Thursday
    return 1;                  // default Monday-or-other
  } else {
    if (dow === 5) return 2;   // Friday
    return 1;                  // default Tuesday-or-other
  }
}
