import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import fs from "fs";

// ── Build-phase isolation ──
// During `next build`'s page-data collection step Next spawns ~30 parallel
// workers that all re-import this module. If they share one SQLite file,
// they collide on:
//   1. PRAGMA journal_mode = WAL (header write, requires exclusive access)
//   2. ALTER TABLE / CREATE TABLE migrations
// Both manifest as SQLITE_BUSY and abort the build.
//
// At runtime (production server) NEXT_PHASE is "phase-production-server"
// so we open the real DB normally. During build we open an in-memory DB
// per worker — they share nothing, never lock each other, and the
// throwaway DBs evaporate when the worker exits.
const IS_BUILD_PHASE =
  process.env.NEXT_PHASE === "phase-production-build" ||
  process.env.NEXT_PHASE === "phase-export";

const DB_PATH = process.env.DATABASE_PATH || process.env.DATABASE_URL || path.join(process.cwd(), "data", "the-frame.db");

if (!IS_BUILD_PHASE) {
  // Ensure directory exists (important for Railway where /data is a volume)
  const dbDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
}

const sqlite = new Database(IS_BUILD_PHASE ? ":memory:" : DB_PATH);

// Performance PRAGMAs per CTO review.
// In-memory mode silently no-ops journal_mode=WAL (file-only), which is fine.
if (!IS_BUILD_PHASE) {
  sqlite.pragma("journal_mode = WAL");
}
sqlite.pragma("busy_timeout = 15000");
sqlite.pragma("synchronous = NORMAL");
sqlite.pragma("cache_size = -64000"); // 64MB
sqlite.pragma("foreign_keys = ON");
sqlite.pragma("temp_store = MEMORY");

export const db = drizzle(sqlite);
export { sqlite };

// ── Skip migrations during `next build` ──
if (!IS_BUILD_PHASE) {

// Ensure columns that ALTER TABLE can't add idempotently
try {
  sqlite.exec("ALTER TABLE marketing_seo_keywords ADD COLUMN difficulty INTEGER");
} catch { /* column already exists */ }

// ── Retire legacy single-value attribute columns on catalog_products ──
// These are now derived from catalog_tags (see curated-attributes.ts).
// SQLite supports DROP COLUMN since 3.35; throws if already gone.
for (const col of ["category", "frame_shape", "frame_material", "gender", "lens_type"]) {
  try {
    sqlite.exec(`ALTER TABLE catalog_products DROP COLUMN ${col}`);
  } catch { /* column already dropped */ }
}

try {
  sqlite.exec("ALTER TABLE companies ADD COLUMN disqualify_reason TEXT");
} catch { /* column already exists */ }

try {
  sqlite.exec("ALTER TABLE companies ADD COLUMN segment TEXT");
} catch { /* column already exists */ }

try {
  sqlite.exec("ALTER TABLE companies ADD COLUMN category TEXT");
} catch { /* column already exists */ }

try {
  sqlite.exec("ALTER TABLE companies ADD COLUMN lead_source_detail TEXT");
} catch { /* column already exists */ }

try {
  sqlite.exec("ALTER TABLE companies ADD COLUMN enrichment_status TEXT DEFAULT 'pending'");
} catch { /* column already exists */ }

try {
  sqlite.exec("ALTER TABLE companies ADD COLUMN source_type TEXT");
} catch { /* column already exists */ }

try {
  sqlite.exec("ALTER TABLE companies ADD COLUMN source_id TEXT");
} catch { /* column already exists */ }

try {
  sqlite.exec("ALTER TABLE companies ADD COLUMN source_query TEXT");
} catch { /* column already exists */ }

try {
  sqlite.exec("CREATE INDEX idx_companies_source_type ON companies (source_type)");
} catch { /* index already exists */ }

try {
  sqlite.exec("CREATE INDEX idx_companies_source_id ON companies (source_id)");
} catch { /* index already exists */ }

try {
  sqlite.exec("ALTER TABLE users ADD COLUMN password_reset_token TEXT");
} catch { /* column already exists */ }

try {
  sqlite.exec("ALTER TABLE users ADD COLUMN password_reset_expires TEXT");
} catch { /* column already exists */ }

// JAX-334: Enrichment fields
// Industry bucket (curated, replaces the 317-distinct-values tags mess).
// Populated by scripts/backfill-industry.ts and on insert by the import engine.
try { sqlite.exec("ALTER TABLE companies ADD COLUMN industry TEXT"); } catch { /* exists */ }
try { sqlite.exec("CREATE INDEX idx_companies_industry ON companies (industry)"); } catch { /* exists */ }

// Enrichment cache — what the LLM classifier saw when it decided. Set by the
// Mac-mini classifier worker after scraping the homepage or pulling Brave
// Search snippets. Keep it cheap-to-recompute (90-day TTL).
try { sqlite.exec("ALTER TABLE companies ADD COLUMN enrichment_text TEXT"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE companies ADD COLUMN enrichment_source TEXT"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE companies ADD COLUMN enrichment_fetched_at TEXT"); } catch { /* exists */ }

// Contact form URL — when scraping a prospect for classification, we ALSO
// harvest contact info. If we found a contact-us page but no direct email,
// stash the URL here for later outreach (manual form submission or scraper).
try { sqlite.exec("ALTER TABLE companies ADD COLUMN contact_form_url TEXT"); } catch { /* exists */ }

try { sqlite.exec("ALTER TABLE companies ADD COLUMN owner_name TEXT"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE companies ADD COLUMN business_hours TEXT"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE companies ADD COLUMN facebook_url TEXT"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE companies ADD COLUMN instagram_url TEXT"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE companies ADD COLUMN twitter_url TEXT"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE companies ADD COLUMN linkedin_url TEXT"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE companies ADD COLUMN yelp_url TEXT"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE companies ADD COLUMN enriched_at TEXT"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE companies ADD COLUMN enrichment_source TEXT"); } catch { /* exists */ }

// JAX-332: Chrome extension fields
try { sqlite.exec("ALTER TABLE companies ADD COLUMN socials TEXT"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE companies ADD COLUMN contact_form_url TEXT"); } catch { /* exists */ }

// ICP manual override — when a reviewer edits a prospect's tier/score the
// classifier should leave it alone. icp_updated_by + icp_updated_at give us
// "who changed this and when" for audit + UI.
try { sqlite.exec("ALTER TABLE companies ADD COLUMN icp_manual_override INTEGER DEFAULT 0"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE companies ADD COLUMN icp_updated_by TEXT"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE companies ADD COLUMN icp_updated_at TEXT"); } catch { /* exists */ }

// ── StoreLeads integration ───────────────────────────────────────────────
// Fields captured from StoreLeads.app — Daniel bought a Pro subscription
// for ecommerce-store enrichment. Columns are added even if the StoreLeads
// API/CSV doesn't always populate them; the import + enrichment paths
// merge-fill rather than overwrite so a hand-edited value is preserved.
// Schema mirror in src/modules/sales/schema/index.ts.
// source_type widening to include "storeleads" is a Drizzle-only change
// (SQLite stores enums as plain TEXT, no migration needed).
try { sqlite.exec("ALTER TABLE companies ADD COLUMN storeleads_id TEXT"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE companies ADD COLUMN storeleads_last_synced_at TEXT"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE companies ADD COLUMN employee_count INTEGER"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE companies ADD COLUMN estimated_monthly_visits INTEGER"); } catch { /* exists */ }
// Stored in USD cents to avoid float drift; UI converts back to dollars.
try { sqlite.exec("ALTER TABLE companies ADD COLUMN estimated_yearly_sales_cents INTEGER"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE companies ADD COLUMN average_product_price_cents INTEGER"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE companies ADD COLUMN tiktok_url TEXT"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE companies ADD COLUMN tiktok_followers INTEGER"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE companies ADD COLUMN youtube_url TEXT"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE companies ADD COLUMN youtube_followers INTEGER"); } catch { /* exists */ }
// e.g. "shopify" / "woocommerce" / "magento" / "bigcommerce" / "custom".
try { sqlite.exec("ALTER TABLE companies ADD COLUMN ecom_platform TEXT"); } catch { /* exists */ }
try { sqlite.exec("CREATE INDEX idx_companies_storeleads_id ON companies (storeleads_id)"); } catch { /* exists */ }
try { sqlite.exec("CREATE INDEX idx_companies_ecom_platform ON companies (ecom_platform)"); } catch { /* exists */ }
// Store the merchant's own description (the "about us" copy they show on
// site) and meta_description (the <meta name="description"> tag — what
// shows up in Google results). StoreLeads exports both as separate
// columns; they're often identical on Shopify stores but can diverge.
// Useful for outreach personalization and future LLM enrichment.
try { sqlite.exec("ALTER TABLE companies ADD COLUMN description TEXT"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE companies ADD COLUMN meta_description TEXT"); } catch { /* exists */ }

// SL Phase 7: enforce one push per (campaign, company) pair so re-running
// the StoreLeads → Instantly push UI doesn't add the same lead twice. The
// existing pushCampaigns flow gates on instantly_lead_id IS NULL but
// doesn't prevent a fresh row from being inserted by the new endpoint.
try { sqlite.exec("CREATE UNIQUE INDEX uq_campaign_leads_campaign_company ON campaign_leads (campaign_id, company_id)"); } catch { /* exists */ }

// SL Phase 7.5: NeverBounce email-verification cache. Stamped per row so
// just-in-time verification before Instantly push can skip rows we
// already checked. Status values mirror NeverBounce's raw `result`
// field so the column tells the operator the literal API outcome:
// 'valid' | 'catchall' | 'unknown' | 'invalid' | 'disposable'.
// Push filter accepts 'valid' + 'catchall' (Daniel's pick).
try { sqlite.exec("ALTER TABLE companies ADD COLUMN email_verification_status TEXT"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE companies ADD COLUMN email_verified_at TEXT"); } catch { /* exists */ }
try { sqlite.exec("CREATE INDEX idx_companies_email_verification ON companies (email_verification_status)"); } catch { /* exists */ }

// Eyewear inventory crawl (Shopify /products.json scan, June 2026):
// per-store aggregates so the cold-email opener generator and the
// prospecting UI can answer "what does this store already carry?"
// without having to re-query the source CSV. All optional — only
// populated for source_type='shopify_crawl' rows in the eyewear
// cohort. See plan: tender-dazzling-sparkle.md.
try { sqlite.exec("ALTER TABLE companies ADD COLUMN top_brand TEXT"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE companies ADD COLUMN eyewear_categories TEXT"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE companies ADD COLUMN eyewear_sku_count INTEGER"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE companies ADD COLUMN eyewear_price_range TEXT"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE companies ADD COLUMN eyewear_price_median_cents INTEGER"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE companies ADD COLUMN eyewear_top_competitors TEXT"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE companies ADD COLUMN eyewear_sample_titles TEXT"); } catch { /* exists */ }
// Pipe-joined alongside eyewear_sample_titles — same length, same order.
// Lets the prospect detail UI render each sample as a clickable link to
// the actual product on the store's site + a thumbnail image. Source
// data lives in the crawl CSV's product_url + product_image columns.
try { sqlite.exec("ALTER TABLE companies ADD COLUMN eyewear_sample_urls TEXT"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE companies ADD COLUMN eyewear_sample_images TEXT"); } catch { /* exists */ }
// Per-sample prices, pipe-joined alongside titles/urls/images. Lets
// the prospect detail tiles show "$82" under each product instead of
// only the title.
try { sqlite.exec("ALTER TABLE companies ADD COLUMN eyewear_sample_prices_cents TEXT"); } catch { /* exists */ }

// Additional StoreLeads cohort fields. None of these were on the
// original schema — but they're already present in the CSV, so the
// importer can fill them on every run without re-crawling.
try { sqlite.exec("ALTER TABLE companies ADD COLUMN estimated_monthly_sales_cents INTEGER"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE companies ADD COLUMN estimated_monthly_pageviews INTEGER"); } catch { /* exists */ }
// Pipe-joined list of Shopify apps installed at the store. High-signal
// competitive intel — e.g. "Klaviyo|Yotpo|Loop|Smile.io|Recharge" tells
// us their email-marketing stack, review platform, returns flow,
// loyalty program, subscription tooling. Useful as opener fodder
// ("saw you're on Klaviyo — happy to send our Klaviyo-tagged catalog").
try { sqlite.exec("ALTER TABLE companies ADD COLUMN installed_apps_names TEXT"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE companies ADD COLUMN about_us_url TEXT"); } catch { /* exists */ }
// When StoreLeads first observed the store. Proxy for store age —
// useful for "established 5 years vs. brand new" classification.
try { sqlite.exec("ALTER TABLE companies ADD COLUMN storeleads_first_seen_at TEXT"); } catch { /* exists */ }
// Comma-joined list of related domains in the same brand cluster.
// Helps spot multi-domain merchants and prevents duplicate outreach
// when sister sites share a buying decision.
try { sqlite.exec("ALTER TABLE companies ADD COLUMN cluster_domains TEXT"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE companies ADD COLUMN meta_keywords TEXT"); } catch { /* exists */ }
// Two AI opener slots — one per email in the Instantly sequence.
// Distinct columns (rather than JSON) so they ship cleanly through
// the existing instantly buildCustomVariables() pipe.
try { sqlite.exec("ALTER TABLE companies ADD COLUMN ai_opener_email1 TEXT"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE companies ADD COLUMN ai_opener_email2 TEXT"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE companies ADD COLUMN ai_opener_generated_at TEXT"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE companies ADD COLUMN ai_opener_model TEXT"); } catch { /* exists */ }
// Index because the opener generator's SELECT filters on top_brand
// IS NOT NULL + ai_opener_email1 IS NULL when scanning for the
// next batch of pitchable leads.
try { sqlite.exec("CREATE INDEX idx_companies_top_brand ON companies (top_brand)"); } catch { /* exists */ }

// Image upload system: new columns on catalog_images
try { sqlite.exec("ALTER TABLE catalog_images ADD COLUMN url TEXT"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE catalog_images ADD COLUMN file_size INTEGER"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE catalog_images ADD COLUMN mime_type TEXT"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE catalog_images ADD COLUMN checksum TEXT"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE catalog_images ADD COLUMN uploaded_by TEXT"); } catch { /* exists */ }
try { sqlite.exec("CREATE INDEX idx_catalog_images_checksum ON catalog_images (checksum)"); } catch { /* exists */ }

// Image editor: new columns on catalog_images
try { sqlite.exec("ALTER TABLE catalog_images ADD COLUMN source TEXT DEFAULT 'upload'"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE catalog_images ADD COLUMN pipeline_status TEXT DEFAULT 'none'"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE catalog_images ADD COLUMN parent_image_id TEXT REFERENCES catalog_images(id)"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE catalog_images ADD COLUMN preset_id TEXT REFERENCES catalog_processing_presets(id)"); } catch { /* exists */ }

// Image editor: new tables (idempotent via IF NOT EXISTS)
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS catalog_processing_presets (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    bg_removal_method TEXT DEFAULT 'gemini',
    bg_removal_params TEXT,
    shadow_method TEXT DEFAULT 'none',
    shadow_params TEXT,
    canvas_size INTEGER DEFAULT 2048,
    canvas_bg TEXT DEFAULT '#F8F9FA',
    canvas_padding REAL DEFAULT 0.0,
    output_quality INTEGER DEFAULT 95,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  sqlite.exec(`CREATE TABLE IF NOT EXISTS catalog_image_pipelines (
    id TEXT PRIMARY KEY NOT NULL,
    image_id TEXT NOT NULL REFERENCES catalog_images(id) ON DELETE CASCADE,
    stage TEXT NOT NULL,
    method TEXT,
    method_params TEXT,
    file_path TEXT NOT NULL,
    file_size INTEGER,
    width INTEGER,
    height INTEGER,
    checksum TEXT,
    status TEXT DEFAULT 'completed',
    error_message TEXT,
    processing_time_ms INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_pipeline_image_stage ON catalog_image_pipelines(image_id, stage)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_pipeline_image ON catalog_image_pipelines(image_id)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_pipeline_stage ON catalog_image_pipelines(stage)`);

  sqlite.exec(`CREATE TABLE IF NOT EXISTS catalog_image_variations (
    id TEXT PRIMARY KEY NOT NULL,
    image_id TEXT NOT NULL REFERENCES catalog_images(id) ON DELETE CASCADE,
    stage TEXT NOT NULL,
    method TEXT NOT NULL,
    method_params TEXT,
    file_path TEXT NOT NULL,
    file_size INTEGER,
    width INTEGER,
    height INTEGER,
    label TEXT,
    is_selected INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_variation_image_stage ON catalog_image_variations(image_id, stage)`);

  sqlite.exec(`CREATE TABLE IF NOT EXISTS catalog_collection_images (
    id TEXT PRIMARY KEY NOT NULL,
    product_id TEXT NOT NULL REFERENCES catalog_products(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    file_size INTEGER,
    width INTEGER,
    height INTEGER,
    layout TEXT,
    variant_count INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_collection_product ON catalog_collection_images(product_id)`);

  sqlite.exec(`CREATE TABLE IF NOT EXISTS catalog_collection_image_skus (
    id TEXT PRIMARY KEY NOT NULL,
    collection_image_id TEXT NOT NULL REFERENCES catalog_collection_images(id) ON DELETE CASCADE,
    sku_id TEXT NOT NULL REFERENCES catalog_skus(id) ON DELETE CASCADE,
    position INTEGER DEFAULT 0
  )`);
  sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_collection_sku ON catalog_collection_image_skus(collection_image_id, sku_id)`);
  sqlite.exec(`CREATE TABLE IF NOT EXISTS catalog_product_listing_images (
    id TEXT PRIMARY KEY NOT NULL,
    product_id TEXT NOT NULL REFERENCES catalog_products(id) ON DELETE CASCADE,
    image_id TEXT NOT NULL REFERENCES catalog_images(id) ON DELETE CASCADE,
    platform TEXT DEFAULT 'all',
    position INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_listing_product_image_platform ON catalog_product_listing_images(product_id, image_id, platform)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_listing_product_platform ON catalog_product_listing_images(product_id, platform)`);
} catch (e) { console.error("[db] Image editor table creation error:", e); }

// ── Amazon Listings (AI-generated Amazon-specific copy per product) ──
// One row per product. Regeneration upserts; audit trail goes to
// catalog_copy_versions with fieldName='amazon_listing'.
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS catalog_amazon_listings (
    id TEXT PRIMARY KEY NOT NULL,
    product_id TEXT NOT NULL REFERENCES catalog_products(id) ON DELETE CASCADE,
    amazon_title TEXT,
    bullet_point_1 TEXT,
    bullet_point_2 TEXT,
    bullet_point_3 TEXT,
    bullet_point_4 TEXT,
    bullet_point_5 TEXT,
    product_description TEXT,
    generic_keywords TEXT,
    suggested_color_map TEXT,
    suggested_lens_material TEXT,
    suggested_frame_material TEXT,
    suggested_polarization TEXT,
    suggested_item_shape TEXT,
    model_used TEXT,
    prompt_version TEXT,
    generated_at TEXT,
    approved_at TEXT,
    approved_by TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_amazon_listing_product ON catalog_amazon_listings(product_id)`);
} catch (e) { console.error("[db] catalog_amazon_listings creation error:", e); }

// ── Amazon Listing Groups (Phase 1 of the group-restructure plan) ──
// Replaces one-listing-per-product on the Amazon feed with one
// listing per shape group (e.g. ROUND, AVIATOR). Children stay per
// (style, color, fulfillment) tuple.
//
// catalog_amazon_listings stays untouched — it still drives Shopify
// storefront copy and other channels. Only the Amazon TSV switches
// to group-level.
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS catalog_amazon_listing_groups (
    id TEXT PRIMARY KEY NOT NULL,
    group_key TEXT NOT NULL UNIQUE,         -- e.g. "round", "aviator"
    shape TEXT NOT NULL,                     -- canonical shape ("round", "cat-eye")
    display_name TEXT NOT NULL,              -- "Jaxy Round Sunglasses"
    title TEXT NOT NULL,                     -- Amazon listing title (≤200 chars)
    product_description TEXT NOT NULL,
    bullet_point_1 TEXT,
    bullet_point_2 TEXT,
    bullet_point_3 TEXT,
    bullet_point_4 TEXT,
    bullet_point_5 TEXT,
    generic_keywords TEXT,
    representative_product_id TEXT REFERENCES catalog_products(id),
    model_used TEXT,
    prompt_version TEXT,
    generated_at TEXT,
    approved_at TEXT,
    approved_by TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_amazon_listing_group_key ON catalog_amazon_listing_groups(group_key)`);
} catch (e) { console.error("[db] catalog_amazon_listing_groups creation error:", e); }

// Helium 10 Cerebro keyword research, scrubbed + classified by
// keywords/scrub.ts. One row per (phrase, source). Feeds the per-product
// keyword assembler that builds Amazon title/bullet/backend pools.
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS catalog_keywords (
    id TEXT PRIMARY KEY NOT NULL,
    phrase TEXT NOT NULL,
    search_volume INTEGER DEFAULT 0,
    title_density INTEGER DEFAULT 0,
    competing_products INTEGER DEFAULT 0,
    keyword_sales INTEGER DEFAULT 0,
    cerebro_iq INTEGER DEFAULT 0,
    classification TEXT,                       -- head|shape|feature|audience|use_case
    shape TEXT,                                -- canonical shape, or NULL = shared head term
    verdict TEXT NOT NULL,                     -- keep|brand|irrelevant|off_intent|junk
    source TEXT NOT NULL,                      -- e.g. "cerebro-round-2026-06-09"
    imported_at TEXT DEFAULT (datetime('now')),
    override_status TEXT                        -- whitelist|blacklist (manual)
  )`);
  sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_catalog_keywords_phrase_source ON catalog_keywords(phrase, source)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_catalog_keywords_shape_verdict ON catalog_keywords(shape, verdict)`);
} catch (e) { console.error("[db] catalog_keywords creation error:", e); }

// Group key on each product — lets the row composer slice products
// by group in O(1). Backfilled from the curated frameShape tag.
try { sqlite.exec("ALTER TABLE catalog_products ADD COLUMN amazon_group_key TEXT"); } catch { /* exists */ }
try { sqlite.exec("CREATE INDEX idx_products_amazon_group_key ON catalog_products(amazon_group_key)"); } catch { /* exists */ }

// Image editor: seed angle-based image types
try {
  const angleTypes = [
    "front", "side", "other-side", "top", "back-crossed",
    "crossed", "inside", "name", "closed", "above",
  ];
  const insertType = sqlite.prepare(
    `INSERT OR IGNORE INTO catalog_image_types (id, slug, label, active, sort_order)
     VALUES (lower(hex(randomblob(16))), ?, ?, 1, ?)`
  );
  for (let i = 0; i < angleTypes.length; i++) {
    const slug = angleTypes[i];
    const label = slug.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
    insertType.run(slug, label, i);
  }
} catch (e) { console.error("[db] Image type seed error:", e); }

// FIFO inventory costing tables
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS inventory_cost_layers (
    id TEXT PRIMARY KEY NOT NULL,
    sku_id TEXT NOT NULL,
    po_line_item_id TEXT,
    po_id TEXT,
    po_number TEXT,
    quantity INTEGER NOT NULL,
    remaining_quantity INTEGER NOT NULL,
    unit_cost REAL NOT NULL DEFAULT 0,
    freight_per_unit REAL NOT NULL DEFAULT 0,
    duties_per_unit REAL NOT NULL DEFAULT 0,
    landed_cost_per_unit REAL NOT NULL DEFAULT 0,
    shipping_method TEXT,
    received_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_cost_layers_sku ON inventory_cost_layers(sku_id)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_cost_layers_po ON inventory_cost_layers(po_id)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_cost_layers_received ON inventory_cost_layers(received_at)`);

  sqlite.exec(`CREATE TABLE IF NOT EXISTS inventory_cost_depletions (
    id TEXT PRIMARY KEY NOT NULL,
    cost_layer_id TEXT NOT NULL REFERENCES inventory_cost_layers(id),
    order_item_id TEXT,
    order_id TEXT,
    channel TEXT,
    quantity INTEGER NOT NULL,
    unit_cost REAL NOT NULL,
    landed_cost_per_unit REAL NOT NULL,
    depleted_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_depletions_layer ON inventory_cost_depletions(cost_layer_id)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_depletions_order ON inventory_cost_depletions(order_id)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_depletions_depleted ON inventory_cost_depletions(depleted_at)`);

  sqlite.exec(`CREATE TABLE IF NOT EXISTS cogs_journals (
    id TEXT PRIMARY KEY NOT NULL,
    week_start TEXT NOT NULL,
    week_end TEXT NOT NULL,
    product_cost REAL NOT NULL DEFAULT 0,
    freight_cost REAL NOT NULL DEFAULT 0,
    duties_cost REAL NOT NULL DEFAULT 0,
    total_cogs REAL NOT NULL DEFAULT 0,
    unit_count INTEGER NOT NULL DEFAULT 0,
    channel_breakdown TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    xero_journal_id TEXT,
    xero_posted_at TEXT,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_cogs_journals_week ON cogs_journals(week_start, week_end)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_cogs_journals_status ON cogs_journals(status)`);
} catch (e) { console.error("[db] FIFO tables error:", e); }

// Shopify category metafield sync: cached AI categorization per product
try { sqlite.exec("ALTER TABLE catalog_products ADD COLUMN ai_categorization TEXT"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE catalog_products ADD COLUMN ai_categorized_at TEXT"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE catalog_products ADD COLUMN ai_categorization_model TEXT"); } catch { /* exists */ }
// Physical frame dimensions in millimetres — see
// src/modules/catalog/lib/frame-size.ts for the parser used to populate
// these from the factory's "51口22 145" strings.
try { sqlite.exec("ALTER TABLE catalog_products ADD COLUMN lens_width INTEGER"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE catalog_products ADD COLUMN bridge_width INTEGER"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE catalog_products ADD COLUMN temple_length INTEGER"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE catalog_products ADD COLUMN lens_height INTEGER"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE catalog_products ADD COLUMN frame_width INTEGER"); } catch { /* exists */ }
// 6th dimension — Google Shopping product_detail[frame_height] is the only
// dimension we weren't writing as a metafield. Added here so the Shopify
// metafield sync can read it from a discrete column rather than parsing
// it back out of the legacy `frame_size` blob.
try { sqlite.exec("ALTER TABLE catalog_products ADD COLUMN frame_height INTEGER"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE catalog_products ADD COLUMN frame_size TEXT"); } catch { /* exists */ }

// Campaign-segmentation label for Google Shopping Custom Label 4 (e.g.
// "SS26", "FW26", "vintage_drop_1"). Single value per product; nullable.
try { sqlite.exec("ALTER TABLE catalog_products ADD COLUMN collection_batch TEXT"); } catch { /* exists */ }

// Per-SKU lens color, distinct from the frame color stored on
// catalog_skus.color_name. Drives the new Shopify variant title format
// `{Frame Color} Frame / {Lens Color} Lens`. Populated by the SEO-feed
// importer (splits legacy slash-form names like "Tort/Green") and via
// future PO imports; falls back gracefully when null.
try { sqlite.exec("ALTER TABLE catalog_skus ADD COLUMN lens_color_name TEXT"); } catch { /* exists */ }

// Reading-glasses variant axes — diopter power + optional blue-light
// filter. Both nullable so sunglass/optical SKUs are unaffected. See
// src/modules/catalog/lib/reading-glasses.ts for the allowed-power list.
try { sqlite.exec("ALTER TABLE catalog_skus ADD COLUMN reading_power REAL"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE catalog_skus ADD COLUMN has_blue_light_filter INTEGER"); } catch { /* exists */ }

// Instantly.ai webhook receiver — idempotency + delivery audit log.
// PK is sha256(eventType|leadEmail|campaignId|timestamp) so retried
// deliveries fail INSERT silently. See
// src/modules/sales/lib/instantly-webhooks.ts.
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS instantly_webhook_events (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    workspace_id TEXT,
    campaign_id TEXT,
    campaign_name TEXT,
    lead_email TEXT,
    payload TEXT NOT NULL,
    token_valid INTEGER NOT NULL,
    handler_ok INTEGER,
    handler_message TEXT,
    received_at TEXT DEFAULT (datetime('now'))
  )`);
  sqlite.exec("CREATE INDEX IF NOT EXISTS idx_instantly_webhook_events_lead_email ON instantly_webhook_events(lead_email)");
  sqlite.exec("CREATE INDEX IF NOT EXISTS idx_instantly_webhook_events_event_type ON instantly_webhook_events(event_type)");
  sqlite.exec("CREATE INDEX IF NOT EXISTS idx_instantly_webhook_events_received_at ON instantly_webhook_events(received_at)");
} catch { /* exists */ }

// PhoneBurner integration — outbound cold-calling.
//
// Push side: campaigns get a PB folder; each campaign_lead's
// PB contact id is stored after the contact is created.
//
// Pull side: a cron polls PB for recent calls every 5 min and
// inserts into phoneburner_call_log (PK is PB's call_id for
// idempotency). campaign_leads carries denormalized last-call
// state for fast prospect-page rendering.
try { sqlite.exec("ALTER TABLE campaigns ADD COLUMN phoneburner_folder_id TEXT"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE campaign_leads ADD COLUMN phoneburner_contact_id TEXT"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE campaign_leads ADD COLUMN last_called_at TEXT"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE campaign_leads ADD COLUMN last_call_disposition TEXT"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE campaign_leads ADD COLUMN call_count INTEGER DEFAULT 0"); } catch { /* exists */ }
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS phoneburner_call_log (
    id TEXT PRIMARY KEY,
    campaign_lead_id TEXT,
    company_id TEXT,
    phoneburner_contact_id TEXT,
    agent_id TEXT,
    agent_email TEXT,
    duration_seconds INTEGER,
    connected INTEGER,
    disposition_label TEXT,
    disposition_id TEXT,
    notes TEXT,
    recording_url TEXT,
    called_at TEXT,
    ingested_at TEXT DEFAULT (datetime('now'))
  )`);
  sqlite.exec("CREATE INDEX IF NOT EXISTS idx_phoneburner_call_log_company ON phoneburner_call_log(company_id)");
  sqlite.exec("CREATE INDEX IF NOT EXISTS idx_phoneburner_call_log_called_at ON phoneburner_call_log(called_at)");
  sqlite.exec("CREATE INDEX IF NOT EXISTS idx_phoneburner_call_log_lead ON phoneburner_call_log(campaign_lead_id)");
  sqlite.exec("CREATE INDEX IF NOT EXISTS idx_phoneburner_call_log_pb_contact ON phoneburner_call_log(phoneburner_contact_id)");
} catch { /* exists */ }

// Warehouse/ShipHero exports: PO line items, freight info on POs, shiphero sync timestamps
try { sqlite.exec("ALTER TABLE catalog_skus ADD COLUMN shiphero_synced_at TEXT"); } catch { /* exists */ }
// Touch-stamp the row when anything edits it (UPC bulk-import,
// per-row UI edit, etc.) — symmetric with most other tables that have
// an updated_at. Idempotent: skipped after the first run.
try { sqlite.exec("ALTER TABLE catalog_skus ADD COLUMN updated_at TEXT"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE catalog_purchase_orders ADD COLUMN factory_code TEXT"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE catalog_purchase_orders ADD COLUMN freight_type TEXT"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE catalog_purchase_orders ADD COLUMN shipping_method TEXT"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE catalog_purchase_orders ADD COLUMN ship_date TEXT"); } catch { /* exists */ }

try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS catalog_purchase_order_items (
    id TEXT PRIMARY KEY NOT NULL,
    purchase_order_id TEXT NOT NULL REFERENCES catalog_purchase_orders(id) ON DELETE CASCADE,
    sku TEXT NOT NULL,
    vendor_sku TEXT,
    quantity INTEGER NOT NULL,
    unit_price REAL,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_po_items_po ON catalog_purchase_order_items(purchase_order_id)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_po_items_sku ON catalog_purchase_order_items(sku)`);
} catch (e) { console.error("[db] PO items table error:", e); }

// Shopify OAuth: shops table (multi-store, channel-driven)
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS shopify_shops (
    id TEXT PRIMARY KEY NOT NULL,
    shop_domain TEXT NOT NULL UNIQUE,
    display_name TEXT,
    channel TEXT NOT NULL,
    access_token TEXT NOT NULL,
    scope TEXT,
    api_version TEXT DEFAULT '2025-07',
    metadata TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    last_health_check_at TEXT,
    last_health_status TEXT,
    last_health_error TEXT,
    installed_at TEXT DEFAULT (datetime('now')),
    uninstalled_at TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_shopify_shops_channel ON shopify_shops(channel)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_shopify_shops_active ON shopify_shops(is_active)`);

  // OAuth nonces (anti-CSRF state). Short-lived rows; cleaned on use or by TTL.
  sqlite.exec(`CREATE TABLE IF NOT EXISTS shopify_oauth_states (
    state TEXT PRIMARY KEY NOT NULL,
    shop_domain TEXT NOT NULL,
    channel TEXT,
    return_to TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  // Webhook event log — every incoming Shopify webhook lands here so we can
  // observe what's firing in production and confirm the subscriptions work.
  sqlite.exec(`CREATE TABLE IF NOT EXISTS shopify_webhook_events (
    id TEXT PRIMARY KEY NOT NULL,
    shop_domain TEXT,
    topic TEXT,
    webhook_id TEXT,
    triggered_at TEXT,
    received_at TEXT DEFAULT (datetime('now')),
    hmac_valid INTEGER,
    handler_ok INTEGER,
    handler_message TEXT,
    payload_size INTEGER,
    payload_preview TEXT
  )`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_shopify_webhook_events_received ON shopify_webhook_events(received_at DESC)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_shopify_webhook_events_shop ON shopify_webhook_events(shop_domain)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_shopify_webhook_events_topic ON shopify_webhook_events(topic)`);
} catch (e) { console.error("[db] Shopify shops table error:", e); }

// ── ShipHero webhook tables ──
// shiphero_webhook_events    every received webhook lands here for observability
// shiphero_webhook_subscriptions  what we've registered with ShipHero
// shiphero_attachment_logs   idempotency key for packing-slip attaches
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS shiphero_webhook_events (
    id TEXT PRIMARY KEY NOT NULL,
    topic TEXT,
    shiphero_id TEXT,
    external_id TEXT,
    triggered_at TEXT,
    received_at TEXT DEFAULT (datetime('now')),
    hmac_valid INTEGER,
    handler_ok INTEGER,
    handler_message TEXT,
    payload_size INTEGER,
    payload_preview TEXT
  )`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_shiphero_webhook_events_received ON shiphero_webhook_events(received_at DESC)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_shiphero_webhook_events_topic ON shiphero_webhook_events(topic)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_shiphero_webhook_events_shiphero_id ON shiphero_webhook_events(shiphero_id)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_shiphero_webhook_events_external_id ON shiphero_webhook_events(external_id)`);

  sqlite.exec(`CREATE TABLE IF NOT EXISTS shiphero_webhook_subscriptions (
    id TEXT PRIMARY KEY NOT NULL,
    topic TEXT NOT NULL,
    url TEXT NOT NULL,
    shared_secret TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    deactivated_at TEXT
  )`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_shiphero_webhook_subscriptions_topic ON shiphero_webhook_subscriptions(topic)`);

  sqlite.exec(`CREATE TABLE IF NOT EXISTS shiphero_attachment_logs (
    id TEXT PRIMARY KEY NOT NULL,
    shiphero_order_id TEXT NOT NULL,
    external_id TEXT,
    faire_order_id TEXT,
    filename TEXT NOT NULL,
    status TEXT NOT NULL,
    error_message TEXT,
    attached_at TEXT DEFAULT (datetime('now'))
  )`);
  // Idempotency key: one successful attach per (shiphero_order_id, filename)
  sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_shiphero_attachment_logs_success
    ON shiphero_attachment_logs(shiphero_order_id, filename) WHERE status = 'success'`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_shiphero_attachment_logs_order ON shiphero_attachment_logs(shiphero_order_id)`);

  // Audit + idempotency for Faire shipment marks.
  // status: success | error | skipped_non_us | skipped_unknown_carrier | skipped_no_tracking
  sqlite.exec(`CREATE TABLE IF NOT EXISTS faire_shipment_marks (
    id TEXT PRIMARY KEY NOT NULL,
    faire_order_id TEXT,
    order_number TEXT,
    country_code TEXT,
    carrier TEXT,
    tracking_code TEXT,
    maker_cost_cents INTEGER,
    status TEXT NOT NULL,
    response_status INTEGER,
    response_body TEXT,
    error_message TEXT,
    marked_at TEXT DEFAULT (datetime('now'))
  )`);
  // One successful mark per Faire order. Re-runs short-circuit on the
  // partial-unique index for safety even if the transition gate in
  // shipment-update.ts doesn't fire (e.g. manual replay through scripts).
  sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_faire_shipment_marks_success
    ON faire_shipment_marks(faire_order_id) WHERE status = 'success'`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_faire_shipment_marks_order
    ON faire_shipment_marks(order_number)`);
} catch (e) { console.error("[db] ShipHero webhook tables error:", e); }

// ── Xero integration tables ──
// Account mappings (category -> Xero GL account code), sync runs,
// journal log audit trail, and per-payout idempotency.
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS xero_account_mappings (
    id TEXT PRIMARY KEY NOT NULL,
    source_platform TEXT NOT NULL,
    category TEXT NOT NULL,
    xero_account_code TEXT NOT NULL,
    xero_account_name TEXT,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_xero_mapping_platform_category
               ON xero_account_mappings(source_platform, category)`);

  sqlite.exec(`CREATE TABLE IF NOT EXISTS xero_sync_runs (
    id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL,
    source_platform TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    date_from TEXT,
    date_to TEXT,
    total_payouts INTEGER DEFAULT 0,
    successful INTEGER DEFAULT 0,
    failed INTEGER DEFAULT 0,
    error_message TEXT,
    started_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT
  )`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_xero_sync_runs_kind ON xero_sync_runs(kind)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_xero_sync_runs_started ON xero_sync_runs(started_at DESC)`);

  sqlite.exec(`CREATE TABLE IF NOT EXISTS xero_journal_log (
    id TEXT PRIMARY KEY NOT NULL,
    sync_run_id TEXT REFERENCES xero_sync_runs(id) ON DELETE SET NULL,
    source_platform TEXT NOT NULL,
    source_id TEXT NOT NULL,
    xero_object_type TEXT NOT NULL,
    xero_object_id TEXT,
    status TEXT NOT NULL,
    amount REAL,
    currency TEXT,
    payload TEXT,
    response TEXT,
    error_message TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_xero_journal_log_run ON xero_journal_log(sync_run_id)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_xero_journal_log_source ON xero_journal_log(source_platform, source_id)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_xero_journal_log_created ON xero_journal_log(created_at DESC)`);

  sqlite.exec(`CREATE TABLE IF NOT EXISTS xero_payout_syncs (
    id TEXT PRIMARY KEY NOT NULL,
    source_platform TEXT NOT NULL,
    source_payout_id TEXT NOT NULL,
    amount REAL,
    currency TEXT,
    paid_at TEXT,
    xero_object_type TEXT,
    xero_object_id TEXT,
    sync_run_id TEXT REFERENCES xero_sync_runs(id) ON DELETE SET NULL,
    synced_at TEXT DEFAULT (datetime('now'))
  )`);
  sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_xero_payout_sync_platform_id
               ON xero_payout_syncs(source_platform, source_payout_id)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_xero_payout_sync_run ON xero_payout_syncs(sync_run_id)`);

  // Tracking-category mapping per source platform. Lets us tag each manual
  // journal line with the matching Xero tracking option (e.g. "Sales Channel
  // = Shopify - Retail") so P&L splits automatically by channel.
  sqlite.exec(`CREATE TABLE IF NOT EXISTS xero_tracking_mappings (
    id TEXT PRIMARY KEY NOT NULL,
    source_platform TEXT NOT NULL UNIQUE,
    tracking_category_id TEXT NOT NULL,
    tracking_category_name TEXT,
    tracking_option_id TEXT NOT NULL,
    tracking_option_name TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);

  // Per-line audit detail for COGS journals. Captures the unit_cost we used
  // at sync time for each SKU so future cost_price changes don't corrupt
  // the audit trail. Indexed by sku so accountants can query
  // "show me every COGS line for SKU JX1001-BLK in March" cheaply.
  sqlite.exec(`CREATE TABLE IF NOT EXISTS xero_journal_log_lines (
    id TEXT PRIMARY KEY NOT NULL,
    journal_log_id TEXT NOT NULL REFERENCES xero_journal_log(id) ON DELETE CASCADE,
    sku TEXT,
    sku_id TEXT,
    product_name TEXT,
    color_name TEXT,
    quantity INTEGER,
    unit_cost_at_sale REAL,
    line_total REAL,
    side TEXT,
    account_code TEXT,
    tracking_option_id TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_xero_journal_log_lines_log ON xero_journal_log_lines(journal_log_id)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_xero_journal_log_lines_sku ON xero_journal_log_lines(sku)`);

  // Per-order revenue recognition log. Written by the shipment-revenue cron
  // when a previously-deferred order ships and revenue moves from Deferred
  // Revenue (2200) → Sales Revenue under accrual. Used for idempotency and
  // audit trail.
  sqlite.exec(`CREATE TABLE IF NOT EXISTS order_revenue_recognitions (
    id TEXT PRIMARY KEY NOT NULL,
    order_id TEXT NOT NULL,
    external_order_id TEXT,
    payout_external_id TEXT,
    channel TEXT NOT NULL,
    recognized_at TEXT NOT NULL,
    revenue_amount REAL NOT NULL,
    cogs_amount REAL DEFAULT 0,
    currency TEXT DEFAULT 'USD',
    xero_manual_journal_id TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_orr_order_id ON order_revenue_recognitions(order_id)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_orr_channel ON order_revenue_recognitions(channel)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_orr_recognized_at ON order_revenue_recognitions(recognized_at)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_orr_payout_external_id ON order_revenue_recognitions(payout_external_id)`);

  // Accrual model needs two more account mappings (added 2026-05-13 when
  // we moved from "recognize revenue on payout" → "defer at payout, recognize
  // at shipment" under ASC 606 accrual rules).
  //   - receivables_holding (1100): non-bank clearing for NET payouts —
  //     swept into the 101x BANK accounts via BankTransaction so the old
  //     "post manual journal directly to BANK" validation failure goes away.
  //   - deferred_revenue (2050): GROSS revenue lives here until the order
  //     ships and recognition fires. 2050 matches the existing Xero CoA;
  //     earlier seed used 2200 which didn't exist on Jaxy's books.
  // Both are "_shared" — channel split is done via Sales Channel tracking.
  sqlite.exec(`
    INSERT OR IGNORE INTO xero_account_mappings (id, source_platform, category, xero_account_code, xero_account_name, notes)
    VALUES
      (lower(hex(randomblob(16))), '_shared', 'receivables_holding', '1100', 'Receivables Holding',
       'Non-bank clearing for net payouts; cleared by BankTransaction into 101x BANK accounts'),
      (lower(hex(randomblob(16))), '_shared', 'deferred_revenue',      '2050', 'Deferred Revenue',
       'Liability for paid-but-unshipped orders; cleared into Sales Revenue at shipment')
  `);

  // One-shot corrective: fixes installs that seeded the wrong deferred-
  // revenue code (the 2026-05-13 first seed used 2200 which doesn't exist
  // in the live CoA — actual account is 2050). UPDATE is idempotent.
  sqlite.exec(`
    UPDATE xero_account_mappings
       SET xero_account_code = '2050',
           xero_account_name = 'Deferred Revenue',
           updated_at = datetime('now')
     WHERE source_platform = '_shared'
       AND category = 'deferred_revenue'
       AND xero_account_code = '2200'
  `);

  // One-shot corrective: Faire-origin settlements were tagged channel=
  // 'shopify_wholesale' (because the Faire integration synced them into
  // our wholesale Shopify store), but that broke the Finance > Settlements
  // and Reconciliation views — they double-counted Faire payouts against
  // wholesale period expected revenue. Faire-payout settlements are
  // identifiable by external_id LIKE 'faire_payout_%'. UPDATE is idempotent.
  sqlite.exec(`
    UPDATE settlements
       SET channel = 'faire'
     WHERE channel = 'shopify_wholesale'
       AND external_id LIKE 'faire_payout_%'
  `);
} catch (e) { console.error("[db] Xero ops tables error:", e); }

// ── Slack notifications ──
// Channel routing: each notification "topic" (e.g. orders.wholesale) maps to
// one Slack channel. UI lets the user override per topic. Bot token lives in
// SLACK_BOT_TOKEN env var (Railway), not in DB.
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS slack_channel_routing (
    id TEXT PRIMARY KEY NOT NULL,
    topic TEXT NOT NULL UNIQUE,
    channel_id TEXT,
    channel_name TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT DEFAULT (datetime('now'))
  )`);

  // Audit log of every Slack message we sent — useful for debugging and to
  // show recent activity on the integrations page.
  sqlite.exec(`CREATE TABLE IF NOT EXISTS slack_message_log (
    id TEXT PRIMARY KEY NOT NULL,
    topic TEXT,
    channel_id TEXT,
    channel_name TEXT,
    text_preview TEXT,
    ok INTEGER,
    error TEXT,
    sent_at TEXT DEFAULT (datetime('now'))
  )`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_slack_message_log_sent ON slack_message_log(sent_at DESC)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_slack_message_log_topic ON slack_message_log(topic)`);
} catch (e) { console.error("[db] Slack tables error:", e); }

// ── Centralized cron scheduler ──
// One Railway cron service hits /api/v1/cron/tick every minute. The
// scheduler reads the in-code job registry, decides what's due, runs them,
// and persists results here.
try {
  // Per-job runtime state — last_run, enabled toggle, schedule override.
  // The job registry is in code (the source of truth), but this table lets
  // the UI disable / re-enable jobs and see when they last fired.
  sqlite.exec(`CREATE TABLE IF NOT EXISTS cron_job_state (
    job_id TEXT PRIMARY KEY NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run_id TEXT,
    last_run_at TEXT,
    last_status TEXT,
    last_error TEXT,
    last_duration_ms INTEGER,
    in_progress INTEGER NOT NULL DEFAULT 0,
    in_progress_since TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  )`);

  // Run history. One row per job execution so the UI can show a sparkline
  // and recent failures.
  sqlite.exec(`CREATE TABLE IF NOT EXISTS cron_runs (
    id TEXT PRIMARY KEY NOT NULL,
    job_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,
    duration_ms INTEGER,
    result TEXT,
    error TEXT,
    triggered_by TEXT
  )`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_cron_runs_job ON cron_runs(job_id, started_at DESC)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_cron_runs_started ON cron_runs(started_at DESC)`);
} catch (e) { console.error("[db] Cron scheduler tables error:", e); }

try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS operations_exports (
    id TEXT PRIMARY KEY NOT NULL,
    export_type TEXT NOT NULL,
    filename TEXT NOT NULL,
    row_count INTEGER NOT NULL,
    filters TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    created_by TEXT
  )`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_operations_exports_type ON operations_exports(export_type)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_operations_exports_created ON operations_exports(created_at)`);
} catch (e) { console.error("[db] Operations exports table error:", e); }

// LLM classification audit log. One row per classification — the Mac-mini
// classifier worker writes here every time it processes a prospect, even on
// re-classifications. Lets us:
//   - Track which prompt version produced which verdict
//   - A/B compare verdicts after a prompt tweak
//   - Audit "why did this row get rejected" months later
//   - Re-train / fine-tune off the human review corrections later
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS prospect_llm_classifications (
    id TEXT PRIMARY KEY NOT NULL,
    company_id TEXT NOT NULL,
    model_name TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    industry TEXT,
    is_chain INTEGER,
    confidence REAL,
    reasoning TEXT,
    flags TEXT,
    raw_response TEXT,
    verdict TEXT,
    enrichment_source TEXT,
    classified_at TEXT DEFAULT (datetime('now'))
  )`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_plc_company ON prospect_llm_classifications(company_id)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_plc_classified_at ON prospect_llm_classifications(classified_at DESC)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_plc_prompt_version ON prospect_llm_classifications(prompt_version)`);
} catch (e) { console.error("[db] LLM classifications table error:", e); }

// Ensure brand_accounts + company_brand_links + magic_link_tokens exist (idempotent)
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS brand_accounts (
    id TEXT PRIMARY KEY NOT NULL,
    external_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    website TEXT,
    sector TEXT,
    relevance TEXT NOT NULL DEFAULT 'needs_review',
    brand_type TEXT NOT NULL DEFAULT 'unknown',
    us_locations INTEGER DEFAULT 0,
    total_locations INTEGER DEFAULT 0,
    top_country TEXT,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS brand_accounts_external_id_unique ON brand_accounts (external_id)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_brand_accounts_relevance ON brand_accounts (relevance)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_brand_accounts_sector ON brand_accounts (sector)`);
  sqlite.exec(`CREATE TABLE IF NOT EXISTS company_brand_links (
    id TEXT PRIMARY KEY NOT NULL,
    company_id TEXT NOT NULL REFERENCES companies(id),
    brand_account_id TEXT NOT NULL REFERENCES brand_accounts(id),
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_cbl_company ON company_brand_links (company_id)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_cbl_brand ON company_brand_links (brand_account_id)`);

  // Multiple phone numbers per company. The legacy companies.phone
  // column holds a single primary phone (the one populated at import
  // from contact_info[0]); this table holds every number we know of
  // — storefront, mobile, customer service — so cold-call lists can
  // try multiple numbers per lead.
  sqlite.exec(`CREATE TABLE IF NOT EXISTS company_phones (
    id TEXT PRIMARY KEY NOT NULL,
    company_id TEXT NOT NULL REFERENCES companies(id),
    phone TEXT NOT NULL,
    source TEXT,          -- 'storeleads' / 'manual' / 'csv' / 'outscraper'
    phone_type TEXT,      -- future: 'storefront' / 'mobile' / 'support'
    is_primary INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_company_phones_company ON company_phones (company_id)`);
  // De-dupe key: same company + same phone string is one row.
  // Comparing on TRIM/LOWER would be more robust but keeps the SQL
  // index simple; callers normalize before insert.
  sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_company_phones ON company_phones (company_id, phone)`);
  sqlite.exec(`CREATE TABLE IF NOT EXISTS magic_link_tokens (
    id TEXT PRIMARY KEY NOT NULL,
    email TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used INTEGER DEFAULT 0 NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS magic_link_tokens_token_unique ON magic_link_tokens (token)`);
  // Ensure notes column on brand_accounts
  try { sqlite.exec("ALTER TABLE brand_accounts ADD COLUMN notes TEXT"); } catch { /* exists */ }
} catch (e) { console.error("[db] Table ensure error:", e); }

// ── ONE-TIME: Clear all old product images (pre-pipeline uploads) ──
// Safe: checks a flag row so it only runs once per database.
try {
  const flag = sqlite.prepare(
    "SELECT 1 FROM catalog_processing_presets WHERE name = '__images_reset_v1'"
  ).get();
  if (!flag) {
    console.log("[db] Running one-time image reset migration...");
    sqlite.exec("DELETE FROM catalog_product_listing_images");
    sqlite.exec("DELETE FROM catalog_collection_image_skus");
    sqlite.exec("DELETE FROM catalog_collection_images");
    sqlite.exec("DELETE FROM catalog_image_variations");
    sqlite.exec("DELETE FROM catalog_image_pipelines");
    sqlite.exec("DELETE FROM catalog_images");
    // Insert flag so this never runs again
    sqlite.prepare(
      `INSERT INTO catalog_processing_presets (id, name, description, created_at)
       VALUES (lower(hex(randomblob(16))), '__images_reset_v1', 'Migration flag — old images cleared', datetime('now'))`
    ).run();
    // Clean up image files from disk
    const imagesDir = process.env.IMAGES_PATH || path.join(process.cwd(), "data", "images");
    if (fs.existsSync(imagesDir)) {
      for (const entry of fs.readdirSync(imagesDir)) {
        const entryPath = path.join(imagesDir, entry);
        try { fs.rmSync(entryPath, { recursive: true, force: true }); } catch {}
      }
      console.log("[db] Cleared image files from", imagesDir);
    }
    console.log("[db] Image reset complete — all old images removed");
  }
} catch (e) { console.error("[db] Image reset error:", e); }

// Unique constraint on inventory(sku_id, location) for ShipHero sync upsert
try { sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_sku_location ON inventory(sku_id, location)"); } catch { /* exists */ }

// One-time: wipe stale inventory quantities so ShipHero sync becomes source of truth
try {
  const flag = sqlite.prepare("SELECT 1 FROM catalog_processing_presets WHERE name = '__inventory_reset_shiphero_v1'").get();
  if (!flag) {
    sqlite.exec("UPDATE inventory SET quantity = 0, reserved_quantity = 0, updated_at = datetime('now')");
    sqlite.prepare(
      "INSERT INTO catalog_processing_presets (id, name, description, created_at) VALUES (lower(hex(randomblob(16))), '__inventory_reset_shiphero_v1', 'Migration flag — old inventory zeroed for ShipHero sync', datetime('now'))"
    ).run();
    console.log("[db] Inventory quantities reset to 0 — ShipHero sync is now source of truth");
  }
} catch (e) { console.error("[db] Inventory reset error:", e); }

// ShipHero columns on orders table
try { sqlite.exec("ALTER TABLE orders ADD COLUMN shiphero_order_id TEXT"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE orders ADD COLUMN shiphero_order_number TEXT"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE orders ADD COLUMN shiphero_fulfillment_status TEXT"); } catch { /* exists */ }
try { sqlite.exec("CREATE INDEX IF NOT EXISTS idx_orders_shiphero_id ON orders(shiphero_order_id)"); } catch { /* exists */ }
// Ship-to recipient captured straight from the Shopify order's shipping
// address (company, falling back to person name). Used verbatim in the
// "order fulfilled" Slack alert — no CRM company lookup, which was
// mis-attributing orders that shared a free-email domain.
try { sqlite.exec("ALTER TABLE orders ADD COLUMN ship_to_name TEXT"); } catch { /* exists */ }

// ShipHero shipments (multiple per order for partial fulfillments)
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS shiphero_shipments (
    id TEXT PRIMARY KEY NOT NULL,
    order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    shiphero_shipment_id TEXT NOT NULL UNIQUE,
    shiphero_order_id TEXT NOT NULL,
    carrier TEXT,
    tracking_number TEXT,
    tracking_url TEXT,
    label_cost REAL,
    status TEXT,
    picked_up INTEGER DEFAULT 0,
    total_packages INTEGER,
    created_date TEXT,
    synced_at TEXT NOT NULL
  )`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_sh_shipments_order ON shiphero_shipments(order_id)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_sh_shipments_shiphero_order ON shiphero_shipments(shiphero_order_id)`);
} catch (e) { console.error("[db] ShipHero shipments table error:", e); }

// ShipHero order costs (from fulfillment invoices)
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS shiphero_order_costs (
    id TEXT PRIMARY KEY NOT NULL,
    order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    shiphero_order_id TEXT NOT NULL,
    invoice_id TEXT,
    invoice_date TEXT,
    shipping_rate REAL NOT NULL DEFAULT 0,
    processing_fee REAL NOT NULL DEFAULT 0,
    picking_fee REAL NOT NULL DEFAULT 0,
    overcharge_fee REAL NOT NULL DEFAULT 0,
    total_cost REAL NOT NULL DEFAULT 0,
    synced_at TEXT NOT NULL
  )`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_sh_costs_order ON shiphero_order_costs(order_id)`);
  sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sh_costs_order_invoice ON shiphero_order_costs(shiphero_order_id, invoice_id)`);
} catch (e) { console.error("[db] ShipHero order costs table error:", e); }

// ShipHero inventory cache
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS shiphero_inventory (
    sku TEXT NOT NULL,
    warehouse_id TEXT NOT NULL,
    on_hand INTEGER NOT NULL DEFAULT 0,
    allocated INTEGER NOT NULL DEFAULT 0,
    available INTEGER NOT NULL DEFAULT 0,
    synced_at TEXT NOT NULL,
    PRIMARY KEY (sku, warehouse_id)
  )`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_shiphero_inv_sku ON shiphero_inventory(sku)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_shiphero_inv_synced ON shiphero_inventory(synced_at)`);
} catch (e) { console.error("[db] ShipHero inventory table error:", e); }

// Ensure segment data model exists before app code reads it.
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS segments (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT,
    icp_profile TEXT,
    email_templates TEXT,
    outreach_notes TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_segments_slug ON segments (slug)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_segments_status ON segments (status)`);
} catch (e) { console.error("[db] Segment ensure error:", e); }

// Auto-run migrations on startup (idempotent — safe to run every time)
try {
  const migrationsFolder = path.join(process.cwd(), "drizzle", "migrations");
  if (fs.existsSync(migrationsFolder)) {
    migrate(db, { migrationsFolder });
    console.log("[db] Migrations applied successfully");
  }
} catch (err) {
  console.error("[db] Migration error:", err);
}

try {
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_companies_segment_id ON companies (segment_id)`);
  sqlite.exec(`
    INSERT OR IGNORE INTO segments (id, name, slug, status, created_at, updated_at)
    SELECT lower(hex(randomblob(16))), trim(segment), lower(replace(trim(segment), ' ', '-')), 'active', datetime('now'), datetime('now')
    FROM companies
    WHERE segment IS NOT NULL AND trim(segment) != ''
    GROUP BY lower(trim(segment))
  `);
  sqlite.exec(`
    UPDATE companies
    SET segment_id = (
      SELECT s.id
      FROM segments s
      WHERE lower(trim(s.name)) = lower(trim(companies.segment))
      LIMIT 1
    )
    WHERE segment_id IS NULL
      AND segment IS NOT NULL
      AND trim(segment) != ''
  `);
} catch (e) { console.error("[db] Segment sync error:", e); }

}  // end if (!IS_BUILD_PHASE)
