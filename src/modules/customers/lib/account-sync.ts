import { db, sqlite } from "@/lib/db";
import { customerAccounts, type CustomerTier } from "@/modules/customers/schema";
import { orders } from "@/modules/orders/schema";
import { eq, sql } from "drizzle-orm";

/**
 * Auto-create or update a customer account when an order is placed.
 * Called when a deal moves to "order_placed" or a new order is created.
 */
export function ensureCustomerAccount(companyId: string): string {
  const existing = db.select().from(customerAccounts).where(eq(customerAccounts.companyId, companyId)).get();

  if (existing) {
    refreshAccountStats(existing.id, companyId);
    return existing.id;
  }

  // Create new account
  const accountId = crypto.randomUUID();
  db.insert(customerAccounts).values({
    id: accountId,
    companyId,
    tier: "bronze",
    lifetimeValue: 0,
    totalOrders: 0,
    avgOrderValue: 0,
    healthScore: 50,
    healthStatus: "healthy",
  }).run();

  refreshAccountStats(accountId, companyId);
  return accountId;
}

/**
 * Recalculate LTV, total orders, avg order value from orders table.
 * Also updates tier based on rules.
 */
export function refreshAccountStats(accountId: string, companyId: string): void {
  const stats = sqlite.prepare(`
    SELECT
      COUNT(*) as total_orders,
      COALESCE(SUM(total), 0) as lifetime_value,
      COALESCE(AVG(total), 0) as avg_order_value,
      MIN(placed_at) as first_order_at,
      MAX(placed_at) as last_order_at
    FROM orders
    WHERE company_id = ? AND status NOT IN ('cancelled', 'returned')
  `).get(companyId) as {
    total_orders: number;
    lifetime_value: number;
    avg_order_value: number;
    first_order_at: string | null;
    last_order_at: string | null;
  };

  const tier = calculateTier(stats.total_orders, stats.lifetime_value);

  db.update(customerAccounts)
    .set({
      totalOrders: stats.total_orders,
      lifetimeValue: stats.lifetime_value,
      avgOrderValue: Math.round(stats.avg_order_value * 100) / 100,
      firstOrderAt: stats.first_order_at,
      lastOrderAt: stats.last_order_at,
      tier,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(customerAccounts.id, accountId))
    .run();
}

/**
 * Tier rules:
 * - bronze: 1 order
 * - silver: 2-4 orders OR $500+ LTV
 * - gold: 5+ orders OR $2K+ LTV
 * - platinum: $5K+ LTV
 */
export function calculateTier(totalOrders: number, lifetimeValue: number): CustomerTier {
  if (lifetimeValue >= 5000) return "platinum";
  if (totalOrders >= 5 || lifetimeValue >= 2000) return "gold";
  if (totalOrders >= 2 || lifetimeValue >= 500) return "silver";
  return "bronze";
}
