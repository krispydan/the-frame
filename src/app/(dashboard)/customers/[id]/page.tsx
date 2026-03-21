export const dynamic = "force-dynamic";
import { sqlite } from "@/lib/db";
import { CustomerDetail } from "@/modules/customers/components/customer-detail";
import { predictReorder } from "@/modules/customers/lib/reorder-engine";
import { notFound } from "next/navigation";

async function getAccount(id: string) {
  return sqlite.prepare(`
    SELECT ca.*, c.name as company_name, c.email as company_email, c.phone as company_phone
    FROM customer_accounts ca
    JOIN companies c ON c.id = ca.company_id
    WHERE ca.id = ?
  `).get(id) as any;
}

async function getOrders(companyId: string) {
  return sqlite.prepare(`
    SELECT id, order_number, channel, status, total, placed_at
    FROM orders
    WHERE company_id = ?
    ORDER BY placed_at DESC
    LIMIT 20
  `).all(companyId) as any[];
}

async function getActivities(companyId: string) {
  return sqlite.prepare(`
    SELECT id, type, description, created_at
    FROM deal_activities
    WHERE company_id = ?
    ORDER BY created_at DESC
    LIMIT 30
  `).all(companyId) as any[];
}

async function getHealthHistory(accountId: string) {
  return sqlite.prepare(`
    SELECT score, status, factors, calculated_at
    FROM account_health_history
    WHERE customer_account_id = ?
    ORDER BY calculated_at DESC
    LIMIT 12
  `).all(accountId) as any[];
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

  return (
    <CustomerDetail
      account={account}
      recentOrders={recentOrders}
      activities={activities}
      healthHistory={healthHistory}
      reorderPrediction={reorderPrediction}
    />
  );
}
