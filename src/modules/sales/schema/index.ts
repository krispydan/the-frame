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
  disqualifyReason: text("disqualify_reason"),
  segment: text("segment"),
  category: text("category"),
  leadSourceDetail: text("lead_source_detail"),
  sourceType: text("source_type", { enum: ["storemapper", "outscraper", "manual", "csv", "chrome-ext"] }),
  sourceId: text("source_id"),
  sourceQuery: text("source_query"),
  ownerName: text("owner_name"),
  businessHours: text("business_hours", { mode: "json" }).$type<Record<string, string>>(),
  facebookUrl: text("facebook_url"),
  instagramUrl: text("instagram_url"),
  twitterUrl: text("twitter_url"),
  linkedinUrl: text("linkedin_url"),
  yelpUrl: text("yelp_url"),
  enrichedAt: text("enriched_at"),
  enrichmentSource: text("enrichment_source"),
  socials: text("socials"),  // JSON: {"instagram": "...", "facebook": "..."}
  contactFormUrl: text("contact_form_url"),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
}, (table) => [
  index("idx_companies_icp_tier").on(table.icpTier),
  index("idx_companies_status").on(table.status),
  index("idx_companies_state").on(table.state),
  index("idx_companies_owner").on(table.ownerId),
  index("idx_companies_domain").on(table.domain),
  index("idx_companies_source_type").on(table.sourceType),
  index("idx_companies_source_id").on(table.sourceId),
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

// ── Smart Lists (Saved Filters) ──
// Re-export pipeline schema
export { deals, dealActivities, DEAL_STAGES, DEAL_STAGE_LABELS, DEAL_STAGE_COLORS, DEAL_CHANNELS, ACTIVITY_TYPES } from "./pipeline";
export type { DealStage, DealChannel, ActivityType } from "./pipeline";

// Re-export campaign schema
export { campaigns, campaignLeads, instantlySync, CAMPAIGN_TYPES, CAMPAIGN_STATUSES, CAMPAIGN_TYPE_LABELS, CAMPAIGN_STATUS_COLORS, LEAD_STATUSES } from "./campaigns";
export type { CampaignType, CampaignStatus, LeadStatus } from "./campaigns";

// ── Smart Lists (Saved Filters) ──
export const smartLists = sqliteTable("smart_lists", {
  id: id(),
  name: text("name").notNull(),
  description: text("description"),
  filters: text("filters", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  ownerId: text("owner_id").references(() => users.id),
  isShared: integer("is_shared", { mode: "boolean" }).notNull().default(true),
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  resultCount: integer("result_count").default(0),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
});
