export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { db, sqlite } from "@/lib/db";
import { emailCampaigns, emailThemes } from "@/modules/marketing/schema";
import { eq, and, ne, desc } from "drizzle-orm";
import { generateCopy } from "@/modules/marketing/lib/email-ai";
import { getCalendarContextForCampaign } from "@/modules/marketing/lib/calendar-context";
import { lintGeneratedCopy } from "@/modules/marketing/lib/copy-quality";
import { snapshotCopy } from "@/modules/marketing/lib/copy-versions";

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
  try {
    return await handle(req, await params);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[generate-copy] unhandled:", e);
    return NextResponse.json({ error: `Server error: ${message}` }, { status: 500 });
  }
}

async function handle(req: NextRequest, params: { id: string }) {
  const { id } = params;

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
  //   4. "(unspecified)" — generation still proceeds but the AI is
  //      told to propose a name in the output
  let body: {
    name?: string;
    briefAngle?: string;
    briefProductHook?: string;
    briefSeasonalContext?: string;
  } = {};
  try { body = await req.json(); } catch { /* empty body fine */ }

  // Campaign NAME is now the brief title (Daniel: "we don't need a
  // campaign name and a campaign title — they are the same"). If
  // empty, the AI is asked to propose one.
  let briefTitle = body.name ?? campaign.name ?? undefined;
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

  const nameWasEmpty = !briefTitle;
  briefTitle = briefTitle ?? "(unspecified — please propose a campaign name)";
  briefAngle = briefAngle ?? "(unspecified)";

  // Persist whatever was effective so the editor reflects what
  // the generator ran with (in case caller passed body overrides).
  // The name is filled later from the AI response if it was empty.
  sqlite
    .prepare(
      `UPDATE marketing_email_campaigns
        SET brief_angle = COALESCE(NULLIF(brief_angle,''), ?),
            brief_product_hook = COALESCE(NULLIF(brief_product_hook,''), ?),
            brief_seasonal_context = COALESCE(NULLIF(brief_seasonal_context,''), ?)
        WHERE id = ?`,
    )
    .run(briefAngle, productHook, seasonalContext, id);

  // Pull calendar events in the ±14-day window so the AI knows what
  // holiday / sale / launch / promo to lean into for this send date.
  const calendarEvents = await getCalendarContextForCampaign({
    scheduledDate: campaign.scheduledDate,
    audience: campaign.audience as "retail" | "wholesale",
  });

  // Recent emails for this audience (excluding this campaign) so the
  // prompt's anti-sameness guidance has real data — otherwise every
  // single-campaign generation is blind to what shipped recently.
  const recentEmails = await db
    .select({ subject: emailCampaigns.subject, heroHeadline: emailCampaigns.heroHeadline })
    .from(emailCampaigns)
    .where(and(eq(emailCampaigns.audience, campaign.audience as "retail" | "wholesale"), ne(emailCampaigns.id, id)))
    .orderBy(desc(emailCampaigns.scheduledDate))
    .limit(5);

  const result = await generateCopy({
    audience: campaign.audience as "retail" | "wholesale",
    scheduledDate: campaign.scheduledDate,
    heroVariant: campaign.heroVariant,
    themeTitle: briefTitle,
    themeAngle: briefAngle,
    productHook,
    seasonalContext,
    calendarEvents,
    recentEmails: recentEmails.filter((r) => r.subject || r.heroHeadline),
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 502 });
  }

  const out = result.output as Record<string, string | Record<string, boolean>>;

  // Snapshot the existing copy BEFORE we overwrite it, so a worse
  // regenerate is non-destructive (the operator can restore the prior
  // version). No-op when the campaign had no copy yet.
  try {
    snapshotCopy(campaign as unknown as Record<string, unknown>, "pre_generate");
  } catch (e) {
    console.warn("[generate-copy] snapshot failed (non-fatal):", e);
  }

  // Persist to the campaign row + record the raw JSON for replay.
  // `name` uses COALESCE-on-empty so a user-provided name isn't
  // overwritten; only fills in when name was blank pre-generation.
  sqlite.prepare(
    `UPDATE marketing_email_campaigns SET
       name = CASE WHEN COALESCE(NULLIF(name, ''), NULL) IS NULL THEN ? ELSE name END,
       brief_title = CASE WHEN COALESCE(NULLIF(brief_title, ''), NULL) IS NULL THEN ? ELSE brief_title END,
       subject = ?, preheader = ?,
       subject_alt = ?, preheader_alt = ?,
       hero_headline = ?, hero_subtitle = ?,
       hero_cta_label = ?, hero_cta_url = COALESCE(NULLIF(hero_cta_url, ''), ?),
       section_a_heading = ?, section_a_body = ?,
       section_b_heading = ?, section_b_body = ?,
       section_b_cta_label = ?, section_b_cta_url = COALESCE(NULLIF(section_b_cta_url, ''), ?),
       ai_copy_prompt_version = 'v5',
       ai_copy_raw_json = ?,
       status = CASE WHEN status IN ('draft','copywriting') THEN 'copywriting' ELSE status END,
       updated_at = datetime('now')
     WHERE id = ?`,
  ).run(
    out.proposedName as string,
    out.proposedName as string,
    out.subject as string,
    out.preheader as string,
    (out.subjectAlt as string) ?? null,
    (out.preheaderAlt as string) ?? null,
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

  // nameWasEmpty signals to the client that the name was AI-proposed
  // (UI can show a subtle "AI named this" hint or auto-focus the field).
  void nameWasEmpty;

  const selfChecks = (out.selfCheckPassed ?? {}) as Record<string, boolean>;
  const failedChecks = Object.entries(selfChecks)
    .filter(([, v]) => v === false)
    .map(([k]) => k);

  // Deterministic, server-side QA — the source of truth (the model's
  // selfCheck above is advisory). Char/word limits, banned brand
  // phrases, emoji, exclamation count, preheader≠subject, pronoun
  // ratio, wholesale-number, CTA case/URL. Surfaced in the editor.
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
