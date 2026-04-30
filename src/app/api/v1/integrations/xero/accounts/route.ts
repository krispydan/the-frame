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
    const error = result.error || "Failed to fetch Xero accounts";
    // Surface scope-specific guidance — most common failure mode is a token
    // that was issued before accounting.settings.read was in our scope set.
    const isScopeIssue = /401|403|forbidden|unauthor/i.test(error);
    return NextResponse.json({
      error,
      hint: isScopeIssue
        ? "Reconnect Xero — your current token may be missing the accounting.settings.read scope."
        : undefined,
    }, { status: 502 });
  }

  const active = (result.accounts || []).filter((a) => a.status === "ACTIVE");
  return NextResponse.json({ accounts: active });
}
