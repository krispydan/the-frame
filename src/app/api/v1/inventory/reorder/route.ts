export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/get-session";
import { runDemandForecast, type ForecastResult, type Velocity } from "@/modules/inventory/agents/demand-forecaster";

/**
 * GET /api/v1/inventory/reorder
 *   ?targetDays=90        days of cover to buy beyond lead time
 *   &include=slow,dead    velocity classes to include that are excluded by default
 *   &format=csv           CSV download
 *
 * Session-gated view of the v2 demand forecast: what to reorder, from which
 * factory, net of in-flight POs. Same engine the admin reorder-report uses.
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const params = req.nextUrl.searchParams;
  const targetDays = Math.min(365, Math.max(14, parseInt(params.get("targetDays") || "90", 10)));
  const include = (params.get("include") || "").split(",").map((s) => s.trim()).filter(Boolean) as Velocity[];
  const excludeVelocities = (["slow", "dead"] as Velocity[]).filter((v) => !include.includes(v));
  const format = params.get("format");

  try {
    const forecast = runDemandForecast({ targetStockDays: targetDays, excludeVelocities });
    const reorder = forecast.filter((r) => r.recommendedReorderQty > 0 && !r.excludedFromReorder);
    const excluded = forecast.filter((r) => r.recommendedReorderQty > 0 && r.excludedFromReorder);

    if (format === "csv") {
      const header = [
        "factory", "sku", "style", "color", "velocity", "weekly_rate", "trend",
        "on_hand", "reserved", "available", "incoming_units", "incoming_eta",
        "days_cover", "stockout_date", "safety_stock", "reorder_qty", "urgency",
      ].join(",");
      const esc = (v: unknown) => {
        const s = v == null ? "" : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const body = [...reorder, ...excluded].map((r) =>
        [
          r.factoryName !== "?" ? r.factoryName : r.factoryCode, r.sku, r.productName, r.colorName,
          r.velocity, r.projectedWeeklyRate, r.trendDirection,
          r.currentStock, r.reservedStock, r.availableStock, r.incomingUnits, r.incomingArrival ?? "",
          r.effectiveDaysOfCover >= 9999 ? "" : r.effectiveDaysOfCover, r.projectedStockoutDate ?? "",
          r.safetyStock, r.recommendedReorderQty, r.urgencyLevel,
        ].map(esc).join(","),
      );
      return new NextResponse([header, ...body].join("\n"), {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="reorder-plan-${new Date().toISOString().split("T")[0]}.csv"`,
        },
      });
    }

    const byFactory: Record<string, { factory: string; code: string; units: number; skus: number; rows: ForecastResult[] }> = {};
    for (const r of reorder) {
      const key = r.factoryName !== "?" ? r.factoryName : r.factoryCode;
      byFactory[key] ??= { factory: key, code: r.factoryCode, units: 0, skus: 0, rows: [] };
      byFactory[key].units += r.recommendedReorderQty;
      byFactory[key].skus += 1;
      byFactory[key].rows.push(r);
    }

    return NextResponse.json({
      ok: true,
      targetDays,
      seasonality: forecast[0]?.seasonalitySource ?? "n/a",
      summary: {
        totalRoots: forecast.length,
        reorderSkus: reorder.length,
        reorderUnits: reorder.reduce((a, r) => a + r.recommendedReorderQty, 0),
        critical: reorder.filter((r) => r.urgencyLevel === "critical").length,
        urgent: reorder.filter((r) => r.urgencyLevel === "urgent").length,
        watch: reorder.filter((r) => r.urgencyLevel === "watch").length,
        withIncomingPo: forecast.filter((r) => r.incomingUnits > 0).length,
        incomingUnits: forecast.reduce((a, r) => a + r.incomingUnits, 0),
        excludedSlowSellers: excluded.length,
      },
      byFactory: Object.values(byFactory).sort((a, b) => b.units - a.units),
      excluded: excluded.map((r) => ({
        sku: r.sku, style: r.productName, color: r.colorName, factory: r.factoryName,
        velocity: r.velocity, weeklyRate: r.projectedWeeklyRate,
        available: r.availableStock, wouldHaveOrdered: r.recommendedReorderQty,
      })),
    });
  } catch (e) {
    console.error("[inventory/reorder] failed:", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
