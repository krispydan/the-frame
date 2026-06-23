export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { db, sqlite } from "@/lib/db";
import { emailCampaigns, emailThemes } from "@/modules/marketing/schema";
import { eq } from "drizzle-orm";
import { generateCopy } from "@/modules/marketing/lib/email-ai";
import { lintGeneratedCopy } from "@/modules/marketing/lib/copy-quality";

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

  // Brief resolution order (Daniel: "the prompt/idea should be core
  // to generating the email content"):
  //   1. Body override (caller passes briefTitle/briefAngle/...)
  //   2. Campaign's brief_* columns (the editable surface)
  //   3. Linked theme row (legacy fallback)
  //   4. "(unspecified)" — generation still proceeds but warns
  let body: {
    briefTitle?: string;
    briefAngle?: string;
    briefProductHook?: string;
    briefSeasonalContext?: string;
  } = {};
  try { body = await req.json(); } catch { /* empty body fine */ }

  let briefTitle = body.briefTitle ?? campaign.briefTitle ?? undefined;
  let briefAngle = body.briefAngle ?? campaign.briefAngle ?? undefined;
  let productHook = body.briefProductHook ?? campaign.briefProductHook ?? null;
  let seasonalContext = body.briefSeasonalContext ?? campaign.briefSeasonalContext ?? null;

  // Fallback to linked theme if brief is empty (covers older campaigns
  // created before the brief columns existed).
  if ((!briefTitle || !briefAngle) && campaign.themeId) {
    const [theme] = await db
      .select()
      .from(emailThemes)
      .where(eq(emailThemes.id, campaign.themeId))
      .limit(1);
    if (theme) {
      briefTitle = briefTitle ?? theme.title;
      briefAngle = briefAngle ?? theme.angle ?? "";
      productHook = productHook ?? theme.productHook;
      seasonalContext = seasonalContext ?? theme.seasonalContext;
    }
  }

  briefTitle = briefTitle ?? "(unspecified — add a brief in the editor)";
  briefAngle = briefAngle ?? "(unspecified)";

  // Persist whatever was effective so the editor reflects what
  // the generator ran with (in case caller passed body overrides).
  sqlite
    .prepare(
      `UPDATE marketing_email_campaigns
        SET brief_title = COALESCE(NULLIF(brief_title,''), ?),
            brief_angle = COALESCE(NULLIF(brief_angle,''), ?),
            brief_product_hook = COALESCE(NULLIF(brief_product_hook,''), ?),
            brief_seasonal_context = COALESCE(NULLIF(brief_seasonal_context,''), ?)
        WHERE id = ?`,
    )
    .run(briefTitle, briefAngle, productHook, seasonalContext, id);

  const result = await generateCopy({
    audience: campaign.audience as "retail" | "wholesale",
    scheduledDate: campaign.scheduledDate,
    heroVariant: campaign.heroVariant,
    themeTitle: briefTitle,
    themeAngle: briefAngle,
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

  // Deterministic, server-side QA — the source of truth (the model's
  // selfCheck above is advisory). Surfaced to the editor as hard errors
  // / warnings.
  const lint = lintGeneratedCopy(out as Record<string, unknown>, campaign.audience as "retail" | "wholesale");

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
    lint,
    usage: result.usage,
  });
}
