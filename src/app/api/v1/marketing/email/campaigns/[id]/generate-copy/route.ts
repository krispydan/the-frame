export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { db, sqlite } from "@/lib/db";
import { emailCampaigns, emailThemes } from "@/modules/marketing/schema";
import { eq } from "drizzle-orm";
import { generateCopy } from "@/modules/marketing/lib/email-ai";

/**
 * POST /api/v1/marketing/email/campaigns/[id]/generate-copy
 *
 * Body (all optional — defaults pulled from the campaign row):
 *   themeTitle, themeAngle, productHook, seasonalContext
 *
 * Calls Claude using the v5 copy-generation prompt. Writes the
 * returned fields onto the campaign row (subject, preheader, hero
 * + section A + section B fields, CTA suggestions). Persists the
 * raw JSON to aiCopyRawJson for debugging.
 *
 * Returns the generated copy + the self-check warnings (any failed
 * checks the UI should surface).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const [campaign] = await db
    .select()
    .from(emailCampaigns)
    .where(eq(emailCampaigns.id, id))
    .limit(1);
  if (!campaign) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }

  // Allow overrides from body but default to the campaign's theme.
  let body: {
    themeTitle?: string;
    themeAngle?: string;
    productHook?: string;
    seasonalContext?: string;
  } = {};
  try { body = await req.json(); } catch { /* empty body fine */ }

  // If campaign has a theme_id and the body didn't override, look up
  // the theme row.
  let themeTitle = body.themeTitle;
  let themeAngle = body.themeAngle;
  let productHook = body.productHook ?? null;
  let seasonalContext = body.seasonalContext ?? null;

  if ((!themeTitle || !themeAngle) && campaign.themeId) {
    const [theme] = await db
      .select()
      .from(emailThemes)
      .where(eq(emailThemes.id, campaign.themeId))
      .limit(1);
    if (theme) {
      themeTitle = themeTitle ?? theme.title;
      themeAngle = themeAngle ?? theme.angle ?? "";
      productHook = productHook ?? theme.productHook;
      seasonalContext = seasonalContext ?? theme.seasonalContext;
    }
  }

  // Last-resort defaults — let the user generate even without a theme.
  themeTitle = themeTitle ?? "(unspecified)";
  themeAngle = themeAngle ?? "(unspecified)";

  const result = await generateCopy({
    audience: campaign.audience as "retail" | "wholesale",
    scheduledDate: campaign.scheduledDate,
    heroVariant: campaign.heroVariant,
    themeTitle,
    themeAngle,
    productHook,
    seasonalContext,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 502 });
  }

  const out = result.output as Record<string, string | Record<string, boolean>>;

  // Persist to the campaign row + record the raw JSON for replay.
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
    out.subject as string,
    out.preheader as string,
    out.heroHeadline as string,
    out.heroSubtitle as string,
    out.heroCtaLabel as string,
    out.heroCtaUrlSuggestion as string,
    out.sectionAHeading as string,
    out.sectionABody as string,
    out.sectionBHeading as string,
    out.sectionBBody as string,
    out.sectionBCtaLabel as string,
    out.sectionBCtaUrlSuggestion as string,
    JSON.stringify(out),
    id,
  );

  const selfChecks = (out.selfCheckPassed ?? {}) as Record<string, boolean>;
  const failedChecks = Object.entries(selfChecks)
    .filter(([, v]) => v === false)
    .map(([k]) => k);

  const [updated] = await db
    .select()
    .from(emailCampaigns)
    .where(eq(emailCampaigns.id, id))
    .limit(1);

  return NextResponse.json({
    ok: true,
    campaign: updated,
    generated: out,
    failedChecks,
    usage: result.usage,
  });
}
