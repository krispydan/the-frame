/**
 * F8-005: Churn Predictor Agent
 * Rule-based churn prediction — flags customers likely to churn.
 */
import { sqlite } from "@/lib/db";
import { calculateHealthScore, healthStatusFromScore } from "@/modules/customers/lib/health-scoring";

export interface ChurnRisk {
  accountId: string;
  companyId: string;
  companyName: string;
  healthScore: number;
  healthStatus: string;
  riskFactors: string[];
  recommendation: string;
  tier: string;
  lifetimeValue: number;
  daysSinceLastOrder: number | null;
}

/**
 * Identify customers at risk of churning.
 * Returns accounts sorted by risk (worst first).
 */
export function predictChurn(): ChurnRisk[] {
  const accounts = sqlite.prepare(`
    SELECT ca.*, c.name as company_name
    FROM customer_accounts ca
    JOIN companies c ON c.id = ca.company_id
    WHERE ca.total_orders >= 1
  `).all() as Array<{
    id: string; company_id: string; company_name: string;
    total_orders: number; avg_order_value: number; lifetime_value: number;
    last_order_at: string | null; first_order_at: string | null;
    tier: string; health_score: number;
  }>;

  const risks: ChurnRisk[] = [];

  for (const acct of accounts) {
    const health = calculateHealthScore({
      totalOrders: acct.total_orders,
      avgOrderValue: acct.avg_order_value,
      lifetimeValue: acct.lifetime_value,
      lastOrderAt: acct.last_order_at,
      firstOrderAt: acct.first_order_at,
    });

    if (health.score >= 70) continue; // healthy, skip

    const riskFactors: string[] = [];
    const daysSince = acct.last_order_at
      ? Math.floor((Date.now() - new Date(acct.last_order_at).getTime()) / 86_400_000)
      : null;

    if (daysSince !== null && daysSince > 180) riskFactors.push(`No order in ${daysSince} days`);
    else if (daysSince !== null && daysSince > 90) riskFactors.push(`Last order ${daysSince} days ago`);
    if (health.factors.frequency < 40) riskFactors.push("Low order frequency");
    if (health.factors.monetary < 40) riskFactors.push("Low average order value");
    if (acct.total_orders === 1) riskFactors.push("Single order customer — never reordered");

    let recommendation = "Monitor closely";
    if (health.status === "churned") recommendation = "Win-back campaign — offer incentive";
    else if (health.status === "churning") recommendation = "Personal outreach — understand blockers";
    else if (health.status === "at_risk") recommendation = "Send reorder reminder with special offer";

    risks.push({
      accountId: acct.id,
      companyId: acct.company_id,
      companyName: acct.company_name,
      healthScore: health.score,
      healthStatus: health.status,
      riskFactors,
      recommendation,
      tier: acct.tier,
      lifetimeValue: acct.lifetime_value,
      daysSinceLastOrder: daysSince,
    });
  }

  return risks.sort((a, b) => a.healthScore - b.healthScore);
}
