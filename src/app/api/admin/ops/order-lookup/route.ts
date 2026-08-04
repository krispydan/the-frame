export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { requireOpsToken } from "@/lib/ops-auth";
import { lookupOrder } from "@/modules/orders/lib/order-lookup";

/**
 * Token-guarded order lookup (x-ops-key: OPS_TOKEN).
 * GET ?number=&accountId=  → where an order actually lives vs. the account.
 * Read-only.
 */
export async function GET(req: NextRequest) {
  const denied = requireOpsToken(req);
  if (denied) return denied;

  const number = req.nextUrl.searchParams.get("number")?.trim();
  const accountId = req.nextUrl.searchParams.get("accountId")?.trim() || undefined;
  if (!number) return NextResponse.json({ error: "pass ?number=<order number>" });
  return NextResponse.json(lookupOrder(number, accountId));
}
