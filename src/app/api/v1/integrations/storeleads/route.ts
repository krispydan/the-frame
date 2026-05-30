export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { isConfigured } from "@/modules/sales/lib/storeleads/client";

/**
 * GET /api/v1/integrations/storeleads
 *
 * Status payload for the integration index card + the dedicated settings
 * page. Cheap reads only — actual API connectivity check lives at
 * /test-connection so the dashboard load doesn't hit StoreLeads on every
 * navigation.
 */
export async function GET() {
  const configured = isConfigured();

  // companies sourced from StoreLeads (CSV import or live enrichment).
  const sourcedCount = (sqlite
    .prepare(
      `SELECT COUNT(*) AS c FROM companies WHERE source_type = 'storeleads'`,
    )
    .get() as { c: number }).c;

  // Last time we touched any row from StoreLeads.
  const lastSync = (sqlite
    .prepare(
      `SELECT MAX(storeleads_last_synced_at) AS t FROM companies WHERE storeleads_last_synced_at IS NOT NULL`,
    )
    .get() as { t: string | null }).t;

  // Companies with a storeleads_id (any source) — gives an idea of how
  // many CRM rows we've enriched, not just imported.
  const enrichedCount = (sqlite
    .prepare(
      `SELECT COUNT(*) AS c FROM companies WHERE storeleads_id IS NOT NULL`,
    )
    .get() as { c: number }).c;

  return NextResponse.json({
    configured,
    sourcedCount,
    enrichedCount,
    lastSync,
  });
}
