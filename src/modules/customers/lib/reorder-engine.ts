/**
 * F8-004: Reorder Predictions & Reminders
 *
 * Predicts next reorder date from order history (avg days between orders).
 * Generates reminders at 14 days, 7 days, and overdue.
 */

import { db, sqlite } from "@/lib/db";
import { customerAccounts } from "@/modules/customers/schema";
import { eq } from "drizzle-orm";

export interface ReorderPrediction {
  accountId: string;
  companyId: string;
  companyName: string;
  avgDaysBetweenOrders: number | null;
  lastOrderAt: string | null;
  predictedReorderDate: string | null;
  daysUntilReorder: number | null;
  reminderStatus: "none" | "14_day" | "7_day" | "overdue";
  totalOrders: number;
}

/** Calculate average days between orders for a company. */
function avgDaysBetweenOrders(companyId: string): number | null {
  const orderDates = sqlite.prepare(`
    SELECT placed_at FROM orders
    WHERE company_id = ? AND status NOT IN ('cancelled', 'returned')
    ORDER BY placed_at ASC
  `).all(companyId) as Array<{ placed_at: string }>;

  if (orderDates.length < 2) return null;

  let totalDays = 0;
  for (let i = 1; i < orderDates.length; i++) {
    totalDays += (new Date(orderDates[i].placed_at).getTime() - new Date(orderDates[i - 1].placed_at).getTime()) / 86_400_000;
  }
  return Math.round(totalDays / (orderDates.length - 1));
}

function reminderStatus(daysUntil: number | null): ReorderPrediction["reminderStatus"] {
  if (daysUntil === null) return "none";
  if (daysUntil <= 0) return "overdue";
  if (daysUntil <= 7) return "7_day";
  if (daysUntil <= 14) return "14_day";
  return "none";
}

/** Get reorder prediction for a single account. */
export function predictReorder(accountId: string): ReorderPrediction | null {
  const acct = sqlite.prepare(`
    SELECT ca.id, ca.company_id, ca.last_order_at, ca.total_orders, c.name as company_name
    FROM customer_accounts ca
    JOIN companies c ON c.id = ca.company_id
    WHERE ca.id = ?
  `).get(accountId) as { id: string; company_id: string; last_order_at: string | null; total_orders: number; company_name: string } | undefined;

  if (!acct) return null;

  const avgDays = avgDaysBetweenOrders(acct.company_id);
  let predictedDate: string | null = null;
  let daysUntil: number | null = null;

  if (avgDays && acct.last_order_at) {
    const predicted = new Date(acct.last_order_at);
    predicted.setDate(predicted.getDate() + avgDays);
    predictedDate = predicted.toISOString().split("T")[0];
    daysUntil = Math.round((predicted.getTime() - Date.now()) / 86_400_000);
  }

  return {
    accountId: acct.id,
    companyId: acct.company_id,
    companyName: acct.company_name,
    avgDaysBetweenOrders: avgDays,
    lastOrderAt: acct.last_order_at,
    predictedReorderDate: predictedDate,
    daysUntilReorder: daysUntil,
    reminderStatus: reminderStatus(daysUntil),
    totalOrders: acct.total_orders,
  };
}

/** Get all reorder predictions, optionally filtered by reminder status. */
export function getAllReorderPredictions(filter?: ReorderPrediction["reminderStatus"]): ReorderPrediction[] {
  const accounts = sqlite.prepare(`
    SELECT ca.id, ca.company_id, ca.last_order_at, ca.total_orders, c.name as company_name
    FROM customer_accounts ca
    JOIN companies c ON c.id = ca.company_id
    WHERE ca.total_orders >= 2
    ORDER BY ca.last_order_at ASC
  `).all() as Array<{ id: string; company_id: string; last_order_at: string | null; total_orders: number; company_name: string }>;

  const predictions: ReorderPrediction[] = [];

  for (const acct of accounts) {
    const avgDays = avgDaysBetweenOrders(acct.company_id);
    let predictedDate: string | null = null;
    let daysUntil: number | null = null;

    if (avgDays && acct.last_order_at) {
      const predicted = new Date(acct.last_order_at);
      predicted.setDate(predicted.getDate() + avgDays);
      predictedDate = predicted.toISOString().split("T")[0];
      daysUntil = Math.round((predicted.getTime() - Date.now()) / 86_400_000);
    }

    const status = reminderStatus(daysUntil);
    if (filter && status !== filter) continue;

    predictions.push({
      accountId: acct.id,
      companyId: acct.company_id,
      companyName: acct.company_name,
      avgDaysBetweenOrders: avgDays,
      lastOrderAt: acct.last_order_at,
      predictedReorderDate: predictedDate,
      daysUntilReorder: daysUntil,
      reminderStatus: status,
      totalOrders: acct.total_orders,
    });
  }

  return predictions.sort((a, b) => (a.daysUntilReorder ?? 999) - (b.daysUntilReorder ?? 999));
}

/** Update nextReorderEstimate on all customer accounts. */
export function refreshReorderEstimates(): number {
  const accounts = sqlite.prepare(`
    SELECT id, company_id, total_orders, last_order_at FROM customer_accounts WHERE total_orders >= 2
  `).all() as Array<{ id: string; company_id: string; total_orders: number; last_order_at: string | null }>;

  let updated = 0;
  for (const acct of accounts) {
    const avgDays = avgDaysBetweenOrders(acct.company_id);
    if (avgDays && acct.last_order_at) {
      const predicted = new Date(acct.last_order_at);
      predicted.setDate(predicted.getDate() + avgDays);
      db.update(customerAccounts)
        .set({ nextReorderEstimate: predicted.toISOString().split("T")[0], updatedAt: new Date().toISOString() })
        .where(eq(customerAccounts.id, acct.id))
        .run();
      updated++;
    }
  }
  return updated;
}

// ── API route handler ──

export function handleReorderApi(url: URL): Response {
  const accountId = url.searchParams.get("accountId");
  const filter = url.searchParams.get("status") as ReorderPrediction["reminderStatus"] | null;

  if (accountId) {
    const prediction = predictReorder(accountId);
    if (!prediction) return Response.json({ error: "Account not found" }, { status: 404 });
    return Response.json(prediction);
  }

  const predictions = getAllReorderPredictions(filter ?? undefined);
  return Response.json({
    predictions,
    total: predictions.length,
    summary: {
      overdue: predictions.filter(p => p.reminderStatus === "overdue").length,
      "7_day": predictions.filter(p => p.reminderStatus === "7_day").length,
      "14_day": predictions.filter(p => p.reminderStatus === "14_day").length,
    },
  });
}
