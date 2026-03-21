/**
 * F8-005: Upsell Recommender Agent
 * Rule-based product recommendations based on past order history.
 */
import { sqlite } from "@/lib/db";

export interface UpsellRecommendation {
  accountId: string;
  companyId: string;
  companyName: string;
  tier: string;
  currentProducts: string[];
  recommendations: Array<{
    type: "upsell" | "cross_sell" | "reorder";
    reason: string;
    suggestion: string;
    priority: "high" | "medium" | "low";
  }>;
}

/**
 * Generate upsell/cross-sell recommendations for a customer.
 */
export function recommendForAccount(accountId: string): UpsellRecommendation | null {
  const acct = sqlite.prepare(`
    SELECT ca.id, ca.company_id, ca.tier, ca.total_orders, ca.avg_order_value, ca.lifetime_value, c.name
    FROM customer_accounts ca
    JOIN companies c ON c.id = ca.company_id
    WHERE ca.id = ?
  `).get(accountId) as { id: string; company_id: string; tier: string; total_orders: number; avg_order_value: number; lifetime_value: number; name: string } | undefined;

  if (!acct) return null;

  // Get products this customer has ordered
  const ordered = sqlite.prepare(`
    SELECT DISTINCT oi.product_name, oi.variant_name, SUM(oi.quantity) as total_qty
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.company_id = ? AND o.status NOT IN ('cancelled', 'returned')
    GROUP BY oi.product_name, oi.variant_name
    ORDER BY total_qty DESC
  `).all(acct.company_id) as Array<{ product_name: string; variant_name: string | null; total_qty: number }>;

  const currentProducts = ordered.map(p => p.variant_name ? `${p.product_name} (${p.variant_name})` : p.product_name);
  const recommendations: UpsellRecommendation["recommendations"] = [];

  // Rule: Low AOV customers → suggest higher-value products
  if (acct.avg_order_value < 500) {
    recommendations.push({
      type: "upsell",
      reason: `Average order is $${acct.avg_order_value.toFixed(0)} — room to grow`,
      suggestion: "Introduce premium collections or volume discounts to increase order size",
      priority: "high",
    });
  }

  // Rule: Single-product customers → cross-sell
  const uniqueProducts = new Set(ordered.map(p => p.product_name));
  if (uniqueProducts.size <= 2 && acct.total_orders >= 2) {
    recommendations.push({
      type: "cross_sell",
      reason: `Only orders ${uniqueProducts.size} product(s) — limited assortment`,
      suggestion: "Share full catalog or send samples of complementary styles",
      priority: "medium",
    });
  }

  // Rule: High-value loyal customers → exclusive offers
  if (acct.tier === "gold" || acct.tier === "platinum") {
    recommendations.push({
      type: "upsell",
      reason: `${acct.tier} tier customer — high lifetime value ($${acct.lifetime_value.toFixed(0)})`,
      suggestion: "Offer early access to new collections or exclusive colorways",
      priority: "medium",
    });
  }

  // Rule: Consistent reorderer → bulk/subscription
  if (acct.total_orders >= 4) {
    recommendations.push({
      type: "upsell",
      reason: `${acct.total_orders} orders placed — consistent buyer`,
      suggestion: "Offer standing order program or volume tier pricing",
      priority: "low",
    });
  }

  // Rule: Bronze tier with decent AOV → nurture to silver
  if (acct.tier === "bronze" && acct.avg_order_value >= 200) {
    recommendations.push({
      type: "cross_sell",
      reason: "Good AOV but only 1 order — potential to upgrade tier",
      suggestion: "Follow up with personalized reorder offer within 30 days",
      priority: "high",
    });
  }

  return {
    accountId: acct.id,
    companyId: acct.company_id,
    companyName: acct.name,
    tier: acct.tier,
    currentProducts,
    recommendations,
  };
}

/**
 * Get recommendations for all accounts with actionable suggestions.
 */
export function getAllRecommendations(): UpsellRecommendation[] {
  const accountIds = sqlite.prepare(`SELECT id FROM customer_accounts WHERE total_orders >= 1`).all() as Array<{ id: string }>;
  const results: UpsellRecommendation[] = [];

  for (const { id } of accountIds) {
    const rec = recommendForAccount(id);
    if (rec && rec.recommendations.length > 0) results.push(rec);
  }

  return results.sort((a, b) => {
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    const aMax = Math.min(...a.recommendations.map(r => priorityOrder[r.priority]));
    const bMax = Math.min(...b.recommendations.map(r => priorityOrder[r.priority]));
    return aMax - bMax;
  });
}
