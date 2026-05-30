export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { testConnection } from "@/modules/sales/lib/storeleads/client";

/**
 * POST /api/v1/integrations/storeleads/test-connection
 *
 * Issues one cheap StoreLeads call (single-domain lookup against
 * shopify.com) and returns {ok, error?}. Used by the settings page's
 * "Test connection" button. Never throws — errors are surfaced as
 * {ok:false, error}.
 */
export async function POST() {
  const result = await testConnection();
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
