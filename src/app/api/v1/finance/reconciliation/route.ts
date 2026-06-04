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
  tiktok_shop: "TikTok Shop",
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

    // Expected revenue per settlement comes from the ORDERS THAT ACTUALLY
    // FLOWED INTO THIS SETTLEMENT (via settlement_line_items.order_id), NOT
    // from a date-range scan of orders.placed_at IN settlement.period.
    //
    // The old approach worked for one bulk weekly payout per channel
    // (Shopify Payments wholesale model). It catastrophically double-counted
    // under the Faire per-order payout model: 17 Faire settlements in a
    // single week would each match against the WHOLE week of orders,
    // inflating total expected revenue ~17×. That's how we got the
    // $1.5M expected vs $50K received bug.
    //
    // Note on join: settlement_line_items.order_id stores two different
    // identifiers depending on which sync wrote it:
    //   - Faire sync writes the LOCAL orders.id (UUID)
    //   - Shopify Payments sync writes the EXTERNAL Shopify order ID
    //     (e.g. "6908713533589")
    // The match below covers both via (o.id = sli.order_id OR
    // o.external_id = sli.order_id). Long-term we should normalize both
    // writers to the local UUID, but for now the dual-match keeps the
    // reconciliation page correct without a destructive backfill.
    const expectedStmt = sqlite.prepare(`
      SELECT
        (SELECT COUNT(DISTINCT o.id) FROM orders o
          WHERE EXISTS (
            SELECT 1 FROM settlement_line_items sli
            WHERE sli.settlement_id = ?
              AND sli.order_id IS NOT NULL
              AND (sli.order_id = o.id OR sli.order_id = o.external_id))
        ) AS order_count,
        COALESCE(
          (SELECT SUM(o.total) FROM orders o
            WHERE EXISTS (
              SELECT 1 FROM settlement_line_items sli
              WHERE sli.settlement_id = ?
                AND sli.order_id IS NOT NULL
                AND (sli.order_id = o.id OR sli.order_id = o.external_id))
              AND (o.status IS NULL OR o.status NOT IN ('cancelled', 'returned'))),
          0
        ) AS revenue
    `);

    const entries: ReconciliationEntry[] = stlRows.map(s => {
      const orderData = expectedStmt.get(s.id, s.id) as { order_count: number; revenue: number } | undefined;

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
