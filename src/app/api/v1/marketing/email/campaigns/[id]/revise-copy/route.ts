export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { emailCampaigns } from "@/modules/marketing/schema";
import { eq } from "drizzle-orm";
import { reviseCopy } from "@/modules/marketing/lib/email-ai";
import { getCalendarContextForCampaign } from "@/modules/marketing/lib/calendar-context";
import { persistGeneratedCopy } from "@/modules/marketing/lib/copy-persist";
import { resolveProducts, formatProductsForPrompt } from "@/modules/marketing/lib/product-selector";
import { parseFeaturedIds } from "@/modules/marketing/lib/featured-products";

/**
 * POST /api/v1/marketing/email/campaigns/[id]/revise-copy
 *
 * Body: { feedback: string }  — natural-language ask to improve the
 * whole email. Re-reads the campaign's CURRENT copy + brief + calendar
 * + featured products, sends it all to the model with the feedback, and
 * persists the revised copy (snapshotting the prior version first, so
 * it's undoable from Copy history). Returns the same shape as
 * generate-copy so the editor can reuse its handling.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    return await handle(req, await params);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[revise-copy] unhandled:", e);
    return NextResponse.json({ error: `Server error: ${message}` }, { status: 500 });
  }
}

async function handle(req: NextRequest, params: { id: string }) {
  const { id } = params;

  let body: { feedback?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  }
  const feedback = typeof body.feedback === "string" ? body.feedback.trim() : "";
  if (!feedback) {
    return NextResponse.json({ error: "feedback required" }, { status: 400 });
  }

  const [campaign] = await db
    .select()
    .from(emailCampaigns)
    .where(eq(emailCampaigns.id, id))
    .limit(1);
  if (!campaign) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }

  const calendarEvents = await getCalendarContextForCampaign({
    scheduledDate: campaign.scheduledDate,
    audience: campaign.audience as "retail" | "wholesale",
  });

  const featuredProducts = await resolveProducts(
    parseFeaturedIds(campaign.featuredProductIds as string | null),
  );
  const featuredProductsText = formatProductsForPrompt(featuredProducts);
  const productImages = featuredProducts
    .filter((p) => p.imageUrl)
    .map((p) => ({ url: p.imageUrl as string }));

  const result = await reviseCopy({
    audience: campaign.audience as "retail" | "wholesale",
    scheduledDate: campaign.scheduledDate,
    brief: { title: campaign.briefTitle ?? campaign.name, angle: campaign.briefAngle },
    current: campaign as unknown as Record<string, unknown>,
    feedback,
    calendarEvents,
    featuredProductsText,
    productImages,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 502 });
  }

  const out = result.output as Record<string, unknown>;
  const { updated, failedChecks, lint } = await persistGeneratedCopy(
    id,
    campaign as unknown as Record<string, unknown>,
    out,
    "pre_revise",
  );

  return NextResponse.json({
    ok: true,
    campaign: updated,
    generated: out,
    failedChecks,
    lint,
    usage: result.usage,
  });
}
