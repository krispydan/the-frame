/**
 * AJ Morgan comparison MCP tools.
 *
 * Lets Claude answer open questions about the acquired brand's history vs
 * Jaxy's own performance — channel/category/period comparisons, the sales-gap
 * decomposition, reader-launch targeting, and win-back accounts — without
 * anyone hand-writing SQL.
 */
import { mcpRegistry } from "@/modules/core/mcp/server";
import { sqlite } from "@/lib/db";
import { z } from "zod";
import { analyzeGap } from "@/modules/sales/lib/ajm/gap-analysis";
import { getReaderTargets, getCategoryBreakdown } from "@/modules/sales/lib/ajm/reader-targets";
import { READER_CATEGORIES } from "@/modules/sales/lib/ajm/categorize";
import { AJM_CHANNEL_SQL, JAXY_CHANNEL_SQL, AJM_WHOLESALE_SOURCES, AJM_DATA_FROM, AJM_DATE_FILTER } from "@/modules/sales/lib/ajm/channels";

const READERS = READER_CATEGORIES.map((c) => `'${c}'`).join(",");

/** MCP handlers must return the content envelope; keep the call sites clean. */
const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });

// ── ajm.gap_analysis ──
mcpRegistry.register(
  "ajm.gap_analysis",
  "Explain why Jaxy's sales trail AJ Morgan's: decomposes the gap into the reading-glasses category Jaxy did not stock, fewer active customers, lower order frequency and average order value. AJ Morgan was a 40-year-old business that CEASED TRADING Dec 2025 — treat it as a seasonal benchmark and an orphaned customer book, not a live competitor. Reports the comparison basis and whether the datasets overlap in time (they do not, so figures are normalized to monthly rates).",
  z.object({
    mode: z.enum(["overlap", "trailing12"]).optional()
      .describe("overlap = same calendar window both datasets cover; trailing12 = each brand's own last 12 months (used automatically when they don't overlap)"),
  }),
  async (args) => ok(analyzeGap({ mode: args.mode })),
);

// ── ajm.compare ──
mcpRegistry.register(
  "ajm.compare",
  "Compare AJ Morgan and Jaxy revenue/orders over time, by year or month. Channels are WHOLESALE (Shopify wholesale + Faire, both brands) and RETAIL (DTC), plus Amazon for Jaxy. Includes AJM's sunglasses-vs-readers split. NOTE: sunglasses are seasonal (AJM peaks Mar-Jun, Dec is ~a third of peak), so compare the same calendar months — pass from/to to align windows. AJ Morgan ceased trading Dec 2025.",
  z.object({
    grain: z.enum(["year", "month"]).optional().describe("Default year"),
    from: z.string().optional().describe("ISO date lower bound, e.g. 2024-01-01"),
    to: z.string().optional().describe("ISO date upper bound"),
  }),
  async (args) => {
    const fmt = args.grain === "month" ? "%Y-%m" : "%Y";
    const from = args.from ?? AJM_DATA_FROM;
    const to = args.to ?? "9999-12-31";
    const ajm = sqlite.prepare(`
      SELECT strftime('${fmt}', o.order_date) AS period,
             ${AJM_CHANNEL_SQL("o")} AS channel,
             ROUND(SUM(o.total),2) AS revenue, COUNT(*) AS orders
      FROM ajm_orders o WHERE o.cancelled=0 AND o.order_date BETWEEN ? AND ? ${AJM_DATE_FILTER('o')}
      GROUP BY period, channel ORDER BY period`).all(from, to);
    const jaxy = sqlite.prepare(`
      SELECT strftime('${fmt}', o.placed_at) AS period,
             ${JAXY_CHANNEL_SQL("o")} AS channel,
             ROUND(SUM(o.total),2) AS revenue, COUNT(*) AS orders
      FROM orders o WHERE o.status NOT IN ('cancelled','returned') AND o.placed_at BETWEEN ? AND ?
      GROUP BY period, channel ORDER BY period`).all(from, to + "T23:59:59");
    const ajmCategory = sqlite.prepare(`
      SELECT strftime('${fmt}', o.order_date) AS period,
             CASE WHEN i.category='sun' THEN 'sunglasses' WHEN i.category IN (${READERS}) THEN 'readers' ELSE 'other/unknown' END AS category,
             ROUND(SUM(i.line_total),2) AS revenue
      FROM ajm_orders o JOIN ajm_order_items i ON i.order_id=o.id
      WHERE o.cancelled=0 AND o.order_date BETWEEN ? AND ? ${AJM_DATE_FILTER('o')}
      GROUP BY period, category ORDER BY period`).all(from, to);
    return ok({ ajm, jaxy, ajmCategory });
  },
);

// ── ajm.reader_targets ──
mcpRegistry.register(
  "ajm.reader_targets",
  "Retailers who bought READING GLASSES from AJ Morgan, ranked by reader spend — the target list for Jaxy's reading-glasses launch. Includes reader share of their spend, top reader styles, and whether they currently buy from Jaxy.",
  z.object({
    segment: z.enum(["reader_led", "reader_heavy", "any_reader", "all"]).optional()
      .describe("reader_led = readers outsold sunglasses for them (default); reader_heavy = readers >=50% of spend"),
    include_retail: z.boolean().optional().describe("Include individual retail consumers (default false — wholesale accounts only)"),
    only_without_jaxy_orders: z.boolean().optional().describe("Only accounts that have never bought from Jaxy"),
    search: z.string().optional(),
    limit: z.number().optional().describe("Default 50"),
  }),
  async (args) => ok(getReaderTargets({
    segment: args.segment ?? "reader_led",
    sources: args.include_retail ? ["all"] : [...AJM_WHOLESALE_SOURCES],
    noJaxyOnly: args.only_without_jaxy_orders,
    q: args.search,
    limit: Math.min(args.limit ?? 50, 500),
  })),
);

// ── ajm.categories ──
mcpRegistry.register(
  "ajm.categories",
  "AJ Morgan revenue split by product category (sunglasses, reading glasses, blue-light readers, sunglass readers, accessories) overall, per sales channel and per year, plus the top-selling reader products. Also reports revenue that could not be attributed to a product.",
  z.object({}),
  async () => ok(getCategoryBreakdown()),
);

// ── ajm.customers ──
mcpRegistry.register(
  "ajm.customers",
  "Query AJ Morgan's customer base: AJM spend, order counts, date ranges, channels, reader-vs-sunglass mix, and each customer's current Jaxy lifetime value. Use filter=dormant to find accounts that bought from AJM but never from Jaxy — these are ORPHANED (AJM ceased trading Dec 2025), not lost to a competitor, and Jaxy employs the rep who owned those relationships.",
  z.object({
    filter: z.enum(["all", "matched", "unmatched", "dormant"]).optional()
      .describe("dormant = matched to a Frame company but zero Jaxy revenue"),
    search: z.string().optional(),
    min_ajm_revenue: z.number().optional(),
    limit: z.number().optional().describe("Default 50"),
  }),
  async (args) => {
    // Order totals and line-level category sums are aggregated SEPARATELY
    // then joined: doing both in one query (orders JOIN items, SUM(o.total))
    // multiplies each order total by its line count.
    const rows = sqlite.prepare(`
      WITH ord AS (
        SELECT COALESCE(company_id, 'raw:' || LOWER(COALESCE(customer_name,'?'))) AS groupKey,
               company_id, MAX(customer_name) AS rawName,
               COUNT(*) AS ajmOrders, ROUND(SUM(total),2) AS ajmRevenue,
               MIN(order_date) AS firstOrder, MAX(order_date) AS lastOrder,
               GROUP_CONCAT(DISTINCT source) AS channels
        FROM ajm_orders o WHERE cancelled = 0 ${AJM_DATE_FILTER('o')} GROUP BY groupKey
      ),
      cats AS (
        SELECT COALESCE(o.company_id, 'raw:' || LOWER(COALESCE(o.customer_name,'?'))) AS groupKey,
               ROUND(SUM(CASE WHEN i.category IN (${READERS}) THEN i.line_total ELSE 0 END),2) AS readerRevenue,
               ROUND(SUM(CASE WHEN i.category='sun' THEN i.line_total ELSE 0 END),2) AS sunRevenue
        FROM ajm_orders o JOIN ajm_order_items i ON i.order_id = o.id
        WHERE o.cancelled = 0 ${AJM_DATE_FILTER('o')} GROUP BY groupKey
      )
      SELECT ord.groupKey, ord.company_id AS companyId,
             COALESCE(c.name, ord.rawName) AS name,
             ca.id AS accountId, ca.lifetime_value AS jaxyLtv, ca.last_order_at AS jaxyLastOrder,
             ord.ajmOrders, ord.ajmRevenue, ord.firstOrder, ord.lastOrder, ord.channels,
             COALESCE(cats.readerRevenue,0) AS readerRevenue,
             COALESCE(cats.sunRevenue,0) AS sunRevenue
      FROM ord
      LEFT JOIN cats ON cats.groupKey = ord.groupKey
      LEFT JOIN companies c ON c.id = ord.company_id
      LEFT JOIN customer_accounts ca ON ca.company_id = ord.company_id
      ORDER BY ord.ajmRevenue DESC
    `).all() as Array<Record<string, unknown>>;
    let out = rows;
    const f = args.filter ?? "all";
    if (f === "matched") out = out.filter((r) => r.companyId);
    else if (f === "unmatched") out = out.filter((r) => !r.companyId);
    else if (f === "dormant") out = out.filter((r) => r.companyId && !(Number(r.jaxyLtv) > 0));
    if (args.min_ajm_revenue) out = out.filter((r) => Number(r.ajmRevenue) >= args.min_ajm_revenue!);
    if (args.search) {
      const q = args.search.toLowerCase();
      out = out.filter((r) => String(r.name ?? "").toLowerCase().includes(q));
    }
    return ok({ total: out.length, customers: out.slice(0, Math.min(args.limit ?? 50, 500)) });
  },
);

// ── ajm.products ──
mcpRegistry.register(
  "ajm.products",
  "AJ Morgan product/style performance: units, revenue and distinct buyers per product, filterable by category. Useful for deciding which reader styles Jaxy should stock.",
  z.object({
    category: z.enum(["sun", "reading", "blue_light", "sunglass_reader", "accessory", "readers", "all"]).optional(),
    limit: z.number().optional().describe("Default 30"),
  }),
  async (args) => {
    const cat = args.category ?? "all";
    const where = cat === "all" ? "" : cat === "readers" ? `AND i.category IN (${READERS})` : `AND i.category = '${cat}'`;
    return ok(sqlite.prepare(`
      SELECT i.product_name AS product, i.category, SUM(i.quantity) AS units,
             ROUND(SUM(i.line_total),2) AS revenue,
             COUNT(DISTINCT COALESCE(o.company_id, o.customer_name)) AS buyers
      FROM ajm_order_items i JOIN ajm_orders o ON o.id = i.order_id
      WHERE o.cancelled = 0 ${AJM_DATE_FILTER('o')} ${where}
      GROUP BY i.product_name ORDER BY revenue DESC LIMIT ?
    `).all(Math.min(args.limit ?? 30, 200)));
  },
);

export const ajmMcpToolNames = [
  "ajm.gap_analysis", "ajm.compare", "ajm.reader_targets",
  "ajm.categories", "ajm.customers", "ajm.products",
];
