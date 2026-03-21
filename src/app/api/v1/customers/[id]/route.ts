export const dynamic = "force-dynamic";
/**
 * GET /api/v1/customers/[id]
 * Returns customer account with orders, health history, activities, and reorder prediction.
 */
import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { predictReorder } from "@/modules/customers/lib/reorder-engine";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const account = sqlite.prepare(`
    SELECT ca.*, c.name as company_name, c.email as company_email, c.phone as company_phone
    FROM customer_accounts ca
    JOIN companies c ON c.id = ca.company_id
    WHERE ca.id = ?
  `).get(id) as any;

  if (!account) {
    return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  }

  const orders = sqlite.prepare(`
    SELECT id, order_number, channel, status, total, placed_at
    FROM orders
    WHERE company_id = ?
    ORDER BY placed_at DESC
    LIMIT 50
  `).all(account.company_id) as any[];

  const healthHistory = sqlite.prepare(`
    SELECT score, status, factors, calculated_at
    FROM account_health_history
    WHERE customer_account_id = ?
    ORDER BY calculated_at DESC
    LIMIT 12
  `).all(id) as any[];

  const activities = sqlite.prepare(`
    SELECT id, type, description, created_at
    FROM deal_activities
    WHERE company_id = ?
    ORDER BY created_at DESC
    LIMIT 30
  `).all(account.company_id) as any[];

  const reorderPrediction = predictReorder(id);

  return NextResponse.json({
    account,
    orders,
    healthHistory,
    activities,
    reorderPrediction,
  });
}
