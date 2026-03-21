import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { companies } from "@/modules/sales/schema";

const id = () => text("id").primaryKey().$defaultFn(() => crypto.randomUUID());
const timestamp = (name: string) => text(name).default(sql`(datetime('now'))`);

// ── Tier & Health Enums ──
export const CUSTOMER_TIERS = ["bronze", "silver", "gold", "platinum"] as const;
export type CustomerTier = (typeof CUSTOMER_TIERS)[number];

export const HEALTH_STATUSES = ["healthy", "at_risk", "churning", "churned"] as const;
export type HealthStatus = (typeof HEALTH_STATUSES)[number];

export const TIER_LABELS: Record<CustomerTier, string> = {
  bronze: "Bronze",
  silver: "Silver",
  gold: "Gold",
  platinum: "Platinum",
};

export const TIER_COLORS: Record<CustomerTier, string> = {
  bronze: "bg-orange-100 text-orange-800",
  silver: "bg-gray-100 text-gray-600",
  gold: "bg-yellow-100 text-yellow-800",
  platinum: "bg-purple-100 text-purple-800",
};

export const HEALTH_COLORS: Record<HealthStatus, string> = {
  healthy: "bg-green-100 text-green-800",
  at_risk: "bg-yellow-100 text-yellow-800",
  churning: "bg-orange-100 text-orange-800",
  churned: "bg-red-100 text-red-800",
};

// ── Customer Accounts ──
export const customerAccounts = sqliteTable("customer_accounts", {
  id: id(),
  companyId: text("company_id").notNull().references(() => companies.id).unique(),
  tier: text("tier", { enum: CUSTOMER_TIERS }).notNull().default("bronze"),
  lifetimeValue: real("lifetime_value").notNull().default(0),
  totalOrders: integer("total_orders").notNull().default(0),
  avgOrderValue: real("avg_order_value").notNull().default(0),
  firstOrderAt: text("first_order_at"),
  lastOrderAt: text("last_order_at"),
  nextReorderEstimate: text("next_reorder_estimate"),
  healthScore: integer("health_score").notNull().default(50),
  healthStatus: text("health_status", { enum: HEALTH_STATUSES }).notNull().default("healthy"),
  paymentTerms: text("payment_terms"), // e.g. "Net 30", "COD"
  discountRate: real("discount_rate").notNull().default(0), // percentage
  notes: text("notes"),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
}, (table) => [
  index("idx_customer_accounts_company").on(table.companyId),
  index("idx_customer_accounts_tier").on(table.tier),
  index("idx_customer_accounts_health").on(table.healthStatus),
  index("idx_customer_accounts_ltv").on(table.lifetimeValue),
  index("idx_customer_accounts_reorder").on(table.nextReorderEstimate),
]);

// ── Account Health History ──
export const accountHealthHistory = sqliteTable("account_health_history", {
  id: id(),
  customerAccountId: text("customer_account_id").notNull().references(() => customerAccounts.id, { onDelete: "cascade" }),
  score: integer("score").notNull(),
  status: text("status", { enum: HEALTH_STATUSES }).notNull(),
  factors: text("factors", { mode: "json" }).$type<{
    recency: number;
    frequency: number;
    monetary: number;
    engagement: number;
    details: string;
  }>(),
  calculatedAt: timestamp("calculated_at"),
}, (table) => [
  index("idx_health_history_account").on(table.customerAccountId),
  index("idx_health_history_date").on(table.calculatedAt),
]);
