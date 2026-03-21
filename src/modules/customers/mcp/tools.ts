/**
 * F8-006: Customer MCP Tools
 * Registers customer-related MCP tools for AI agent access.
 */
import { mcpRegistry } from "@/modules/core/mcp/server";
import { sqlite, db } from "@/lib/db";
import { customerAccounts, CUSTOMER_TIERS } from "@/modules/customers/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getHealthSummary, recalculateAllHealthScores } from "@/modules/customers/lib/health-scoring";
import { getAllReorderPredictions, predictReorder } from "@/modules/customers/lib/reorder-engine";
import { calculateTier } from "@/modules/customers/lib/account-sync";

// ── customers.list_accounts ──
mcpRegistry.register(
  "customers.list_accounts",
  "List customer accounts with optional filters for tier, health status, and search.",
  z.object({
    search: z.string().optional().describe("Search by company name"),
    tier: z.string().optional().describe("Filter by tier: bronze, silver, gold, platinum"),
    health_status: z.string().optional().describe("Filter by health: healthy, at_risk, churning, churned"),
    sort: z.string().optional().describe("Sort by: lifetime_value, health_score, total_orders, last_order_at"),
    order: z.string().optional().describe("asc or desc (default desc)"),
    limit: z.number().optional().describe("Max results (default 25)"),
    page: z.number().optional().describe("Page number (default 1)"),
  }),
  async (args) => {
    const limit = Math.min(100, args.limit ?? 25);
    const page = args.page ?? 1;
    const offset = (page - 1) * limit;
    const order = args.order === "asc" ? "ASC" : "DESC";
    const sortCol: Record<string, string> = {
      lifetime_value: "ca.lifetime_value",
      health_score: "ca.health_score",
      total_orders: "ca.total_orders",
      last_order_at: "ca.last_order_at",
    };
    const sort = sortCol[args.sort ?? "lifetime_value"] ?? "ca.lifetime_value";

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (args.search) { conditions.push("c.name LIKE ?"); params.push(`%${args.search}%`); }
    if (args.tier) { conditions.push("ca.tier = ?"); params.push(args.tier); }
    if (args.health_status) { conditions.push("ca.health_status = ?"); params.push(args.health_status); }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = sqlite.prepare(`
      SELECT ca.*, c.name as company_name
      FROM customer_accounts ca
      JOIN companies c ON c.id = ca.company_id
      ${where}
      ORDER BY ${sort} ${order}
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    const total = sqlite.prepare(`
      SELECT COUNT(*) as count FROM customer_accounts ca
      JOIN companies c ON c.id = ca.company_id ${where}
    `).get(...params) as { count: number };

    return { accounts: rows, total: total.count, page, limit };
  }
);

// ── customers.get_account ──
mcpRegistry.register(
  "customers.get_account",
  "Get detailed customer account info by account ID or company ID.",
  z.object({
    account_id: z.string().optional().describe("Customer account ID"),
    company_id: z.string().optional().describe("Company ID"),
  }),
  async (args) => {
    if (!args.account_id && !args.company_id) return { error: "Provide account_id or company_id" };

    const where = args.account_id ? "ca.id = ?" : "ca.company_id = ?";
    const param = args.account_id ?? args.company_id;

    const account = sqlite.prepare(`
      SELECT ca.*, c.name as company_name, c.website, c.state, c.city
      FROM customer_accounts ca
      JOIN companies c ON c.id = ca.company_id
      WHERE ${where}
    `).get(param);

    if (!account) return { error: "Account not found" };

    // Recent orders
    const recentOrders = sqlite.prepare(`
      SELECT id, order_number, total, status, placed_at
      FROM orders WHERE company_id = ?
      ORDER BY placed_at DESC LIMIT 5
    `).all((account as { company_id: string }).company_id);

    // Health history
    const healthHistory = sqlite.prepare(`
      SELECT score, status, factors, calculated_at
      FROM account_health_history
      WHERE customer_account_id = ?
      ORDER BY calculated_at DESC LIMIT 10
    `).all((account as { id: string }).id);

    return { account, recentOrders, healthHistory };
  }
);

// ── customers.get_health ──
mcpRegistry.register(
  "customers.get_health",
  "Get customer health summary across all accounts, optionally recalculate scores.",
  z.object({
    recalculate: z.boolean().optional().describe("Recalculate all health scores first"),
  }),
  async (args) => {
    if (args.recalculate) {
      const result = recalculateAllHealthScores();
      return { recalculated: result.updated, summary: getHealthSummary() };
    }
    return getHealthSummary();
  }
);

// ── customers.get_reorder_predictions ──
mcpRegistry.register(
  "customers.get_reorder_predictions",
  "Get reorder predictions and reminders for customers.",
  z.object({
    account_id: z.string().optional().describe("Get prediction for specific account"),
    status: z.string().optional().describe("Filter: 14_day, 7_day, overdue"),
  }),
  async (args) => {
    if (args.account_id) {
      const prediction = predictReorder(args.account_id);
      if (!prediction) return { error: "Account not found" };
      return prediction;
    }
    const predictions = getAllReorderPredictions(args.status as "14_day" | "7_day" | "overdue" | undefined);
    return {
      predictions,
      total: predictions.length,
      summary: {
        overdue: predictions.filter(p => p.reminderStatus === "overdue").length,
        seven_day: predictions.filter(p => p.reminderStatus === "7_day").length,
        fourteen_day: predictions.filter(p => p.reminderStatus === "14_day").length,
      },
    };
  }
);

// ── customers.update_tier ──
mcpRegistry.register(
  "customers.update_tier",
  "Manually override a customer's tier. Use 'auto' to recalculate from order data.",
  z.object({
    account_id: z.string().describe("Customer account ID"),
    tier: z.enum(["bronze", "silver", "gold", "platinum", "auto"]).describe("New tier or 'auto' to recalculate"),
  }),
  async (args) => {
    const account = db.select().from(customerAccounts).where(eq(customerAccounts.id, args.account_id)).get();
    if (!account) return { error: "Account not found" };

    const newTier = args.tier === "auto"
      ? calculateTier(account.totalOrders, account.lifetimeValue)
      : args.tier;

    db.update(customerAccounts)
      .set({ tier: newTier, updatedAt: new Date().toISOString() })
      .where(eq(customerAccounts.id, args.account_id))
      .run();

    return { accountId: args.account_id, previousTier: account.tier, newTier, auto: args.tier === "auto" };
  }
);
