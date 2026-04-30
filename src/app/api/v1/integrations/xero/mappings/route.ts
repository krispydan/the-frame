export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { xeroAccountMappings, DEFAULT_PAYOUT_CATEGORIES } from "@/modules/integrations/schema/xero";
import { eq, and } from "drizzle-orm";

/**
 * GET /api/v1/integrations/xero/mappings?platform=shopify_dtc
 *
 * Returns the saved account mappings for the requested source platform,
 * with an entry per default category — empty (xeroAccountCode = null) for
 * any category the user hasn't mapped yet, so the UI can render a complete
 * grid without per-row null checks.
 *
 * Query:
 *   platform   required, e.g. "shopify_dtc", "shopify_wholesale", "faire"
 */
export async function GET(req: NextRequest) {
  const platform = req.nextUrl.searchParams.get("platform");
  if (!platform) {
    return NextResponse.json({ error: "platform query param required" }, { status: 400 });
  }

  const saved = await db
    .select()
    .from(xeroAccountMappings)
    .where(eq(xeroAccountMappings.sourcePlatform, platform));

  const byCategory = new Map(saved.map((m) => [m.category, m]));

  const mappings = DEFAULT_PAYOUT_CATEGORIES.map((category) => {
    const m = byCategory.get(category);
    return {
      category,
      xeroAccountCode: m?.xeroAccountCode ?? null,
      xeroAccountName: m?.xeroAccountName ?? null,
      notes: m?.notes ?? null,
      updatedAt: m?.updatedAt ?? null,
    };
  });

  return NextResponse.json({ platform, mappings });
}

/**
 * PUT /api/v1/integrations/xero/mappings
 *
 * Body:
 *   {
 *     platform: "shopify_dtc",
 *     mappings: [
 *       { category: "sales", xeroAccountCode: "4000", xeroAccountName: "Sales", notes? },
 *       ...
 *     ]
 *   }
 *
 * Upserts each mapping. Categories not in the body are left untouched.
 * To clear a mapping, send xeroAccountCode = null and we'll delete that row.
 */
export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const platform: string | undefined = body.platform;
  const mappings: Array<{
    category: string;
    xeroAccountCode: string | null;
    xeroAccountName?: string | null;
    notes?: string | null;
  }> | undefined = body.mappings;

  if (!platform) return NextResponse.json({ error: "platform required" }, { status: 400 });
  if (!Array.isArray(mappings)) return NextResponse.json({ error: "mappings array required" }, { status: 400 });

  let upserted = 0;
  let cleared = 0;

  for (const m of mappings) {
    if (!m.category) continue;

    if (!m.xeroAccountCode) {
      // Clear the mapping
      const result = await db
        .delete(xeroAccountMappings)
        .where(and(eq(xeroAccountMappings.sourcePlatform, platform), eq(xeroAccountMappings.category, m.category)));
      if ((result as { changes?: number }).changes ?? 0 > 0) cleared++;
      continue;
    }

    const now = new Date().toISOString();
    const [existing] = await db
      .select()
      .from(xeroAccountMappings)
      .where(and(eq(xeroAccountMappings.sourcePlatform, platform), eq(xeroAccountMappings.category, m.category)));

    if (existing) {
      await db
        .update(xeroAccountMappings)
        .set({
          xeroAccountCode: m.xeroAccountCode,
          xeroAccountName: m.xeroAccountName ?? null,
          notes: m.notes ?? null,
          updatedAt: now,
        })
        .where(eq(xeroAccountMappings.id, existing.id));
    } else {
      await db.insert(xeroAccountMappings).values({
        sourcePlatform: platform,
        category: m.category,
        xeroAccountCode: m.xeroAccountCode,
        xeroAccountName: m.xeroAccountName ?? null,
        notes: m.notes ?? null,
        createdAt: now,
        updatedAt: now,
      });
    }
    upserted++;
  }

  return NextResponse.json({ ok: true, upserted, cleared });
}
