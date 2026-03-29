import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

const id = () => text("id").primaryKey().$defaultFn(() => crypto.randomUUID());
const timestamp = (name: string) => text(name).default(sql`(datetime('now'))`);

// ── Users ──
export const users = sqliteTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash"),
  role: text("role", { enum: ["owner", "sales_manager", "warehouse", "finance", "marketing", "support", "ai"] }).notNull().default("support"),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  lastLoginAt: text("last_login_at"),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
});

// ── API Keys ──
export const apiKeys = sqliteTable("api_keys", {
  id: id(),
  name: text("name").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  userId: text("user_id").references(() => users.id),
  permissions: text("permissions", { mode: "json" }).$type<string[]>(),
  lastUsedAt: text("last_used_at"),
  expiresAt: text("expires_at"),
  createdAt: timestamp("created_at"),
});

// ── Error Logs ──
export const errorLogs = sqliteTable("error_logs", {
  id: id(),
  timestamp: timestamp("timestamp"),
  level: text("level", { enum: ["error", "warn", "critical"] }).notNull(),
  source: text("source").notNull(),
  message: text("message").notNull(),
  stackTrace: text("stack_trace"),
  requestMethod: text("request_method"),
  requestPath: text("request_path"),
  requestBody: text("request_body"),
  userId: text("user_id"),
  ipAddress: text("ip_address"),
  metadata: text("metadata", { mode: "json" }),
  resolved: integer("resolved", { mode: "boolean" }).notNull().default(false),
  resolvedAt: text("resolved_at"),
  resolvedBy: text("resolved_by"),
});

// ── Change Logs (immutable audit trail) ──
export const changeLogs = sqliteTable("change_logs", {
  id: id(),
  timestamp: timestamp("timestamp"),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  field: text("field").notNull(),
  oldValue: text("old_value"),
  newValue: text("new_value"),
  userId: text("user_id"),
  source: text("source", { enum: ["ui", "api", "agent", "system", "webhook"] }).notNull(),
  agentType: text("agent_type"),
  requestId: text("request_id"),
});

// ── Reporting Logs ──
export const reportingLogs = sqliteTable("reporting_logs", {
  id: id(),
  timestamp: timestamp("timestamp"),
  eventType: text("event_type").notNull(),
  module: text("module").notNull(),
  userId: text("user_id"),
  metadata: text("metadata", { mode: "json" }),
  durationMs: integer("duration_ms"),
  tokensUsed: integer("tokens_used"),
  costCents: integer("cost_cents"),
});

// ── Activity Feed ──
export const activityFeed = sqliteTable("activity_feed", {
  id: id(),
  eventType: text("event_type").notNull(),
  module: text("module").notNull(),
  entityType: text("entity_type"),
  entityId: text("entity_id"),
  data: text("data", { mode: "json" }),
  userId: text("user_id"),
  createdAt: timestamp("created_at"),
});

// ── Jobs ──
export const jobs = sqliteTable("jobs", {
  id: id(),
  type: text("type").notNull(),
  module: text("module").notNull(),
  status: text("status", { enum: ["pending", "running", "completed", "failed", "cancelled"] }).notNull().default("pending"),
  input: text("input", { mode: "json" }),
  output: text("output", { mode: "json" }),
  priority: integer("priority").notNull().default(2),
  scheduledFor: text("scheduled_for"),
  recurring: text("recurring"),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(3),
  error: text("error"),
  createdAt: timestamp("created_at"),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
});

// ── Agent Runs ──
export const agentRuns = sqliteTable("agent_runs", {
  id: id(),
  agentName: text("agent_name").notNull(),
  module: text("module").notNull(),
  status: text("status", { enum: ["pending", "running", "completed", "failed"] }).notNull().default("pending"),
  input: text("input", { mode: "json" }),
  output: text("output", { mode: "json" }),
  tokensUsed: integer("tokens_used"),
  cost: integer("cost"), // in cents
  durationMs: integer("duration_ms"),
  error: text("error"),
  createdAt: timestamp("created_at"),
  completedAt: text("completed_at"),
});

// ── Magic Link Tokens ──
export const magicLinkTokens = sqliteTable("magic_link_tokens", {
  id: id(),
  email: text("email").notNull(),
  token: text("token").notNull().unique().$defaultFn(() => crypto.randomUUID()),
  expiresAt: text("expires_at").notNull(),
  used: integer("used", { mode: "boolean" }).notNull().default(false),
  createdAt: timestamp("created_at"),
});

// ── Settings (with type column per CTO review) ──
// ── Notifications ──
export const notifications = sqliteTable("notifications", {
  id: id(),
  type: text("type", { enum: ["inventory", "deal", "customer", "finance", "agent", "order"] }).notNull(),
  title: text("title").notNull(),
  message: text("message").notNull(),
  severity: text("severity", { enum: ["critical", "high", "medium", "low"] }).notNull(),
  module: text("module").notNull(),
  entityId: text("entity_id"),
  entityType: text("entity_type"),
  read: integer("read").notNull().default(0),
  dismissed: integer("dismissed").notNull().default(0),
  createdAt: timestamp("created_at"),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value"),
  type: text("type", { enum: ["string", "number", "boolean", "json"] }).notNull().default("string"),
  module: text("module"),
  updatedAt: timestamp("updated_at"),
});
