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
import { getCalendarContextForCampaign } from "../lib/calendar-context";
import { and, eq, desc, gte, lte } from "drizzle-orm";
import {
  generateCopy,
  generateThemes,
  generateImagePrompts,
} from "../lib/email-ai";
import {
  recommendForSlot,
  recommendForWeek,
  recommendForWeeks,
  IMAGE_STYLES,
  SUBJECT_ANGLES,
  LAYOUT_PROFILES,
} from "../lib/email-strategy";
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
      const brandDir = path.join(process.cwd(), "src", "modules", "marketing", "brand-context");
      const promptsDir = path.join(process.cwd(), "src", "modules", "marketing", "prompts");

      const voice = audience === "wholesale"
        ? fs.readFileSync(path.join(brandDir, "wholesale-voice.md"), "utf-8")
        : fs.readFileSync(path.join(brandDir, "brand-bible.md"), "utf-8");
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
          enum: ["draft", "copywriting", "photography", "design_review", "scheduled", "sent", "analyzed"],
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
         VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, datetime('now'), datetime('now'))`,
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

      sets.push("status = CASE WHEN status IN ('draft','copywriting') THEN 'copywriting' ELSE status END");
      sets.push("ai_copy_prompt_version = 'chat-Claude-draft'");
      sets.push("updated_at = datetime('now')");
      vals.push(campaignId);
      sqlite.prepare(`UPDATE marketing_email_campaigns SET ${sets.join(", ")} WHERE id = ?`).run(...vals);

      // Lightweight server-side validation. Mirrors the worst of
      // the banned-word list — chat-Claude already had the full
      // list via get_brand_context but this is the safety net.
      const all = [
        input.subject, input.heroHeadline, input.heroSubtitle,
        input.sectionAHeading, input.sectionABody,
        input.sectionBHeading, input.sectionBBody,
      ].filter((v) => typeof v === "string").join(" ").toLowerCase();
      const BANNED_HARD = [
        "curated", "premium", "luxury", "investment piece",
        "elevate", "effortless", "game-changer", "must-have",
        "introducing", "we're so excited", "we're thrilled",
        "made in la", "made in california",
        "lose them", "throw them around",
      ];
      const failedChecks: string[] = [];
      for (const b of BANNED_HARD) {
        if (all.includes(b)) failedChecks.push(`banned_phrase: "${b}"`);
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            campaignId,
            failedChecks,
            warning:
              failedChecks.length > 0
                ? "Server validation found banned phrases. The copy IS saved — you should revise and call save_draft again."
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

      const calendarEvents = await getCalendarContextForCampaign({
        scheduledDate: campaign.scheduledDate,
        audience: campaign.audience as "retail" | "wholesale",
      });
      const result = await generateCopy({
        audience: campaign.audience as "retail" | "wholesale",
        scheduledDate: campaign.scheduledDate,
        heroVariant: campaign.heroVariant,
        themeTitle: themeTitle ?? "(unspecified)",
        themeAngle: themeAngle ?? "(unspecified)",
        productHook,
        seasonalContext,
        calendarEvents,
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
           status = CASE WHEN status = 'draft' THEN 'copywriting' ELSE status END,
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

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ ok: true, campaignId, generated: out, failedChecks: failed }, null, 2),
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
           status = CASE WHEN status IN ('draft','copywriting') THEN 'photography' ELSE status END,
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
      const audience = input.audience as "retail" | "wholesale";
      const weeks = (input.weeks as number) ?? 4;
      const createCampaigns = input.createCampaigns !== false;
      const weekStart = (input.weekStart as string | undefined) ?? nextMonday();

      // Generate themes — one per week
      const themeRes = await generateThemes({ audience, weekStart, count: weeks });
      if (!themeRes.ok) return { content: [{ type: "text", text: `Theme AI error: ${themeRes.error}` }], isError: true };
      const themes = (themeRes.output.themes ?? []) as Array<{
        weekOf: string; title: string; angle: string;
        productHook?: string | null; seasonalContext?: string | null;
      }>;

      // Persist themes
      const themeInsertStmt = sqlite.prepare(
        `INSERT INTO marketing_email_themes
          (id, week_of, audience, title, angle, product_hook, seasonal_context, raw_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      );
      const insertedThemes = themes.map((t) => {
        const id = crypto.randomUUID();
        themeInsertStmt.run(
          id, t.weekOf, audience, t.title, t.angle ?? null,
          t.productHook ?? null, t.seasonalContext ?? null, JSON.stringify(t),
        );
        return { id, ...t };
      });

      // Maybe create campaigns — now driven by the strategy engine.
      // Each slot gets:
      //   1. Variant layout from recommendForSlot()
      //   2. A UNIQUE BRIEF derived from the week's theme + the
      //      slot's image style + subject angle (so slot 1 brief
      //      differs from slot 2 brief even though they share a
      //      theme).
      //   3. Designer notes (strategy rationale + image directive)
      //
      // The brief is editable in the campaign editor — Daniel:
      // "you can edit and refine it." Generate-copy reads the brief
      // from the campaign row at run time.
      let campaignsCreated: {
        id: string;
        scheduledDate: string;
        themeId: string;
        themeTitle: string;
        briefTitle: string;
        briefAngle: string;
        slotInWeek: 1 | 2;
        layoutProfile: string;
        imageStyle: string;
        subjectAngle: string;
      }[] = [];
      if (createCampaigns) {
        const campaignInsertStmt = sqlite.prepare(
          `INSERT INTO marketing_email_campaigns
            (id, audience, scheduled_date, week_of, theme_id, status,
             hero_variant, section_a_variant, secondary_image_variant, section_b_variant,
             brief_title, brief_angle, brief_product_hook, brief_seasonal_context,
             designer_notes,
             created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
        );
        for (const theme of insertedThemes) {
          const slots: (1 | 2)[] = [1, 2];
          for (const slot of slots) {
            const rec = recommendForSlot(audience, theme.weekOf, slot);
            const id = crypto.randomUUID();
            const designerNote = `STRATEGY: ${rec.rationale}\n\nIMAGE STYLE: ${rec.imageStyleDirective}\n\nSUBJECT ANGLE: ${rec.subjectAngleHint}`;

            // Compose a per-slot brief from theme + strategy. The
            // title gets the slot dimension appended so the user can
            // distinguish the two slots at a glance in the calendar.
            // Angle weaves the image style + subject angle hints
            // into the theme's angle so the AI knows the lens.
            const slotLabel = slot === 1
              ? (audience === "retail" ? "Mon" : "Tue")
              : (audience === "retail" ? "Thu" : "Fri");
            const imageStyleLabel = rec.imageStyle === "product_flatlay"
              ? "product still-life angle"
              : rec.imageStyle === "on_model_lifestyle"
                ? "on-model lifestyle angle"
                : rec.imageStyle.replace(/_/g, " ");
            const briefTitle = `${theme.title} — ${slotLabel} (${imageStyleLabel})`;
            const briefAngle = `${theme.angle ?? ""}

Slot context: ${imageStyleLabel}. Subject-angle direction: ${rec.subjectAngleHint}`;

            campaignInsertStmt.run(
              id,
              audience,
              rec.scheduledDate,
              theme.weekOf,
              theme.id,
              rec.layoutVariants.heroVariant,
              rec.layoutVariants.sectionAVariant,
              rec.layoutVariants.secondaryImageVariant,
              rec.layoutVariants.sectionBVariant,
              briefTitle,
              briefAngle,
              theme.productHook ?? null,
              theme.seasonalContext ?? null,
              designerNote,
            );
            campaignsCreated.push({
              id,
              scheduledDate: rec.scheduledDate,
              themeId: theme.id,
              themeTitle: theme.title,
              briefTitle,
              briefAngle,
              slotInWeek: slot,
              layoutProfile: rec.layoutProfile,
              imageStyle: rec.imageStyle,
              subjectAngle: rec.subjectAngle,
            });
          }
        }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            audience,
            weekStart,
            weeksPlanned: weeks,
            themes: insertedThemes,
            campaignsCreated,
            note: createCampaigns
              ? `Created ${campaignsCreated.length} campaign slots. Each slot got its own brief (slot 1 ≠ slot 2 even within the same week — different image style + subject angle). User can edit briefs in the editor at /marketing/email/campaigns/[id] before calling generate-copy. Cadence: ${audience === "retail" ? "Mon + Thu" : "Tue + Fri"}.`
              : "Themes only — no campaigns created.",
          }, null, 2),
        }],
      };
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
         VALUES (?, ?, ?, ?, ?, 'copywriting', ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      ).run(
        campaignId, audience, scheduled, weekOf, themeId,
        heroVariant, sectionAVariant, secondaryImageVariant, sectionBVariant,
        input.themeTitle as string,
        input.themeAngle as string,
        (input.productHook as string | undefined) ?? null,
        (input.seasonalContext as string | undefined) ?? null,
        designerNote,
      );

      // 3. Copy via v5 prompt — with calendar context for the date window
      const buildCalendarEvents = await getCalendarContextForCampaign({
        scheduledDate: scheduled,
        audience,
      });
      const copyRes = await generateCopy({
        audience, scheduledDate: scheduled, heroVariant,
        themeTitle: input.themeTitle as string,
        themeAngle: input.themeAngle as string,
        productHook: (input.productHook as string | undefined) ?? null,
        seasonalContext: (input.seasonalContext as string | undefined) ?? null,
        calendarEvents: buildCalendarEvents,
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
           status = 'copywriting',
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
             status = 'photography',
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

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            campaignId,
            themeId,
            campaign: final,
            failedChecks,
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

      const refineCalendar = await getCalendarContextForCampaign({
        scheduledDate: campaign.scheduledDate,
        audience: campaign.audience as "retail" | "wholesale",
      });
      const res = await generateCopy({
        audience: campaign.audience as "retail" | "wholesale",
        scheduledDate: campaign.scheduledDate,
        heroVariant: campaign.heroVariant,
        themeTitle,
        themeAngle: refinedAngle,
        productHook: null, seasonalContext: null,
        calendarEvents: refineCalendar,
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

  // ── Marketing calendar ──────────────────────────────────────────
  // Lets chat-Claude see upcoming holidays / sales / launches /
  // promos AND add new ones inline ("there's a Memorial Day promo
  // coming up — add it to the calendar so the email planner picks
  // it up automatically").
  {
    name: "marketing.calendar.list_events",
    description:
      "List marketing calendar events (holidays, sales, launches, promotions) in a date window. By default returns ±60 days from today. These events are auto-injected into email generate-copy as context, so the calendar drives what the AI knows is coming.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "ISO date (YYYY-MM-DD). Defaults to today." },
        to: { type: "string", description: "ISO date. Defaults to today + 60 days." },
        audience: { type: "string", enum: ["all", "retail", "wholesale"] },
        event_type: { type: "string", enum: ["holiday", "sale", "launch", "promotion"] },
      },
    },
    handler: async ({ input }) => {
      const { calendarEvents } = await import("../schema");
      const { and, asc, gte, lte } = await import("drizzle-orm");
      const today = new Date().toISOString().slice(0, 10);
      const from = (input.from as string) ?? today;
      const toDate = new Date(from + "T00:00:00Z");
      toDate.setUTCDate(toDate.getUTCDate() + 60);
      const to = (input.to as string) ?? toDate.toISOString().slice(0, 10);
      const audience = input.audience as "all" | "retail" | "wholesale" | undefined;
      const eventType = input.event_type as string | undefined;

      const all = await db
        .select()
        .from(calendarEvents)
        .where(and(lte(calendarEvents.dateStart, to), gte(calendarEvents.dateEnd, from)))
        .orderBy(asc(calendarEvents.dateStart));
      const filtered = all.filter(e => {
        if (eventType && e.eventType !== eventType) return false;
        if (audience && audience !== "all" && e.audience !== "all" && e.audience !== audience) return false;
        return true;
      });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            window: { from, to },
            count: filtered.length,
            events: filtered,
            note: "These events are auto-injected into generate-copy / plan_week for any campaign whose scheduledDate overlaps the ±14-day window of the event.",
          }, null, 2),
        }],
      };
    },
  },
  {
    name: "marketing.email.plan_month",
    description:
      "Calendar-driven planner. Given audience + start date + weeks, AI proposes one unique brief per email slot — calendar-aware (leans into upcoming holidays/sales/launches/promos) and slot-aware (matches the strategy engine's pre-assigned layout + image-style + subject-angle per slot). Returns proposals for review. Use marketing.email.create_campaign per accepted brief OR direct the user to /marketing/email/plan for bulk-create UI.",
    inputSchema: {
      type: "object",
      required: ["audience", "start_date"],
      properties: {
        audience: { type: "string", enum: ["retail", "wholesale"] },
        start_date: { type: "string", description: "ISO YYYY-MM-DD" },
        weeks: { type: "number", description: "1-12, default 4", minimum: 1, maximum: 12 },
      },
    },
    handler: async ({ input }) => {
      const { planMonth } = await import("../lib/email-ai");
      const { getCalendarContextForRange, loadEventsInRange } = await import("../lib/calendar-context");
      const { recommendForWeeks } = await import("../lib/email-strategy");
      const audience = input.audience as "retail" | "wholesale";
      const startDate = input.start_date as string;
      const weeks = (input.weeks as number) ?? 4;

      const slots = recommendForWeeks(audience, startDate, weeks);
      if (slots.length === 0) {
        return { content: [{ type: "text", text: "Strategy engine returned no slots" }], isError: true };
      }
      const firstDate = slots[0].scheduledDate;
      const lastDate = slots[slots.length - 1].scheduledDate;
      const events = await loadEventsInRange({ startDate: firstDate, endDate: lastDate, audience });
      const calendarBlock = await getCalendarContextForRange({ startDate: firstDate, endDate: lastDate, audience });
      const aiResult = await planMonth({
        audience,
        startDate: firstDate,
        endDate: lastDate,
        slots: slots.map(s => ({
          date: s.scheduledDate, slotInWeek: s.slotInWeek,
          layoutProfile: s.layoutProfile, imageStyle: s.imageStyle,
          subjectAngle: s.subjectAngle,
        })),
        calendarEvents: calendarBlock,
      });
      if (!aiResult.ok) {
        return { content: [{ type: "text", text: `AI error: ${aiResult.error}` }], isError: true };
      }
      const briefs = (aiResult.output as { briefs?: Array<Record<string, string>> }).briefs ?? [];
      const proposals = slots.map((s, i) => ({
        slotIndex: i,
        scheduledDate: s.scheduledDate,
        weekOf: s.weekOf,
        slotInWeek: s.slotInWeek,
        layoutVariants: s.layoutVariants,
        imageStyle: s.imageStyle,
        subjectAngle: s.subjectAngle,
        brief: briefs[i] ?? null,
      }));
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            audience, weeks, eventsConsidered: events.length, proposals,
            note: "Review with the user. To accept all → marketing.email.create_campaign per proposal (preserving layoutVariants + brief). Or direct user to /marketing/email/plan for bulk-create UI.",
          }, null, 2),
        }],
      };
    },
  },
  {
    name: "marketing.calendar.add_event",
    description:
      "Add a holiday, sale, launch, or promotion to the marketing calendar. Once added, any campaign generated for a date within ±14 days of this event will see it in the AI prompt. Use this when the user mentions an upcoming moment that should drive copy ('we're running 30% off readers Memorial Day weekend' → add a SALE event).",
    inputSchema: {
      type: "object",
      required: ["event_type", "date_start", "title"],
      properties: {
        event_type: { type: "string", enum: ["holiday", "sale", "launch", "promotion"] },
        date_start: { type: "string", description: "ISO date YYYY-MM-DD" },
        date_end: { type: "string", description: "ISO date YYYY-MM-DD. Defaults to date_start (single-day event)." },
        audience: { type: "string", enum: ["all", "retail", "wholesale"], description: "Who this event matters for. Default 'all'." },
        title: { type: "string", description: "Short specific title. 'Memorial Day' not 'long weekend'." },
        description: { type: "string", description: "1–3 sentences of context the AI should weigh." },
        product_skus: { type: "string", description: "Comma-separated SKU list (optional)." },
        link_url: { type: "string", description: "URL the campaign CTA might use." },
        priority: { type: "number", enum: [1, 2, 3], description: "1 = primary moment, 2 = secondary, 3 = background." },
        tag: { type: "string", description: "Optional tag for grouping (e.g. 'BFCM-2026')." },
      },
    },
    handler: async ({ input }) => {
      const { calendarEvents } = await import("../schema");
      const dateStart = input.date_start as string;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStart)) {
        return { content: [{ type: "text", text: "date_start must be YYYY-MM-DD" }], isError: true };
      }
      const dateEnd = (input.date_end as string) ?? dateStart;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateEnd)) {
        return { content: [{ type: "text", text: "date_end must be YYYY-MM-DD" }], isError: true };
      }
      const id = crypto.randomUUID();
      await db.insert(calendarEvents).values({
        id,
        eventType: input.event_type as "holiday" | "sale" | "launch" | "promotion",
        dateStart,
        dateEnd,
        audience: (input.audience as "all" | "retail" | "wholesale" | undefined) ?? "all",
        title: input.title as string,
        description: (input.description as string) ?? null,
        productSkus: (input.product_skus as string) ?? null,
        linkUrl: (input.link_url as string) ?? null,
        priority: (input.priority as number) ?? 2,
        tag: (input.tag as string) ?? null,
      });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ ok: true, id, message: `Added "${input.title}" to the calendar. Any campaign scheduled within ±14 days of ${dateStart} will now see this in its AI prompt.` }, null, 2),
        }],
      };
    },
  },
  {
    name: "marketing.email.push_omnisend",
    description:
      "Push a finished campaign into Omnisend: renders the email HTML, imports it as an Omnisend template, creates the Omnisend campaign (draft by default; schedule=true also schedules 9am PT on the campaign's send date). Requires OMNISEND_API_KEY to be configured — returns a clear error otherwise. Stores the Omnisend campaign id on the row.",
    inputSchema: {
      type: "object",
      required: ["campaign_id"],
      properties: {
        campaign_id: { type: "string", description: "the-frame campaign id" },
        schedule: { type: "boolean", description: "Also schedule the send (default false = draft in Omnisend)" },
      },
    },
    handler: async ({ input }) => {
      const { isOmnisendConfigured, importTemplate, createCampaign, sendCampaign } = await import("../lib/omnisend-client");
      const { renderEmailHtml } = await import("../lib/render-email");
      const { campaignRowToData } = await import("../lib/campaign-render-data");
      if (!isOmnisendConfigured()) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Omnisend not configured — set OMNISEND_API_KEY or the omnisend_api_key setting." }) }] };
      }
      const [row] = await db.select().from(emailCampaigns).where(eq(emailCampaigns.id, input.campaign_id as string)).limit(1);
      if (!row) return { content: [{ type: "text", text: JSON.stringify({ error: "Campaign not found" }) }] };
      if (!row.subject) return { content: [{ type: "text", text: JSON.stringify({ error: "Campaign has no subject — generate copy first." }) }] };
      const { imagesComplete } = await import("../lib/images-complete");
      if (!imagesComplete(row)) return { content: [{ type: "text", text: JSON.stringify({ error: "Campaign images aren't complete — upload hero/secondary images (or disable those sections) first." }) }] };
      const html = renderEmailHtml(campaignRowToData(row));
      const label = row.name || row.subject;
      const tpl = await importTemplate(`the-frame — ${label}`, html);
      if (!tpl.ok) return { content: [{ type: "text", text: JSON.stringify({ error: tpl.error }) }] };
      const scheduledAt = input.schedule && row.scheduledDate ? `${row.scheduledDate}T17:00:00Z` : null;
      const created = await createCampaign({ name: label, subject: row.subject, preheader: row.preheader, senderName: "Jaxy", templateID: tpl.data.templateID, scheduledAt });
      if (!created.ok) return { content: [{ type: "text", text: JSON.stringify({ error: created.error }) }] };
      let scheduled = false;
      if (scheduledAt) {
        const sent = await sendCampaign(created.data.campaignID);
        scheduled = sent.ok;
      }
      sqlite.prepare("UPDATE marketing_email_campaigns SET omnisend_campaign_id = ?, updated_at = datetime('now') WHERE id = ?").run(created.data.campaignID, row.id);
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, omnisendCampaignId: created.data.campaignID, scheduled }, null, 2) }] };
    },
  },
  {
    name: "marketing.email.record_send_results",
    description:
      "Record post-send performance (recipients/opens/clicks/notes) for a campaign, per platform (omnisend|faire). Auto-advances status sent/scheduled → analyzed. This is the learning-loop input that future planning reads.",
    inputSchema: {
      type: "object",
      required: ["campaign_id", "platform"],
      properties: {
        campaign_id: { type: "string" },
        platform: { type: "string", enum: ["omnisend", "faire"] },
        sent_at: { type: "string", description: "ISO date the send went out" },
        recipients: { type: "number" },
        opens: { type: "number" },
        clicks: { type: "number" },
        notes: { type: "string" },
      },
    },
    handler: async ({ input }) => {
      const [row] = await db.select({ id: emailCampaigns.id, status: emailCampaigns.status }).from(emailCampaigns).where(eq(emailCampaigns.id, input.campaign_id as string)).limit(1);
      if (!row) return { content: [{ type: "text", text: JSON.stringify({ error: "Campaign not found" }) }] };
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
      const rid = crypto.randomUUID();
      sqlite.prepare(
        `INSERT INTO marketing_email_send_results (id, campaign_id, platform, sent_at, recipients, opens, clicks, notes) VALUES (?,?,?,?,?,?,?,?)`,
      ).run(rid, row.id, input.platform as string, (input.sent_at as string) ?? null, num(input.recipients), num(input.opens), num(input.clicks), (input.notes as string)?.slice(0, 2000) ?? null);
      let statusAfter = row.status;
      if (row.status === "sent" || row.status === "scheduled") {
        sqlite.prepare("UPDATE marketing_email_campaigns SET status = 'analyzed' WHERE id = ?").run(row.id);
        statusAfter = "analyzed";
      }
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, resultId: rid, statusAfter }, null, 2) }] };
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

function nextMonday(): string {
  const d = new Date();
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + (day === 1 ? 7 : 8 - day));
  return d.toISOString().slice(0, 10);
}
