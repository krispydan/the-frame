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
 *
 * Query param:
 *   slot=hero|secondary   (optional) — regenerate ONLY that slot,
 *                         leaving the other one untouched. Omitted =
 *                         regenerate both (the original behaviour).
 *                         The model still sees the whole email each
 *                         time (so hero + secondary stay coherent);
 *                         we just persist the requested slot.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    return await handle(req, await params);
  } catch (e) {
    // Defense in depth — if anything throws (DB failure, JSON parse,
    // anything), the client always gets a structured JSON body
    // instead of Next's default 500 HTML page (which made the
    // client's res.json() crash with "Unexpected end of JSON input").
    const message = e instanceof Error ? e.message : String(e);
    console.error("[generate-image-prompts] unhandled:", e);
    return NextResponse.json({ error: `Server error: ${message}` }, { status: 500 });
  }
}

async function handle(req: NextRequest, params: { id: string }) {
  const { id } = params;

  const slotParam = req.nextUrl.searchParams.get("slot");
  const slot: "hero" | "secondary" | null =
    slotParam === "hero" || slotParam === "secondary" ? slotParam : null;

  const [campaign] = await db
    .select()
    .from(emailCampaigns)
    .where(eq(emailCampaigns.id, id))
    .limit(1);
  if (!campaign) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }

  // Brief resolution: campaign's own brief_* fields are primary,
  // theme row is the fallback for older campaigns.
  let themeTitle = campaign.briefTitle ?? "(no brief)";
  let themeAngle = campaign.briefAngle ?? "(no angle)";
  if ((!campaign.briefTitle || !campaign.briefAngle) && campaign.themeId) {
    const [theme] = await db
      .select()
      .from(emailThemes)
      .where(eq(emailThemes.id, campaign.themeId))
      .limit(1);
    if (theme) {
      if (!campaign.briefTitle) themeTitle = theme.title;
      if (!campaign.briefAngle) themeAngle = theme.angle ?? "(no angle)";
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

  // The stored raw JSON always reflects BOTH slots so the editor /
  // designer queue render consistently. When regenerating a single
  // slot we splice the fresh slot into the previously-stored object
  // rather than overwriting the other slot with this call's output.
  let storedRaw: typeof out = out;
  if (slot) {
    let prev: Partial<typeof out> = {};
    try {
      prev = campaign.aiImagePromptRawJson
        ? (JSON.parse(campaign.aiImagePromptRawJson) as Partial<typeof out>)
        : {};
    } catch {
      prev = {};
    }
    storedRaw = {
      hero: slot === "hero" ? out.hero : prev.hero ?? out.hero,
      secondary: slot === "secondary" ? out.secondary : prev.secondary ?? out.secondary,
    };
  }

  // Persist prompts + alt suggestions + scrim recommendation.
  // For grid_2up we also stash prompts[1] / alts[1] into the
  // secondary_image_*_2 columns; other variants only use [0].
  // A `slot` request only touches that slot's columns.
  if (slot === "hero") {
    sqlite.prepare(
      `UPDATE marketing_email_campaigns SET
         hero_image_prompt = ?,
         hero_image_alt = COALESCE(NULLIF(hero_image_alt, ''), ?),
         hero_scrim = COALESCE(?, hero_scrim),
         ai_image_prompt_raw_json = ?,
         status = CASE WHEN status IN ('draft','copywriting') THEN 'photography' ELSE status END,
         updated_at = datetime('now')
       WHERE id = ?`,
    ).run(
      out.hero.prompt,
      out.hero.alt,
      out.hero.recommendedScrim,
      JSON.stringify(storedRaw),
      id,
    );
  } else if (slot === "secondary") {
    sqlite.prepare(
      `UPDATE marketing_email_campaigns SET
         secondary_image_prompt = ?,
         secondary_image_alt = COALESCE(NULLIF(secondary_image_alt, ''), ?),
         secondary_image_prompt_2 = ?,
         secondary_image_alt_2 = COALESCE(NULLIF(secondary_image_alt_2, ''), ?),
         ai_image_prompt_raw_json = ?,
         status = CASE WHEN status IN ('draft','copywriting') THEN 'photography' ELSE status END,
         updated_at = datetime('now')
       WHERE id = ?`,
    ).run(
      out.secondary.prompts[0] ?? "",
      out.secondary.alts[0] ?? "",
      out.secondary.prompts[1] ?? null,
      out.secondary.alts[1] ?? null,
      JSON.stringify(storedRaw),
      id,
    );
  } else {
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
         status = CASE WHEN status IN ('draft','copywriting') THEN 'photography' ELSE status END,
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
      JSON.stringify(storedRaw),
      id,
    );
  }

  const [updated] = await db
    .select()
    .from(emailCampaigns)
    .where(eq(emailCampaigns.id, id))
    .limit(1);

  return NextResponse.json({
    ok: true,
    slot: slot ?? "both",
    campaign: updated,
    generated: out,
    usage: result.usage,
  });
}
