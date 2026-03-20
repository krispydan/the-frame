import { sqliteTable, text, integer, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { users } from "@/modules/core/schema";

const id = () => text("id").primaryKey().$defaultFn(() => crypto.randomUUID());
const timestamp = (name: string) => text(name).default(sql`(datetime('now'))`);

// ── Companies ──
export const companies = sqliteTable("companies", {
  id: id(),
  name: text("name").notNull(),
  type: text("type", { enum: ["independent", "chain", "online", "department_store", "boutique", "other"] }),
  website: text("website"),
  domain: text("domain"), // normalized domain per CTO review
  phone: text("phone"),
  email: text("email"),
  address: text("address"),
  city: text("city"),
  state: text("state"),
  zip: text("zip"),
  country: text("country").default("US"),
  googlePlaceId: text("google_place_id"),
  googleRating: real("google_rating"),
  googleReviewCount: integer("google_review_count"),
  status: text("status", { enum: ["new", "contacted", "qualified", "rejected", "customer"] }).notNull().default("new"),
  source: text("source"),
  icpTier: text("icp_tier", { enum: ["A", "B", "C", "D"] }),
  icpScore: integer("icp_score"),
  icpReasoning: text("icp_reasoning"),
  ownerId: text("owner_id").references(() => users.id),
  tags: text("tags", { mode: "json" }).$type<string[]>(),
  notes: text("notes"),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
}, (table) => [
  index("idx_companies_icp_tier").on(table.icpTier),
  index("idx_companies_status").on(table.status),
  index("idx_companies_state").on(table.state),
  index("idx_companies_owner").on(table.ownerId),
  index("idx_companies_domain").on(table.domain),
]);

// ── Stores ──
export const stores = sqliteTable("stores", {
  id: id(),
  companyId: text("company_id").notNull().references(() => companies.id),
  name: text("name").notNull(),
  isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false), // per CTO review
  address: text("address"),
  city: text("city"),
  state: text("state"),
  zip: text("zip"),
  phone: text("phone"),
  email: text("email"),
  managerName: text("manager_name"),
  googlePlaceId: text("google_place_id"),
  googleRating: real("google_rating"),
  latitude: real("latitude"),
  longitude: real("longitude"),
  status: text("status", { enum: ["active", "inactive", "closed"] }).notNull().default("active"),
  notes: text("notes"),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
}, (table) => [
  index("idx_stores_company").on(table.companyId),
]);

// ── Contacts ──
export const contacts = sqliteTable("contacts", {
  id: id(),
  storeId: text("store_id").references(() => stores.id),
  companyId: text("company_id").notNull().references(() => companies.id), // denormalized per CTO review
  firstName: text("first_name"),
  lastName: text("last_name"),
  title: text("title"),
  email: text("email"),
  phone: text("phone"),
  isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
  ownerId: text("owner_id").references(() => users.id),
  lastContactedAt: text("last_contacted_at"),
  source: text("source"),
  notes: text("notes"),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
}, (table) => [
  index("idx_contacts_company").on(table.companyId),
  index("idx_contacts_store").on(table.storeId),
  index("idx_contacts_email").on(table.email),
]);
