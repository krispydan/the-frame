export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { notifyStuckOrder } from "@/modules/integrations/lib/slack/notifications";

/**
 * POST/GET /api/v1/integrations/slack/scan-stuck-orders
 *
 * Looks for orders that have been status="confirmed" for more than 48 hours
 * and pings Slack about each. Designed to run via Railway cron once a day.
 *
 * Stores the alerted_stuck_at timestamp on the order so we don't re-alert
 * the same order every day — only one ping per stuck order, until it ships.
 */
type Row = {
  id: string;
  order_number: string;
  channel: string;
  total: number;
  currency: string;
  placed_at: string;
};

export async function POST() {
  return runScan();
}
export async function GET() {
  return runScan();
}

async function runScan() {
  // Add a marker column the first time so we can dedupe alerts. Idempotent.
  try { sqlite.exec("ALTER TABLE orders ADD COLUMN slack_stuck_alerted_at TEXT"); } catch { /* exists */ }

  const cutoff = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  const rows = sqlite.prepare(`
    SELECT id, order_number, channel, total, currency, placed_at
    FROM orders
    WHERE status = 'confirmed'
      AND placed_at IS NOT NULL
      AND placed_at < ?
      AND slack_stuck_alerted_at IS NULL
  `).all(cutoff) as Row[];

  let alerted = 0;
  for (const o of rows) {
    try {
      await notifyStuckOrder({
        orderNumber: o.order_number,
        channel: o.channel,
        total: o.total,
        currency: o.currency || "USD",
        placedAt: o.placed_at,
      });
      sqlite.prepare("UPDATE orders SET slack_stuck_alerted_at = datetime('now') WHERE id = ?").run(o.id);
      alerted++;
    } catch (e) {
      console.error("[scan-stuck-orders] alert failed:", e);
    }
  }

  return NextResponse.json({ ok: true, scanned: rows.length, alerted });
}
