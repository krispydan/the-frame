export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { buildAmazonMonthlyReport } from "@/modules/integrations/lib/amazon/monthly-report";
import { buildAsinProfitability } from "@/modules/integrations/lib/amazon/asin-profitability";
import { buildAmazonDashboardSeries } from "@/modules/integrations/lib/amazon/dashboard-series";
import { buildReplenishmentProposal } from "@/modules/integrations/lib/amazon/replenishment";
import { buildExcessReport } from "@/modules/integrations/lib/amazon/excess-inventory";

/**
 * GET /api/v1/finance/amazon/reports?view=…
 *
 * The session-guarded front door for the same libraries the ops endpoints
 * expose. One implementation, two doors — see docs/ops-endpoints.md.
 *
 * Served per-view rather than as one payload: the replenishment proposal and
 * the per-ASIN table each scan the whole archive, and paying for both on
 * every page load would make the overview slower than the reports that
 * actually need them.
 */
export async function GET(req: NextRequest) {
  const view = req.nextUrl.searchParams.get("view") ?? "performance";
  const months = Number(req.nextUrl.searchParams.get("months")) || 3;
  const days = Number(req.nextUrl.searchParams.get("days")) || 90;
  const coverDays = Number(req.nextUrl.searchParams.get("coverDays")) || undefined;

  try {
    switch (view) {
      case "performance":
        return NextResponse.json({ ok: true, view, performance: buildAmazonMonthlyReport({ months }) });
      case "products":
        return NextResponse.json({ ok: true, view, profitability: buildAsinProfitability({ months }) });
      case "series":
        return NextResponse.json({ ok: true, view, series: buildAmazonDashboardSeries({ days }) });
      case "replenishment":
        return NextResponse.json({
          ok: true, view,
          replenishment: buildReplenishmentProposal({ coverDays }),
          excess: buildExcessReport({ coverDays: undefined }),
        });
      default:
        return NextResponse.json(
          { ok: false, error: `Unknown view "${view}".`, views: ["performance", "products", "series", "replenishment"] },
          { status: 400 },
        );
    }
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
