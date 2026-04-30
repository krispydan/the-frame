export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import {
  getXeroConnectionStatus,
  getXeroAuthUrl,
  disconnectXero,
  syncSettlementToXero,
  getChartOfAccounts,
  isXeroConfigured,
  getXeroSetupInstructions,
} from "@/modules/finance/lib/xero-client";

/**
 * GET /api/v1/finance/xero — connection status + auth URL.
 *
 * Auth is enforced by the middleware that protects /api/v1/* routes — same
 * pattern as the Shopify integrations endpoints. The previous apiHandler
 * wrapping caused 401s for users whose role wasn't on a hardcoded allowlist
 * even when they were correctly authenticated.
 */
export async function GET() {
  const status = getXeroConnectionStatus();
  const configured = isXeroConfigured();
  const authUrl = configured ? getXeroAuthUrl() : null;

  return NextResponse.json({
    configured,
    ...status,
    authUrl,
    setupInstructions: configured ? undefined : getXeroSetupInstructions(),
  });
}

/** POST /api/v1/finance/xero — actions: sync, chart-of-accounts, disconnect. */
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { action, settlementId } = body;

  switch (action) {
    case "sync": {
      if (!settlementId) {
        return NextResponse.json({ error: "settlementId required" }, { status: 400 });
      }
      const result = await syncSettlementToXero(settlementId);
      return NextResponse.json(result, { status: result.success ? 200 : 400 });
    }
    case "chart-of-accounts": {
      const result = await getChartOfAccounts();
      return NextResponse.json(result, { status: result.success ? 200 : 400 });
    }
    case "disconnect": {
      disconnectXero();
      return NextResponse.json({ success: true });
    }
    default:
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }
}
