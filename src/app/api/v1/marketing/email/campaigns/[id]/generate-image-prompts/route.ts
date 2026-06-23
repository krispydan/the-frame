export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { db, sqlite } from "@/lib/db";
import { emailCampaigns, emailThemes } from "@/modules/marketing/schema";
import { eq } from "drizzle-orm";
import { generateImagePrompts } from "@/modules/marketing/lib/email-ai";

/**
 * POST /api/v1/marketing/email/campaigns/[id]/generate-image-prompts
 *
 * Generates Higgsfield-ready briefs for the hero + secondary images
 * based on the campaign's chosen variants + current copy + theme.
 *
 * Persists prompts + recommended scrim onto the campaign row. The
 * designer queue (Phase 4) reads these and presents them in the
 * upload UI.
 */
export async function POST(
  _req: NextRequest,
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

  let themeTitle = "(no theme)";
  let themeAngle = "(no theme)";
  if (campaign.themeId) {
    const [theme] = await db
      .select()
      .from(emailThemes)
      .where(eq(emailThemes.id, campaign.themeId))
      .limit(1);
    if (theme) {
      themeTitle = theme.title;
      themeAngle = theme.angle ?? "(no angle)";
    }
  }

  const result = await generateImagePrompts({
    audience: campaign.audience as "retail" | "wholesale",
    heroVariant: campaign.heroVariant,
    secondaryImageVariant: campaign.secondaryImageVariant,
    themeTitle,
    themeAngle,
    heroHeadline: campaign.heroHeadline,
    heroSubtitle: campaign.heroSubtitle,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 502 });
  }

  const out = result.output as {
    hero: {
      prompt: string;
      alt: string;
      recommendedScrim: "dark" | "light" | "none" | null;
      dimensions: string;
      notes: string;
    };
    secondary: {
      prompts: string[];
      alts: string[];
      dimensions: string;
      notes: string;
    };
  };

  // Persist prompts + alt suggestions + scrim recommendation.
  // For grid_2up we also stash prompts[1] / alts[1] into the
  // secondary_image_*_2 columns; other variants only use [0].
  sqlite.prepare(
    `UPDATE marketing_email_campaigns SET
       hero_image_prompt = ?,
       hero_image_alt = COALESCE(NULLIF(hero_image_alt, ''), ?),
       hero_scrim = COALESCE(?, hero_scrim),
       secondary_image_prompt = ?,
       secondary_image_alt = COALESCE(NULLIF(secondary_image_alt, ''), ?),
       secondary_image_prompt_2 = ?,
       secondary_image_alt_2 = COALESCE(NULLIF(secondary_image_alt_2, ''), ?),
       ai_image_prompt_raw_json = ?,
       status = CASE WHEN status IN ('idea','themed','copy_pending','copy_review') THEN 'image_pending' ELSE status END,
       updated_at = datetime('now')
     WHERE id = ?`,
  ).run(
    out.hero.prompt,
    out.hero.alt,
    out.hero.recommendedScrim,
    out.secondary.prompts[0] ?? "",
    out.secondary.alts[0] ?? "",
    out.secondary.prompts[1] ?? null,
    out.secondary.alts[1] ?? null,
    JSON.stringify(out),
    id,
  );

  const [updated] = await db
    .select()
    .from(emailCampaigns)
    .where(eq(emailCampaigns.id, id))
    .limit(1);

  return NextResponse.json({
    ok: true,
    campaign: updated,
    generated: out,
    usage: result.usage,
  });
}
