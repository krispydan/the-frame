/**
 * Product performance analytics — the "what's actually selling, to whom, and
 * where is it heading" layer that sits between raw orders and the reorder
 * decision.
 *
 * Everything is computed at the ROOT (colorway) SKU grain and resolved through
 * the same pack/alias-aware resolver the demand forecaster uses, so units here
 * always agree with the forecast and the reorder report.
 *
 * Per product it answers:
 *   - Channel split: wholesale vs retail units/revenue (a frame that only moves
 *     DTC is a very different reorder decision than one 40 doors reorder).
 *   - Trend: recent half-window vs prior half — rising / falling / steady.
 *   - AOQ (avg order quantity): units per order line containing it. High AOQ =
 *     stores buy it deep, so it carries a PO and belongs in the catalog.
 *   - Reach & stickiness: how many distinct accounts bought it, and how many
 *     came back for it a second time (the repeat signal — hero products).
 *   - Margin: gross profit and margin % using catalog cost price.
 *   - Stock position: on-hand, cover days, velocity — so a rising seller with
 *     thin cover surfaces as a risk, not a win.
 */

import { sqlite } from "@/lib/db";
import { makeRootResolver, rootSkuOf } from "./demand";
import { parsePackSize } from "@/modules/finance/lib/pack-size";

/** Only true DTC counts as retail; every other channel is a wholesale door. */
const RETAIL_CHANNELS = new Set(["shopify_dtc"]);

export type TrendDirection = "rising" | "falling" | "steady" | "new";

export interface ProductPerformanceRow {
  rootSku: string;
  productName: string;
  colorName: string;
  factoryCode: string | null;
  // Volume
  units: number;
  revenue: number;
  unitsWholesale: number;
  revenueWholesale: number;
  unitsRetail: number;
  revenueRetail: number;
  /** 0–100; share of UNITS that went through wholesale channels. */
  wholesaleSharePct: number;
  // Depth / reach
  orderLines: number;
  avgOrderQty: number;
  accounts: number;
  repeatAccounts: number;
  repeatRatePct: number;
  // Trend (recent half-window vs prior half-window, by units)
  unitsRecent: number;
  unitsPrior: number;
  trendPct: number | null;
  trend: TrendDirection;
  // Money
  unitCost: number | null;
  grossProfit: number | null;
  marginPct: number | null;
  // Stock
  onHand: number;
  available: number;
  weeklyRate: number;
  daysCover: number | null;
}

export interface ProductPerformanceResult {
  windowDays: number;
  generatedAt: string;
  totals: {
    units: number;
    revenue: number;
    unitsWholesale: number;
    unitsRetail: number;
    wholesaleSharePct: number;
    products: number;
  };
  rows: ProductPerformanceRow[];
}

interface RawLine {
  sku: string | null;
  sku_id: string | null;
  quantity: number;
  total_price: number | null;
  unit_price: number | null;
  channel: string;
  company_id: string | null;
  order_id: string;
  placed_at: string;
}

/** Cost per root SKU: prefer the exact colorway row, else average its variants. */
function loadUnitCosts(): Map<string, number> {
  const rows = sqlite
    .prepare("SELECT sku, cost_price FROM catalog_skus WHERE cost_price IS NOT NULL AND cost_price > 0")
    .all() as Array<{ sku: string; cost_price: number }>;
  const exact = new Map<string, number>();
  const agg = new Map<string, { sum: number; n: number }>();
  for (const r of rows) {
    const root = rootSkuOf(r.sku);
    if (!root) continue;
    if (r.sku.toUpperCase() === root) exact.set(root, r.cost_price);
    const a = agg.get(root) ?? { sum: 0, n: 0 };
    a.sum += r.cost_price;
    a.n += 1;
    agg.set(root, a);
  }
  const out = new Map<string, number>();
  for (const [root, a] of agg) out.set(root, exact.get(root) ?? a.sum / a.n);
  return out;
}

/** Stock + persisted velocity per root SKU. */
function loadStock(): Map<string, { onHand: number; available: number; weeklyRate: number }> {
  const rows = sqlite
    .prepare(
      `SELECT s.sku, i.quantity, i.reserved_quantity, i.sell_through_weekly
         FROM inventory i JOIN catalog_skus s ON s.id = i.sku_id
        WHERE i.location = 'warehouse'`,
    )
    .all() as Array<{ sku: string; quantity: number; reserved_quantity: number; sell_through_weekly: number | null }>;
  const out = new Map<string, { onHand: number; available: number; weeklyRate: number }>();
  for (const r of rows) {
    const root = rootSkuOf(r.sku);
    if (!root) continue;
    const cur = out.get(root) ?? { onHand: 0, available: 0, weeklyRate: 0 };
    cur.onHand += r.quantity ?? 0;
    cur.available += Math.max(0, (r.quantity ?? 0) - (r.reserved_quantity ?? 0));
    cur.weeklyRate += r.sell_through_weekly ?? 0;
    out.set(root, cur);
  }
  return out;
}

/** Display names + factory per root SKU. */
function loadMeta(): Map<string, { productName: string; colorName: string; factoryCode: string | null }> {
  const rows = sqlite
    .prepare(
      `SELECT s.sku, s.color_name, p.name AS product_name
         FROM catalog_skus s JOIN catalog_products p ON p.id = s.product_id`,
    )
    .all() as Array<{ sku: string; color_name: string | null; product_name: string }>;
  const out = new Map<string, { productName: string; colorName: string; factoryCode: string | null }>();
  for (const r of rows) {
    const root = rootSkuOf(r.sku);
    if (!root) continue;
    const isExact = r.sku.toUpperCase() === root;
    if (!out.has(root) || isExact) {
      out.set(root, {
        productName: r.product_name,
        colorName: r.color_name ?? "",
        factoryCode: root.slice(0, 3),
      });
    }
  }
  return out;
}

export function getProductPerformance(
  opts: { windowDays?: number; limit?: number } = {},
): ProductPerformanceResult {
  const windowDays = opts.windowDays ?? 90;
  const start = new Date(Date.now() - windowDays * 86400000).toISOString();
  const midpoint = new Date(Date.now() - (windowDays / 2) * 86400000).toISOString();

  const lines = sqlite
    .prepare(
      `SELECT oi.sku, oi.sku_id, oi.quantity, oi.total_price, oi.unit_price,
              o.channel, o.company_id, o.id AS order_id,
              COALESCE(o.placed_at, o.created_at) AS placed_at
         FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE o.status NOT IN ('cancelled','returned')
          AND COALESCE(o.placed_at, o.created_at) >= ?`,
    )
    .all(start) as RawLine[];

  const resolve = makeRootResolver();

  interface Acc {
    units: number; revenue: number;
    unitsWholesale: number; revenueWholesale: number;
    unitsRetail: number; revenueRetail: number;
    orderLines: number;
    unitsRecent: number; unitsPrior: number;
    orders: Set<string>;
    accounts: Map<string, Set<string>>; // company -> distinct order ids
  }
  const acc = new Map<string, Acc>();

  for (const line of lines) {
    const root = resolve(line.sku, line.sku_id);
    if (!root) continue;
    const units = (line.quantity ?? 0) * parsePackSize(line.sku);
    if (units <= 0) continue;
    const revenue = line.total_price ?? (line.unit_price ?? 0) * (line.quantity ?? 0);
    const isRetail = RETAIL_CHANNELS.has(line.channel);

    let a = acc.get(root);
    if (!a) {
      a = {
        units: 0, revenue: 0,
        unitsWholesale: 0, revenueWholesale: 0,
        unitsRetail: 0, revenueRetail: 0,
        orderLines: 0, unitsRecent: 0, unitsPrior: 0,
        orders: new Set(), accounts: new Map(),
      };
      acc.set(root, a);
    }
    a.units += units;
    a.revenue += revenue;
    a.orderLines += 1;
    a.orders.add(line.order_id);
    if (isRetail) {
      a.unitsRetail += units;
      a.revenueRetail += revenue;
    } else {
      a.unitsWholesale += units;
      a.revenueWholesale += revenue;
      if (line.company_id) {
        const set = a.accounts.get(line.company_id) ?? new Set<string>();
        set.add(line.order_id);
        a.accounts.set(line.company_id, set);
      }
    }
    if (line.placed_at >= midpoint) a.unitsRecent += units;
    else a.unitsPrior += units;
  }

  const costs = loadUnitCosts();
  const stock = loadStock();
  const meta = loadMeta();

  const rows: ProductPerformanceRow[] = [];
  for (const [rootSku, a] of acc) {
    const m = meta.get(rootSku);
    const st = stock.get(rootSku) ?? { onHand: 0, available: 0, weeklyRate: 0 };
    const unitCost = costs.get(rootSku) ?? null;
    const grossProfit = unitCost != null ? a.revenue - unitCost * a.units : null;
    const marginPct = grossProfit != null && a.revenue > 0 ? (grossProfit / a.revenue) * 100 : null;

    // Trend: needs enough volume in the window for the comparison to mean
    // anything, otherwise a 1→2 unit move reads as "+100%".
    let trendPct: number | null = null;
    let trend: TrendDirection = "steady";
    if (a.unitsPrior === 0 && a.unitsRecent > 0) {
      trend = "new";
    } else if (a.units >= 8 && a.unitsPrior > 0) {
      trendPct = ((a.unitsRecent - a.unitsPrior) / a.unitsPrior) * 100;
      if (trendPct >= 20) trend = "rising";
      else if (trendPct <= -20) trend = "falling";
    }

    const accounts = a.accounts.size;
    const repeatAccounts = [...a.accounts.values()].filter((orders) => orders.size >= 2).length;
    const dailyRate = st.weeklyRate / 7;

    rows.push({
      rootSku,
      productName: m?.productName ?? rootSku,
      colorName: m?.colorName ?? "",
      factoryCode: m?.factoryCode ?? null,
      units: a.units,
      revenue: Math.round(a.revenue * 100) / 100,
      unitsWholesale: a.unitsWholesale,
      revenueWholesale: Math.round(a.revenueWholesale * 100) / 100,
      unitsRetail: a.unitsRetail,
      revenueRetail: Math.round(a.revenueRetail * 100) / 100,
      wholesaleSharePct: a.units > 0 ? (a.unitsWholesale / a.units) * 100 : 0,
      orderLines: a.orderLines,
      avgOrderQty: a.orderLines > 0 ? a.units / a.orderLines : 0,
      accounts,
      repeatAccounts,
      repeatRatePct: accounts > 0 ? (repeatAccounts / accounts) * 100 : 0,
      unitsRecent: a.unitsRecent,
      unitsPrior: a.unitsPrior,
      trendPct,
      trend,
      unitCost,
      grossProfit: grossProfit != null ? Math.round(grossProfit * 100) / 100 : null,
      marginPct,
      onHand: st.onHand,
      available: st.available,
      weeklyRate: st.weeklyRate,
      daysCover: dailyRate > 0 ? Math.round(st.available / dailyRate) : null,
    });
  }

  rows.sort((x, y) => y.revenue - x.revenue);
  const limited = opts.limit ? rows.slice(0, opts.limit) : rows;

  const totals = rows.reduce(
    (t, r) => {
      t.units += r.units;
      t.revenue += r.revenue;
      t.unitsWholesale += r.unitsWholesale;
      t.unitsRetail += r.unitsRetail;
      return t;
    },
    { units: 0, revenue: 0, unitsWholesale: 0, unitsRetail: 0, wholesaleSharePct: 0, products: rows.length },
  );
  totals.wholesaleSharePct = totals.units > 0 ? (totals.unitsWholesale / totals.units) * 100 : 0;
  totals.revenue = Math.round(totals.revenue * 100) / 100;

  return { windowDays, generatedAt: new Date().toISOString(), totals, rows: limited };
}

/**
 * Biggest movers in both directions — products whose unit velocity changed most
 * between the two halves of the window. Filters out noise (needs real volume)
 * so the list is actionable rather than a long tail of 1-unit swings.
 */
export function getMovers(opts: { windowDays?: number; limit?: number } = {}) {
  const { rows } = getProductPerformance({ windowDays: opts.windowDays ?? 60 });
  const limit = opts.limit ?? 5;
  const scored = rows.filter((r) => r.trendPct != null && r.units >= 8);
  const rising = [...scored].sort((a, b) => (b.trendPct ?? 0) - (a.trendPct ?? 0)).slice(0, limit);
  const falling = [...scored].sort((a, b) => (a.trendPct ?? 0) - (b.trendPct ?? 0)).filter((r) => (r.trendPct ?? 0) < 0).slice(0, limit);
  const breakout = rows.filter((r) => r.trend === "new" && r.units >= 8).sort((a, b) => b.units - a.units).slice(0, limit);
  return { rising, falling, breakout };
}
