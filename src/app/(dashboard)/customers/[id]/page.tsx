export const dynamic = "force-dynamic";
import { sqlite } from "@/lib/db";
import { CustomerDetail } from "@/modules/customers/components/customer-detail";
import { predictReorder } from "@/modules/customers/lib/reorder-engine";
import { predictChurn } from "@/modules/customers/agents/churn-predictor";
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
  return sqlite.prepare(`
    SELECT
      ca.*,
      c.name as company_name,
      c.email as company_email,
      (SELECT cp.phone FROM company_phones cp
        WHERE cp.company_id = c.id
        ORDER BY cp.is_primary DESC, cp.created_at ASC
        LIMIT 1) as company_phone,
      COALESCE(s.name, c.segment) as segment
    FROM customer_accounts ca
    JOIN companies c ON c.id = ca.company_id
    LEFT JOIN segments s ON s.id = c.segment_id
    WHERE ca.id = ?
  `).get(id) as AccountRow | undefined;
}

async function getOrders(companyId: string) {
  return sqlite.prepare(`
    SELECT id, order_number, channel, status, total, placed_at
    FROM orders
    WHERE company_id = ?
    ORDER BY placed_at DESC
    LIMIT 20
  `).all(companyId) as OrderRow[];
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

  const reorderPrediction = predictReorder(id);

  // Get churn risk data for this account
  const allRisks = predictChurn();
  const churnRisk = allRisks.find(r => r.accountId === id) || null;

  return (
    <CustomerDetail
      account={account}
      recentOrders={recentOrders}
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
