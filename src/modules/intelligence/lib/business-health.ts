/**
 * Business Health Score
 * Composite score from sales velocity, cash flow, inventory, and customer retention.
 * Uses real data from orders, inventory, customers, and finance modules.
 */

import { sqlite } from "@/lib/db";

export interface HealthComponent {
  score: number;
  label: string;
  trend: "up" | "down" | "flat";
}

export interface BusinessHealth {
  overall: number;
  status: "excellent" | "good" | "fair" | "poor";
  color: "green" | "yellow" | "red";
  components: {
    pipeline: HealthComponent;
    inventory: HealthComponent;
    customers: HealthComponent;
    finance: HealthComponent;
  };
  generatedAt: string;
}

function clamp(n: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, Math.round(n)));
}

/**
 * Sales velocity: orders per day, current 14d vs prior 14d.
 */
function scorePipeline(): HealthComponent {
  const now = new Date();
  const d14 = new Date(now.getTime() - 14 * 86400000).toISOString().slice(0, 10);
  const d28 = new Date(now.getTime() - 28 * 86400000).toISOString().slice(0, 10);

  const data = sqlite.prepare(`
    SELECT
      CASE WHEN placed_at >= ? THEN 'current' ELSE 'prior' END AS period_label,
      COUNT(*) AS cnt,
      COALESCE(SUM(total), 0) AS rev
    FROM orders
    WHERE placed_at >= ? AND status NOT IN ('cancelled', 'returned')
    GROUP BY period_label
  `).all(d14, d28) as Array<{ period_label: string; cnt: number; rev: number }>;

  const cur = data.find((r) => r.period_label === "current") || { cnt: 0, rev: 0 };
  const pri = data.find((r) => r.period_label === "prior") || { cnt: 0, rev: 0 };

  const velocityCurrent = cur.cnt / 14;
  const velocityPrior = pri.cnt / 14;
  const trend: "up" | "down" | "flat" = velocityCurrent > velocityPrior * 1.05 ? "up" : velocityCurrent < velocityPrior * 0.95 ? "down" : "flat";

  // Score: base 50 + growth bonus up to 50
  const growthRate = velocityPrior > 0 ? (velocityCurrent - velocityPrior) / velocityPrior : 0;
  const score = clamp(50 + growthRate * 50 + Math.min(velocityCurrent * 10, 30));

  const label = `${velocityCurrent.toFixed(1)} orders/day (${trend === "up" ? "↑" : trend === "down" ? "↓" : "→"} vs prior)`;

  return { score, label, trend };
}

/**
 * Inventory health: % of SKUs adequately stocked vs needing reorder.
 */
function scoreInventory(): HealthComponent {
  const data = sqlite.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN needs_reorder = 1 THEN 1 ELSE 0 END) AS needs_reorder,
      SUM(CASE WHEN quantity <= 0 THEN 1 ELSE 0 END) AS out_of_stock
    FROM inventory
    WHERE location = 'warehouse'
  `).get() as { total: number; needs_reorder: number; out_of_stock: number } | undefined;

  if (!data || data.total === 0) {
    return { score: 70, label: "No inventory data", trend: "flat" };
  }

  const healthyPct = ((data.total - data.needs_reorder) / data.total) * 100;
  const oosDeduction = (data.out_of_stock / data.total) * 30; // heavy penalty for OOS
  const score = clamp(healthyPct - oosDeduction);

  const label = `${data.total - data.needs_reorder}/${data.total} SKUs healthy, ${data.out_of_stock} OOS`;
  const trend: "up" | "down" | "flat" = data.out_of_stock > 3 ? "down" : data.needs_reorder > data.total * 0.3 ? "down" : "flat";

  return { score, label, trend };
}

/**
 * Customer retention: repeat order rate in last 60 days.
 */
function scoreCustomers(): HealthComponent {
  const d60 = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);

  const data = sqlite.prepare(`
    SELECT
      COUNT(DISTINCT company_id) AS total_customers,
      SUM(CASE WHEN order_count > 1 THEN 1 ELSE 0 END) AS repeat_customers
    FROM (
      SELECT company_id, COUNT(*) AS order_count
      FROM orders
      WHERE placed_at >= ?
        AND status NOT IN ('cancelled', 'returned')
        AND company_id IS NOT NULL
      GROUP BY company_id
    )
  `).get(d60) as { total_customers: number; repeat_customers: number } | undefined;

  if (!data || data.total_customers === 0) {
    return { score: 70, label: "No customer data", trend: "flat" };
  }

  const repeatRate = (data.repeat_customers / data.total_customers) * 100;
  // Good retention: 20%+ repeat = 80+ score
  const score = clamp(40 + repeatRate * 2);
  const label = `${data.repeat_customers}/${data.total_customers} repeat buyers (${repeatRate.toFixed(0)}%)`;
  const trend: "up" | "down" | "flat" = repeatRate >= 25 ? "up" : repeatRate < 10 ? "down" : "flat";

  return { score, label, trend };
}

/**
 * Finance: revenue trend (positive = growing).
 */
function scoreFinance(): HealthComponent {
  const d30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const d60 = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);

  const data = sqlite.prepare(`
    SELECT
      CASE WHEN placed_at >= ? THEN 'current' ELSE 'prior' END AS period_label,
      COALESCE(SUM(total), 0) AS rev
    FROM orders
    WHERE placed_at >= ? AND status NOT IN ('cancelled', 'returned')
    GROUP BY period_label
  `).all(d30, d60) as Array<{ period_label: string; rev: number }>;

  const cur = data.find((r) => r.period_label === "current")?.rev || 0;
  const pri = data.find((r) => r.period_label === "prior")?.rev || 0;

  const growthRate = pri > 0 ? ((cur - pri) / pri) * 100 : cur > 0 ? 100 : 0;
  const trend: "up" | "down" | "flat" = growthRate > 5 ? "up" : growthRate < -5 ? "down" : "flat";
  const score = clamp(50 + growthRate * 0.5 + (cur > 0 ? 20 : 0));

  const fmtRev = (n: number) => `$${(n / 1000).toFixed(1)}k`;
  const label = `${fmtRev(cur)} revenue (${growthRate > 0 ? "+" : ""}${growthRate.toFixed(0)}% vs prior)`;

  return { score, label, trend };
}

export function calculateBusinessHealth(): BusinessHealth {
  const pipeline = scorePipeline();
  const inventory = scoreInventory();
  const customers = scoreCustomers();
  const finance = scoreFinance();

  const overall = Math.round(
    pipeline.score * 0.3 + inventory.score * 0.25 + customers.score * 0.25 + finance.score * 0.2
  );

  const status: BusinessHealth["status"] =
    overall >= 80 ? "excellent" : overall >= 65 ? "good" : overall >= 50 ? "fair" : "poor";

  const color: BusinessHealth["color"] =
    overall >= 80 ? "green" : overall >= 60 ? "yellow" : "red";

  return {
    overall,
    status,
    color,
    components: { pipeline, inventory, customers, finance },
    generatedAt: new Date().toISOString(),
  };
}
