export const dynamic = "force-dynamic";
import { sqlite } from "@/lib/db";
import { CustomerList } from "@/modules/customers/components/customer-list";

interface CustomerListRow {
  id: string;
  company_id: string;
  company_name: string;
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
}

async function getCustomers() {
  return sqlite.prepare(`
    SELECT
      ca.id, ca.company_id, c.name as company_name,
      COALESCE(s.name, c.segment) as segment,
      ca.tier, ca.lifetime_value, ca.total_orders, ca.avg_order_value,
      ca.health_score, ca.health_status,
      ca.first_order_at, ca.last_order_at, ca.next_reorder_estimate
    FROM customer_accounts ca
    JOIN companies c ON c.id = ca.company_id
    LEFT JOIN segments s ON s.id = c.segment_id
    ORDER BY ca.lifetime_value DESC
  `).all() as CustomerListRow[];
}

export default async function CustomersPage() {
  const customers = await getCustomers();

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Customer Success</h1>
        <p className="text-gray-500">Track account health, predict reorders, and prevent churn</p>
      </div>
      <CustomerList customers={customers} />
    </div>
  );
}
