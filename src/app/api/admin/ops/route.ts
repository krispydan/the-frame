export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { requireOpsToken } from "@/lib/ops-auth";

/**
 * Token-guarded ops index. Hitting this with a valid x-ops-key confirms the
 * OPS_TOKEN is configured and correct, and lists the available operations.
 */
export async function GET(req: NextRequest) {
  const denied = requireOpsToken(req);
  if (denied) return denied;

  return NextResponse.json({
    ok: true,
    operations: {
      "GET  /api/admin/ops/geocode?mode=count|diag|failures": "geocoding status / reachability probe / failure breakdown",
      "POST /api/admin/ops/geocode?confirm=1": "run a geocode batch { limit, force, retryFailed, customersOnly }",
      "POST /api/admin/ops/backfill-addresses?confirm=1": "fill blank company addresses from Shopify { stores, maxPages }",
      "GET  /api/admin/ops/order-lookup?number=&accountId=": "where an order actually lives vs. the account",
      "GET  /api/admin/ops/db-backup": "list DB backups in the private R2 bucket",
      "POST /api/admin/ops/db-backup?confirm=1": "run a DB backup now (snapshot → gzip → private R2 → prune)",
      "GET  /api/admin/ops/amazon?view=status|health|month-end|xero|settlements": "Amazon channel diagnostics (read-only)",
      "POST /api/admin/ops/amazon?confirm=1": "Amazon operations { action: backfill | sync-orders | sync-settlements | sync-traffic | sync-inventory | import-only | bridge-only | post-xero }",
      "GET  /api/admin/ops/companies/merge?minRevenue=&limit=": "duplicate-company groups + needsReview (read-only)",
      "POST /api/admin/ops/companies/merge?confirm=1[&apply=1]": "merge duplicates — DRY RUN unless apply=1 is also set",
      "GET  /api/admin/ops/ajm?view=": "AJM import/categorisation diagnostics",
      "GET  /api/admin/ops/ajm/diagnose?names=a,b": "why a named AJM account shows no Jaxy revenue",
      "GET  /api/admin/ops/ajm/gap": "AJM vs Jaxy gap decomposition",
      "GET  /api/admin/ops/cogs": "COGS/FIFO coverage diagnostics",
      "GET  /api/admin/ops/three-pl": "3PL invoice import + audit operations",
      "GET  /api/admin/ops/purchase-orders": "open purchase-order commitments (cash-flow)",
      "GET  /api/admin/ops/faire-outreach": "Faire outreach diagnostics",
      "POST /api/admin/ops/apify-qualifier-test?confirm=1": "start an ICP qualifier/market bench on Apify { matrix?, perCell? }",
      "GET  /api/admin/ops/apify-qualifier-test[?batch=&export=1&minScore=]": "poll + scorecard, or export the scored leads",
      "GET  /api/admin/ops/apify-usage[?since=YYYY-MM-DD&limit=]": "Apify spend ledger — every run by actor and day (read-only)",
      "GET  /api/admin/ops/instantly-cohort[?limit=&minScore=&full=1]": "next Instantly cohort — ranked, with funnel + exclusions (read-only)",
      "POST /api/admin/ops/instantly-cohort?confirm=1": "NeverBounce-verify that cohort { action:'verify', limit, minScore }",
      "POST /api/admin/ops/instantly-contacted?confirm=1": "record leads already contacted in Instantly from a CSV export { rows[], dryRun? }",
      "GET  /api/admin/ops/campaigns": "campaigns with lead counts and Instantly links (read-only)",
      "POST /api/admin/ops/campaigns?confirm=1": "create/link a campaign { action:'create', name, instantlyCampaignId }",
    },
    auth: "x-ops-key: <OPS_TOKEN>  (mutations also require ?confirm=1)",
  });
}
