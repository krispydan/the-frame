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

/**
 * Compute the UTC bounds for "yesterday in Pacific Time" — handles DST
 * correctly by reading the actual PT offset from Intl rather than hard-coding
 * -7 or -8. Returns ISO strings suitable for SQLite datetime() comparisons.
 *
 * Returns end (exclusive) — i.e. midnight at the start of today PT.
 */
function ptYesterdayBounds(): { startIso: string; endIso: string; ptDate: string } {
  const ptDateOf = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
      year: "numeric", month: "2-digit", day: "2-digit",
    }).format(d);

  const yesterdayPt = ptDateOf(new Date(Date.now() - 24 * 3600_000)); // "YYYY-MM-DD"

  // Discover PT offset for yesterday (DST-safe): format noon UTC as the PT
  // hour-of-day; the difference vs 12 is the offset.
  const [yy, mm, dd] = yesterdayPt.split("-").map(Number);
  const noonUtcYesterday = new Date(Date.UTC(yy, mm - 1, dd, 12));
  const ptHourAtNoonUtc = parseInt(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles", hourCycle: "h23", hour: "2-digit",
    }).format(noonUtcYesterday),
    10,
  );
  const offsetHours = ptHourAtNoonUtc - 12; // -7 in PDT, -8 in PST

  // Midnight PT yesterday in UTC = yesterday's date at (-offsetHours) UTC.
  const startUtc = new Date(Date.UTC(yy, mm - 1, dd, -offsetHours));
  const endUtc = new Date(startUtc.getTime() + 24 * 3600_000);

  return {
    startIso: startUtc.toISOString(),
    endIso: endUtc.toISOString(),
    ptDate: yesterdayPt,
  };
}

function loadChannelRevenue(startIso: string, endIso: string): ChannelRevenue[] {
  return sqlite.prepare(`
    SELECT channel, ROUND(SUM(total), 2) AS revenue, COUNT(*) AS orders
    FROM orders
    WHERE datetime(placed_at) >= datetime(?)
      AND datetime(placed_at) <  datetime(?)
      AND status != 'cancelled'
    GROUP BY channel
    ORDER BY revenue DESC
  `).all(startIso, endIso) as ChannelRevenue[];
}

function loadTopSkus(startIso: string, endIso: string, limit = 5): SkuTopRow[] {
  return sqlite.prepare(`
    SELECT oi.sku AS sku,
           COALESCE(oi.product_name, p.name) AS product_name,
           COALESCE(oi.color_name, s.color_name) AS color_name,
           SUM(oi.quantity) AS qty
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    LEFT JOIN catalog_skus s ON s.sku = oi.sku
    LEFT JOIN catalog_products p ON p.id = s.product_id
    WHERE datetime(o.placed_at) >= datetime(?)
      AND datetime(o.placed_at) <  datetime(?)
      AND o.status != 'cancelled'
      AND oi.sku IS NOT NULL
    GROUP BY oi.sku
    ORDER BY qty DESC
    LIMIT ?
  `).all(startIso, endIso, limit) as SkuTopRow[];
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

/**
 * Compute the day-before-yesterday bounds (PT) — used as the
 * comparison window for "is this up or down" deltas in the digest.
 */
function ptDayBeforeYesterdayBounds(): { startIso: string; endIso: string } {
  const ptDateOf = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
      year: "numeric", month: "2-digit", day: "2-digit",
    }).format(d);
  const target = ptDateOf(new Date(Date.now() - 2 * 24 * 3600_000));
  const [yy, mm, dd] = target.split("-").map(Number);
  const noonUtc = new Date(Date.UTC(yy, mm - 1, dd, 12));
  const ptHourAtNoonUtc = parseInt(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles", hourCycle: "h23", hour: "2-digit",
    }).format(noonUtc),
    10,
  );
  const offsetHours = ptHourAtNoonUtc - 12;
  const startUtc = new Date(Date.UTC(yy, mm - 1, dd, -offsetHours));
  const endUtc = new Date(startUtc.getTime() + 24 * 3600_000);
  return { startIso: startUtc.toISOString(), endIso: endUtc.toISOString() };
}

interface CallMetrics {
  total: number;
  connected: number;
  interested: number;
}

export function loadPhoneBurnerMetrics(startIso: string, endIso: string): CallMetrics {
  const row = sqlite
    .prepare(
      // datetime() on BOTH sides so the window comparison is robust to
      // the stored timestamp format. PhoneBurner webhooks write called_at
      // as "YYYY-MM-DD HH:MM:SS" (space, no Z); a raw string compare
      // against an ISO-UTC bound silently excludes those rows (space sorts
      // before 'T'), which is why calls read 0 while revenue (which already
      // uses datetime()) was correct.
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN connected = 1 THEN 1 ELSE 0 END) AS connected,
              SUM(CASE WHEN lower(disposition_label) LIKE 'set appointment%' THEN 1 ELSE 0 END) AS interested
         FROM phoneburner_call_log
        WHERE datetime(called_at) >= datetime(?) AND datetime(called_at) < datetime(?)`,
    )
    .get(startIso, endIso) as { total: number; connected: number; interested: number } | undefined;
  return {
    total: row?.total ?? 0,
    connected: row?.connected ?? 0,
    interested: row?.interested ?? 0,
  };
}

interface EmailMetrics {
  sent: number;
  replied: number;
  interested: number;
  bounced: number;
}

function loadInstantlyMetrics(startIso: string, endIso: string): EmailMetrics {
  const row = sqlite
    .prepare(
      `SELECT SUM(CASE WHEN event_type = 'email_sent' THEN 1 ELSE 0 END) AS sent,
              SUM(CASE WHEN event_type IN ('reply_received','auto_reply_received') THEN 1 ELSE 0 END) AS replied,
              SUM(CASE WHEN event_type = 'lead_interested' THEN 1 ELSE 0 END) AS interested,
              SUM(CASE WHEN event_type = 'email_bounced' THEN 1 ELSE 0 END) AS bounced
         FROM instantly_webhook_events
        WHERE datetime(received_at) >= datetime(?) AND datetime(received_at) < datetime(?)
          AND token_valid = 1`,
    )
    .get(startIso, endIso) as
    | { sent: number; replied: number; interested: number; bounced: number }
    | undefined;
  return {
    sent: row?.sent ?? 0,
    replied: row?.replied ?? 0,
    interested: row?.interested ?? 0,
    bounced: row?.bounced ?? 0,
  };
}

/** "↑42" / "↓7" / "—" — chosen so the message stays scannable. */
function delta(today: number, prior: number): string {
  if (today === prior) return "—";
  const arrow = today > prior ? "↑" : "↓";
  return `${arrow}${Math.abs(today - prior)}`;
}

function deltaPctPoints(today: number, prior: number): string {
  if (Math.abs(today - prior) < 0.5) return "—";
  const arrow = today > prior ? "↑" : "↓";
  return `${arrow}${Math.abs(Math.round(today - prior))}pp`;
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
 * Render an "age" for stuck orders in friendly units:
 *   < 48 hours -> "32h"
 *   48 hours+  -> "5d"   (rounded down to whole days)
 * Avoids "555h" which is technically correct but takes mental
 * arithmetic to interpret.
 */
function ageLabel(hours: number): string {
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Daily digest — yesterday's activity. Designed to fire at ~7am PT.
 */
export async function postDailyDigest(): Promise<{ ok: boolean }> {
  // "Yesterday in PT" = midnight-to-midnight in America/Los_Angeles.
  // ptYesterdayBounds() handles PDT/PST so digest covers a full day even
  // when it fires later in the morning.
  const { startIso, endIso, ptDate } = ptYesterdayBounds();

  const channels = loadChannelRevenue(startIso, endIso);
  const totalRevenue = channels.reduce((s, c) => s + c.revenue, 0);
  const totalOrders = channels.reduce((s, c) => s + c.orders, 0);
  // Top sellers omitted per Daniel 2026-06-18 — wasn't being read.
  // Still surfaced in the Monday weekly digest.
  const lowStock = loadLowStock();
  const stuck = loadStuckOrders();

  // Prospecting metrics — yesterday vs day-before, day-over-day delta.
  const prior = ptDayBeforeYesterdayBounds();
  const pbToday = loadPhoneBurnerMetrics(startIso, endIso);
  const pbPrior = loadPhoneBurnerMetrics(prior.startIso, prior.endIso);
  const emToday = loadInstantlyMetrics(startIso, endIso);
  const emPrior = loadInstantlyMetrics(prior.startIso, prior.endIso);

  const channelLines = channels.length === 0
    ? "No orders in the last 24h."
    : channels.map((c) => `• *${platformLabel(c.channel)}* — ${money(c.revenue)} (${c.orders} order${c.orders === 1 ? "" : "s"})`).join("\n");

  const stockLine = lowStock.length === 0
    ? "✅ All SKUs above reorder point"
    : `${lowStock.length} below reorder point — top 3: ${lowStock.slice(0, 3).map((s) => `\`${s.sku}\` (${s.quantity})`).join(", ")}`;

  const stuckLine = stuck.count === 0
    ? "✅ No stuck orders"
    : `📦 ${stuck.count} order${stuck.count === 1 ? "" : "s"} stuck > 12h, oldest ${ageLabel(stuck.oldestHours)}`;

  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: "🌅 Good morning Jaxy team", emoji: true },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Yesterday at a glance* — ${new Date(`${ptDate}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "America/Los_Angeles" })}\nTotal: *${money(totalRevenue)}* across *${totalOrders}* order${totalOrders === 1 ? "" : "s"}` },
    },
    { type: "section", text: { type: "mrkdwn", text: `*Revenue by channel*\n${channelLines}` } },
    { type: "section", text: { type: "mrkdwn", text: `*Inventory*\n${stockLine}` } },
    { type: "section", text: { type: "mrkdwn", text: `*Fulfillment*\n${stuckLine}` } },
  ];

  // Cold calling — only render the block when we actually made calls
  // yesterday OR the day before (so the digest doesn't carry an empty
  // section on quiet weekends).
  if (pbToday.total > 0 || pbPrior.total > 0) {
    const pickupPctToday = pbToday.total > 0 ? (pbToday.connected / pbToday.total) * 100 : 0;
    const pickupPctPrior = pbPrior.total > 0 ? (pbPrior.connected / pbPrior.total) * 100 : 0;
    // 0 calls logged yesterday while the day before had real volume is
    // far more likely an ingestion gap (webhook lapse / stuck poll) than
    // a genuinely call-free day — flag it instead of presenting 0 as fact.
    const suspectGap = pbToday.total === 0 && pbPrior.total > 0;
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*📞 Cold calling (PhoneBurner)*\n` +
          (suspectGap
            ? `• :warning: *0 calls logged* — the day before had ${pbPrior.total}. This is likely a PhoneBurner *sync gap* (webhook delivery or the call-poll job), not a quiet day. Check before trusting the zeros below.\n`
            : "") +
          `• Calls: *${pbToday.total}* (${delta(pbToday.total, pbPrior.total)} vs day before)\n` +
          `• Pickup rate: *${pickupPctToday.toFixed(0)}%* (${deltaPctPoints(pickupPctToday, pickupPctPrior)}) — ${pbToday.connected}/${pbToday.total} connected\n` +
          `• Interested: *${pbToday.interested}* (${delta(pbToday.interested, pbPrior.interested)})`,
      },
    });
  }

  // Cold email — render the block when we actually sent yesterday OR
  // the day before.
  if (emToday.sent > 0 || emPrior.sent > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*📧 Cold email (Instantly)*\n` +
          `• Emails sent: *${emToday.sent}* (${delta(emToday.sent, emPrior.sent)} vs day before)\n` +
          `• Replies: *${emToday.replied}* (${delta(emToday.replied, emPrior.replied)})\n` +
          `• Interested: *${emToday.interested}* (${delta(emToday.interested, emPrior.interested)})` +
          (emToday.bounced > 0 ? `\n• Bounced: ${emToday.bounced}` : ""),
      },
    });
  }

  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `Generated ${new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" })}` }],
  });

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
  const nowIso = new Date().toISOString();
  const sevenDaysAgoIso = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
  const fourteenDaysAgoIso = new Date(Date.now() - 14 * 24 * 3600_000).toISOString();

  // Last 7 days (now - 7d → now)
  const last7 = loadChannelRevenue(sevenDaysAgoIso, nowIso);
  // Prior 7 days (now - 14d → now - 7d) — distinct window, no subtraction math.
  const prior7 = loadChannelRevenue(fourteenDaysAgoIso, sevenDaysAgoIso);

  const totalLast7 = last7.reduce((s, c) => s + c.revenue, 0);
  const totalPrior = prior7.reduce((s, c) => s + c.revenue, 0);
  const wow = totalPrior > 0 ? ((totalLast7 - totalPrior) / totalPrior) * 100 : 0;

  const channelLines = last7.length === 0
    ? "Quiet week — no orders."
    : last7.map((c) => {
        const share = totalLast7 > 0 ? (c.revenue / totalLast7) * 100 : 0;
        return `• *${platformLabel(c.channel)}* — ${money(c.revenue)} (${share.toFixed(0)}% of total, ${c.orders} order${c.orders === 1 ? "" : "s"})`;
      }).join("\n");

  const topSkus = loadTopSkus(sevenDaysAgoIso, nowIso, 5);
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
