export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { listAllShops } from "@/modules/integrations/lib/shopify/admin-api";

/** GET /api/v1/integrations/shopify — list all connected shops for the settings UI. */
export async function GET() {
  const shops = await listAllShops();
  return NextResponse.json({
    shops: shops.map((s) => ({
      id: s.id,
      shopDomain: s.shopDomain,
      displayName: s.displayName,
      channel: s.channel,
      scope: s.scope,
      apiVersion: s.apiVersion,
      isActive: s.isActive,
      lastHealthCheckAt: s.lastHealthCheckAt,
      lastHealthStatus: s.lastHealthStatus,
      lastHealthError: s.lastHealthError,
      installedAt: s.installedAt,
      uninstalledAt: s.uninstalledAt,
    })),
  });
}
