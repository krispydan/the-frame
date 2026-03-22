export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

export interface ReconciliationEntry {
  channel: string;
  channelLabel: string;
  periodStart: string;
  periodEnd: string;
  expectedRevenue: number;
  settlementGross: number;
  settlementFees: number;
  settlementNet: number;
  discrepancy: number;
  discrepancyPct: number;
  settlementId: string | null;
  settlementStatus: string | null;
  orderCount: number;
}

const CHANNEL_LABELS: Record<string, string> = {
  shopify: "Shopify (All)",
  shopify_dtc: "Shopify DTC",
  shopify_wholesale: "Shopify Wholesale",
  faire: "Faire",
  amazon: "Amazon",
  direct: "Direct",
};

// GET /api/v1/finance/reconciliation
export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const channel = url.searchParams.get("channel");
  const dateFrom = url.searchParams.get("date_from");
  const dateTo = url.searchParams.get("date_to");

  try {
    // Get all settlements
    let settlementQuery = `
      SELECT id, channel, period_start, period_end, gross_amount, fees, net_amount, status
      FROM settlements WHERE 1=1
    `;
    const params: string[] = [];
    if (channel) { settlementQuery += " AND channel = ?"; params.push(channel); }
    if (dateFrom) { settlementQuery += " AND period_start >= ?"; params.push(dateFrom); }
    if (dateTo) { settlementQuery += " AND period_end <= ?"; params.push(dateTo); }
    settlementQuery += " ORDER BY period_end DESC";

    const stlRows = sqlite.prepare(settlementQuery).all(...params) as Array<{
      id: string; channel: string; period_start: string; period_end: string;
      gross_amount: number; fees: number; net_amount: number; status: string;
    }>;

    const entries: ReconciliationEntry[] = stlRows.map(s => {
      // Get expected revenue from orders for this settlement period + channel
      // Settlement channel may be generic (e.g. 'shopify') while orders use specific channels (e.g. 'shopify_dtc', 'shopify_wholesale')
      const channelMapping: Record<string, string[]> = {
        shopify: ["shopify_dtc", "shopify_wholesale"],
      };
      const orderChannels = channelMapping[s.channel] || [s.channel];
      const placeholders = orderChannels.map(() => "?").join(", ");
      const orderData = sqlite.prepare(`
        SELECT COUNT(DISTINCT id) as order_count, COALESCE(SUM(total), 0) as revenue
        FROM orders
        WHERE channel IN (${placeholders}) AND placed_at >= ? AND placed_at <= ?
          AND status NOT IN ('cancelled', 'returned')
      `).get(...orderChannels, s.period_start, s.period_end + "T23:59:59") as {
        order_count: number; revenue: number;
      } | undefined;

      const expectedRevenue = orderData?.revenue || 0;
      const discrepancy = expectedRevenue - s.gross_amount;
      return {
        channel: s.channel,
        channelLabel: CHANNEL_LABELS[s.channel] || s.channel,
        periodStart: s.period_start,
        periodEnd: s.period_end,
        expectedRevenue,
        settlementGross: s.gross_amount,
        settlementFees: s.fees,
        settlementNet: s.net_amount,
        discrepancy,
        discrepancyPct: expectedRevenue > 0 ? (discrepancy / expectedRevenue) * 100 : 0,
        settlementId: s.id,
        settlementStatus: s.status,
        orderCount: orderData?.order_count || 0,
      };
    });

    // Summary stats
    const totalExpected = entries.reduce((s, e) => s + e.expectedRevenue, 0);
    const totalReceived = entries.reduce((s, e) => s + e.settlementGross, 0);
    const totalDiscrepancy = totalExpected - totalReceived;
    const flaggedCount = entries.filter(e => Math.abs(e.discrepancyPct) > 2).length;

    return NextResponse.json({
      entries,
      summary: {
        totalExpected,
        totalReceived,
        totalDiscrepancy,
        totalDiscrepancyPct: totalExpected > 0 ? (totalDiscrepancy / totalExpected) * 100 : 0,
        flaggedCount,
        totalEntries: entries.length,
      },
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
