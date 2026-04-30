export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { probeAllShops } from "@/modules/integrations/lib/shopify/health";

/**
 * POST /api/v1/integrations/shopify/health-all
 *
 * Run a health probe against every active Shopify shop. Persists the result
 * on each row and creates a notification when status flips between ok and
 * non-ok. Designed to be called by an external scheduler (Railway cron,
 * GitHub Actions, etc.) on a 5-15 minute cadence.
 *
 * Returns:
 *   {
 *     ok: boolean,
 *     probed: number,
 *     results: [{ shopDomain, channel, status, previousStatus, flipped, error? }]
 *   }
 */
export async function POST() {
  const results = await probeAllShops();
  const allOk = results.every((r) => r.status === "ok");
  return NextResponse.json({
    ok: allOk,
    probed: results.length,
    flipped: results.filter((r) => r.flipped).length,
    results,
  });
}

// Allow GET too so simple curl/cron-job.org style schedulers can hit it.
export async function GET() {
  return POST();
}
