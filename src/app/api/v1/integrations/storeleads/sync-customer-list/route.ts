export const dynamic = "force-dynamic";
export const maxDuration = 600;

import { NextRequest, NextResponse } from "next/server";
import { uploadCustomerListToStoreLeads, DEFAULT_CUSTOMER_LIST_NAME } from "@/modules/sales/lib/storeleads/customer-sync";

/**
 * POST /api/v1/integrations/storeleads/sync-customer-list
 *
 * Two steps in one call (StoreLeads-side, not local):
 *   1. PUT every customer's domain into a StoreLeads List ("Jaxy
 *      Customers" by default — stable name so re-runs add to the
 *      same list rather than spawning duplicates).
 *   2. Bulk-fetch each customer's StoreLeads profile (≤100/req,
 *      250ms pacing) and merge the new fields into our local
 *      `companies` row using the fill-nulls rule.
 *
 * Body (optional):
 *   { listName?: string, limit?: number, dryRun?: false }
 *
 * Returns full CustomerSyncStats — totals, accepted, unrecognised,
 * enriched, errors, durationMs.
 */
export async function POST(req: NextRequest) {
  let body: { listName?: string; limit?: number; dryRun?: boolean } = {};
  try {
    body = (await req.json()) as { listName?: string; limit?: number; dryRun?: boolean };
  } catch {
    // empty body fine
  }

  if (body.dryRun) {
    const { exportCustomerDomains } = await import("@/modules/sales/lib/storeleads/customer-sync");
    const customers = exportCustomerDomains();
    return NextResponse.json({
      ok: true,
      dryRun: true,
      listName: body.listName ?? DEFAULT_CUSTOMER_LIST_NAME,
      totalCustomers: customers.length,
      preview: customers.slice(0, 20),
    });
  }

  try {
    const stats = await uploadCustomerListToStoreLeads({
      listName: body.listName,
      limit: body.limit,
    });
    return NextResponse.json({ ok: true, listName: body.listName ?? DEFAULT_CUSTOMER_LIST_NAME, stats });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
