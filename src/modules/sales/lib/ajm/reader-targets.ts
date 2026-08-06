/**
 * Reading-glasses launch targeting.
 *
 * Jaxy launches its reading-glasses line in Aug 2026. AJM sold readers for
 * years, so their order history names exactly which retailers buy readers —
 * and how much they spent. This ranks those buyers so marketing can go after
 * the highest-intent accounts first, and links them to Frame companies /
 * contacts where we already know them.
 *
 * Segments (a customer can be in several):
 *   reader_led    reader revenue > sunglass revenue — readers are their thing
 *   reader_heavy  readers >= 50% of their AJM revenue
 *   any_reader    bought readers at all
 */
import { sqlite } from "@/lib/db";
import { READER_CATEGORIES } from "./categorize";
import { AJM_WHOLESALE_SOURCES } from "./channels";

export type ReaderSegment = "reader_led" | "reader_heavy" | "any_reader";

export interface ReaderTarget {
  groupKey: string;
  companyId: string | null;
  accountId: string | null;
  name: string;
  email: string | null;
  city: string | null;
  state: string | null;
  sources: string;
  readerRevenue: number;
  sunRevenue: number;
  totalRevenue: number;
  readerUnits: number;
  readerSharePct: number;
  orders: number;
  firstOrder: string | null;
  lastOrder: string | null;
  /** Jaxy lifetime value — 0/null means they've never bought from us. */
  jaxyLtv: number | null;
  jaxyLastOrder: string | null;
  topReaderStyles: string;
  segments: ReaderSegment[];
}

const READERS_SQL = READER_CATEGORIES.map((c) => `'${c}'`).join(",");

export function getReaderTargets(opts?: {
  segment?: ReaderSegment | "all";
  matchedOnly?: boolean;
  /** Only customers with no Jaxy orders (pure win-back / new-business list). */
  noJaxyOnly?: boolean;
  /** Restrict to buyers from these AJM channels. Defaults to the canonical
   *  WHOLESALE set (Shopify wholesale + Faire + OMS — see channels.ts) because
   *  the reader launch is a wholesale motion; retail rows are individual
   *  consumers and would swamp the list. Pass ["all"] to include retail. */
  sources?: string[];
  q?: string;
  limit?: number;
}): { total: number; totals: { readerRevenue: number; customers: number }; targets: ReaderTarget[] } {
  const sources = opts?.sources?.length ? opts.sources : [...AJM_WHOLESALE_SOURCES];
  const sourceFilter = sources.includes("all")
    ? ""
    : `AND o.source IN (${sources.map((s) => `'${s.replace(/'/g, "")}'`).join(",")})`;
  const rows = sqlite.prepare(`
    SELECT
      COALESCE(o.company_id, 'raw:' || LOWER(COALESCE(o.customer_name,'?'))) AS groupKey,
      o.company_id AS companyId,
      MAX(ca.id) AS accountId,
      MAX(COALESCE(c.name, o.customer_name)) AS name,
      MAX(COALESCE(o.email, fe.email)) AS email,
      MAX(o.city) AS city, MAX(o.state) AS state,
      GROUP_CONCAT(DISTINCT o.source) AS sources,
      COUNT(DISTINCT o.id) AS orders,
      MIN(o.order_date) AS firstOrder,
      MAX(o.order_date) AS lastOrder,
      MAX(ca.lifetime_value) AS jaxyLtv,
      MAX(ca.last_order_at) AS jaxyLastOrder,
      ROUND(SUM(CASE WHEN i.category IN (${READERS_SQL}) THEN i.line_total ELSE 0 END), 2) AS readerRevenue,
      ROUND(SUM(CASE WHEN i.category = 'sun' THEN i.line_total ELSE 0 END), 2) AS sunRevenue,
      ROUND(SUM(i.line_total), 2) AS totalRevenue,
      SUM(CASE WHEN i.category IN (${READERS_SQL}) THEN i.quantity ELSE 0 END) AS readerUnits
    FROM ajm_orders o
    JOIN ajm_order_items i ON i.order_id = o.id
    LEFT JOIN companies c ON c.id = o.company_id
    LEFT JOIN customer_accounts ca ON ca.company_id = o.company_id
    LEFT JOIN ajm_faire_emails fe
      ON fe.store_name_norm = LOWER(TRIM(REPLACE(REPLACE(COALESCE(o.customer_name,''), '.', ''), ',', '')))
    WHERE o.cancelled = 0 ${sourceFilter}
    GROUP BY groupKey
    HAVING readerRevenue > 0
    ORDER BY readerRevenue DESC
  `).all() as Array<Omit<ReaderTarget, "readerSharePct" | "segments" | "topReaderStyles">>;

  const styleStmt = sqlite.prepare(`
    SELECT i.product_name AS n, SUM(i.quantity) AS u
    FROM ajm_orders o JOIN ajm_order_items i ON i.order_id = o.id
    WHERE o.cancelled = 0 AND i.category IN (${READERS_SQL})
      AND (o.company_id = ? OR (? IS NULL AND LOWER(o.customer_name) = ?))
    GROUP BY i.product_name ORDER BY u DESC LIMIT 3
  `);

  let targets: ReaderTarget[] = rows.map((r) => {
    const share = r.totalRevenue > 0 ? (r.readerRevenue / r.totalRevenue) * 100 : 0;
    const segments: ReaderSegment[] = ["any_reader"];
    if (r.readerRevenue > r.sunRevenue) segments.push("reader_led");
    if (share >= 50) segments.push("reader_heavy");
    return { ...r, readerSharePct: Math.round(share * 10) / 10, segments, topReaderStyles: "" };
  });

  const segment = opts?.segment ?? "all";
  if (segment !== "all") targets = targets.filter((t) => t.segments.includes(segment));
  if (opts?.matchedOnly) targets = targets.filter((t) => t.companyId);
  if (opts?.noJaxyOnly) targets = targets.filter((t) => !(t.jaxyLtv && t.jaxyLtv > 0));
  const q = (opts?.q ?? "").trim().toLowerCase();
  if (q) targets = targets.filter((t) => (t.name ?? "").toLowerCase().includes(q));

  const total = targets.length;
  const totals = {
    readerRevenue: Math.round(targets.reduce((s, t) => s + t.readerRevenue, 0) * 100) / 100,
    customers: total,
  };

  const limit = Math.min(opts?.limit ?? 200, 2000);
  targets = targets.slice(0, limit);
  // Top reader styles only for the page we return (cheap enough per row).
  for (const t of targets) {
    const raw = t.companyId ? null : t.groupKey.replace(/^raw:/, "");
    const styles = styleStmt.all(t.companyId, t.companyId, raw) as Array<{ n: string }>;
    t.topReaderStyles = styles.map((s) => s.n).join(", ");
  }
  return { total, totals, targets };
}

/** Category rollup for the AJM analysis page (per source + overall). */
export function getCategoryBreakdown() {
  const overall = sqlite.prepare(`
    SELECT i.category, COUNT(*) AS lines, SUM(i.quantity) AS units, ROUND(SUM(i.line_total), 2) AS revenue
    FROM ajm_order_items i JOIN ajm_orders o ON o.id = i.order_id
    WHERE o.cancelled = 0 GROUP BY i.category ORDER BY revenue DESC
  `).all();
  const bySource = sqlite.prepare(`
    SELECT o.source, i.category, ROUND(SUM(i.line_total), 2) AS revenue, SUM(i.quantity) AS units
    FROM ajm_order_items i JOIN ajm_orders o ON o.id = i.order_id
    WHERE o.cancelled = 0 GROUP BY o.source, i.category
  `).all();
  const byYear = sqlite.prepare(`
    SELECT substr(o.order_date, 1, 4) AS year, i.category, ROUND(SUM(i.line_total), 2) AS revenue
    FROM ajm_order_items i JOIN ajm_orders o ON o.id = i.order_id
    WHERE o.cancelled = 0 AND o.order_date IS NOT NULL
    GROUP BY year, i.category ORDER BY year
  `).all();
  const topReaderProducts = sqlite.prepare(`
    SELECT i.product_name AS product, SUM(i.quantity) AS units, ROUND(SUM(i.line_total), 2) AS revenue,
           COUNT(DISTINCT o.company_id) AS buyers
    FROM ajm_order_items i JOIN ajm_orders o ON o.id = i.order_id
    WHERE o.cancelled = 0 AND i.category IN (${READERS_SQL})
    GROUP BY i.product_name ORDER BY revenue DESC LIMIT 25
  `).all();
  return { overall, bySource, byYear, topReaderProducts };
}
