export const dynamic = "force-dynamic";
import { sqlite } from "@/lib/db";
import { CustomerDetail } from "@/modules/customers/components/customer-detail";
import { getAjmHistory } from "@/modules/sales/lib/ajm/history";
import { predictReorder } from "@/modules/customers/lib/reorder-engine";
import { predictChurn } from "@/modules/customers/agents/churn-predictor";
import { getOrderEconomics } from "@/modules/finance/lib/order-economics";
import { notFound } from "next/navigation";

interface AccountRow {
  id: string;
  company_id: string;
  company_name: string;
  company_email: string | null;
  company_phone: string | null;
  segment: string | null;
  tier: string;
  lifetime_value: number;
  total_orders: number;
  avg_order_value: number;
  health_score: number;
  health_status: string;
  first_order_at: string | null;
  last_order_at: string | null;
  next_reorder_estimate: string | null;
  payment_terms: string | null;
  discount_rate: number;
  notes: string | null;
}

interface OrderRow {
  id: string;
  order_number: string;
  channel: string;
  status: string;
  total: number;
  placed_at: string;
}

interface ActivityRow {
  id: string;
  type: string;
  description: string | null;
  created_at: string;
}

interface HealthHistoryRow {
  score: number;
  status: string;
  factors: string | null;
  calculated_at: string;
}

async function getAccount(id: string) {
  // Accept EITHER a customer_accounts.id (canonical) or a companies.id
  // (what most other pages have handy — analytics rows, deal lists, order
  // pages). WHERE clause matches both so a link from anywhere Just Works.
  return sqlite.prepare(`
    SELECT
      ca.*,
      c.name as company_name,
      (SELECT ct.email FROM contacts ct
        WHERE ct.company_id = c.id AND ct.email IS NOT NULL AND TRIM(ct.email) != ''
        ORDER BY ct.is_primary DESC, ct.created_at ASC
        LIMIT 1) as company_email,
      (SELECT cp.phone FROM company_phones cp
        WHERE cp.company_id = c.id
        ORDER BY cp.is_primary DESC, cp.created_at ASC
        LIMIT 1) as company_phone,
      COALESCE(s.name, c.segment) as segment
    FROM customer_accounts ca
    JOIN companies c ON c.id = ca.company_id
    LEFT JOIN segments s ON s.id = c.segment_id
    WHERE ca.id = ? OR ca.company_id = ?
    LIMIT 1
  `).get(id, id) as AccountRow | undefined;
}

async function getOrders(companyId: string) {
  return sqlite.prepare(`
    SELECT id, order_number, channel, status, total, placed_at
    FROM orders
    WHERE company_id = ?
    ORDER BY placed_at DESC
    LIMIT 100
  `).all(companyId) as OrderRow[];
}

/**
 * Percentile benchmarks vs the whole customer base — how good/bad this
 * customer is, in numbers the sales team can act on. Percentile = share of
 * customers at or below this one (higher = better).
 */
function getBenchmarks(account: AccountRow) {
  const base = (sqlite.prepare("SELECT COUNT(*) AS c FROM customer_accounts").get() as { c: number }).c;
  if (base === 0) return null;
  const pct = (col: string, v: number) =>
    Math.round(((sqlite.prepare(`SELECT COUNT(*) AS c FROM customer_accounts WHERE ${col} <= ?`).get(v) as { c: number }).c / base) * 100);
  const avg = sqlite.prepare(
    "SELECT AVG(lifetime_value) AS ltv, AVG(avg_order_value) AS aov, AVG(total_orders) AS orders FROM customer_accounts",
  ).get() as { ltv: number; aov: number; orders: number };
  return {
    base,
    ltv: { value: account.lifetime_value, percentile: pct("lifetime_value", account.lifetime_value), avg: avg.ltv ?? 0 },
    aov: { value: account.avg_order_value, percentile: pct("avg_order_value", account.avg_order_value), avg: avg.aov ?? 0 },
    orders: { value: account.total_orders, percentile: pct("total_orders", account.total_orders), avg: avg.orders ?? 0 },
  };
}

async function getActivities(companyId: string) {
  return sqlite.prepare(`
    SELECT id, type, description, created_at
    FROM deal_activities
    WHERE company_id = ?
    ORDER BY created_at DESC
    LIMIT 30
  `).all(companyId) as ActivityRow[];
}

async function getHealthHistory(accountId: string) {
  return sqlite.prepare(`
    SELECT score, status, factors, calculated_at
    FROM account_health_history
    WHERE customer_account_id = ?
    ORDER BY calculated_at DESC
    LIMIT 12
  `).all(accountId) as HealthHistoryRow[];
}

export default async function CustomerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const account = await getAccount(id);
  if (!account) notFound();

  const [recentOrders, activities, healthHistory] = await Promise.all([
    getOrders(account.company_id),
    getActivities(account.company_id),
    getHealthHistory(id),
  ]);

  // Per-order economics (revenue / COGS / 3PL actual-or-estimated / profit)
  // + lifetime profit rollup for the profit table and charts.
  const econMap = getOrderEconomics(recentOrders.map((o) => o.id));
  const orderEconomics = recentOrders.map((o) => ({
    ...o,
    economics: econMap.get(o.id) ?? null,
  }));
  const benchmarks = getBenchmarks(account);
  const ajmHistory = getAjmHistory(account.company_id);

  const reorderPrediction = predictReorder(id);

  // Get churn risk data for this account
  const allRisks = predictChurn();
  const churnRisk = allRisks.find(r => r.accountId === id) || null;

  return (
    <CustomerDetail
      account={account}
      recentOrders={recentOrders}
      orderEconomics={orderEconomics}
      benchmarks={benchmarks}
      ajmHistory={ajmHistory}
      activities={activities}
      healthHistory={healthHistory}
      reorderPrediction={reorderPrediction}
      churnRisk={churnRisk ? {
        healthScore: churnRisk.healthScore,
        healthStatus: churnRisk.healthStatus,
        riskFactors: churnRisk.riskFactors,
        recommendation: churnRisk.recommendation,
        daysSinceLastOrder: churnRisk.daysSinceLastOrder,
      } : null}
    />
  );
}
