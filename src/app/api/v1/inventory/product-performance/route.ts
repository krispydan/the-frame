export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/get-session";
import { getProductPerformance, getMovers } from "@/modules/inventory/lib/product-performance";

/**
 * GET /api/v1/inventory/product-performance
 *   ?days=90        analysis window
 *   &limit=200      max rows
 *   &movers=1       also return rising / falling / breakout lists
 *   &format=csv     CSV download of the full table
 *
 * Session-gated (any authenticated role — product performance is not
 * role-restricted the way finance is).
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const params = req.nextUrl.searchParams;
  const days = Math.min(365, Math.max(7, parseInt(params.get("days") || "90", 10)));
  const limit = Math.min(1000, Math.max(1, parseInt(params.get("limit") || "200", 10)));
  const wantMovers = params.get("movers") === "1";
  const format = params.get("format");

  try {
    const result = getProductPerformance({ windowDays: days, limit });

    if (format === "csv") {
      const header = [
        "sku", "style", "color", "factory", "units", "revenue",
        "units_wholesale", "revenue_wholesale", "units_retail", "revenue_retail",
        "wholesale_share_pct", "order_lines", "avg_order_qty", "accounts",
        "repeat_accounts", "repeat_rate_pct", "units_recent", "units_prior",
        "trend_pct", "trend", "unit_cost", "gross_profit", "margin_pct",
        "on_hand", "available", "weekly_rate", "days_cover",
        "on_order", "total_position", "days_cover_with_incoming", "open_pos",
      ].join(",");
      const esc = (v: unknown) => {
        const s = v == null ? "" : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const body = result.rows.map((r) =>
        [
          r.rootSku, r.productName, r.colorName, r.factoryCode, r.units, r.revenue,
          r.unitsWholesale, r.revenueWholesale, r.unitsRetail, r.revenueRetail,
          r.wholesaleSharePct.toFixed(1), r.orderLines, r.avgOrderQty.toFixed(1), r.accounts,
          r.repeatAccounts, r.repeatRatePct.toFixed(1), r.unitsRecent, r.unitsPrior,
          r.trendPct == null ? "" : r.trendPct.toFixed(1), r.trend,
          r.unitCost ?? "", r.grossProfit ?? "", r.marginPct == null ? "" : r.marginPct.toFixed(1),
          r.onHand, r.available, r.weeklyRate, r.daysCover ?? "",
          r.onOrder, r.totalPosition, r.daysCoverWithIncoming ?? "",
          // "JAX101:1200 (2026-09-04)" per PO, so the CSV is self-explanatory.
          r.onOrderPos.map((p) => `${p.poNumber}:${p.units}${p.expectedArrivalDate ? ` (${p.expectedArrivalDate})` : ""}`).join("; "),
        ].map(esc).join(","),
      );
      return new NextResponse([header, ...body].join("\n"), {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="product-performance-${new Date().toISOString().split("T")[0]}.csv"`,
        },
      });
    }

    return NextResponse.json({
      ok: true,
      ...result,
      ...(wantMovers ? { movers: getMovers({ windowDays: days }) } : {}),
    });
  } catch (e) {
    console.error("[product-performance] failed:", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
