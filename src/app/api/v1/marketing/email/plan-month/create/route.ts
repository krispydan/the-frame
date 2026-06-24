/**
 * POST /api/v1/marketing/email/plan-month/create
 *
 * Body: { audience, proposals: Array<{
 *           scheduledDate, weekOf, slotInWeek, layoutVariants,
 *           brief: { name, angle, productHook, seasonalContext }
 *         }> }
 *
 * Bulk-creates campaigns from the (user-reviewed) proposals
 * returned by /propose. Done in a single transaction — all or
 * nothing, so a partial failure doesn't leave half a month on
 * the calendar.
 *
 * Returns: { ok, created, campaignIds }
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { suggestRandomProducts } from "@/modules/marketing/lib/product-selector";
import { assignFeaturedProductIds } from "@/modules/marketing/lib/featured-products";

interface Proposal {
  scheduledDate: string;
  weekOf: string;
  slotInWeek: 1 | 2;
  layoutVariants: {
    heroVariant: string;
    sectionAVariant: string;
    secondaryImageVariant: string;
    sectionBVariant: string;
  };
  rationale?: string;
  imageStyle?: string;
  subjectAngle?: string;
  brief: {
    name: string;
    angle: string;
    productHook?: string | null;
    seasonalContext?: string | null;
    rationale?: string;
  };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { audience?: string; proposals?: Proposal[]; autoFeatureProducts?: boolean };

    if (body.audience !== "retail" && body.audience !== "wholesale") {
      return NextResponse.json({ error: "audience must be 'retail' or 'wholesale'" }, { status: 400 });
    }
    if (!Array.isArray(body.proposals) || body.proposals.length === 0) {
      return NextResponse.json({ error: "proposals array required" }, { status: 400 });
    }
    if (body.proposals.length > 50) {
      return NextResponse.json({ error: "max 50 campaigns per batch" }, { status: 400 });
    }

    // Validate every proposal before opening the transaction. If
    // anything's malformed we want to fail loudly before mutating.
    for (let i = 0; i < body.proposals.length; i++) {
      const p = body.proposals[i];
      if (!p.scheduledDate || !/^\d{4}-\d{2}-\d{2}$/.test(p.scheduledDate)) {
        return NextResponse.json({ error: `proposals[${i}]: scheduledDate must be YYYY-MM-DD` }, { status: 400 });
      }
      if (!p.brief || typeof p.brief.name !== "string" || typeof p.brief.angle !== "string") {
        return NextResponse.json({ error: `proposals[${i}]: brief.name + brief.angle required` }, { status: 400 });
      }
      if (!p.layoutVariants?.heroVariant) {
        return NextResponse.json({ error: `proposals[${i}]: layoutVariants required` }, { status: 400 });
      }
    }

    const audience = body.audience as "retail" | "wholesale";

    // Auto-feature products ("Both" mode): attach a real in-stock SKU to
    // the product-anchored proposals (the ones the planner gave a
    // productHook) so SOME emails are grounded in products and the rest
    // stay brand/theme emails — a natural mix. Cycle a random pool so
    // they're not all the same frame. Operator can adjust per campaign.
    const productHooks = body.proposals.map((p) => p.brief.productHook);
    let featuredByIndex: Array<string | null> = productHooks.map(() => null);
    if (body.autoFeatureProducts) {
      const anchoredCount = productHooks.filter((h) => h && h.trim()).length;
      if (anchoredCount > 0) {
        const pool = await suggestRandomProducts(Math.min(anchoredCount, 12), "in_stock");
        featuredByIndex = assignFeaturedProductIds(productHooks, pool.map((p) => p.id));
      }
    }

    // Single transaction so partial failures don't strand half the
    // month. better-sqlite3's tx wrapper handles rollback on throw.
    const insert = sqlite.prepare(
      `INSERT INTO marketing_email_campaigns
        (id, name, audience, scheduled_date, week_of, status,
         hero_variant, section_a_variant, secondary_image_variant, section_b_variant,
         brief_title, brief_angle, brief_product_hook, brief_seasonal_context,
         featured_product_ids,
         designer_notes,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    );

    const ids: string[] = [];
    const tx = sqlite.transaction((props: Proposal[]) => {
      props.forEach((p, i) => {
        const id = crypto.randomUUID();
        ids.push(id);
        const designerNotes = [
          p.rationale ? `STRATEGY: ${p.rationale}` : "",
          p.imageStyle ? `IMAGE STYLE: ${p.imageStyle}` : "",
          p.subjectAngle ? `SUBJECT ANGLE: ${p.subjectAngle}` : "",
          p.brief.rationale ? `AI RATIONALE: ${p.brief.rationale}` : "",
        ].filter(Boolean).join("\n\n");
        insert.run(
          id,
          p.brief.name,
          audience,
          p.scheduledDate,
          p.weekOf ?? mondayOf(p.scheduledDate),
          p.layoutVariants.heroVariant,
          p.layoutVariants.sectionAVariant,
          p.layoutVariants.secondaryImageVariant,
          p.layoutVariants.sectionBVariant,
          p.brief.name,                            // brief_title mirrors name
          p.brief.angle,
          p.brief.productHook || null,
          p.brief.seasonalContext || null,
          featuredByIndex[i],
          designerNotes,
        );
      });
    });
    tx(body.proposals);

    return NextResponse.json({
      ok: true,
      created: ids.length,
      campaignIds: ids,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[plan-month/create] unhandled:", e);
    return NextResponse.json({ error: `Server error: ${message}` }, { status: 500 });
  }
}

function mondayOf(isoDate: string): string {
  const d = new Date(isoDate + "T00:00:00Z");
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - (day - 1));
  return d.toISOString().slice(0, 10);
}
