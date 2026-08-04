export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { syncAmazonOrders } from "@/modules/integrations/lib/amazon/sync";
import { importAmazonOrders } from "@/modules/orders/lib/amazon-sync";
import { getSyncState } from "@/modules/integrations/lib/amazon/ingest";

/**
 * GET /api/v1/orders/amazon-sync — status.
 *
 * Reports both stages separately (raw archive vs imported orders) because
 * they fail independently: Windsor can be down while the archive still
 * imports fine, and a SKU mapping problem can block the import while the
 * archive keeps filling. Collapsing them into one "last synced" would hide
 * whichever half is broken.
 */
export async function GET() {
  const archive = sqlite.prepare(`
    SELECT COUNT(*) AS lines,
           COUNT(DISTINCT amazon_order_id) AS orders,
           MAX(purchase_date) AS latestPurchase,
           MAX(ingested_at) AS lastIngestedAt
    FROM amazon_order_rows
  `).get() as { lines: number; orders: number; latestPurchase: string | null; lastIngestedAt: string | null };

  const imported = sqlite.prepare(`
    SELECT COUNT(*) AS orders,
           MAX(placed_at) AS latestPlaced,
           SUM(CASE WHEN status = 'shipped' THEN 1 ELSE 0 END) AS shipped,
           SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled
    FROM orders WHERE channel = 'amazon'
  `).get() as Record<string, number | string | null>;

  const unmapped = sqlite.prepare(`
    SELECT COUNT(DISTINCT oi.sku) AS n
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.channel = 'amazon' AND oi.sku_id IS NULL
  `).get() as { n: number };

  return NextResponse.json({
    ok: true,
    configured: Boolean(process.env.WINDSOR_API_KEY),
    archive,
    imported,
    unmappedSkuCount: unmapped?.n ?? 0,
    reports: getSyncState().filter((s) => s.reportName.startsWith("orders")),
  });
}

/**
 * POST /api/v1/orders/amazon-sync — pull from Windsor, then import.
 *
 * Body (all optional):
 *   { days?: number, from?: string, to?: string, importOnly?: boolean }
 *
 * `importOnly` re-runs the normalisation step over the existing archive
 * without touching Windsor — the fast path after fixing a SKU mapping, and
 * the reason the archive exists at all.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { days, from, to, importOnly } = body as {
      days?: number; from?: string; to?: string; importOnly?: boolean;
    };

    const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
    if (from !== undefined && !isDate(from)) {
      return NextResponse.json({ ok: false, error: "`from` must be YYYY-MM-DD" }, { status: 400 });
    }
    if (to !== undefined && !isDate(to)) {
      return NextResponse.json({ ok: false, error: "`to` must be YYYY-MM-DD" }, { status: 400 });
    }
    if (days !== undefined && (!Number.isFinite(days) || days < 1 || days > 365)) {
      return NextResponse.json({ ok: false, error: "`days` must be between 1 and 365" }, { status: 400 });
    }

    let fetchOutcomes: Awaited<ReturnType<typeof syncAmazonOrders>> = [];

    if (!importOnly) {
      if (!process.env.WINDSOR_API_KEY) {
        return NextResponse.json(
          { ok: false, error: "WINDSOR_API_KEY is not configured. Set it in the Railway environment, or pass importOnly:true to re-import from the existing archive." },
          { status: 400 },
        );
      }
      fetchOutcomes = await syncAmazonOrders({ dateFrom: from, dateTo: to, days });
    }

    // Import runs even when a fetch failed: the archive still holds
    // everything from previous runs, and importing it is strictly better
    // than doing nothing because Windsor had a bad night.
    const imported = importAmazonOrders({ since: from, until: to });

    const failed = fetchOutcomes.filter((o) => !o.ok);
    const message = [
      importOnly ? "Re-imported from archive" : `Fetched ${fetchOutcomes.length} report(s)`,
      `${imported.ordersCreated} created`,
      `${imported.ordersUpdated} updated`,
      `${imported.ordersUnchanged} unchanged`,
      imported.unmappedSkus.length ? `${imported.unmappedSkus.length} unmapped SKU(s)` : null,
      failed.length ? `${failed.length} report(s) failed` : null,
    ].filter(Boolean).join(", ");

    return NextResponse.json({
      ok: failed.length === 0,
      message,
      fetch: fetchOutcomes.map((o) => ({
        report: o.report, ok: o.ok, dateFrom: o.dateFrom, dateTo: o.dateTo,
        received: o.ingest?.received ?? 0, inserted: o.ingest?.inserted ?? 0,
        updated: o.ingest?.updated ?? 0, error: o.error, errorKind: o.errorKind,
        notes: o.notes,
      })),
      imported,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
