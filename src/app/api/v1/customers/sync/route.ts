export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { db, sqlite } from "@/lib/db";
import { orders } from "@/modules/orders/schema";
import { ensureCustomerAccount } from "@/modules/customers/lib/account-sync";
import { sql } from "drizzle-orm";

// POST /api/v1/customers/sync — backfill customer accounts from all orders
export async function POST() {
  try {
    // Get all distinct company IDs that have orders
    const companiesWithOrders = sqlite.prepare(`
      SELECT DISTINCT company_id
      FROM orders
      WHERE company_id IS NOT NULL AND company_id != ''
    `).all() as Array<{ company_id: string }>;

    let created = 0;
    let updated = 0;
    let errors = 0;

    for (const row of companiesWithOrders) {
      try {
        const existing = sqlite.prepare(
          `SELECT id FROM customer_accounts WHERE company_id = ?`
        ).get(row.company_id);

        ensureCustomerAccount(row.company_id);

        if (existing) {
          updated++;
        } else {
          created++;
        }
      } catch (e) {
        console.error(`[AccountSync] Error syncing company ${row.company_id}:`, e);
        errors++;
      }
    }

    return NextResponse.json({
      success: true,
      companiesProcessed: companiesWithOrders.length,
      created,
      updated,
      errors,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
