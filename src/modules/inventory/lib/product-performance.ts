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
  /** Units on open (not yet received) purchase orders. */
  onOrder: number;
  /** Which POs those units are on, soonest arrival first. */
  onOrderPos: OnOrderPo[];
  /** On-hand + on-order — the position that matters for a reorder decision. */
  totalPosition: number;
  /**
   * Cover including inbound stock. A product with 10 days on hand and a
   * container landing next week is not the same emergency as one with 10 days
   * and nothing ordered, and the old daysCover couldn't tell them apart.
   */
  daysCoverWithIncoming: number | null;
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
    onHand: number;
    onOrder: number;
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

/**
 * Units on open purchase orders per root SKU, plus the per-PO breakdown so the
 * UI can show *which* POs and when they land.
 *
 * "Open" = ordered but not yet in the warehouse. Received/complete POs are
 * already counted in on-hand, so including them would double-count; cancelled
 * ones are never arriving. Quantity is normalized to true units (quantity ×
 * pack_size) to match how on-hand and the forecast count.
 */
const OPEN_PO_STATUSES = ["draft", "submitted", "confirmed", "in_production", "shipped", "in_transit"];

export interface OnOrderPo {
  poId: string;
  poNumber: string;
  factory: string | null;
  status: string;
  units: number;
  expectedArrivalDate: string | null;
  expectedShipDate: string | null;
}

function loadOnOrder(): Map<string, { onOrder: number; pos: OnOrderPo[] }> {
  const rows = sqlite
    .prepare(
      `SELECT s.sku, li.quantity, li.pack_size,
              po.id AS po_id, po.po_number, po.status,
              po.expected_arrival_date, po.expected_ship_date,
              f.name AS factory
         FROM inventory_po_line_items li
         JOIN inventory_purchase_orders po ON po.id = li.po_id
         JOIN catalog_skus s ON s.id = li.sku_id
         LEFT JOIN inventory_factories f ON f.id = po.factory_id
        WHERE po.status IN (${OPEN_PO_STATUSES.map(() => "?").join(",")})`,
    )
    .all(...OPEN_PO_STATUSES) as Array<{
    sku: string; quantity: number; pack_size: number | null;
    po_id: string; po_number: string; status: string;
    expected_arrival_date: string | null; expected_ship_date: string | null; factory: string | null;
  }>;

  const out = new Map<string, { onOrder: number; pos: OnOrderPo[] }>();
  for (const r of rows) {
    const root = rootSkuOf(r.sku);
    if (!root) continue;
    const units = (r.quantity ?? 0) * (r.pack_size && r.pack_size > 0 ? r.pack_size : 1);
    if (units <= 0) continue;
    const cur = out.get(root) ?? { onOrder: 0, pos: [] };
    cur.onOrder += units;
    // One root SKU can appear on several lines of the same PO (different
    // powers/sizes roll up to the same colorway) — merge those into one entry.
    const existing = cur.pos.find((p) => p.poId === r.po_id);
    if (existing) {
      existing.units += units;
    } else {
      cur.pos.push({
        poId: r.po_id,
        poNumber: r.po_number,
        factory: r.factory,
        status: r.status,
        units,
        expectedArrivalDate: r.expected_arrival_date,
        expectedShipDate: r.expected_ship_date,
      });
    }
    out.set(root, cur);
  }
  // Soonest arrival first — that's the order a planner cares about.
  for (const v of out.values()) {
    v.pos.sort((a, b) => (a.expectedArrivalDate || "9999").localeCompare(b.expectedArrivalDate || "9999"));
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
  const onOrder = loadOnOrder();
  const meta = loadMeta();

  const rows: ProductPerformanceRow[] = [];
  for (const [rootSku, a] of acc) {
    const m = meta.get(rootSku);
    const st = stock.get(rootSku) ?? { onHand: 0, available: 0, weeklyRate: 0 };
    const oo = onOrder.get(rootSku) ?? { onOrder: 0, pos: [] };
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
      onOrder: oo.onOrder,
      onOrderPos: oo.pos,
      totalPosition: st.onHand + oo.onOrder,
      daysCoverWithIncoming: dailyRate > 0 ? Math.round((st.available + oo.onOrder) / dailyRate) : null,
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
      t.onHand += r.onHand;
      t.onOrder += r.onOrder;
      return t;
    },
    { units: 0, revenue: 0, unitsWholesale: 0, unitsRetail: 0, wholesaleSharePct: 0, products: rows.length, onHand: 0, onOrder: 0 },
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

// ── Colour performance ──

/**
 * Which colourways actually sell, and when.
 *
 * Style and colour are separate buying decisions: the factory makes a frame in
 * N colours and we choose the split. Product-level numbers can't answer "are we
 * over-buying tortoise", because a hit style masks a dead colour inside it and
 * vice versa. This rolls every order line up to the colour instead of the SKU.
 *
 * The "when" half matters more than the totals. Eyewear colour demand is
 * seasonal — brights lift in spring, tortoise and warm tones in autumn — so a
 * flat annual ranking will happily tell you to buy a colour in the month it
 * stops selling. Each colour therefore carries a month-by-month unit series and
 * its single peak month, computed over the same window as the totals.
 */

export interface ColorMonthPoint {
  /** "2026-03" */
  month: string;
  units: number;
  revenue: number;
}

export interface ColorPerformanceRow {
  color: string;
  units: number;
  revenue: number;
  unitsWholesale: number;
  unitsRetail: number;
  wholesaleSharePct: number;
  /** Share of all units in the window that were this colour (0–100). */
  unitSharePct: number;
  /** Distinct root SKUs (style × colour) sold in this colour. */
  products: number;
  /** Distinct accounts that bought this colour. */
  accounts: number;
  avgOrderQty: number;
  orderLines: number;
  // Trend, same recent-vs-prior-half method as products
  unitsRecent: number;
  unitsPrior: number;
  trendPct: number | null;
  trend: TrendDirection;
  // Stock position across every style in this colour
  onHand: number;
  onOrder: number;
  /** Weeks of cover at the window's average rate — is the buy in proportion? */
  weeksCover: number | null;
  // Seasonality
  byMonth: ColorMonthPoint[];
  /** Month with the most units ("2026-03"), null when there's no data. */
  peakMonth: string | null;
  /**
   * Peak month's units as a multiple of the average month. >1.5 means the
   * colour is genuinely seasonal rather than steady, which changes when you
   * want the container to land.
   */
  seasonalityIndex: number | null;
}

export interface ColorPerformanceResult {
  windowDays: number;
  generatedAt: string;
  months: string[];
  totals: { units: number; revenue: number; colors: number; onHand: number; onOrder: number };
  rows: ColorPerformanceRow[];
}

/**
 * Normalize a raw colour_name into a comparable label.
 *
 * Catalog colour names carry qualifiers ("Crystal Blue", "Matte Black") that we
 * keep — they're real buying choices, not noise — but casing and punctuation
 * drift between imports, which would otherwise split one colour into three rows.
 */
function normalizeColor(raw: string | null | undefined): string | null {
  const v = (raw || "").trim().replace(/\s+/g, " ");
  if (!v) return null;
  return v
    .toLowerCase()
    .split(" ")
    .map((w) => (w.length ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** Root SKU → normalized colour, from the catalog. */
function loadColorBySku(): Map<string, string> {
  const rows = sqlite
    .prepare("SELECT sku, color_name FROM catalog_skus WHERE TRIM(COALESCE(color_name,'')) <> ''")
    .all() as Array<{ sku: string; color_name: string }>;
  const out = new Map<string, string>();
  for (const r of rows) {
    const root = rootSkuOf(r.sku);
    const color = normalizeColor(r.color_name);
    if (!root || !color) continue;
    // Prefer the exact colorway row's own name over a variant's.
    if (!out.has(root) || r.sku.toUpperCase() === root) out.set(root, color);
  }
  return out;
}

export function getColorPerformance(opts: { windowDays?: number } = {}): ColorPerformanceResult {
  const windowDays = opts.windowDays ?? 365;
  // Colour seasonality needs a year by default — a 90-day window can't show you
  // that a colour peaks in March.
  const perf = getProductPerformance({ windowDays });
  const colorBySku = loadColorBySku();

  const start = new Date(Date.now() - windowDays * 86400000).toISOString();
  const midpoint = new Date(Date.now() - (windowDays / 2) * 86400000).toISOString();

  // Month-by-month + reach needs the raw lines again, resolved the same way.
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

  const resolveRoot = makeRootResolver();

  interface Acc {
    units: number; revenue: number;
    unitsWholesale: number; unitsRetail: number;
    unitsRecent: number; unitsPrior: number;
    orderLines: number;
    products: Set<string>;
    accounts: Set<string>;
    byMonth: Map<string, { units: number; revenue: number }>;
  }
  const acc = new Map<string, Acc>();
  const blank = (): Acc => ({
    units: 0, revenue: 0, unitsWholesale: 0, unitsRetail: 0, unitsRecent: 0, unitsPrior: 0,
    orderLines: 0, products: new Set(), accounts: new Set(), byMonth: new Map(),
  });

  const monthsSeen = new Set<string>();
  for (const line of lines) {
    const root = resolveRoot(line.sku, line.sku_id);
    if (!root) continue;
    const color = colorBySku.get(root);
    if (!color) continue;

    // Pack-aware unit count, matching getProductPerformance.
    const packSize = parsePackSize(line.sku) || 1;
    const units = (line.quantity ?? 0) * packSize;
    if (units <= 0) continue;
    const revenue = line.total_price ?? (line.unit_price ?? 0) * (line.quantity ?? 0);

    const a = acc.get(color) ?? blank();
    a.units += units;
    a.revenue += revenue;
    if (RETAIL_CHANNELS.has(line.channel)) a.unitsRetail += units;
    else a.unitsWholesale += units;
    if (line.placed_at >= midpoint) a.unitsRecent += units;
    else a.unitsPrior += units;
    a.orderLines += 1;
    a.products.add(root);
    if (line.company_id) a.accounts.add(line.company_id);

    const month = line.placed_at.slice(0, 7);
    monthsSeen.add(month);
    const m = a.byMonth.get(month) ?? { units: 0, revenue: 0 };
    m.units += units;
    m.revenue += revenue;
    a.byMonth.set(month, m);

    acc.set(color, a);
  }

  // Stock position per colour, from the already-computed product rows.
  const stockByColor = new Map<string, { onHand: number; onOrder: number }>();
  for (const r of perf.rows) {
    const color = colorBySku.get(r.rootSku);
    if (!color) continue;
    const cur = stockByColor.get(color) ?? { onHand: 0, onOrder: 0 };
    cur.onHand += r.onHand;
    cur.onOrder += r.onOrder;
    stockByColor.set(color, cur);
  }
  // A colour can hold stock without having sold in the window — that's exactly
  // the over-buy we want visible, so seed a row for it.
  for (const [color, s] of stockByColor) {
    if (!acc.has(color) && (s.onHand > 0 || s.onOrder > 0)) acc.set(color, blank());
  }

  const months = [...monthsSeen].sort();
  const totalUnits = [...acc.values()].reduce((t, a) => t + a.units, 0);
  const weeks = windowDays / 7;

  const rows: ColorPerformanceRow[] = [];
  for (const [color, a] of acc) {
    let trendPct: number | null = null;
    let trend: TrendDirection = "steady";
    if (a.unitsPrior === 0 && a.unitsRecent > 0) {
      trend = "new";
    } else if (a.units >= 8 && a.unitsPrior > 0) {
      trendPct = ((a.unitsRecent - a.unitsPrior) / a.unitsPrior) * 100;
      if (trendPct >= 20) trend = "rising";
      else if (trendPct <= -20) trend = "falling";
    }

    // Zero-fill every month in the window so the sparkline reads as a real
    // timeline — a colour that stopped selling in April should show a flat
    // tail, not a shorter line.
    const byMonth: ColorMonthPoint[] = months.map((m) => ({
      month: m,
      units: a.byMonth.get(m)?.units ?? 0,
      revenue: Math.round((a.byMonth.get(m)?.revenue ?? 0) * 100) / 100,
    }));

    let peakMonth: string | null = null;
    let seasonalityIndex: number | null = null;
    if (byMonth.length > 0 && a.units > 0) {
      const peak = byMonth.reduce((best, p) => (p.units > best.units ? p : best), byMonth[0]);
      peakMonth = peak.units > 0 ? peak.month : null;
      const avg = a.units / byMonth.length;
      seasonalityIndex = avg > 0 ? Math.round((peak.units / avg) * 100) / 100 : null;
    }

    const stock = stockByColor.get(color) ?? { onHand: 0, onOrder: 0 };
    const weeklyRate = a.units / weeks;

    rows.push({
      color,
      units: a.units,
      revenue: Math.round(a.revenue * 100) / 100,
      unitsWholesale: a.unitsWholesale,
      unitsRetail: a.unitsRetail,
      wholesaleSharePct: a.units > 0 ? (a.unitsWholesale / a.units) * 100 : 0,
      unitSharePct: totalUnits > 0 ? (a.units / totalUnits) * 100 : 0,
      products: a.products.size,
      accounts: a.accounts.size,
      avgOrderQty: a.orderLines > 0 ? a.units / a.orderLines : 0,
      orderLines: a.orderLines,
      unitsRecent: a.unitsRecent,
      unitsPrior: a.unitsPrior,
      trendPct,
      trend,
      onHand: stock.onHand,
      onOrder: stock.onOrder,
      weeksCover: weeklyRate > 0 ? Math.round(((stock.onHand + stock.onOrder) / weeklyRate) * 10) / 10 : null,
      byMonth,
      peakMonth,
      seasonalityIndex,
    });
  }

  rows.sort((x, y) => y.units - x.units);

  return {
    windowDays,
    generatedAt: new Date().toISOString(),
    months,
    totals: {
      units: totalUnits,
      revenue: Math.round(rows.reduce((t, r) => t + r.revenue, 0) * 100) / 100,
      colors: rows.length,
      onHand: rows.reduce((t, r) => t + r.onHand, 0),
      onOrder: rows.reduce((t, r) => t + r.onOrder, 0),
    },
    rows,
  };
}
