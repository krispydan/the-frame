/**
 * Daily and weekly Slack digests.
 *
 * Pull metrics from the local DB, format with friendly copy + emoji,
 * post via the digest topic. Designed to be called by Railway cron.
 */

import { sqlite } from "@/lib/db";
import { postSlack, type SlackBlock } from "./client";

function money(n: number, currency = "USD"): string {
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n); }
  catch { return `$${n.toFixed(2)}`; }
}

function pct(n: number): string {
  if (n > 0) return `+${n.toFixed(0)}%`;
  return `${n.toFixed(0)}%`;
}

type ChannelRevenue = { channel: string; revenue: number; orders: number };
type SkuTopRow = { sku: string; product_name: string; color_name: string | null; qty: number };

function loadChannelRevenue(sinceIso: string): ChannelRevenue[] {
  return sqlite.prepare(`
    SELECT channel, ROUND(SUM(total), 2) AS revenue, COUNT(*) AS orders
    FROM orders
    WHERE placed_at >= ? AND status != 'cancelled'
    GROUP BY channel
    ORDER BY revenue DESC
  `).all(sinceIso) as ChannelRevenue[];
}

function loadTopSkus(sinceIso: string, limit = 5): SkuTopRow[] {
  return sqlite.prepare(`
    SELECT oi.sku AS sku,
           COALESCE(oi.product_name, p.name) AS product_name,
           COALESCE(oi.color_name, s.color_name) AS color_name,
           SUM(oi.quantity) AS qty
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    LEFT JOIN catalog_skus s ON s.sku = oi.sku
    LEFT JOIN catalog_products p ON p.id = s.product_id
    WHERE o.placed_at >= ? AND o.status != 'cancelled' AND oi.sku IS NOT NULL
    GROUP BY oi.sku
    ORDER BY qty DESC
    LIMIT ?
  `).all(sinceIso, limit) as SkuTopRow[];
}

type StockAlertRow = { sku: string; quantity: number; product_name: string; color_name: string | null };

function loadLowStock(): StockAlertRow[] {
  return sqlite.prepare(`
    SELECT s.sku, i.quantity, p.name AS product_name, s.color_name
    FROM inventory i
    JOIN catalog_skus s ON s.id = i.sku_id
    JOIN catalog_products p ON p.id = s.product_id
    WHERE i.location = 'warehouse' AND i.quantity < i.reorder_point
    ORDER BY i.quantity ASC
    LIMIT 10
  `).all() as StockAlertRow[];
}

function loadStuckOrders(): { count: number; oldestHours: number } {
  const row = sqlite.prepare(`
    SELECT COUNT(*) AS c,
           MAX((julianday('now') - julianday(placed_at)) * 24) AS oldest_h
    FROM orders
    WHERE status = 'confirmed'
      AND placed_at IS NOT NULL
      AND placed_at < datetime('now', '-12 hours')
  `).get() as { c: number; oldest_h: number | null };
  return { count: row?.c ?? 0, oldestHours: Math.round(row?.oldest_h ?? 0) };
}

function platformLabel(channel: string): string {
  switch (channel) {
    case "shopify_dtc":       return "Retail";
    case "shopify_wholesale": return "Wholesale";
    case "faire":             return "Faire";
    case "amazon":            return "Amazon";
    case "tiktok_shop":       return "TikTok";
    default:                  return channel;
  }
}

function skuLabel(s: SkuTopRow): string {
  return `*${s.product_name}*${s.color_name ? ` (${s.color_name})` : ""}`;
}

/**
 * Daily digest — yesterday's activity. Designed to fire at ~7am PT.
 */
export async function postDailyDigest(): Promise<{ ok: boolean }> {
  // "Yesterday in PT" — start at midnight 24h ago (server time is UTC).
  // Slightly fuzzy: digest covers the last 24h ending now.
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();

  const channels = loadChannelRevenue(since);
  const totalRevenue = channels.reduce((s, c) => s + c.revenue, 0);
  const totalOrders = channels.reduce((s, c) => s + c.orders, 0);
  const topSkus = loadTopSkus(since, 5);
  const lowStock = loadLowStock();
  const stuck = loadStuckOrders();

  const channelLines = channels.length === 0
    ? "No orders in the last 24h."
    : channels.map((c) => `• *${platformLabel(c.channel)}* — ${money(c.revenue)} (${c.orders} order${c.orders === 1 ? "" : "s"})`).join("\n");

  const skuLines = topSkus.length === 0
    ? "_No items sold yet._"
    : topSkus.map((s) => `${skuLabel(s)} \`${s.sku}\` × ${s.qty}`).join("\n");

  const stockLine = lowStock.length === 0
    ? "✅ All SKUs above reorder point"
    : `${lowStock.length} below reorder point — top 3: ${lowStock.slice(0, 3).map((s) => `\`${s.sku}\` (${s.quantity})`).join(", ")}`;

  const stuckLine = stuck.count === 0
    ? "✅ No stuck orders"
    : `📦 ${stuck.count} order${stuck.count === 1 ? "" : "s"} stuck > 12h, oldest ${stuck.oldestHours}h`;

  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: "🌅 Good morning Jaxy team", emoji: true },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Yesterday at a glance*\nTotal: *${money(totalRevenue)}* across *${totalOrders}* order${totalOrders === 1 ? "" : "s"}` },
    },
    { type: "section", text: { type: "mrkdwn", text: `*Revenue by channel*\n${channelLines}` } },
    { type: "section", text: { type: "mrkdwn", text: `*Top sellers*\n${skuLines}` } },
    { type: "section", text: { type: "mrkdwn", text: `*Inventory*\n${stockLine}` } },
    { type: "section", text: { type: "mrkdwn", text: `*Fulfillment*\n${stuckLine}` } },
    { type: "context", elements: [{ type: "mrkdwn", text: `Generated ${new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" })}` }] },
  ];

  const result = await postSlack({
    topic: "digest.daily",
    text: `🌅 Daily digest — ${money(totalRevenue)} across ${totalOrders} orders yesterday`,
    blocks,
  });
  return { ok: result.ok };
}

/**
 * Weekly digest — last 7 days vs prior 7 days. Designed to fire Monday ~8am PT.
 */
export async function postWeeklyDigest(): Promise<{ ok: boolean }> {
  const now = Date.now();
  const since7 = new Date(now - 7 * 24 * 3600_000).toISOString();
  const since14 = new Date(now - 14 * 24 * 3600_000).toISOString();

  const last7 = loadChannelRevenue(since7);
  const prior7 = loadChannelRevenue(since14).map((c) => ({
    ...c,
    revenue: c.revenue - (last7.find((x) => x.channel === c.channel)?.revenue ?? 0),
    orders: c.orders - (last7.find((x) => x.channel === c.channel)?.orders ?? 0),
  }));

  const totalLast7 = last7.reduce((s, c) => s + c.revenue, 0);
  const totalPrior = prior7.reduce((s, c) => s + Math.max(c.revenue, 0), 0);
  const wow = totalPrior > 0 ? ((totalLast7 - totalPrior) / totalPrior) * 100 : 0;

  const channelLines = last7.length === 0
    ? "Quiet week — no orders."
    : last7.map((c) => {
        const share = totalLast7 > 0 ? (c.revenue / totalLast7) * 100 : 0;
        return `• *${platformLabel(c.channel)}* — ${money(c.revenue)} (${share.toFixed(0)}% of total, ${c.orders} order${c.orders === 1 ? "" : "s"})`;
      }).join("\n");

  const topSkus = loadTopSkus(since7, 5);
  const skuLines = topSkus.length === 0
    ? "_No items sold._"
    : topSkus.map((s, i) => `${i + 1}. ${skuLabel(s)} \`${s.sku}\` × ${s.qty}`).join("\n");

  const slowMovers = sqlite.prepare(`
    SELECT s.sku, p.name AS product_name, s.color_name,
           MAX(o.placed_at) AS last_sold
    FROM catalog_skus s
    JOIN catalog_products p ON p.id = s.product_id
    LEFT JOIN order_items oi ON oi.sku = s.sku
    LEFT JOIN orders o ON o.id = oi.order_id AND o.status != 'cancelled'
    GROUP BY s.id
    HAVING last_sold IS NULL OR last_sold < datetime('now', '-30 days')
    ORDER BY last_sold ASC NULLS FIRST
    LIMIT 5
  `).all() as Array<{ sku: string; product_name: string; color_name: string | null; last_sold: string | null }>;

  const slowLines = slowMovers.length === 0
    ? "✅ Every SKU sold in the last 30 days"
    : slowMovers.map((s) => `\`${s.sku}\` ${s.product_name}${s.color_name ? ` (${s.color_name})` : ""} — ${s.last_sold ? `last sold ${new Date(s.last_sold).toLocaleDateString()}` : "never"}`).join("\n");

  const blocks: SlackBlock[] = [
    { type: "header", text: { type: "plain_text", text: "📊 Last week at Jaxy", emoji: true } },
    {
      type: "section",
      text: { type: "mrkdwn", text: `Revenue: *${money(totalLast7)}* (${wow >= 0 ? "📈" : "📉"} ${pct(wow)} wow)` },
    },
    { type: "section", text: { type: "mrkdwn", text: `*By channel*\n${channelLines}` } },
    { type: "section", text: { type: "mrkdwn", text: `*Top sellers*\n${skuLines}` } },
    { type: "section", text: { type: "mrkdwn", text: `*Slow movers (>30d no sale)*\n${slowLines}` } },
    { type: "context", elements: [{ type: "mrkdwn", text: `Generated ${new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" })}` }] },
  ];

  const result = await postSlack({
    topic: "digest.weekly",
    text: `📊 Weekly digest — ${money(totalLast7)} (${pct(wow)} wow)`,
    blocks,
  });
  return { ok: result.ok };
}
