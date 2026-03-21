/**
 * F8-003: Health Scoring & Tier Management
 * Calculates customer health scores (0-100) and manages tier assignments.
 */
import { db, sqlite } from "@/lib/db";
import { customerAccounts, accountHealthHistory, type HealthStatus } from "@/modules/customers/schema";
import { eq } from "drizzle-orm";
import { calculateTier } from "@/modules/customers/lib/account-sync";

// ── Score Weights ──
const WEIGHTS = {
  recency: 0.35,
  frequency: 0.25,
  monetary: 0.20,
  engagement: 0.20,
};

// ── Health Status Thresholds ──
export function healthStatusFromScore(score: number): HealthStatus {
  if (score >= 70) return "healthy";
  if (score >= 40) return "at_risk";
  if (score >= 20) return "churning";
  return "churned";
}

/**
 * Recency score: days since last order.
 * 0-30 days = 100, 31-60 = 80, 61-90 = 60, 91-180 = 40, 181-365 = 20, >365 = 0
 */
function recencyScore(daysSinceLastOrder: number | null): number {
  if (daysSinceLastOrder === null) return 0;
  if (daysSinceLastOrder <= 30) return 100;
  if (daysSinceLastOrder <= 60) return 80;
  if (daysSinceLastOrder <= 90) return 60;
  if (daysSinceLastOrder <= 180) return 40;
  if (daysSinceLastOrder <= 365) return 20;
  return 0;
}

/**
 * Frequency score: orders per year.
 * 6+ = 100, 4-5 = 80, 2-3 = 60, 1 = 40, 0 = 0
 */
function frequencyScore(ordersPerYear: number): number {
  if (ordersPerYear >= 6) return 100;
  if (ordersPerYear >= 4) return 80;
  if (ordersPerYear >= 2) return 60;
  if (ordersPerYear >= 1) return 40;
  return 0;
}

/**
 * Monetary score: average order value.
 * $2000+ = 100, $1000+ = 80, $500+ = 60, $200+ = 40, <$200 = 20
 */
function monetaryScore(avgOrderValue: number): number {
  if (avgOrderValue >= 2000) return 100;
  if (avgOrderValue >= 1000) return 80;
  if (avgOrderValue >= 500) return 60;
  if (avgOrderValue >= 200) return 40;
  return 20;
}

/**
 * Engagement score: based on order growth trend and consistency.
 * For now: based on total orders and recency combined heuristic.
 */
function engagementScore(totalOrders: number, daysSinceLastOrder: number | null): number {
  if (totalOrders === 0) return 0;
  const orderBase = Math.min(totalOrders * 15, 60); // up to 60 pts for order count
  const recencyBonus = daysSinceLastOrder !== null && daysSinceLastOrder <= 60 ? 40 : daysSinceLastOrder !== null && daysSinceLastOrder <= 120 ? 20 : 0;
  return Math.min(100, orderBase + recencyBonus);
}

export interface HealthScoreResult {
  score: number;
  status: HealthStatus;
  factors: {
    recency: number;
    frequency: number;
    monetary: number;
    engagement: number;
    details: string;
  };
}

/**
 * Calculate health score for a customer account.
 */
export function calculateHealthScore(account: {
  totalOrders: number;
  avgOrderValue: number;
  lifetimeValue: number;
  lastOrderAt: string | null;
  firstOrderAt: string | null;
}): HealthScoreResult {
  const now = Date.now();
  const daysSinceLastOrder = account.lastOrderAt
    ? Math.floor((now - new Date(account.lastOrderAt).getTime()) / (1000 * 60 * 60 * 24))
    : null;

  // Calculate orders per year
  const accountAgeDays = account.firstOrderAt
    ? Math.max(1, Math.floor((now - new Date(account.firstOrderAt).getTime()) / (1000 * 60 * 60 * 24)))
    : 1;
  const ordersPerYear = (account.totalOrders / accountAgeDays) * 365;

  const r = recencyScore(daysSinceLastOrder);
  const f = frequencyScore(ordersPerYear);
  const m = monetaryScore(account.avgOrderValue);
  const e = engagementScore(account.totalOrders, daysSinceLastOrder);

  const score = Math.round(
    r * WEIGHTS.recency + f * WEIGHTS.frequency + m * WEIGHTS.monetary + e * WEIGHTS.engagement
  );

  const status = healthStatusFromScore(score);
  const details = `Recency: ${daysSinceLastOrder ?? "never"}d, Freq: ${ordersPerYear.toFixed(1)}/yr, AOV: $${account.avgOrderValue.toFixed(0)}, Orders: ${account.totalOrders}`;

  return { score, status, factors: { recency: r, frequency: f, monetary: m, engagement: e, details } };
}

/**
 * Recalculate health scores for all customer accounts.
 * Meant to run as a background job.
 */
export function recalculateAllHealthScores(): { updated: number } {
  const accounts = db.select().from(customerAccounts).all();
  let updated = 0;

  for (const account of accounts) {
    const result = calculateHealthScore(account);
    const tier = calculateTier(account.totalOrders, account.lifetimeValue);

    db.update(customerAccounts)
      .set({
        healthScore: result.score,
        healthStatus: result.status,
        tier,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(customerAccounts.id, account.id))
      .run();

    // Record history
    db.insert(accountHealthHistory).values({
      customerAccountId: account.id,
      score: result.score,
      status: result.status,
      factors: result.factors,
    }).run();

    updated++;
  }

  return { updated };
}

/**
 * Get health summary across all customers.
 */
export function getHealthSummary() {
  const rows = sqlite.prepare(`
    SELECT
      health_status,
      COUNT(*) as count,
      AVG(health_score) as avg_score,
      SUM(lifetime_value) as total_ltv
    FROM customer_accounts
    GROUP BY health_status
  `).all() as { health_status: HealthStatus; count: number; avg_score: number; total_ltv: number }[];

  const byTier = sqlite.prepare(`
    SELECT tier, COUNT(*) as count, SUM(lifetime_value) as total_ltv
    FROM customer_accounts
    GROUP BY tier
  `).all() as { tier: string; count: number; total_ltv: number }[];

  return { byStatus: rows, byTier };
}
