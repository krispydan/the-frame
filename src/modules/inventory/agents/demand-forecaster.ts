/**
 * Demand Forecaster v2 (rule-based, root-SKU grain)
 *
 * Improvements over v1:
 *   - Demand comes from ALL channels: order lines are resolved by SKU string
 *     through the FIFO resolver (packs + aliases), so Faire/wholesale lines
 *     that lack a sku_id FK now count. (v1 grouped by sku_id and silently
 *     dropped them.)
 *   - Forecast grain is the ROOT (colorway) SKU: reader power variants and
 *     12-packs roll up to what a factory actually quotes.
 *   - Available stock = on-hand − reserved (v1 used raw on-hand).
 *   - Open purchase orders count as incoming supply — the forecast never
 *     recommends reordering units already on the water.
 *   - Safety stock from real demand variability (z × σ_weekly × √LT_weeks).
 *   - Seasonality learned from order history when there's enough of it;
 *     hardcoded curve is only the cold-start fallback.
 *   - Reorder qty respects factory MOQ and rounds to inner-pack multiples.
 *   - Velocity classification (fast/normal/slow/dead) so slow sellers can be
 *     excluded from reorder recommendations.
 */

import { sqlite } from "@/lib/db";
import {
  getRootDemandForWindow,
  getWeeklyDemandSeries,
  getLearnedSeasonality,
  rootSkuOf,
} from "@/modules/inventory/lib/demand";

export type Velocity = "fast" | "normal" | "slow" | "dead";

export type ForecastResult = {
  skuId: string;              // representative catalog sku id for the root
  sku: string;                // ROOT sku (colorway grain)
  productName: string;
  colorName: string;
  factoryCode: string;
  factoryName: string;
  currentStock: number;       // on-hand (all rolled-up SKUs)
  reservedStock: number;
  availableStock: number;     // on-hand − reserved
  incomingUnits: number;      // open-PO units not yet received
  incomingArrival: string | null; // earliest expected arrival (ISO date)
  // Sell-through windows (units/week, all channels, pack-expanded)
  sellThrough30d: number;
  sellThrough60d: number;
  sellThrough90d: number;
  trendDirection: "accelerating" | "stable" | "decelerating";
  projectedWeeklyRate: number;
  velocity: Velocity;
  // Forecast
  projectedStockoutDate: string | null; // on available stock only
  daysUntilStockout: number;
  effectiveDaysOfCover: number;         // including incoming PO units
  // Recommendation
  safetyStock: number;
  recommendedReorderQty: number;        // net of incoming, MOQ/pack rounded
  excludedFromReorder: boolean;         // slow/dead sellers
  exclusionReason: string | null;
  targetStockDays: number;
  urgencyLevel: "critical" | "urgent" | "watch" | "ok";
  seasonalFactor: number;
  seasonalitySource: "learned" | "default";
  notes: string;
};

// Cold-start seasonal curve (sunglasses-led). Only used until the order
// history is deep enough for getLearnedSeasonality().
const DEFAULT_SEASONAL_FACTORS: Record<number, number> = {
  1: 0.7, 2: 0.75, 3: 0.9, 4: 1.1, 5: 1.3, 6: 1.4,
  7: 1.5, 8: 1.3, 9: 1.0, 10: 0.8, 11: 0.9, 12: 1.1,
};

/** z-score for ~95% service level. */
const SERVICE_Z = 1.64;
/** Round reorder quantities up to inner-pack multiples. */
const INNER_PACK = 12;

/** PO statuses that mean "units are coming but not on the shelf yet". */
const OPEN_PO_STATUSES = ["submitted", "confirmed", "in_production", "shipped", "in_transit"];

export type ForecastOptions = {
  targetStockDays?: number;
  /** Velocity classes excluded from reorder recommendations. */
  excludeVelocities?: Velocity[];
};

type RootAgg = {
  skuId: string;
  rootSku: string;
  productName: string;
  colorName: string;
  factoryCode: string | null;
  factoryName: string | null;
  productionLeadDays: number;
  transitLeadDays: number;
  moq: number;
  quantity: number;
  reserved: number;
  seedRate: number;
};

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/** Roll inventory + catalog + factory rows up to root SKUs. */
function loadRootInventory(): Map<string, RootAgg> {
  const rows = sqlite.prepare(`
    SELECT
      i.sku_id, i.quantity, i.reserved_quantity, i.sell_through_weekly,
      s.sku, s.color_name,
      p.name AS product_name,
      f.code AS factory_code, f.name AS factory_name,
      f.production_lead_days, f.transit_lead_days, f.moq
    FROM inventory i
    JOIN catalog_skus s ON i.sku_id = s.id
    JOIN catalog_products p ON s.product_id = p.id
    LEFT JOIN inventory_factories f ON f.code = SUBSTR(s.sku, 1, 3)
    WHERE i.location = 'warehouse'
  `).all() as Array<{
    sku_id: string; quantity: number; reserved_quantity: number;
    sell_through_weekly: number | null; sku: string; color_name: string | null;
    product_name: string; factory_code: string | null; factory_name: string | null;
    production_lead_days: number | null; transit_lead_days: number | null; moq: number | null;
  }>;

  const roots = new Map<string, RootAgg>();
  for (const r of rows) {
    const root = rootSkuOf(r.sku);
    if (!root) continue;
    let agg = roots.get(root);
    if (!agg) {
      agg = {
        skuId: r.sku_id,
        rootSku: root,
        productName: r.product_name,
        colorName: r.color_name ?? "",
        factoryCode: r.factory_code,
        factoryName: r.factory_name,
        productionLeadDays: r.production_lead_days ?? 30,
        transitLeadDays: r.transit_lead_days ?? 25,
        moq: r.moq ?? 300,
        quantity: 0,
        reserved: 0,
        seedRate: 0,
      };
      roots.set(root, agg);
    }
    // Prefer the exact colorway row as the representative (its id + names
    // beat a power-variant row's).
    if (r.sku.toUpperCase() === root) {
      agg.skuId = r.sku_id;
      agg.productName = r.product_name;
      agg.colorName = r.color_name ?? agg.colorName;
    }
    agg.quantity += r.quantity ?? 0;
    agg.reserved += r.reserved_quantity ?? 0;
    agg.seedRate += r.sell_through_weekly ?? 0;
  }
  return roots;
}

/** Open-PO incoming units + earliest arrival per root SKU. */
function loadIncoming(): Map<string, { units: number; arrival: string | null }> {
  const rows = sqlite.prepare(`
    SELECT s.sku, li.quantity, li.pack_size,
           po.expected_arrival_date, po.expected_ship_date, po.status
    FROM inventory_po_line_items li
    JOIN inventory_purchase_orders po ON li.po_id = po.id
    JOIN catalog_skus s ON li.sku_id = s.id
    WHERE po.status IN (${OPEN_PO_STATUSES.map(() => "?").join(",")})
  `).all(...OPEN_PO_STATUSES) as Array<{
    sku: string; quantity: number; pack_size: number | null;
    expected_arrival_date: string | null; expected_ship_date: string | null; status: string;
  }>;

  const out = new Map<string, { units: number; arrival: string | null }>();
  for (const r of rows) {
    const root = rootSkuOf(r.sku);
    if (!root) continue;
    const units = (r.quantity ?? 0) * (r.pack_size && r.pack_size > 0 ? r.pack_size : 1);
    const arrival = r.expected_arrival_date ?? r.expected_ship_date ?? null;
    const cur = out.get(root) ?? { units: 0, arrival: null };
    cur.units += units;
    if (arrival && (!cur.arrival || arrival < cur.arrival)) cur.arrival = arrival;
    out.set(root, cur);
  }
  return out;
}

export function classifyVelocity(weeklyRate: number): Velocity {
  if (weeklyRate >= 10) return "fast";
  if (weeklyRate >= 3) return "normal";
  if (weeklyRate >= 0.5) return "slow";
  return "dead";
}

export function runDemandForecast(
  targetStockDaysOrOpts: number | ForecastOptions = 90,
): ForecastResult[] {
  const opts: ForecastOptions =
    typeof targetStockDaysOrOpts === "number"
      ? { targetStockDays: targetStockDaysOrOpts }
      : targetStockDaysOrOpts;
  const targetStockDays = opts.targetStockDays ?? 90;
  const excludeVelocities = new Set<Velocity>(opts.excludeVelocities ?? ["slow", "dead"]);

  const st30 = getRootDemandForWindow(30);
  const st60 = getRootDemandForWindow(60);
  const st90 = getRootDemandForWindow(90);
  const weeklySeries = getWeeklyDemandSeries(12);
  const incoming = loadIncoming();
  const roots = loadRootInventory();

  const learned = getLearnedSeasonality();
  const seasonalitySource: "learned" | "default" = learned ? "learned" : "default";
  const factors = learned ?? DEFAULT_SEASONAL_FACTORS;
  const currentMonth = new Date().getMonth() + 1;
  const seasonalFactor = factors[currentMonth] ?? 1.0;

  // Roots that sold recently but have no inventory row at all (e.g. never
  // synced) still deserve a line — surface them with zero stock.
  for (const soldRoot of st90.keys()) {
    if (!roots.has(soldRoot)) {
      const row = sqlite.prepare(
        "SELECT s.id, s.sku, s.color_name, p.name AS product_name FROM catalog_skus s JOIN catalog_products p ON s.product_id = p.id WHERE UPPER(s.sku) = ? LIMIT 1",
      ).get(soldRoot) as { id: string; sku: string; color_name: string | null; product_name: string } | undefined;
      if (!row) continue;
      roots.set(soldRoot, {
        skuId: row.id,
        rootSku: soldRoot,
        productName: row.product_name,
        colorName: row.color_name ?? "",
        factoryCode: null,
        factoryName: null,
        productionLeadDays: 30,
        transitLeadDays: 25,
        moq: 300,
        quantity: 0,
        reserved: 0,
        seedRate: 0,
      });
    }
  }

  const results: ForecastResult[] = [];

  for (const agg of roots.values()) {
    const root = agg.rootSku;
    const weeks30 = 30 / 7, weeks60 = 60 / 7, weeks90 = 90 / 7;
    const sold30 = st30.get(root) ?? 0;
    const sold60 = st60.get(root) ?? 0;
    const sold90 = st90.get(root) ?? 0;
    const hasSales = sold90 > 0 || sold60 > 0 || sold30 > 0;

    const rate30 = hasSales ? Math.round((sold30 / weeks30) * 10) / 10 : agg.seedRate;
    const rate60 = hasSales ? Math.round((sold60 / weeks60) * 10) / 10 : agg.seedRate;
    const rate90 = hasSales ? Math.round((sold90 / weeks90) * 10) / 10 : agg.seedRate;

    let trendDirection: ForecastResult["trendDirection"] = "stable";
    if (rate90 > 0) {
      const ratio = rate30 / rate90;
      if (ratio > 1.15) trendDirection = "accelerating";
      else if (ratio < 0.85) trendDirection = "decelerating";
    }

    const avgRate = (rate30 * 3 + rate60 * 2 + rate90 * 1) / 6;
    const projectedWeeklyRate = Math.round(avgRate * seasonalFactor * 10) / 10;
    const dailyRate = projectedWeeklyRate / 7;
    const velocity = classifyVelocity(projectedWeeklyRate);

    const available = Math.max(0, agg.quantity - agg.reserved);
    const inc = incoming.get(root) ?? { units: 0, arrival: null };

    // Stockout on available stock only
    const daysUntilStockout = dailyRate > 0 ? Math.round(available / dailyRate) : 9999;
    let projectedStockoutDate: string | null = null;
    if (daysUntilStockout < 9999) {
      const d = new Date();
      d.setDate(d.getDate() + daysUntilStockout);
      projectedStockoutDate = d.toISOString().split("T")[0];
    }

    // Effective cover: incoming units extend the runway if they arrive
    // before the shelf goes empty (simple single-step simulation).
    let effectiveDaysOfCover = daysUntilStockout;
    if (dailyRate > 0 && inc.units > 0) {
      const arrivalDays = inc.arrival
        ? Math.max(0, Math.round((Date.parse(inc.arrival) - Date.now()) / 86400000))
        : 0;
      if (arrivalDays <= daysUntilStockout) {
        effectiveDaysOfCover = Math.round((available + inc.units) / dailyRate);
      }
    }

    const leadDays = agg.productionLeadDays + agg.transitLeadDays;
    const leadWeeks = leadDays / 7;

    // Safety stock from weekly demand variability. Thin history → assume
    // σ ≈ 60% of the weekly rate (typical for intermittent retail demand).
    const series = weeklySeries.get(root);
    const sigmaWeekly = series && series.filter((v) => v > 0).length >= 4
      ? stddev(series)
      : projectedWeeklyRate * 0.6;
    const safetyStock = dailyRate > 0 ? Math.ceil(SERVICE_Z * sigmaWeekly * Math.sqrt(leadWeeks)) : 0;

    // Net reorder need over lead time + target cover, minus what we have and
    // what's already on the water.
    let recommendedReorderQty = 0;
    if (dailyRate > 0) {
      const need = dailyRate * (leadDays + targetStockDays) + safetyStock - available - inc.units;
      if (need > 0) {
        let qty = Math.ceil(need / INNER_PACK) * INNER_PACK;
        if (qty < agg.moq) qty = agg.moq;
        recommendedReorderQty = qty;
      }
    }

    const excludedFromReorder = excludeVelocities.has(velocity);
    const exclusionReason = excludedFromReorder
      ? `${velocity} seller (${projectedWeeklyRate}/wk)`
      : null;

    let urgencyLevel: ForecastResult["urgencyLevel"] = "ok";
    if (recommendedReorderQty > 0) {
      if (available === 0 && inc.units === 0) urgencyLevel = "critical";
      else if (effectiveDaysOfCover <= leadDays) urgencyLevel = "critical";
      else if (effectiveDaysOfCover <= leadDays + 14) urgencyLevel = "urgent";
      else if (effectiveDaysOfCover <= leadDays + 30) urgencyLevel = "watch";
    }

    const notesParts: string[] = [];
    if (trendDirection === "accelerating") notesParts.push("📈 accelerating");
    if (trendDirection === "decelerating") notesParts.push("📉 decelerating");
    if (inc.units > 0) notesParts.push(`🚢 ${inc.units} on order${inc.arrival ? ` (ETA ${inc.arrival})` : ""}`);
    if (seasonalFactor > 1.2) notesParts.push(`🌞 peak season ×${seasonalFactor}`);
    if (seasonalFactor < 0.8) notesParts.push(`❄️ low season ×${seasonalFactor}`);
    if (excludedFromReorder) notesParts.push(`⏸ ${exclusionReason}`);

    results.push({
      skuId: agg.skuId,
      sku: root,
      productName: agg.productName,
      colorName: agg.colorName,
      factoryCode: agg.factoryCode ?? "?",
      factoryName: agg.factoryName ?? "?",
      currentStock: agg.quantity,
      reservedStock: agg.reserved,
      availableStock: available,
      incomingUnits: inc.units,
      incomingArrival: inc.arrival,
      sellThrough30d: rate30,
      sellThrough60d: rate60,
      sellThrough90d: rate90,
      trendDirection,
      projectedWeeklyRate,
      velocity,
      projectedStockoutDate,
      daysUntilStockout,
      effectiveDaysOfCover,
      safetyStock,
      recommendedReorderQty,
      excludedFromReorder,
      exclusionReason,
      targetStockDays,
      urgencyLevel,
      seasonalFactor,
      seasonalitySource,
      notes: notesParts.join(" · "),
    });
  }

  const urgencyOrder = { critical: 0, urgent: 1, watch: 2, ok: 3 };
  results.sort(
    (a, b) =>
      urgencyOrder[a.urgencyLevel] - urgencyOrder[b.urgencyLevel] ||
      a.effectiveDaysOfCover - b.effectiveDaysOfCover,
  );

  return results;
}
