export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { runDemandForecast, type ForecastResult, type Velocity } from "@/modules/inventory/agents/demand-forecaster";

/**
 * GET /api/admin/inventory/reorder-report
 *
 * Runs the v2 demand forecast and returns a factory-grouped reorder report.
 *
 * Query params:
 *   targetDays=90         — days of cover to buy (beyond lead time)
 *   include=slow          — comma list of velocity classes to INCLUDE that are
 *                           excluded by default (slow,dead)
 *   format=csv            — CSV download instead of JSON
 *   all=1                 — include non-reorder rows (full forecast dump)
 *
 * Auth: x-admin-key: jaxy2026.
 */

const VERSION = "v2-reorder-report";

function toCsv(rows: ForecastResult[]): string {
  const header = [
    "factory", "po_suggest", "sku", "style", "color", "velocity",
    "weekly_rate", "trend", "on_hand", "reserved", "available",
    "incoming_units", "incoming_eta", "days_cover_effective",
    "stockout_date", "safety_stock", "reorder_qty", "urgency",
    "excluded", "exclusion_reason", "notes",
  ].join(",");
  const esc = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = rows.map((r) =>
    [
      r.factoryName !== "?" ? r.factoryName : r.factoryCode,
      r.factoryCode,
      r.sku, r.productName, r.colorName, r.velocity,
      r.projectedWeeklyRate, r.trendDirection,
      r.currentStock, r.reservedStock, r.availableStock,
      r.incomingUnits, r.incomingArrival ?? "",
      r.effectiveDaysOfCover >= 9999 ? "" : r.effectiveDaysOfCover,
      r.projectedStockoutDate ?? "",
      r.safetyStock, r.recommendedReorderQty, r.urgencyLevel,
      r.excludedFromReorder ? "yes" : "no",
      r.exclusionReason ?? "", r.notes,
    ].map(esc).join(","),
  );
  return [header, ...lines].join("\n");
}

export async function GET(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const params = new URL(req.url).searchParams;
  const targetDays = parseInt(params.get("targetDays") || "90", 10);
  const includeExtra = (params.get("include") || "")
    .split(",").map((s) => s.trim()).filter(Boolean) as Velocity[];
  const format = params.get("format");
  const all = params.get("all") === "1";

  const excludeVelocities = (["slow", "dead"] as Velocity[]).filter(
    (v) => !includeExtra.includes(v),
  );

  const forecast = runDemandForecast({ targetStockDays: targetDays, excludeVelocities });

  const reorder = forecast.filter(
    (r) => r.recommendedReorderQty > 0 && !r.excludedFromReorder,
  );
  const excluded = forecast.filter(
    (r) => r.recommendedReorderQty > 0 && r.excludedFromReorder,
  );

  if (format === "csv") {
    const rows = all ? forecast : [...reorder, ...excluded];
    return new NextResponse(toCsv(rows), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="reorder-report-${new Date().toISOString().split("T")[0]}.csv"`,
      },
    });
  }

  // Group reorder rows by factory
  const byFactory: Record<string, { factory: string; units: number; skus: number; rows: ForecastResult[] }> = {};
  for (const r of reorder) {
    const key = r.factoryName !== "?" ? r.factoryName : r.factoryCode;
    byFactory[key] ??= { factory: key, units: 0, skus: 0, rows: [] };
    byFactory[key].units += r.recommendedReorderQty;
    byFactory[key].skus += 1;
    byFactory[key].rows.push(r);
  }

  return NextResponse.json({
    ok: true,
    version: VERSION,
    targetDays,
    seasonality: forecast[0]?.seasonalitySource ?? "n/a",
    summary: {
      totalRoots: forecast.length,
      reorderSkus: reorder.length,
      reorderUnits: reorder.reduce((a, r) => a + r.recommendedReorderQty, 0),
      excludedSlowSellers: excluded.length,
      critical: reorder.filter((r) => r.urgencyLevel === "critical").length,
      urgent: reorder.filter((r) => r.urgencyLevel === "urgent").length,
      watch: reorder.filter((r) => r.urgencyLevel === "watch").length,
      withIncomingPo: forecast.filter((r) => r.incomingUnits > 0).length,
    },
    byFactory: Object.values(byFactory).sort((a, b) => b.units - a.units),
    excludedSlowSellers: excluded.map((r) => ({
      sku: r.sku, style: r.productName, color: r.colorName,
      factory: r.factoryName, velocity: r.velocity,
      weeklyRate: r.projectedWeeklyRate, available: r.availableStock,
      wouldHaveOrdered: r.recommendedReorderQty,
    })),
    ...(all ? { forecast } : {}),
  });
}
