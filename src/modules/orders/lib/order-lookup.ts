import { sqlite } from "@/lib/db";

export interface OrderLookupResult {
  query: string;
  account: unknown;
  matchedOrders: unknown[];
  found: number;
  siblingCompanies: unknown[];
  hint: string;
}

/**
 * Read-only diagnostic for "an order isn't showing on the customer page."
 * The customer show page lists orders WHERE company_id = <account's company>,
 * so an order goes missing when it's attributed to a DIFFERENT company (a
 * duplicate record for the same retailer), has a NULL company, or was never
 * synced. This reports where the order actually lives so we can tell which.
 */
export function lookupOrder(number: string, accountId?: string): OrderLookupResult {
  let account: unknown = null;
  if (accountId) {
    account = sqlite.prepare(`
      SELECT ca.id AS accountId, ca.company_id AS companyId, c.name AS companyName,
             ca.total_orders AS totalOrders, ca.last_order_at AS lastOrderAt
      FROM customer_accounts ca JOIN companies c ON c.id = ca.company_id
      WHERE ca.id = ?
    `).get(accountId) ?? null;
  }

  const like = `%${number}%`;
  const orders = sqlite.prepare(`
    SELECT o.id, o.order_number AS orderNumber, o.external_id AS externalId,
           o.channel, o.status, o.total, o.placed_at AS placedAt,
           o.company_id AS companyId, co.name AS companyName,
           o.ship_to_name AS shipToName, o.source_name AS sourceName,
           (SELECT ca.id FROM customer_accounts ca WHERE ca.company_id = o.company_id) AS companyAccountId
    FROM orders o
    LEFT JOIN companies co ON co.id = o.company_id
    WHERE o.order_number = ? OR o.order_number = ? OR o.order_number LIKE ? OR o.external_id = ?
    ORDER BY o.placed_at DESC
  `).all(number, `#${number}`, like, number) as unknown[];

  let siblingCompanies: unknown[] = [];
  const shipName = (orders[0] as { shipToName?: string } | undefined)?.shipToName;
  if (shipName) {
    siblingCompanies = sqlite.prepare(`
      SELECT c.id, c.name,
             (SELECT ca.id FROM customer_accounts ca WHERE ca.company_id = c.id) AS accountId,
             (SELECT COUNT(*) FROM orders o WHERE o.company_id = c.id) AS orderCount
      FROM companies c
      WHERE LOWER(TRIM(c.name)) = LOWER(TRIM(?))
    `).all(shipName) as unknown[];
  }

  return {
    query: number,
    account,
    matchedOrders: orders,
    found: orders.length,
    siblingCompanies,
    hint: orders.length === 0
      ? "Order not in the DB at all — it was never synced from Shopify/Faire."
      : "Compare matchedOrders[].companyId to account.companyId. If they differ, the order is on a duplicate company; if companyId is null, it was never attributed.",
  };
}
