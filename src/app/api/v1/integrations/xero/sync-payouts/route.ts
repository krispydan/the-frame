export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { syncShopifyPayouts } from "@/modules/integrations/lib/xero/payout-sync";

/**
 * POST /api/v1/integrations/xero/sync-payouts
 *
 * Triggers a Shopify → Xero payout sync run. Returns the run id +
 * counters as soon as the batch finishes (synchronous since runs are
 * usually <30s for normal volumes).
 *
 * Body (all optional):
 *   { dateFrom?: "YYYY-MM-DD",  // defaults: 14 days ago
 *     dateTo?:   "YYYY-MM-DD",  // defaults: today
 *     status?:   "POSTED" | "DRAFT",  // default POSTED
 *     force?:    boolean }      // re-process already-synced payouts
 *
 * Designed to be called by:
 *   - The "Run sync" button on the Xero integrations page
 *   - A Railway cron pinging this endpoint daily (matches the
 *     Shopify-health-cron pattern we set up earlier)
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));

  const dateFrom = typeof body.dateFrom === "string" ? body.dateFrom : undefined;
  const dateTo = typeof body.dateTo === "string" ? body.dateTo : undefined;
  const status = body.status === "DRAFT" ? "DRAFT" : "POSTED";
  const force = body.force === true;

  try {
    const result = await syncShopifyPayouts({ dateFrom, dateTo, status, force });
    const ok = result.failed === 0;
    return NextResponse.json(
      {
        ok,
        ...result,
      },
      { status: ok ? 200 : 207 },  // 207 Multi-Status when some succeeded and some failed
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error("[xero/sync-payouts] route threw:", e);
    return NextResponse.json({ error: `Sync failed: ${message}` }, { status: 500 });
  }
}

// Allow GET too so a simple cron service (cron-job.org, Railway cron with
// curl) can hit the endpoint without a JSON body. Treats it as a no-options
// run with all defaults.
export async function GET() {
  try {
    const result = await syncShopifyPayouts({});
    const ok = result.failed === 0;
    return NextResponse.json({ ok, ...result }, { status: ok ? 200 : 207 });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: `Sync failed: ${message}` }, { status: 500 });
  }
}
