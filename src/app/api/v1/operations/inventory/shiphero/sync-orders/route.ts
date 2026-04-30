export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiHandler } from "@/lib/api-middleware";
import { syncShipHeroOrders } from "@/modules/operations/lib/shiphero/sync-orders";
import { isDuringBusinessHours } from "@/modules/operations/lib/shiphero/sync-inventory";

/**
 * POST /api/v1/operations/inventory/shiphero/sync-orders
 *
 * Trigger a ShipHero order sync. Matches ShipHero orders to local orders,
 * updates fulfillment status, and upserts shipment records.
 * Query param: ?force=true to skip business-hours check.
 */
export const POST = apiHandler(
  async (request: NextRequest) => {
    const force = request.nextUrl.searchParams.get("force") === "true";

    if (!force && !isDuringBusinessHours()) {
      return NextResponse.json(
        { skipped: true, reason: "Outside PST business hours (Mon–Fri 9 AM – 6 PM)" },
        { status: 200 },
      );
    }

    const result = await syncShipHeroOrders();

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    return NextResponse.json(result);
  },
  { auth: true, roles: ["owner", "warehouse", "finance", "ai"] },
);
