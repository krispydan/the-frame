export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { runDemandForecast } from "@/modules/inventory/agents/demand-forecaster";

/**
 * Admin reorder plan, scoped to one factory.
 *
 * GET  ?factory=JX4[&targetDays=90][&includeExcluded=1][&format=csv]
 *      → the demand forecast filtered to that factory's SKUs, with the buy
 *        rolled up so it can be handed to the factory as a PO.
 *
 * POST { factory: "JX4", productionLeadDays?, transitLeadDays?, moq? }
 *      → update a factory's lead times. These drive the forecast directly:
 *        the coverage window is productionLeadDays + transitLeadDays +
 *        targetStockDays, so a factory quoting 75-day production needs a
 *        materially bigger buy than one quoting 30, and getting this wrong is
 *        the difference between a stockout and dead stock.
 *
 * Auth: x-admin-key: jaxy2026.
 */

function factoryRow(code: string) {
  return sqlite
    .prepare("SELECT id, code, name, production_lead_days, transit_lead_days, moq FROM inventory_factories WHERE UPPER(code) = ?")
    .get(code.toUpperCase()) as
    | { id: string; code: string; name: string; production_lead_days: number; transit_lead_days: number; moq: number | null }
    | undefined;
}

export async function GET(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const params = new URL(req.url).searchParams;
  const factory = (params.get("factory") || "").trim().toUpperCase();
  const targetDays = Math.min(365, Math.max(14, parseInt(params.get("targetDays") || "90", 10)));
  const includeExcluded = params.get("includeExcluded") === "1";

  const fac = factory ? factoryRow(factory) : undefined;
  if (factory && !fac) {
    const all = sqlite.prepare("SELECT code, name FROM inventory_factories ORDER BY code").all();
    return NextResponse.json({ error: `Unknown factory "${factory}"`, factories: all }, { status: 400 });
  }

  const all = runDemandForecast(targetDays);
  // Match on the SKU prefix rather than the joined factory row: a SKU whose
  // catalog product has no factory link still belongs to JX4 by its number, and
  // dropping it would silently under-order.
  const rows = factory
    ? all.filter((r) => r.factoryCode === factory || r.sku.toUpperCase().startsWith(factory))
    : all;

  const buy = rows.filter((r) => r.recommendedReorderQty > 0 && (includeExcluded || !r.excludedFromReorder));
  const excluded = rows.filter((r) => r.excludedFromReorder);

  const totals = {
    skus: rows.length,
    buySkus: buy.length,
    buyUnits: buy.reduce((t, r) => t + r.recommendedReorderQty, 0),
    critical: buy.filter((r) => r.urgencyLevel === "critical").length,
    urgent: buy.filter((r) => r.urgencyLevel === "urgent").length,
    watch: buy.filter((r) => r.urgencyLevel === "watch").length,
    excludedSkus: excluded.length,
    outOfStockSkus: rows.filter((r) => r.availableStock <= 0).length,
  };

  if (params.get("format") === "csv") {
    const esc = (v: unknown) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = [
      "sku", "style", "color", "reorder_qty", "urgency", "on_hand", "available",
      "incoming", "weekly_rate", "trend", "velocity", "days_cover",
      "days_until_stockout", "safety_stock", "seasonal_factor", "notes",
    ].join(",");
    const body = buy
      .sort((a, b) => b.recommendedReorderQty - a.recommendedReorderQty)
      .map((r) => [
        r.sku, r.productName, r.colorName, r.recommendedReorderQty, r.urgencyLevel,
        r.currentStock, r.availableStock, r.incomingUnits, r.projectedWeeklyRate.toFixed(1),
        r.trendDirection, r.velocity, r.effectiveDaysOfCover, r.daysUntilStockout,
        r.safetyStock, r.seasonalFactor, r.notes,
      ].map(esc).join(","));
    return new NextResponse([header, ...body].join("\n"), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="reorder-${factory || "all"}-${new Date().toISOString().split("T")[0]}.csv"`,
      },
    });
  }

  return NextResponse.json({
    ok: true,
    factory: fac
      ? {
          code: fac.code, name: fac.name, moq: fac.moq,
          productionLeadDays: fac.production_lead_days,
          transitLeadDays: fac.transit_lead_days,
          totalLeadDays: fac.production_lead_days + fac.transit_lead_days,
        }
      : null,
    targetStockDays: targetDays,
    totals,
    buy: buy
      .sort((a, b) => b.recommendedReorderQty - a.recommendedReorderQty)
      .map((r) => ({
        sku: r.sku, style: r.productName, color: r.colorName,
        qty: r.recommendedReorderQty, urgency: r.urgencyLevel,
        onHand: r.currentStock, available: r.availableStock, incoming: r.incomingUnits,
        weeklyRate: Math.round(r.projectedWeeklyRate * 10) / 10,
        trend: r.trendDirection, velocity: r.velocity,
        daysCover: r.effectiveDaysOfCover, daysUntilStockout: r.daysUntilStockout,
        safetyStock: r.safetyStock, seasonalFactor: r.seasonalFactor, notes: r.notes,
      })),
    excluded: excluded.map((r) => ({
      sku: r.sku, style: r.productName, color: r.colorName,
      onHand: r.currentStock, weeklyRate: Math.round(r.projectedWeeklyRate * 10) / 10,
      velocity: r.velocity, reason: r.exclusionReason,
    })),
  });
}

export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const code = String(body.factory || "").trim().toUpperCase();
  const fac = code ? factoryRow(code) : undefined;
  if (!fac) return NextResponse.json({ error: `Unknown factory "${code}"` }, { status: 400 });

  const before = {
    productionLeadDays: fac.production_lead_days,
    transitLeadDays: fac.transit_lead_days,
    moq: fac.moq,
  };
  const production = Number.isFinite(body.productionLeadDays) ? Math.max(1, Math.floor(body.productionLeadDays)) : fac.production_lead_days;
  const transit = Number.isFinite(body.transitLeadDays) ? Math.max(1, Math.floor(body.transitLeadDays)) : fac.transit_lead_days;
  const moq = Number.isFinite(body.moq) ? Math.max(1, Math.floor(body.moq)) : fac.moq;

  sqlite
    .prepare("UPDATE inventory_factories SET production_lead_days = ?, transit_lead_days = ?, moq = ? WHERE id = ?")
    .run(production, transit, moq, fac.id);

  return NextResponse.json({
    ok: true,
    factory: fac.code,
    name: fac.name,
    before,
    after: { productionLeadDays: production, transitLeadDays: transit, moq },
    totalLeadDays: production + transit,
  });
}
