export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { getChartOfAccounts } from "@/modules/finance/lib/xero-client";

/**
 * GET /api/v1/integrations/xero/accounts
 *
 * Live fetch of the Xero chart of accounts for the connected tenant.
 * Used by the account mapping UI to populate per-category dropdowns.
 *
 * Returns:
 *   { success: true, accounts: [{ code, name, type, status }, ...] }
 *
 * Filters: only ACTIVE accounts so the UI doesn't show archived rows.
 */
export async function GET() {
  const result = await getChartOfAccounts();
  if (!result.success) {
    return NextResponse.json({ error: result.error || "Failed to fetch Xero accounts" }, { status: 502 });
  }

  // Filter to active accounts only — archived ones aren't postable.
  const active = (result.accounts || []).filter((a) => a.status === "ACTIVE");

  return NextResponse.json({ accounts: active });
}
