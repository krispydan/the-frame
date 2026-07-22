export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

/**
 * GET /api/v1/orders/[id]/international-shipping
 * Returns the international shipping request for this order, or 404 if none.
 * Used by the order detail page to show the intl-shipping card only when
 * the order actually qualified.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const row = sqlite.prepare(
    "SELECT * FROM international_shipping_requests WHERE order_id = ?",
  ).get(id);
  if (!row) return NextResponse.json({ error: "none" }, { status: 404 });
  return NextResponse.json(row);
}
