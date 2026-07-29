export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/get-session";
import { getColorPerformance } from "@/modules/inventory/lib/product-performance";

/**
 * GET /api/v1/inventory/color-performance
 *   ?days=365       analysis window (defaults to a year — colour seasonality
 *                   can't be read off a quarter)
 *   &format=csv     CSV download, one row per colour with the monthly series
 *                   flattened into columns
 *
 * Session-gated (any authenticated role).
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const params = req.nextUrl.searchParams;
  const days = Math.min(1095, Math.max(30, parseInt(params.get("days") || "365", 10)));

  try {
    const result = getColorPerformance({ windowDays: days });

    if (params.get("format") === "csv") {
      const esc = (v: unknown) => {
        const s = v == null ? "" : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      // Monthly units become their own columns so the file opens straight into
      // a pivot/chart without anyone having to unpack a JSON blob.
      const header = [
        "color", "units", "revenue", "unit_share_pct", "units_wholesale", "units_retail",
        "wholesale_share_pct", "products", "accounts", "avg_order_qty",
        "trend_pct", "trend", "on_hand", "on_order", "weeks_cover",
        "peak_month", "seasonality_index",
        ...result.months,
      ].join(",");
      const body = result.rows.map((r) =>
        [
          r.color, r.units, r.revenue, r.unitSharePct.toFixed(1), r.unitsWholesale, r.unitsRetail,
          r.wholesaleSharePct.toFixed(1), r.products, r.accounts, r.avgOrderQty.toFixed(1),
          r.trendPct == null ? "" : r.trendPct.toFixed(1), r.trend, r.onHand, r.onOrder,
          r.weeksCover ?? "", r.peakMonth ?? "", r.seasonalityIndex ?? "",
          ...r.byMonth.map((m) => m.units),
        ].map(esc).join(","),
      );
      return new NextResponse([header, ...body].join("\n"), {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="color-performance-${new Date().toISOString().split("T")[0]}.csv"`,
        },
      });
    }

    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    console.error("[color-performance] failed:", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
