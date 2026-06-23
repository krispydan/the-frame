export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { outcomesByDimension } from "@/modules/marketing/lib/strategy-outcomes";

/**
 * GET /api/v1/marketing/email/insights
 *
 * The ROI + learning surface:
 *  - pipeline counts by status
 *  - emails "produced" (reached exported/sent/analyzed) all-time + this
 *    month, and the estimated agency spend that replaces
 *  - best-performing strategy dimensions (subject angle / image style)
 *    per audience, from captured outcomes — the v2 recommender's inputs
 *
 * Cost model is configurable:
 *   MARKETING_AGENCY_MONTHLY (default 3000)
 *   MARKETING_EMAILS_PER_MONTH (default 16 = 4/week)
 */
export async function GET() {
  const monthly = Number(process.env.MARKETING_AGENCY_MONTHLY ?? 3000);
  const perMonthCount = Number(process.env.MARKETING_EMAILS_PER_MONTH ?? 16);
  const perEmail = perMonthCount > 0 ? monthly / perMonthCount : 0;

  const statusRows = sqlite
    .prepare(`SELECT status, COUNT(*) AS n FROM marketing_email_campaigns GROUP BY status`)
    .all() as Array<{ status: string; n: number }>;
  const statusCounts: Record<string, number> = {};
  for (const r of statusRows) statusCounts[r.status] = r.n;

  const PRODUCED = "('exported','sent','analyzed')";
  const producedTotal =
    (sqlite.prepare(`SELECT COUNT(*) AS n FROM marketing_email_campaigns WHERE status IN ${PRODUCED}`).get() as { n: number }).n;

  // "This month" by scheduled_date within the current calendar month.
  const now = new Date();
  const monthPrefix = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const producedThisMonth =
    (sqlite
      .prepare(`SELECT COUNT(*) AS n FROM marketing_email_campaigns WHERE status IN ${PRODUCED} AND scheduled_date LIKE ?`)
      .get(`${monthPrefix}-%`) as { n: number }).n;

  const insightsFor = (audience: "retail" | "wholesale") => ({
    subjectAngle: outcomesByDimension(audience, "subject_angle"),
    imageStyle: outcomesByDimension(audience, "image_style"),
    layoutProfile: outcomesByDimension(audience, "layout_profile"),
  });

  return NextResponse.json({
    statusCounts,
    produced: { total: producedTotal, thisMonth: producedThisMonth },
    roi: {
      perEmail,
      agencyMonthly: monthly,
      savedThisMonth: Math.round(producedThisMonth * perEmail),
      savedAllTime: Math.round(producedTotal * perEmail),
    },
    performance: {
      retail: insightsFor("retail"),
      wholesale: insightsFor("wholesale"),
    },
  });
}
