export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

/**
 * GET /api/v1/sales/faire-unmapped
 *
 * Companies that need a real email/website mapped: an anonymized Faire
 * customer = has a relay.faire.com contact email, no website, and no real
 * (non-relay) email. The work queue behind the prospect-page banner.
 */
export async function GET() {
  const rows = sqlite
    .prepare(
      `SELECT
         c.id,
         c.name,
         (SELECT ct.email FROM contacts ct
            WHERE ct.company_id = c.id AND LOWER(COALESCE(ct.email,'')) LIKE '%@relay.faire.com%'
            ORDER BY ct.is_primary DESC, ct.created_at ASC LIMIT 1) AS relay_email,
         (SELECT COUNT(*) FROM orders o WHERE o.company_id = c.id) AS order_count,
         (SELECT COALESCE(SUM(CASE WHEN o.status != 'cancelled' THEN o.total ELSE 0 END), 0)
            FROM orders o WHERE o.company_id = c.id) AS total_revenue,
         (SELECT MAX(COALESCE(o.placed_at, o.created_at)) FROM orders o WHERE o.company_id = c.id) AS last_order_at
       FROM companies c
       WHERE (c.website IS NULL OR TRIM(c.website) = '')
         AND EXISTS (
           SELECT 1 FROM contacts ct WHERE ct.company_id = c.id
             AND LOWER(COALESCE(ct.email,'')) LIKE '%@relay.faire.com%'
         )
         AND NOT EXISTS (
           SELECT 1 FROM contacts ct2 WHERE ct2.company_id = c.id
             AND TRIM(COALESCE(ct2.email,'')) <> '' AND LOWER(ct2.email) NOT LIKE '%@relay.faire.com%'
         )
       ORDER BY last_order_at DESC
       LIMIT 500`,
    )
    .all() as Array<Record<string, unknown>>;

  return NextResponse.json({ count: rows.length, customers: rows });
}
