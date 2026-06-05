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
  // True when a reviewer manually set the tier/score. Classifier skips these.
  icpManualOverride: integer("icp_manual_override", { mode: "boolean" }).default(false),
  icpUpdatedBy: text("icp_updated_by"),
  icpUpdatedAt: text("icp_updated_at"),
  ownerId: text("owner_id").references(() => users.id),
  tags: text("tags", { mode: "json" }).$type<string[]>(),
  notes: text("notes"),
  disqualifyReason: text("disqualify_reason"),
  segment: text("segment"),
  category: text("category"),
  // Curated ICP-aligned industry bucket. Derived from `tags` by
  // industry-mapping.ts and backfilled by scripts/backfill-industry.ts.
  // Replaces the long-tail 317-distinct-values mess we had in `tags` for
  // filter/segmentation. See INDUSTRY_DISPLAY for the canonical list of
  // values.
  industry: text("industry"),
  // Cached homepage excerpt (or Brave Search snippets) used by the LLM
  // classifier. Refreshed every 90 days by the worker.
  enrichmentText: text("enrichment_text"),
  enrichmentSource: text("enrichment_source"),         // "homepage" | "brave" | "none"
  enrichmentFetchedAt: text("enrichment_fetched_at"),  // ISO timestamp
  // Contact form URL: when scraping a prospect for classification, we ALSO
  // harvest contact info. When there's no public email but there IS a
  // contact-us page, stash the URL for later outreach.
  contactFormUrl: text("contact_form_url"),
  leadSourceDetail: text("lead_source_detail"),
  sourceType: text("source_type", { enum: ["storemapper", "outscraper", "manual", "csv", "chrome-ext", "storeleads", "shopify_crawl"] }),
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
  socials: text("socials"),  // JSON: {"instagram": "...", "facebook": "..."}
  // ── StoreLeads integration fields ──
  // StoreLeads.app provides ecommerce-store firmographics (sales, traffic,
  // platform, contact info). Populated by the CSV importer and the live
  // enrichment job. Always merge-fill (never clobber hand-edited values).
  storeleadsId: text("storeleads_id"),
  storeleadsLastSyncedAt: text("storeleads_last_synced_at"),
  employeeCount: integer("employee_count"),
  estimatedMonthlyVisits: integer("estimated_monthly_visits"),
  estimatedYearlySalesCents: integer("estimated_yearly_sales_cents"),
  averageProductPriceCents: integer("average_product_price_cents"),
  tiktokUrl: text("tiktok_url"),
  tiktokFollowers: integer("tiktok_followers"),
  youtubeUrl: text("youtube_url"),
  youtubeFollowers: integer("youtube_followers"),
  // "shopify" / "woocommerce" / "magento" / "bigcommerce" / "custom" / …
  ecomPlatform: text("ecom_platform"),
  // Merchant's "about us" / homepage copy.
  description: text("description"),
  // <meta name="description"> — what shows up in Google results.
  // Often identical to `description` on Shopify but can diverge.
  metaDescription: text("meta_description"),
  // ── MillionVerifier ──
  // Raw `result` from MillionVerifier's API; one of:
  //   'ok' | 'catch_all' | 'unknown' | 'invalid' | 'disposable' | 'error'
  // Null = never verified. Push-to-Instantly filter only accepts 'ok'
  // and 'catch_all'.
  emailVerificationStatus: text("email_verification_status"),
  emailVerifiedAt: text("email_verified_at"),
  // ── Eyewear inventory crawl aggregates (Jun 2026) ──
  // Per-store rollups from the Shopify /products.json scan that
  // found which boutiques already carry sunglasses or reading
  // glasses. Populated only for source_type='shopify_crawl' rows
  // in the eyewear cohort; null on every other lead.
  topBrand: text("top_brand"),
  eyewearCategories: text("eyewear_categories"),     // "sunglasses" / "reading_glasses" / "sunglasses,reading_glasses"
  eyewearSkuCount: integer("eyewear_sku_count"),
  eyewearPriceRange: text("eyewear_price_range"),    // "$25–$95"
  eyewearPriceMedianCents: integer("eyewear_price_median_cents"),
  eyewearTopCompetitors: text("eyewear_top_competitors"), // pipe-joined top 3
  eyewearSampleTitles: text("eyewear_sample_titles"),     // pipe-joined top 3
  // AI-generated opening lines per email in the Instantly sequence.
  // Two distinct slots so email 1 and email 2 don't repeat the same
  // observation about the store.
  aiOpenerEmail1: text("ai_opener_email1"),
  aiOpenerEmail2: text("ai_opener_email2"),
  aiOpenerGeneratedAt: text("ai_opener_generated_at"),
  aiOpenerModel: text("ai_opener_model"),
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
  index("idx_companies_storeleads_id").on(table.storeleadsId),
  index("idx_companies_top_brand").on(table.topBrand),
  index("idx_companies_ecom_platform").on(table.ecomPlatform),
  index("idx_companies_email_verification").on(table.emailVerificationStatus),
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

// ── Brand Accounts ──
export const brandAccounts = sqliteTable("brand_accounts", {
  id: id(),
  externalId: text("external_id").notNull().unique(),
  name: text("name").notNull(),
  website: text("website"),
  sector: text("sector"),
  relevance: text("relevance", { enum: ["relevant", "irrelevant", "needs_review"] }).notNull().default("needs_review"),
  brandType: text("brand_type", { enum: ["wholesale", "own_store", "unknown"] }).notNull().default("unknown"),
  usLocations: integer("us_locations").default(0),
  totalLocations: integer("total_locations").default(0),
  topCountry: text("top_country"),
  notes: text("notes"),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
}, (table) => [
  uniqueIndex("idx_brand_accounts_external_id").on(table.externalId),
  index("idx_brand_accounts_relevance").on(table.relevance),
  index("idx_brand_accounts_sector").on(table.sector),
]);

// ── Company-Brand Links ──
export const companyBrandLinks = sqliteTable("company_brand_links", {
  id: id(),
  companyId: text("company_id").notNull().references(() => companies.id),
  brandAccountId: text("brand_account_id").notNull().references(() => brandAccounts.id),
  createdAt: timestamp("created_at"),
}, (table) => [
  index("idx_cbl_company").on(table.companyId),
  index("idx_cbl_brand").on(table.brandAccountId),
]);

// ── company_phones — one row per known phone per company ──
// The legacy `companies.phone` holds a single primary; this table
// holds the FULL set so cold-call workflows can try every number
// StoreLeads (or any other source) returned.
export const companyPhones = sqliteTable("company_phones", {
  id: id(),
  companyId: text("company_id").notNull().references(() => companies.id),
  phone: text("phone").notNull(),
  source: text("source"),
  phoneType: text("phone_type"),
  isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
}, (table) => [
  index("idx_company_phones_company").on(table.companyId),
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

// ── LLM classification audit log ──
// One row per classification run. Lets us see WHY a prospect got its current
// industry/status — useful when tuning the prompt or investigating an edge
// case months later. The actual industry/verdict ends up on `companies`;
// this table is the history.
export const prospectLlmClassifications = sqliteTable("prospect_llm_classifications", {
  id: id(),
  companyId: text("company_id").notNull(),
  modelName: text("model_name").notNull(),       // e.g. "qwen2.5:7b-instruct-q4_K_M"
  promptVersion: text("prompt_version").notNull(),
  industry: text("industry"),                    // LLM's industry pick
  isChain: integer("is_chain", { mode: "boolean" }),
  confidence: real("confidence"),
  reasoning: text("reasoning"),
  flags: text("flags", { mode: "json" }).$type<string[]>(),
  rawResponse: text("raw_response"),             // full LLM JSON for debugging
  verdict: text("verdict"),                      // "approve" | "reject" | "needs_human"
  enrichmentSource: text("enrichment_source"),   // "homepage" | "brave" | "none"
  classifiedAt: timestamp("classified_at"),
}, (table) => [
  index("idx_plc_company").on(table.companyId),
  index("idx_plc_classified_at").on(table.classifiedAt),
  index("idx_plc_prompt_version").on(table.promptVersion),
]);
