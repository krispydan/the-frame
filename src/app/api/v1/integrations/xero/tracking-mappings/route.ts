export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { xeroTrackingMappings } from "@/modules/integrations/schema/xero";
import { eq } from "drizzle-orm";

const PLATFORMS = [
  "shopify_dtc",
  "shopify_afterpay",
  "shopify_wholesale",
  "faire",
  "amazon",
  "tiktok_shop",
] as const;
type Platform = (typeof PLATFORMS)[number];

/**
 * GET /api/v1/integrations/xero/tracking-mappings
 *
 * Returns the saved tracking-option mappings for every supported source
 * platform, with null fields for platforms that haven't been mapped yet so
 * the UI can render a complete grid.
 */
export async function GET() {
  const saved = await db.select().from(xeroTrackingMappings);
  const byPlatform = new Map(saved.map((m) => [m.sourcePlatform, m]));

  const mappings = PLATFORMS.map((platform) => {
    const m = byPlatform.get(platform);
    return {
      platform,
      trackingCategoryId: m?.trackingCategoryId ?? null,
      trackingCategoryName: m?.trackingCategoryName ?? null,
      trackingOptionId: m?.trackingOptionId ?? null,
      trackingOptionName: m?.trackingOptionName ?? null,
      updatedAt: m?.updatedAt ?? null,
    };
  });

  return NextResponse.json({ mappings });
}

/**
 * PUT /api/v1/integrations/xero/tracking-mappings
 *
 * Body:
 *   {
 *     mappings: [
 *       {
 *         platform: "shopify_dtc",
 *         trackingCategoryId: "abc-123",
 *         trackingCategoryName: "Sales Channel",
 *         trackingOptionId: "def-456",
 *         trackingOptionName: "Shopify - Retail"
 *       }, ...
 *     ]
 *   }
 *
 * Upserts each platform's mapping. To clear a mapping, send
 * trackingOptionId = null and the row gets deleted.
 */
export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const mappings: Array<{
    platform: string;
    trackingCategoryId?: string | null;
    trackingCategoryName?: string | null;
    trackingOptionId?: string | null;
    trackingOptionName?: string | null;
  }> | undefined = body.mappings;

  if (!Array.isArray(mappings)) {
    return NextResponse.json({ error: "mappings array required" }, { status: 400 });
  }

  let upserted = 0;
  let cleared = 0;

  for (const m of mappings) {
    const platform = m.platform as Platform;
    if (!PLATFORMS.includes(platform)) continue;

    if (!m.trackingOptionId || !m.trackingCategoryId) {
      const result = await db
        .delete(xeroTrackingMappings)
        .where(eq(xeroTrackingMappings.sourcePlatform, platform));
      if ((result as { changes?: number }).changes ?? 0 > 0) cleared++;
      continue;
    }

    const now = new Date().toISOString();
    const [existing] = await db
      .select()
      .from(xeroTrackingMappings)
      .where(eq(xeroTrackingMappings.sourcePlatform, platform));

    if (existing) {
      await db.update(xeroTrackingMappings).set({
        trackingCategoryId: m.trackingCategoryId,
        trackingCategoryName: m.trackingCategoryName ?? null,
        trackingOptionId: m.trackingOptionId,
        trackingOptionName: m.trackingOptionName ?? null,
        updatedAt: now,
      }).where(eq(xeroTrackingMappings.id, existing.id));
    } else {
      await db.insert(xeroTrackingMappings).values({
        sourcePlatform: platform,
        trackingCategoryId: m.trackingCategoryId,
        trackingCategoryName: m.trackingCategoryName ?? null,
        trackingOptionId: m.trackingOptionId,
        trackingOptionName: m.trackingOptionName ?? null,
        createdAt: now,
        updatedAt: now,
      });
    }
    upserted++;
  }

  return NextResponse.json({ ok: true, upserted, cleared });
}
