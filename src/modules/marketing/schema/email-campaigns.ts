/**
 * Marketing Email Assistant schema.
 *
 * Separate from `marketing_content_calendar` (which conflates
 * blog/social/email under a single "content idea" row). Email
 * campaigns have a richer per-block template structure with
 * variant choices, AI-generated copy, designer images, and a
 * multi-stage workflow status — they earn their own tables.
 */

import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

const id = () => text("id").primaryKey().$defaultFn(() => crypto.randomUUID());
const timestamp = (name: string) => text(name).default(sql`(datetime('now'))`);

/**
 * One row per scheduled email. The audience (retail|wholesale) is
 * paired with a calendar slot (scheduledDate). Each block of the
 * template stores its variant choice + the content for that variant
 * + AI metadata so we can re-run the AI later without losing the
 * human edits.
 *
 * Status moves through the 10-stage workflow:
 *   idea → themed → copy_pending → copy_review →
 *   image_pending → image_review → preview_ready →
 *   exported → sent → analyzed
 */
export const emailCampaigns = sqliteTable("marketing_email_campaigns", {
  id: id(),

  // Planning
  /** Human-readable name for the campaign (separate from `subject` —
   *  the latter is the inbox subject line, this is the operator's
   *  internal label for finding it in lists). */
  name: text("name"),
  audience: text("audience", { enum: ["retail", "wholesale"] }).notNull(),
  scheduledDate: text("scheduled_date").notNull(),          // ISO date (YYYY-MM-DD)
  weekOf: text("week_of"),                                   // Monday ISO date, for calendar grouping
  /**
   * Kanban-style status. Renamed 2026-06-23 from the verbose
   * idea/themed/copy_pending… enum to a flatter 7-stage model
   * that matches how Daniel thinks about the workflow.
   *
   * Legacy values still appear in old data; the status-display
   * helper normalizes them on read.
   */
  status: text("status", {
    enum: [
      "draft",            // brief filled, nothing else
      "copywriting",      // copy AI is working / human refining
      "photography",      // designer briefing / rendering
      "design_review",    // full preview being reviewed
      "scheduled",        // queued for send
      "sent",
      "analyzed",
    ],
  }).notNull().default("draft"),
  themeId: text("theme_id"),                                 // → marketing_email_themes.id

  // ── Brief (the AI prompt/idea — Daniel: "before you run the AI
  // generation, we should give it a prompt/idea for the campaign.
  // this should be core to generating the email content.") ──
  // These four fields are the editable surface in the campaign
  // editor that drives the generate-copy + generate-image-prompts
  // calls. Pre-filled by plan_week + build_campaign_from_idea;
  // the user can refine before/after each generation.
  briefTitle: text("brief_title"),                           // "Sara's Main Character moment"
  briefAngle: text("brief_angle"),                            // 1-2 sentences — why this email, why now
  briefProductHook: text("brief_product_hook"),               // SKU / category / colorway
  briefSeasonalContext: text("brief_seasonal_context"),       // holiday / weather / cultural anchor

  /** Per-campaign logo override (e.g. for co-branded campaigns).
   *  When null, the default brand logo (/public/brand/jaxy-logo-black.svg)
   *  is used by the renderer. */
  logoImagePath: text("logo_image_path"),

  /** Per-section visibility toggles. When TRUE the renderer skips
   *  that block entirely — used when a campaign doesn't need a
   *  secondary image, or wants a single-section announcement, etc.
   *  Default false (= all sections rendered). */
  heroDisabled: integer("hero_disabled", { mode: "boolean" }).default(false),
  sectionADisabled: integer("section_a_disabled", { mode: "boolean" }).default(false),
  secondaryDisabled: integer("secondary_disabled", { mode: "boolean" }).default(false),
  sectionBDisabled: integer("section_b_disabled", { mode: "boolean" }).default(false),

  // Subject + preheader (inbox metadata, separate from in-email content)
  subject: text("subject"),
  preheader: text("preheader"),
  /** Alternative subject/preheader testing a DIFFERENT angle — for
   *  A/B subject testing (Daniel: "test subject angles"). AI proposes
   *  both; the operator can swap the alt into primary before export. */
  subjectAlt: text("subject_alt"),
  preheaderAlt: text("preheader_alt"),

  // ── Variant choice per block ──
  // Each block has 1+ variants; renderer dispatches based on these.
  // New variants drop in as additional enum values + a new component file.
  heroVariant: text("hero_variant", {
    enum: ["full_bleed_overlay", "image_75_solid", "split_50_50"],
  }).notNull().default("full_bleed_overlay"),
  sectionAVariant: text("section_a_variant", {
    enum: ["centered", "with_pullquote"],
  }).notNull().default("centered"),
  secondaryImageVariant: text("secondary_image_variant", {
    enum: ["full_bleed", "centered_75", "grid_2up"],
  }).notNull().default("full_bleed"),
  sectionBVariant: text("section_b_variant", {
    enum: ["centered_with_cta", "two_column_with_cta"],
  }).notNull().default("centered_with_cta"),

  // ── Hero block content ──
  heroHeadline: text("hero_headline"),
  heroSubtitle: text("hero_subtitle"),
  heroCtaLabel: text("hero_cta_label"),
  heroCtaUrl: text("hero_cta_url"),
  /**
   * Scrim is only meaningful for heroVariant=full_bleed_overlay.
   * Other variants ignore it; the field stays for forward-compat.
   */
  heroScrim: text("hero_scrim", { enum: ["dark", "light", "none"] }).default("dark"),
  heroImagePath: text("hero_image_path"),                    // /data/images/email/{id}/hero.jpg
  heroImageAlt: text("hero_image_alt"),
  heroImagePrompt: text("hero_image_prompt"),                // Higgsfield brief

  // ── Text section A ──
  sectionAHeading: text("section_a_heading"),
  sectionABody: text("section_a_body"),

  // ── Secondary image block ──
  secondaryImagePath: text("secondary_image_path"),
  /** Second image — only populated when secondaryImageVariant=grid_2up. */
  secondaryImagePath2: text("secondary_image_path_2"),
  secondaryImageAlt: text("secondary_image_alt"),
  secondaryImageAlt2: text("secondary_image_alt_2"),
  secondaryImagePrompt: text("secondary_image_prompt"),
  secondaryImagePrompt2: text("secondary_image_prompt_2"),

  // ── Text section B (with CTA) ──
  sectionBHeading: text("section_b_heading"),
  sectionBBody: text("section_b_body"),
  sectionBCtaLabel: text("section_b_cta_label"),
  sectionBCtaUrl: text("section_b_cta_url"),

  // ── Tracking + designer + AI metadata ──
  utmCampaign: text("utm_campaign"),                         // e.g. 2026-w26-retail
  designerNotes: text("designer_notes"),
  aiCopyPromptVersion: text("ai_copy_prompt_version"),       // prompt template version used
  aiCopyRawJson: text("ai_copy_raw_json"),                   // last Claude response, full
  aiImagePromptRawJson: text("ai_image_prompt_raw_json"),    // last image-prompt response
  exportedHtmlPath: text("exported_html_path"),              // post-export, where the file lives

  // Timestamps
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
}, (table) => ({
  statusIdx: index("idx_email_campaigns_status").on(table.status),
  scheduledIdx: index("idx_email_campaigns_scheduled").on(table.scheduledDate),
  audienceIdx: index("idx_email_campaigns_audience").on(table.audience),
  themeIdx: index("idx_email_campaigns_theme").on(table.themeId),
}));

/**
 * A theme = a weekly content angle (e.g. "Late-summer linen", "First
 * cool morning"). One theme can seed multiple campaigns if we run
 * the same idea across both audiences. AI generates a batch per
 * call (4-8 weeks at a time); user picks.
 */
export const emailThemes = sqliteTable("marketing_email_themes", {
  id: id(),
  weekOf: text("week_of").notNull(),                         // Monday ISO date
  audience: text("audience", { enum: ["retail", "wholesale"] }).notNull(),
  title: text("title").notNull(),                            // "Late-summer linen"
  angle: text("angle"),                                       // why now, who it's for
  productHook: text("product_hook"),                          // SKU family or category
  seasonalContext: text("seasonal_context"),                  // holiday / weather / cultural anchor
  rawJson: text("raw_json"),                                  // raw Claude output for debugging
  createdAt: timestamp("created_at"),
}, (table) => ({
  weekOfIdx: index("idx_email_themes_week").on(table.weekOf),
  audienceIdx: index("idx_email_themes_audience").on(table.audience),
}));

/**
 * Send-result capture. v1 = manual entry form so Daniel can paste
 * what Omnisend/Faire report. v2 = pulled via API.
 */
export const emailSendResults = sqliteTable("marketing_email_send_results", {
  id: id(),
  campaignId: text("campaign_id").notNull(),
  platform: text("platform", { enum: ["omnisend", "faire"] }).notNull(),
  sentAt: text("sent_at"),
  recipients: integer("recipients"),
  opens: integer("opens"),
  clicks: integer("clicks"),
  notes: text("notes"),
  createdAt: timestamp("created_at"),
}, (table) => ({
  campaignIdx: index("idx_email_send_results_campaign").on(table.campaignId),
}));
