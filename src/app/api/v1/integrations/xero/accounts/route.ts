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
  try {
    const result = await getChartOfAccounts();
    if (!result.success) {
      const error = result.error || "Failed to fetch Xero accounts";
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
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error("[xero/accounts] route threw:", e);
    return NextResponse.json({
      error: `Internal error: ${message}`,
    }, { status: 500 });
  }
}
