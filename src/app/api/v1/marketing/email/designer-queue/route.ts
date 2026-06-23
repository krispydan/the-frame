export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { emailCampaigns } from "@/modules/marketing/schema";
import { inArray, asc } from "drizzle-orm";

/**
 * GET /api/v1/marketing/email/designer-queue
 *
 * Returns all campaigns awaiting image renders or in image-review.
 * Designer uses this list to know what to work on next.
 *
 * Sorted by scheduledDate ASC — closest deadlines first.
 *
 * Each row includes everything the designer needs:
 *  - hero + secondary image prompts (the Higgsfield briefs)
 *  - recommended scrim
 *  - variant choices (drive dimensions per shared/tokens.ts)
 *  - upload progress (which slots are filled)
 *  - designer_notes (strategy rationale + image-style directive)
 */
export async function GET() {
  const rows = await db
    .select()
    .from(emailCampaigns)
    .where(inArray(emailCampaigns.status, ["photography", "design_review"] as never[]))
    .orderBy(asc(emailCampaigns.scheduledDate));

  // Annotate each row with what's needed vs uploaded so the UI
  // doesn't have to recompute. The grid_2up variant requires 2
  // secondary images; everything else just needs 1.
  const enriched = rows.map((c) => {
    const needsSecondary2 = c.secondaryImageVariant === "grid_2up";
    const heroReady = !!c.heroImagePath;
    const secondaryReady = !!c.secondaryImagePath;
    const secondary2Ready = !!c.secondaryImagePath2;
    const allReady = heroReady && secondaryReady && (!needsSecondary2 || secondary2Ready);
    return {
      ...c,
      needsSecondary2,
      heroReady,
      secondaryReady,
      secondary2Ready,
      allReady,
    };
  });

  return NextResponse.json({
    queue: enriched,
    summary: {
      total: enriched.length,
      pending: enriched.filter((c) => c.status === "photography").length,
      inReview: enriched.filter((c) => c.status === "design_review").length,
      allReady: enriched.filter((c) => c.allReady).length,
    },
  });
}
