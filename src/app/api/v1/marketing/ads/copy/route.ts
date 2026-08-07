/**
 * Ad copy variants.
 *
 * GET  — list all variants (+ per-variant usage count so you can see
 *        which copy is actually running).
 * POST — create one: {primaryText, headline?, description?, notes?}
 *        manually, or {generate: true, count?, productName?, direction?}
 *        for AI variants (distinct angles, brand voice from the prompt
 *        store). Codes are assigned sequentially and never reused.
 */
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { insertCopyVariant, generateAdCopy } from "@/modules/marketing/lib/ads/ad-copy";

export async function GET() {
  const variants = sqlite.prepare(`
    SELECT c.code, c.primary_text AS primaryText, c.headline, c.description, c.notes, c.created_at AS createdAt,
           (SELECT COUNT(*) FROM marketing_ads a WHERE a.copy_variant = c.code) AS usedBy
    FROM marketing_ad_copy c ORDER BY c.code
  `).all();
  return NextResponse.json({ variants });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (body.generate === true) {
    const result = await generateAdCopy({
      count: typeof body.count === "number" ? body.count : undefined,
      productName: typeof body.productName === "string" ? body.productName : undefined,
      direction: typeof body.direction === "string" ? body.direction : undefined,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 502 });
    return NextResponse.json({ created: result.created }, { status: 201 });
  }

  if (typeof body.primaryText !== "string" || !body.primaryText.trim()) {
    return NextResponse.json({ error: "primaryText is required" }, { status: 400 });
  }
  const { code } = insertCopyVariant({
    primaryText: body.primaryText,
    headline: typeof body.headline === "string" ? body.headline : null,
    description: typeof body.description === "string" ? body.description : null,
    notes: typeof body.notes === "string" ? body.notes : null,
  });
  return NextResponse.json({ code }, { status: 201 });
}
