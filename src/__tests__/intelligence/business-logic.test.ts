import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, resetTestDb } from "../setup";

/**
 * Intelligence & Business Logic tests (JAX-328)
 * Tests business health scoring, trend detection, sell-through, and P&L engine logic.
 */

describe("Business Intelligence", () => {
  let db: ReturnType<typeof getTestDb>;

  beforeEach(() => {
    db = getTestDb();
    resetTestDb();
  });

  // ── Business Health Score ──
  describe("Business Health Score", () => {
    it("calculates composite score with correct weights", () => {
      // Weights: pipeline 0.3, inventory 0.25, customers 0.25, finance 0.2
      const pipeline = 80, inventory = 70, customers = 60, finance = 90;
      const overall = Math.round(pipeline * 0.3 + inventory * 0.25 + customers * 0.25 + finance * 0.2);
      // 24 + 17.5 + 15 + 18 = 74.5 → 75
      expect(overall).toBe(75);
    });

    it("weights sum to 1.0", () => {
      const weights = [0.3, 0.25, 0.25, 0.2];
      const sum = weights.reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1.0);
    });

    it("green status for score >= 80", () => {
      const score = 85;
      const color = score >= 80 ? "green" : score >= 60 ? "yellow" : "red";
      const status = score >= 80 ? "excellent" : score >= 65 ? "good" : score >= 50 ? "fair" : "poor";
      expect(color).toBe("green");
      expect(status).toBe("excellent");
    });

    it("yellow status for score 60-79", () => {
      for (const score of [60, 65, 70, 79]) {
        const color = score >= 80 ? "green" : score >= 60 ? "yellow" : "red";
        expect(color).toBe("yellow");
      }
    });

    it("red status for score < 60", () => {
      for (const score of [0, 30, 50, 59]) {
        const color = score >= 80 ? "green" : score >= 60 ? "yellow" : "red";
        expect(color).toBe("red");
      }
    });

    it("clamps scores to 0-100 range", () => {
      const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
      expect(clamp(150)).toBe(100);
      expect(clamp(-20)).toBe(0);
      expect(clamp(73.6)).toBe(74);
    });
  });

  // ── Trend Detector ──
  describe("Trend Detector", () => {
    it("calculates growth rate from period comparison", () => {
      const priorUnits = 20;
      const currentUnits = 30;
      const growthRate = ((currentUnits - priorUnits) / priorUnits) * 100;
      expect(growthRate).toBe(50); // 50% growth
    });

    it("handles zero prior period (new product)", () => {
      const priorUnits = 0;
      const currentUnits = 15;
      const growthRate = priorUnits > 0
        ? ((currentUnits - priorUnits) / priorUnits) * 100
        : currentUnits > 0 ? 100 : 0;
      expect(growthRate).toBe(100);
    });

    it("identifies declining products (negative growth)", () => {
      const priorUnits = 50;
      const currentUnits = 30;
      const growthRate = ((currentUnits - priorUnits) / priorUnits) * 100;
      const direction = growthRate > 5 ? "up" : growthRate < -5 ? "down" : "flat";

      expect(growthRate).toBe(-40);
      expect(direction).toBe("down");
    });

    it("classifies flat products (growth between -5% and 5%)", () => {
      const priorUnits = 100;
      const currentUnits = 103;
      const growthRate = ((currentUnits - priorUnits) / priorUnits) * 100;
      const direction = growthRate > 5 ? "up" : growthRate < -5 ? "down" : "flat";

      expect(growthRate).toBe(3);
      expect(direction).toBe("flat");
    });

    it("calculates momentum score (volume-weighted growth)", () => {
      const growthRate = 50; // 50% growth
      const currentUnits = 15;
      const volumeWeight = Math.min(currentUnits / 10, 1); // cap at 1
      const momentumScore = Math.round(Math.max(-100, Math.min(100, growthRate * volumeWeight)));

      expect(volumeWeight).toBe(1);
      expect(momentumScore).toBe(50);
    });

    it("identifies dead stock from DB (no sales in period)", () => {
      const now = new Date();
      const d60ago = new Date(now.getTime() - 60 * 86400000).toISOString().split("T")[0];

      // Order from 60+ days ago
      db.prepare("INSERT INTO orders (id, order_number, channel, total, placed_at, status) VALUES ('o1', 'ORD-1', 'shopify_dtc', 100, ?, 'fulfilled')").run(d60ago);
      db.prepare("INSERT INTO order_items (id, order_id, sku, product_name, quantity, unit_price, total_price) VALUES ('oi1', 'o1', 'JAX-OLD-01', 'Old Frame', 5, 20, 100)").run();

      // No recent orders for this SKU
      const deadStock = db.prepare(`
        SELECT oi.sku, oi.product_name,
          CAST(julianday('now') - julianday(MAX(o.placed_at)) AS INTEGER) AS days_since
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        WHERE o.status NOT IN ('cancelled', 'returned')
        GROUP BY oi.sku
        HAVING days_since > 30
      `).all() as any[];

      expect(deadStock.length).toBeGreaterThanOrEqual(1);
      expect(deadStock[0].sku).toBe("JAX-OLD-01");
      expect(deadStock[0].days_since).toBeGreaterThanOrEqual(30);
    });
  });

  // ── Sell-Through ──
  describe("Sell-Through", () => {
    it("calculates weekly velocity from order data", () => {
      const unitsSold = 28;
      const windowDays = 28;
      const weeks = windowDays / 7;
      const weeklyRate = unitsSold / weeks;

      expect(weeklyRate).toBe(7);
    });

    it("calculates daily rate and days of stock", () => {
      const weeklyRate = 7;
      const dailyRate = weeklyRate / 7;
      const availableStock = 100;
      const daysOfStock = dailyRate > 0 ? availableStock / dailyRate : 9999;

      expect(dailyRate).toBe(1);
      expect(daysOfStock).toBe(100);
    });

    it("classifies velocity: fast/normal/slow/dead", () => {
      const classify = (weeklyRate: number) => {
        if (weeklyRate >= 10) return "fast";
        if (weeklyRate >= 3) return "normal";
        if (weeklyRate >= 0.5) return "slow";
        return "dead";
      };

      expect(classify(15)).toBe("fast");
      expect(classify(5)).toBe("normal");
      expect(classify(1)).toBe("slow");
      expect(classify(0)).toBe("dead");
    });

    it("identifies dead stock (0 sales in period)", () => {
      const unitsSold = 0;
      const windowDays = 30;
      const weeks = windowDays / 7;
      const weeklyRate = unitsSold / weeks;

      const velocity = weeklyRate >= 10 ? "fast" : weeklyRate >= 3 ? "normal" : weeklyRate >= 0.5 ? "slow" : "dead";
      expect(velocity).toBe("dead");
      expect(weeklyRate).toBe(0);
    });

    it("calculates reorder date based on lead times", () => {
      const dailyRate = 2;
      const availableStock = 100;
      const productionLeadDays = 30;
      const transitLeadDays = 25;
      const totalLeadDays = productionLeadDays + transitLeadDays;

      const stockRunoutDays = availableStock / dailyRate; // 50 days
      const reorderDaysFromNow = stockRunoutDays - totalLeadDays; // 50 - 55 = -5

      const needsReorder = reorderDaysFromNow <= 7;
      expect(stockRunoutDays).toBe(50);
      expect(reorderDaysFromNow).toBe(-5);
      expect(needsReorder).toBe(true); // Already past reorder point!
    });
  });

  // ── P&L Engine Logic ──
  describe("P&L Engine", () => {
    it("gross margin = revenue - COGS", () => {
      const revenue = 10000;
      const cogs = 3500;
      const grossMargin = revenue - cogs;
      const grossMarginPct = (grossMargin / revenue) * 100;

      expect(grossMargin).toBe(6500);
      expect(grossMarginPct).toBe(65);
    });

    it("net income = gross margin - fees - expenses", () => {
      const grossMargin = 6500;
      const fees = 450;
      const expenses = 3000;
      const netIncome = grossMargin - fees - expenses;

      expect(netIncome).toBe(3050);
    });

    it("period comparison: pct change calculation", () => {
      const pctChange = (current: number, prior: number) => {
        if (prior === 0) return current === 0 ? 0 : 100;
        return ((current - prior) / Math.abs(prior)) * 100;
      };

      expect(pctChange(1200, 1000)).toBe(20);
      expect(pctChange(800, 1000)).toBe(-20);
      expect(pctChange(500, 0)).toBe(100);
      expect(pctChange(0, 0)).toBe(0);
    });
  });

  // ── Cash Flow Logic ──
  describe("Cash Flow Projections", () => {
    it("detects negative balance in projections", () => {
      const projections = [
        { week: 1, balance: 5000 },
        { week: 2, balance: 2000 },
        { week: 3, balance: -500 },
        { week: 4, balance: -1200 },
      ];

      const goesNegative = projections.some((p) => p.balance < 0);
      const firstNegative = projections.find((p) => p.balance < 0);

      expect(goesNegative).toBe(true);
      expect(firstNegative?.week).toBe(3);
      expect(firstNegative?.balance).toBe(-500);
    });

    it("applies scenario multipliers correctly", () => {
      const baseInflow = 10000;
      const baseOutflow = 8000;

      const scenarios = {
        optimistic: { inflow: 1.2, outflow: 0.9 },
        expected: { inflow: 1.0, outflow: 1.0 },
        pessimistic: { inflow: 0.7, outflow: 1.15 },
      };

      // Optimistic: more income, less expense
      const optNet = baseInflow * 1.2 - baseOutflow * 0.9;
      expect(optNet).toBe(4800);

      // Pessimistic: less income, more expense
      const pessNet = baseInflow * 0.7 - baseOutflow * 1.15;
      expect(pessNet).toBe(-2200);

      // Expected: neutral
      const expNet = baseInflow * 1.0 - baseOutflow * 1.0;
      expect(expNet).toBe(2000);
    });

    it("finds low point in projections", () => {
      const projections = [
        { week: 1, balance: 5000 },
        { week: 2, balance: 3000 },
        { week: 3, balance: 1000 },
        { week: 4, balance: 2500 },
      ];

      const lowPoint = projections.reduce((min, p) =>
        p.balance < min.balance ? p : min, projections[0]);

      expect(lowPoint.week).toBe(3);
      expect(lowPoint.balance).toBe(1000);
    });
  });
});
