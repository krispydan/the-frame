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

// Email hero: where the headline/subtitle sits over a full-bleed image
// (top/middle/bottom); the scrim fade follows the text. Default middle
// preserves the pre-existing center-aligned behavior.
try { sqlite.exec("ALTER TABLE marketing_email_campaigns ADD COLUMN hero_text_placement TEXT DEFAULT 'middle'"); } catch { /* exists */ }

// Email hero: which part of the image survives the cover-crop (CSS
// background-position keywords, 9-point grid). Default keeps center-crop.
try { sqlite.exec("ALTER TABLE marketing_email_campaigns ADD COLUMN hero_image_focal TEXT DEFAULT 'center center'"); } catch { /* exists */ }

// Brief hash at copy-generation time — the editor compares live brief fields
// against this to nudge "brief changed since copy was generated".
try { sqlite.exec("ALTER TABLE marketing_email_campaigns ADD COLUMN copy_brief_fingerprint TEXT"); } catch { /* exists */ }

// Omnisend campaign id — set by the push-omnisend route (latest push wins).
try { sqlite.exec("ALTER TABLE marketing_email_campaigns ADD COLUMN omnisend_campaign_id TEXT"); } catch { /* exists */ }

// TikTok trending sounds: play_url from the actor lets us preview the
// audio inline (no trip to TikTok).
try { sqlite.exec("ALTER TABLE marketing_tiktok_sounds ADD COLUMN preview_url TEXT"); } catch { /* exists */ }
// Backfill existing rows from the verbatim `raw` payload so preview works
// without waiting for the next sync.
try {
  sqlite.exec(`UPDATE marketing_tiktok_sounds
    SET preview_url = json_extract(raw, '$.play_url.url_list[0]')
    WHERE preview_url IS NULL AND raw IS NOT NULL
      AND json_valid(raw)
      AND json_extract(raw, '$.play_url.url_list[0]') IS NOT NULL`);
} catch { /* older sqlite without json1, or no rows */ }

// Day-over-day momentum: remember each sound's prior usage/rank so we can
// score which one is climbing fastest (best bet) and sort by it.
try { sqlite.exec("ALTER TABLE marketing_tiktok_sounds ADD COLUMN prev_usage_count INTEGER"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE marketing_tiktok_sounds ADD COLUMN prev_rank INTEGER"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE marketing_tiktok_sounds ADD COLUMN prev_synced_at TEXT"); } catch { /* exists */ }

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
// Apify Google Maps enrichment tracking — set on every attempt so we
// can build a "needs manual review" queue from the rows where we
// tried but didn't get a high-confidence match.
try { sqlite.exec("ALTER TABLE companies ADD COLUMN gmaps_enrichment_attempted_at TEXT"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE companies ADD COLUMN gmaps_skip_reason TEXT"); } catch { /* exists */ }
// Preserve the original name when Apify enrichment updates it to the
// canonical Google-formatted title. Stamped once (the first time the
// name is updated by Apify); subsequent updates leave it alone so
// we always have the "what the scraper originally captured" record.
try { sqlite.exec("ALTER TABLE companies ADD COLUMN original_name TEXT"); } catch { /* exists */ }
// More Apify-derived fields. URL for one-click Google Maps lookup,
// subtypes for category-based disqualification (bridal/maternity/
// kids stores aren't Jaxy ICP), description for surface context.
try { sqlite.exec("ALTER TABLE companies ADD COLUMN gmaps_url TEXT"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE companies ADD COLUMN gmaps_subtypes TEXT"); } catch { /* exists */ } // JSON array
try { sqlite.exec("ALTER TABLE companies ADD COLUMN gmaps_description TEXT"); } catch { /* exists */ }
// Run-by-run history of Apify enrichment batches. The work runs
// fire-and-forget for batches > 100, so the operator can't read the
// HTTP response — they read these rows instead. One row per
// enrichViaGoogleMaps() call, started on entry and updated on exit.
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS apify_enrichment_runs (
    id TEXT PRIMARY KEY NOT NULL,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    limit_requested INTEGER,
    tier_filter TEXT,
    status_filter TEXT,
    force_flag INTEGER NOT NULL DEFAULT 0,
    dry_run INTEGER NOT NULL DEFAULT 0,
    companies_attempted INTEGER,
    phones_added INTEGER,
    permanently_closed_marked INTEGER,
    hours_updated INTEGER,
    no_match INTEGER,
    low_confidence_skipped INTEGER,
    errors_count INTEGER,
    errors_sample TEXT,
    error_message TEXT
  )`);
} catch { /* exists */ }
try { sqlite.exec("CREATE INDEX IF NOT EXISTS idx_apify_runs_started ON apify_enrichment_runs (started_at DESC)"); } catch { /* exists */ }

// Per-match audit log. Every (company, apify-returned-place) pair
// gets a row recording what we sent, what Apify returned, the fuzzy
// similarity score, and what we decided. Used to spot-check the
// matcher and tune thresholds — exportable as CSV for spreadsheet
// review.
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS apify_match_log (
    id TEXT PRIMARY KEY NOT NULL,
    company_id TEXT NOT NULL,
    run_id TEXT,
    search_string TEXT,
    company_name TEXT,
    company_city TEXT,
    company_state TEXT,
    apify_title TEXT,
    apify_address TEXT,
    apify_city TEXT,
    apify_state TEXT,
    apify_phone TEXT,
    apify_place_id TEXT,
    apify_rating REAL,
    apify_review_count INTEGER,
    apify_permanently_closed INTEGER,
    apify_temporarily_closed INTEGER,
    apify_url TEXT,
    similarity_score REAL,
    decision TEXT,
    decision_reason TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
} catch { /* exists */ }
try { sqlite.exec("CREATE INDEX IF NOT EXISTS idx_apify_match_log_decision ON apify_match_log (decision, created_at DESC)"); } catch { /* exists */ }
try { sqlite.exec("CREATE INDEX IF NOT EXISTS idx_apify_match_log_company ON apify_match_log (company_id)"); } catch { /* exists */ }

// Side-effect-free preview runs. The POST /preview endpoint inserts a
// pending row, fires Apify in the background, and returns the id.
// The GET /preview/:id endpoint fetches the result.
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS apify_preview_runs (
    id TEXT PRIMARY KEY NOT NULL,
    inputs_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    result_json TEXT,
    error_message TEXT
  )`);
} catch { /* exists */ }
try { sqlite.exec("CREATE INDEX IF NOT EXISTS idx_apify_preview_started ON apify_preview_runs (started_at DESC)"); } catch { /* exists */ }

// Tracks every Apify-enriched company we've pushed to a PhoneBurner
// folder. Lets us skip already-pushed leads on subsequent runs without
// asking PB. UNIQUE(company_id, folder_id) makes re-pushes a no-op.
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS phoneburner_folder_pushes (
    id TEXT PRIMARY KEY NOT NULL,
    company_id TEXT NOT NULL,
    folder_id TEXT NOT NULL,
    pb_contact_id TEXT,
    phone_pushed TEXT NOT NULL,
    pushed_at TEXT NOT NULL DEFAULT (datetime('now')),
    error TEXT
  )`);
} catch { /* exists */ }
try { sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS uq_pb_folder_pushes ON phoneburner_folder_pushes (company_id, folder_id)"); } catch { /* exists */ }
try { sqlite.exec("CREATE INDEX IF NOT EXISTS idx_pb_folder_pushes_folder ON phoneburner_folder_pushes (folder_id, pushed_at DESC)"); } catch { /* exists */ }
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
// Canonical sunglass-competitor brand each store carries — chosen
// from a curated list of 17 brands Jaxy directly competes with.
// Pushed to Instantly as the `primary_competitor` custom variable
// for brand-specific mail-merge in the Brand Carriers campaign.
// Populated by /api/admin/sales/backfill-competitor-brand.
try { sqlite.exec("ALTER TABLE companies ADD COLUMN primary_competitor_brand TEXT"); } catch { /* exists */ }
try { sqlite.exec("CREATE INDEX idx_companies_primary_competitor ON companies (primary_competitor_brand)"); } catch { /* exists */ }

// AJM legacy import (2026-06-19): historical AJ Morgan customer data
// for the wholesale reactivation campaign. The cohort numbers (spend,
// orders, dates) drive priority tiering in smart lists and Christina's
// call order. AJM status retained as-is to distinguish recent-Inactive
// (winnable) from stale-Inactive (skipped at import).
try { sqlite.exec("ALTER TABLE companies ADD COLUMN ajm_total_spend REAL"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE companies ADD COLUMN ajm_total_orders INTEGER"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE companies ADD COLUMN ajm_first_order TEXT"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE companies ADD COLUMN ajm_last_order TEXT"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE companies ADD COLUMN ajm_status TEXT"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE companies ADD COLUMN ajm_category TEXT"); } catch { /* exists */ }
try { sqlite.exec("CREATE INDEX idx_companies_ajm_spend ON companies (ajm_total_spend)"); } catch { /* exists */ }
try { sqlite.exec("CREATE INDEX idx_companies_ajm_last_order ON companies (ajm_last_order)"); } catch { /* exists */ }

// Pipedrive CRM sync: cross-system identity stamps. Org/Person live on
// the company; the deal id is stamped on the order (Customers pipeline)
// and on the deals projection (outreach pipelines). See
// docs/crm-master-plan.md §4 and src/modules/sales/lib/pipedrive-sync.ts.
// Shopify customer id — the stable identity for a retailer, esp. Faire-via-
// Shopify orders that share a relay email / carry no company name. Used to key
// distinct customers so they don't collapse under one company.
try { sqlite.exec("ALTER TABLE companies ADD COLUMN shopify_customer_id TEXT"); } catch { /* exists */ }
try { sqlite.exec("CREATE INDEX idx_companies_shopify_customer ON companies (shopify_customer_id)"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE companies ADD COLUMN pipedrive_org_id INTEGER"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE companies ADD COLUMN pipedrive_person_id INTEGER"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE companies ADD COLUMN pipedrive_synced_at TEXT"); } catch { /* exists */ }
try { sqlite.exec("CREATE INDEX idx_companies_pipedrive_org ON companies (pipedrive_org_id)"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE orders ADD COLUMN pipedrive_deal_id INTEGER"); } catch { /* exists */ }
try { sqlite.exec("CREATE INDEX idx_orders_pipedrive_deal ON orders (pipedrive_deal_id)"); } catch { /* exists */ }
// Instantly/PhoneBurner activity_feed rows mirrored to Pipedrive activities.
// Stamp the Pipedrive activity id so each engagement event pushes once.
try { sqlite.exec("ALTER TABLE activity_feed ADD COLUMN pipedrive_activity_id INTEGER"); } catch { /* exists */ }

// One "lead converted to wholesale customer" alert per order (idempotency).
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS lead_conversion_alerts (
    order_id TEXT PRIMARY KEY NOT NULL,
    company_id TEXT,
    matched_company_id TEXT,
    kind TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
} catch (e) { console.error("[db] lead_conversion_alerts table error:", e); }

// Pipedrive deal projection (read-only mirror of Pipedrive deals). Kept in
// its own table rather than overloading `deals` so the existing internal
// kanban isn't flooded with seeded/backfilled CRM rows (the kanban-vs-
// projection question is a deliberate product call — docs §4.1/§13). This
// table is the dedup store: the one-open-deal-per-(company,pipeline) key and
// the order→deal link both resolve against it before any Pipedrive create.
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS pipedrive_deals (
    id TEXT PRIMARY KEY NOT NULL,
    pipedrive_deal_id INTEGER UNIQUE,
    company_id TEXT,
    order_id TEXT,
    pipeline TEXT,
    stage TEXT,
    status TEXT DEFAULT 'open',
    is_open INTEGER DEFAULT 1,
    value REAL,
    title TEXT,
    backfill_run_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  sqlite.exec("CREATE INDEX IF NOT EXISTS idx_pd_deals_company ON pipedrive_deals (company_id, pipeline, is_open)");
  sqlite.exec("CREATE INDEX IF NOT EXISTS idx_pd_deals_order ON pipedrive_deals (order_id)");
} catch (e) { console.error("[db] pipedrive_deals table error:", e); }

// Pipedrive inbound-webhook audit + idempotency. dedup_key is a UNIQUE
// hash of the delivery so a double-delivered webhook is recorded once and
// the handler can skip reprocessing.
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS pipedrive_webhook_events (
    id TEXT PRIMARY KEY NOT NULL,
    dedup_key TEXT UNIQUE,
    event TEXT,
    object TEXT,
    action TEXT,
    pipedrive_id INTEGER,
    company_id TEXT,
    payload TEXT,
    status TEXT DEFAULT 'received',
    error TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  sqlite.exec("CREATE INDEX IF NOT EXISTS idx_pd_webhook_object ON pipedrive_webhook_events (object, pipedrive_id)");
} catch (e) { console.error("[db] pipedrive_webhook_events table error:", e); }

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

  // Daily COGS observability: run log + exceptions worklist.
  sqlite.exec(`CREATE TABLE IF NOT EXISTS cogs_run_log (
    id TEXT PRIMARY KEY NOT NULL,
    run_date TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'live',
    orders_processed INTEGER NOT NULL DEFAULT 0,
    units_costed INTEGER NOT NULL DEFAULT 0,
    total_cogs REAL NOT NULL DEFAULT 0,
    exceptions_opened INTEGER NOT NULL DEFAULT 0,
    cogs_journal_id TEXT,
    xero_journal_id TEXT,
    duration_ms INTEGER,
    error TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_cogs_run_log_date ON cogs_run_log(run_date)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_cogs_run_log_created ON cogs_run_log(created_at)`);

  sqlite.exec(`CREATE TABLE IF NOT EXISTS cogs_exceptions (
    id TEXT PRIMARY KEY NOT NULL,
    type TEXT NOT NULL,
    order_id TEXT,
    order_item_id TEXT,
    order_number TEXT,
    sku TEXT,
    sku_id TEXT,
    units INTEGER,
    channel TEXT,
    detail TEXT,
    run_id TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT DEFAULT (datetime('now')),
    resolved_at TEXT
  )`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_cogs_exceptions_status ON cogs_exceptions(status)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_cogs_exceptions_type ON cogs_exceptions(type)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_cogs_exceptions_order ON cogs_exceptions(order_id)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_cogs_exceptions_order_item ON cogs_exceptions(order_item_id)`);

  // SKU aliases: map a sales/order SKU string that has no catalog row (e.g. a
  // mis-formatted size variant "JX4004-S-BLK") to a canonical catalog SKU so it
  // costs against that SKU's FIFO layers instead of raising an unmapped_sku.
  sqlite.exec(`CREATE TABLE IF NOT EXISTS catalog_sku_aliases (
    alias TEXT PRIMARY KEY NOT NULL,
    sku_id TEXT NOT NULL,
    canonical_sku TEXT,
    note TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
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
// Multi-channel campaigns — channels[] replaces the single-channel
// `type` field for delivery routing. type stays as the campaign's
// INTENT (cold_outreach vs ab_test). channels lists actual delivery
// routes. JSON-encoded array of strings, e.g. '["instantly","phoneburner"]'.
try { sqlite.exec("ALTER TABLE campaigns ADD COLUMN channels TEXT NOT NULL DEFAULT '[\"instantly\"]'"); } catch { /* exists */ }
// Backfill: derive channels from existing type for pre-2026-06-19 rows.
// Only fires on rows where channels is still the default — explicit
// edits stick.
try {
  sqlite.exec(`
    UPDATE campaigns
       SET channels = '["phoneburner"]'
     WHERE type = 'calling'
       AND channels = '["instantly"]'
  `);
} catch { /* table empty or column missing on legacy db */ }
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
  // Full call transcript (Whisper) — saved on file for every Set-Appointment
  // call so it can feed AI analysis, notes, and future use.
  try { sqlite.exec("ALTER TABLE phoneburner_call_log ADD COLUMN transcript TEXT"); } catch { /* exists */ }
  try { sqlite.exec("ALTER TABLE phoneburner_call_log ADD COLUMN transcript_status TEXT"); } catch { /* exists */ }
  try { sqlite.exec("ALTER TABLE phoneburner_call_log ADD COLUMN transcribed_at TEXT"); } catch { /* exists */ }
} catch { /* exists */ }

// PhoneBurner webhook delivery log — workspace-wide webhooks per the
// PB Settings UI (see webhooksSettings.pdf). PK is a content hash so
// retried deliveries fail INSERT silently → free idempotency. Mirrors
// instantly_webhook_events. See src/modules/sales/lib/phoneburner-webhooks.ts.
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS phoneburner_webhook_events (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    pb_call_id TEXT,
    pb_contact_id TEXT,
    frame_lead_id TEXT,
    payload TEXT NOT NULL,
    token_valid INTEGER NOT NULL,
    handler_ok INTEGER,
    handler_message TEXT,
    received_at TEXT DEFAULT (datetime('now'))
  )`);
  sqlite.exec("CREATE INDEX IF NOT EXISTS idx_pb_webhook_events_event_type ON phoneburner_webhook_events(event_type)");
  sqlite.exec("CREATE INDEX IF NOT EXISTS idx_pb_webhook_events_pb_contact ON phoneburner_webhook_events(pb_contact_id)");
  sqlite.exec("CREATE INDEX IF NOT EXISTS idx_pb_webhook_events_received ON phoneburner_webhook_events(received_at)");
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

// Inventory PO columns for FIFO landed-cost (shipping method on the PO header,
// pack size on each line so packs normalize to units). Idempotent.
try { sqlite.exec("ALTER TABLE inventory_purchase_orders ADD COLUMN shipping_method TEXT"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE inventory_po_line_items ADD COLUMN pack_size INTEGER NOT NULL DEFAULT 1"); } catch { /* exists */ }

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

  // ── Phone-storage consolidation (2026-06-19) ────────────────────
  //
  // Daniel: "merge these fields so there is 1 source of truth for
  // phone numbers." The legacy `companies.phone` column historically
  // held the single primary; `company_phones` was added later for
  // multi-number support but never became authoritative — which
  // caused the Brand Carriers v1 PhoneBurner push to skip 349 leads
  // whose phones lived only in the legacy column.
  //
  // POST-DROP STATE: companies.phone was dropped 2026-06-19 in the
  // Phase 4 boot block below. After that, the backfill + triggers
  // here would reference a non-existent column and the whole boot
  // block would throw "no such column: c.phone". Guard everything
  // phone-related by checking whether the column still exists, so
  // a re-boot after the drop is a no-op.
  const phoneColCheck = sqlite
    .prepare("PRAGMA table_info(companies)")
    .all() as Array<{ name: string }>;
  const phoneColExists = phoneColCheck.some((c) => c.name === "phone");

  if (phoneColExists) {

  // Backfill: any company with a legacy phone but no row in
  // company_phones gets one inserted as primary. INSERT OR IGNORE
  // makes this safe to re-run; the unique index on (company_id, phone)
  // prevents dupes.
  sqlite.exec(`
    INSERT OR IGNORE INTO company_phones (id, company_id, phone, source, is_primary, created_at, updated_at)
    SELECT
      lower(hex(randomblob(16))),
      c.id,
      TRIM(c.phone),
      'legacy_backfill',
      1,
      datetime('now'),
      datetime('now')
    FROM companies c
    WHERE TRIM(COALESCE(c.phone, '')) <> ''
      AND NOT EXISTS (
        SELECT 1 FROM company_phones cp WHERE cp.company_id = c.id
      )
  `);

  // Triggers: keep companies.phone synced to the primary phone of
  // company_phones. Re-creating triggers is cheap; drop+recreate so
  // any schema change to the trigger body propagates on next boot.
  sqlite.exec(`DROP TRIGGER IF EXISTS trg_company_phones_after_insert`);
  sqlite.exec(`DROP TRIGGER IF EXISTS trg_company_phones_after_update`);
  sqlite.exec(`DROP TRIGGER IF EXISTS trg_company_phones_after_delete`);

  // The "refresh primary" pattern: pick the highest-ranked phone
  // (is_primary DESC, then oldest-first as tiebreaker) and write it
  // back to companies.phone. If no rows remain, NULL out the cache.
  const refreshSql = (cidCol: string) => `
    UPDATE companies
       SET phone = (
         SELECT phone FROM company_phones
          WHERE company_id = ${cidCol}
          ORDER BY is_primary DESC, created_at ASC
          LIMIT 1
       )
     WHERE id = ${cidCol};
  `;

  sqlite.exec(`
    CREATE TRIGGER trg_company_phones_after_insert
    AFTER INSERT ON company_phones
    BEGIN ${refreshSql("NEW.company_id")} END;
  `);
  sqlite.exec(`
    CREATE TRIGGER trg_company_phones_after_update
    AFTER UPDATE ON company_phones
    BEGIN ${refreshSql("NEW.company_id")} END;
  `);
  sqlite.exec(`
    CREATE TRIGGER trg_company_phones_after_delete
    AFTER DELETE ON company_phones
    BEGIN ${refreshSql("OLD.company_id")} END;
  `);

  // Reverse-direction mirror: any legacy code path that writes to
  // companies.phone (chrome-extension capture, storeleads cleanup,
  // manual SQL fixups, seed/test data) gets an automatic row in
  // company_phones so the canonical store stays complete. INSERT OR
  // IGNORE makes this idempotent; the (company_id, phone) unique
  // index dedupes naturally. SQLite's default `recursive_triggers=0`
  // prevents the cache-refresh trigger above from firing in response
  // to this insert and looping back.
  sqlite.exec(`DROP TRIGGER IF EXISTS trg_companies_phone_insert_mirror`);
  sqlite.exec(`DROP TRIGGER IF EXISTS trg_companies_phone_update_mirror`);

  const mirrorBody = `
    INSERT OR IGNORE INTO company_phones
      (id, company_id, phone, source, is_primary, created_at, updated_at)
    VALUES (
      lower(hex(randomblob(16))),
      NEW.id,
      TRIM(NEW.phone),
      'legacy_companies_write',
      1,
      datetime('now'),
      datetime('now')
    );
  `;

  sqlite.exec(`
    CREATE TRIGGER trg_companies_phone_insert_mirror
    AFTER INSERT ON companies
    WHEN NEW.phone IS NOT NULL AND TRIM(NEW.phone) <> ''
    BEGIN ${mirrorBody} END;
  `);
  sqlite.exec(`
    CREATE TRIGGER trg_companies_phone_update_mirror
    AFTER UPDATE OF phone ON companies
    WHEN NEW.phone IS NOT NULL AND TRIM(NEW.phone) <> ''
    BEGIN ${mirrorBody} END;
  `);

  // ── Phone snapshot parachute ────────────────────────────────────
  //
  // Before we drop companies.phone in a follow-up commit, capture the
  // (company_id, phone) pair for every non-empty legacy row into a
  // side table. If anything goes wrong with the migration, restore
  // is one INSERT statement. Idempotent: only inserts rows the
  // snapshot doesn't already have.
  //
  // The snapshot can be dropped 30-90 days after the column drop
  // once we're confident nothing was lost.
  sqlite.exec(`CREATE TABLE IF NOT EXISTS _legacy_companies_phone_snapshot (
    company_id TEXT PRIMARY KEY NOT NULL,
    phone TEXT NOT NULL,
    captured_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  // Guard against the column having already been dropped — once
  // companies.phone is gone, this INSERT errors. We tolerate the
  // failure silently because the snapshot is already populated.
  try {
    sqlite.exec(`
      INSERT OR IGNORE INTO _legacy_companies_phone_snapshot (company_id, phone)
      SELECT c.id, TRIM(c.phone)
        FROM companies c
       WHERE TRIM(COALESCE(c.phone, '')) <> ''
    `);
  } catch {
    /* companies.phone column already dropped — snapshot is final */
  }

  } // end if (phoneColExists)

  // ── Phase 3: integrity-guarded drop of companies.phone ─────────
  //
  // The "one source of truth" finale. Reads and writes all route
  // through company_phones now (see prior refactor commits); the
  // column is purely a trigger-maintained cache. Time to drop it.
  //
  // SAFETY: we do NOT drop blindly. The drop only runs if the same
  // integrity-check logic from /api/admin/sales/phone-integrity-check
  // returns zero orphans (legacy_only_count) AND zero value
  // mismatches (value_mismatch_count, with +1 country-code drift
  // ignored — see e8e673e). If either is non-zero, the boot logs
  // loudly and skips the drop — column stays, triggers stay,
  // human investigates the snapshot table.
  //
  // After a successful drop we also clean up the now-unused
  // triggers (both cache-refresh and reverse-mirror) since there's
  // nothing left to cache or mirror.
  const cols = sqlite
    .prepare("PRAGMA table_info(companies)")
    .all() as Array<{ name: string }>;
  const hasLegacyPhoneCol = cols.some((c) => c.name === "phone");

  if (hasLegacyPhoneCol) {
    // (A) Legacy-only — phones in companies.phone but no row in
    // company_phones. Should be 0 after the boot backfill above.
    const legacyOnly = (
      sqlite
        .prepare(
          `SELECT COUNT(*) AS n FROM companies c
            WHERE TRIM(COALESCE(c.phone, '')) <> ''
              AND NOT EXISTS (
                SELECT 1 FROM company_phones cp WHERE cp.company_id = c.id
              )`,
        )
        .get() as { n: number }
    ).n;

    // (B) Value mismatch — legacy phone's last-10-digits doesn't
    // appear in any company_phones row for the same company.
    // Verified 2026-06-19: SUBSTR(s, -10) was broken in SQLite when
    // the input was exactly 11 chars (it returned empty), producing
    // 2,778 false-positive mismatches on prod. Use explicit
    // "drop leading 1 if 11 digits" instead — same intent, no
    // negative-index footgun.
    const normalize = (col: string) => {
      const stripped = `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(${col},'-',''),' ',''),'(',''),')',''),'+',''),'.',''),CHAR(9),'')`;
      return `CASE
        WHEN LENGTH(${stripped}) = 11 AND SUBSTR(${stripped}, 1, 1) = '1'
        THEN SUBSTR(${stripped}, 2)
        ELSE ${stripped}
      END`;
    };
    const mismatch = (
      sqlite
        .prepare(
          `SELECT COUNT(*) AS n FROM (
             SELECT c.id FROM companies c
              WHERE TRIM(COALESCE(c.phone, '')) <> ''
                AND EXISTS (SELECT 1 FROM company_phones cp2 WHERE cp2.company_id = c.id)
                AND NOT EXISTS (
                  SELECT 1 FROM company_phones cp WHERE cp.company_id = c.id AND cp.phone = c.phone
                )
                AND NOT EXISTS (
                  SELECT 1 FROM company_phones cp WHERE cp.company_id = c.id
                    AND ${normalize("cp.phone")} = ${normalize("c.phone")}
                )
           )`,
        )
        .get() as { n: number }
    ).n;

    if (legacyOnly === 0 && mismatch === 0) {
      try {
        // Drop the triggers first — once the column is gone the
        // reverse-mirror triggers can't reference it, and the
        // cache-refresh triggers have nothing to refresh.
        sqlite.exec(`DROP TRIGGER IF EXISTS trg_company_phones_after_insert`);
        sqlite.exec(`DROP TRIGGER IF EXISTS trg_company_phones_after_update`);
        sqlite.exec(`DROP TRIGGER IF EXISTS trg_company_phones_after_delete`);
        sqlite.exec(`DROP TRIGGER IF EXISTS trg_companies_phone_insert_mirror`);
        sqlite.exec(`DROP TRIGGER IF EXISTS trg_companies_phone_update_mirror`);
        // The actual drop. Snapshot table preserved for 30-90 days.
        sqlite.exec(`ALTER TABLE companies DROP COLUMN phone`);
        console.log(
          "[db] companies.phone dropped — company_phones is now the sole source of truth. Snapshot retained in _legacy_companies_phone_snapshot.",
        );
      } catch (e) {
        console.error(
          "[db] companies.phone drop failed despite passing integrity check:",
          e,
        );
      }
    } else {
      console.warn(
        `[db] SKIPPING companies.phone drop — drift detected: ` +
          `legacy_only=${legacyOnly}, value_mismatch=${mismatch}. ` +
          `Run GET /api/admin/sales/phone-integrity-check for samples. ` +
          `Snapshot is intact in _legacy_companies_phone_snapshot.`,
      );
    }
  }

  // ── Email-storage consolidation (2026-06-19) ───────────────────
  //
  // Daniel: "one source of truth for emails." Same pattern as the
  // phone migration. The contacts table becomes canonical — every
  // email address lives as a contacts row. companies.email is a
  // trigger-maintained cache during the transition, dropped in a
  // follow-up commit when reads are migrated.
  //
  // Audit (2026-06-19): 144,958 companies have legacy email, 124,018
  // of them are orphans (no matching contacts row). 0 duplicates,
  // 0 case mismatches, 92 multi-email-string legacy values. The
  // last 92 are handled as-is during backfill (one contact row each
  // with the joined string) and cleaned by a follow-up admin endpoint.
  //
  // POST-DROP STATE: same guard as the phone block above. Once
  // companies.email is dropped (Phase 4), these statements reference
  // a non-existent column and the boot block throws "no such column:
  // c.email". Guard the snapshot + backfill + triggers so re-boot
  // after the drop is a no-op.
  const emailColCheck = sqlite
    .prepare("PRAGMA table_info(companies)")
    .all() as Array<{ name: string }>;
  const emailColExists = emailColCheck.some((c) => c.name === "email");

  if (emailColExists) {

  // ── Email snapshot parachute ────────────────────────────────────
  sqlite.exec(`CREATE TABLE IF NOT EXISTS _legacy_companies_email_snapshot (
    company_id TEXT PRIMARY KEY NOT NULL,
    email TEXT NOT NULL,
    captured_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  try {
    sqlite.exec(`
      INSERT OR IGNORE INTO _legacy_companies_email_snapshot (company_id, email)
      SELECT c.id, TRIM(c.email)
        FROM companies c
       WHERE TRIM(COALESCE(c.email, '')) <> ''
    `);
  } catch {
    /* companies.email column already dropped — snapshot is final */
  }

  // ── Backfill companies.email → contacts ─────────────────────────
  //
  // For every (company, non-empty email) where no contacts row
  // already exists with the same lower(email), insert a new contacts
  // row. Lowercase the email so the migration normalizes the
  // inconsistent-casing problem at the same time.
  //
  // is_primary heuristic: if this company has NO contacts yet, the
  // backfill row becomes the primary. If contacts already exist,
  // the backfill is an additional non-primary alternate so we don't
  // disrupt the user's intended primary.
  //
  // Idempotent via the EXISTS-guard — re-runs are no-ops.
  try {
    sqlite.exec(`
      INSERT INTO contacts (
        id, company_id, store_id, first_name, last_name, title,
        email, phone, is_primary, source, created_at, updated_at
      )
      SELECT
        lower(hex(randomblob(16))),
        c.id,
        NULL,
        NULL,
        NULL,
        NULL,
        LOWER(TRIM(c.email)),
        NULL,
        CASE
          WHEN EXISTS (SELECT 1 FROM contacts cx WHERE cx.company_id = c.id)
          THEN 0 ELSE 1
        END,
        'legacy_email_backfill',
        datetime('now'),
        datetime('now')
      FROM companies c
      WHERE TRIM(COALESCE(c.email, '')) <> ''
        AND NOT EXISTS (
          SELECT 1 FROM contacts ct
          WHERE ct.company_id = c.id
            AND LOWER(TRIM(ct.email)) = LOWER(TRIM(c.email))
        )
    `);
  } catch (e) {
    /* companies.email column already dropped or backfill error */
    console.warn("[db] companies.email backfill skipped:", e);
  }

  // ── Email cache-refresh triggers ────────────────────────────────
  //
  // Keep companies.email synced to the "primary email" of contacts
  // (is_primary=1 first, then oldest, with non-empty email). When
  // contacts changes, companies.email reflects the right primary.
  //
  // Drop+recreate so any schema change to the body propagates.
  sqlite.exec(`DROP TRIGGER IF EXISTS trg_contacts_email_after_insert`);
  sqlite.exec(`DROP TRIGGER IF EXISTS trg_contacts_email_after_update`);
  sqlite.exec(`DROP TRIGGER IF EXISTS trg_contacts_email_after_delete`);

  const emailRefreshSql = (cidCol: string) => `
    UPDATE companies
       SET email = (
         SELECT LOWER(TRIM(email)) FROM contacts
          WHERE company_id = ${cidCol}
            AND TRIM(COALESCE(email, '')) <> ''
          ORDER BY is_primary DESC, created_at ASC
          LIMIT 1
       )
     WHERE id = ${cidCol};
  `;

  // Only fire when an email field actually changed to avoid
  // cascading from unrelated contacts updates.
  sqlite.exec(`
    CREATE TRIGGER trg_contacts_email_after_insert
    AFTER INSERT ON contacts
    WHEN NEW.email IS NOT NULL AND TRIM(NEW.email) <> ''
    BEGIN ${emailRefreshSql("NEW.company_id")} END;
  `);
  sqlite.exec(`
    CREATE TRIGGER trg_contacts_email_after_update
    AFTER UPDATE OF email, is_primary ON contacts
    BEGIN ${emailRefreshSql("NEW.company_id")} END;
  `);
  sqlite.exec(`
    CREATE TRIGGER trg_contacts_email_after_delete
    AFTER DELETE ON contacts
    BEGIN ${emailRefreshSql("OLD.company_id")} END;
  `);

  // ── Reverse-mirror triggers ─────────────────────────────────────
  //
  // Any legacy writer that still writes companies.email (Chrome ext,
  // Faire/Shopify webhooks, manual SQL) gets the value mirrored into
  // contacts automatically. INSERT OR IGNORE so duplicates are
  // dropped naturally.
  sqlite.exec(`DROP TRIGGER IF EXISTS trg_companies_email_insert_mirror`);
  sqlite.exec(`DROP TRIGGER IF EXISTS trg_companies_email_update_mirror`);

  const emailMirrorBody = `
    INSERT INTO contacts (
      id, company_id, store_id, first_name, last_name, title,
      email, phone, is_primary, source, created_at, updated_at
    )
    SELECT
      lower(hex(randomblob(16))),
      NEW.id, NULL, NULL, NULL, NULL,
      LOWER(TRIM(NEW.email)),
      NULL,
      CASE
        WHEN EXISTS (SELECT 1 FROM contacts cx WHERE cx.company_id = NEW.id)
        THEN 0 ELSE 1
      END,
      'legacy_companies_write',
      datetime('now'),
      datetime('now')
    WHERE NOT EXISTS (
      SELECT 1 FROM contacts ct
      WHERE ct.company_id = NEW.id
        AND LOWER(TRIM(ct.email)) = LOWER(TRIM(NEW.email))
    );
  `;

  sqlite.exec(`
    CREATE TRIGGER trg_companies_email_insert_mirror
    AFTER INSERT ON companies
    WHEN NEW.email IS NOT NULL AND TRIM(NEW.email) <> ''
    BEGIN ${emailMirrorBody} END;
  `);
  sqlite.exec(`
    CREATE TRIGGER trg_companies_email_update_mirror
    AFTER UPDATE OF email ON companies
    WHEN NEW.email IS NOT NULL AND TRIM(NEW.email) <> ''
    BEGIN ${emailMirrorBody} END;
  `);

  } // end if (emailColExists)

  // ── Phase 4: integrity-guarded drop of companies.email ─────────
  //
  // The "one source of truth" finale for emails. Reads and writes
  // route through contacts now (Phase 2 + 3 refactor); the column
  // is purely a trigger-maintained cache. Time to drop it.
  //
  // SAFETY: matches the phone Phase 4 pattern. Drop only fires when
  // (A) every non-empty companies.email has at least one matching
  // contacts row (case-insensitive). If anything drifts, log loudly
  // and skip — column stays, triggers stay, snapshot is intact,
  // human investigates.
  //
  // After a successful drop, clean up both trigger sets — nothing
  // left to cache or mirror.
  // NOTE: the boot-block drop was removed 2026-06-22 after it caused
  // a Railway healthcheck failure. ALTER TABLE DROP COLUMN on the
  // 144k-row companies table rewrites the table + rebuilds every
  // index — observed to exceed the 30s healthcheck window and prevent
  // the deploy from coming up healthy.
  //
  // The drop is now triggered on-demand via:
  //   POST /api/admin/sales/email-drop-column
  // That endpoint runs the same integrity check + drop and surfaces
  // any error in the HTTP response, with maxDuration=300 so it has
  // plenty of time to finish.
  //
  // After hitting that endpoint once successfully, the column is gone
  // and the email Phase 1/2 block above no-ops on subsequent boots.

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

// ── Marketing email assistant tables ────────────────────────────
// Three tables backing the Email Assistant feature in the marketing
// module. Schema definitions live in
// src/modules/marketing/schema/email-campaigns.ts; this boot block
// just ensures the tables exist on every startup. Idempotent —
// CREATE IF NOT EXISTS so existing data isn't touched.
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS marketing_email_campaigns (
    id TEXT PRIMARY KEY NOT NULL,
    audience TEXT NOT NULL,
    scheduled_date TEXT NOT NULL,
    week_of TEXT,
    status TEXT NOT NULL DEFAULT 'idea',
    theme_id TEXT,
    brief_title TEXT,
    brief_angle TEXT,
    brief_product_hook TEXT,
    brief_seasonal_context TEXT,
    subject TEXT,
    preheader TEXT,
    hero_variant TEXT NOT NULL DEFAULT 'full_bleed_overlay',
    section_a_variant TEXT NOT NULL DEFAULT 'centered',
    secondary_image_variant TEXT NOT NULL DEFAULT 'full_bleed',
    section_b_variant TEXT NOT NULL DEFAULT 'centered_with_cta',
    hero_headline TEXT,
    hero_subtitle TEXT,
    hero_cta_label TEXT,
    hero_cta_url TEXT,
    hero_scrim TEXT DEFAULT 'dark',
    hero_image_path TEXT,
    hero_image_alt TEXT,
    hero_image_prompt TEXT,
    section_a_heading TEXT,
    section_a_body TEXT,
    secondary_image_path TEXT,
    secondary_image_path_2 TEXT,
    secondary_image_alt TEXT,
    secondary_image_alt_2 TEXT,
    secondary_image_prompt TEXT,
    secondary_image_prompt_2 TEXT,
    section_b_heading TEXT,
    section_b_body TEXT,
    section_b_cta_label TEXT,
    section_b_cta_url TEXT,
    utm_campaign TEXT,
    designer_notes TEXT,
    ai_copy_prompt_version TEXT,
    ai_copy_raw_json TEXT,
    ai_image_prompt_raw_json TEXT,
    exported_html_path TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_email_campaigns_status ON marketing_email_campaigns (status)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_email_campaigns_scheduled ON marketing_email_campaigns (scheduled_date)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_email_campaigns_audience ON marketing_email_campaigns (audience)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_email_campaigns_theme ON marketing_email_campaigns (theme_id)`);

  sqlite.exec(`CREATE TABLE IF NOT EXISTS marketing_email_themes (
    id TEXT PRIMARY KEY NOT NULL,
    week_of TEXT NOT NULL,
    audience TEXT NOT NULL,
    title TEXT NOT NULL,
    angle TEXT,
    product_hook TEXT,
    seasonal_context TEXT,
    raw_json TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_email_themes_week ON marketing_email_themes (week_of)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_email_themes_audience ON marketing_email_themes (audience)`);

  sqlite.exec(`CREATE TABLE IF NOT EXISTS marketing_email_send_results (
    id TEXT PRIMARY KEY NOT NULL,
    campaign_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    sent_at TEXT,
    recipients INTEGER,
    opens INTEGER,
    clicks INTEGER,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_email_send_results_campaign ON marketing_email_send_results (campaign_id)`);

  // Copy version history — snapshot of copy fields before each AI
  // regenerate so a worse regenerate is non-destructive (restore prior).
  sqlite.exec(`CREATE TABLE IF NOT EXISTS marketing_email_copy_versions (
    id TEXT PRIMARY KEY NOT NULL,
    campaign_id TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    source TEXT,
    label TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_email_copy_versions_campaign ON marketing_email_copy_versions (campaign_id)`);

  // ── 2026-06-23: per-campaign brief columns ───────────────────
  // CREATE TABLE IF NOT EXISTS above only fires on a fresh DB —
  // existing rows need these added via ALTER. Try-each-individually
  // so the second boot (column already exists) is a no-op.
  for (const col of [
    "brief_title TEXT",
    "brief_angle TEXT",
    "brief_product_hook TEXT",
    "brief_seasonal_context TEXT",
    // 2026-06-23 second pass: human-readable name + kanban statuses
    "name TEXT",
    // 2026-06-23 third pass: logo override + section visibility toggles
    "logo_image_path TEXT",
    "hero_disabled INTEGER DEFAULT 0",
    "section_a_disabled INTEGER DEFAULT 0",
    "secondary_disabled INTEGER DEFAULT 0",
    "section_b_disabled INTEGER DEFAULT 0",
    // 2026-06-23: subject-line A/B (alt subject + preheader)
    "subject_alt TEXT",
    "preheader_alt TEXT",
    // 2026-06-24: featured products (JSON array of catalog_products.id)
    "featured_product_ids TEXT",
  ]) {
    try {
      sqlite.exec(`ALTER TABLE marketing_email_campaigns ADD COLUMN ${col}`);
    } catch {
      /* column already exists */
    }
  }

  // Migrate legacy status values to the new kanban-friendly set.
  // Mapping:
  //   idea / themed                            → draft
  //   copy_pending / copy_review               → copywriting
  //   image_pending                            → photography
  //   image_review / preview_ready             → design_review
  //   exported                                 → scheduled
  //   sent / analyzed                          unchanged
  // Idempotent — re-runs find no rows with old values.
  try {
    sqlite.exec(`UPDATE marketing_email_campaigns SET status = 'draft'         WHERE status IN ('idea','themed')`);
    sqlite.exec(`UPDATE marketing_email_campaigns SET status = 'copywriting'   WHERE status IN ('copy_pending','copy_review')`);
    sqlite.exec(`UPDATE marketing_email_campaigns SET status = 'photography'   WHERE status = 'image_pending'`);
    sqlite.exec(`UPDATE marketing_email_campaigns SET status = 'design_review' WHERE status IN ('image_review','preview_ready')`);
    sqlite.exec(`UPDATE marketing_email_campaigns SET status = 'scheduled'     WHERE status = 'exported'`);
  } catch {
    /* no rows or already migrated */
  }
} catch (e) { console.error("[db] Marketing email tables error:", e); }

// ── Marketing calendar (holidays / sales / launches / promos) ──
// Feeds the AI prompt so generate-copy knows what's coming up
// within a campaign's date window.
try {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS marketing_calendar_events (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL CHECK(event_type IN ('holiday','sale','launch','promotion')),
    date_start TEXT NOT NULL,
    date_end TEXT NOT NULL,
    audience TEXT NOT NULL DEFAULT 'all' CHECK(audience IN ('all','retail','wholesale')),
    title TEXT NOT NULL,
    description TEXT,
    product_skus TEXT,
    link_url TEXT,
    priority INTEGER NOT NULL DEFAULT 2,
    tag TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_calendar_date_start ON marketing_calendar_events (date_start)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_calendar_audience ON marketing_calendar_events (audience)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_calendar_event_type ON marketing_calendar_events (event_type)`);

  // Seed US holidays for the upcoming 12 months. Uses INSERT OR IGNORE
  // keyed on a deterministic id so re-running is idempotent. Daniel
  // can edit titles/descriptions in the UI — they won't be overwritten
  // because the seed only inserts when the id doesn't exist.
  //
  // Limited to dates Daniel's emails would actually anchor to. Federal
  // holidays + a few cultural anchors (Mother's Day, Father's Day,
  // Valentine's Day) that matter for retail. Wholesale-relevant
  // shopping anchors (BFCM, Cyber Monday, EOSS) included too.
  const HOLIDAYS = [
    { id: "seed-2026-07-04", dateStart: "2026-07-04", dateEnd: "2026-07-04", title: "Fourth of July", description: "Federal holiday. Summer-sun lifestyle angle — boardwalks, lake days, road trips." },
    { id: "seed-2026-09-07", dateStart: "2026-09-07", dateEnd: "2026-09-07", title: "Labor Day", description: "End-of-summer long weekend. EOSS angle works here." },
    { id: "seed-2026-10-31", dateStart: "2026-10-31", dateEnd: "2026-10-31", title: "Halloween", description: "Costume / playful angle. Skip for wholesale." },
    { id: "seed-2026-11-26", dateStart: "2026-11-26", dateEnd: "2026-11-26", title: "Thanksgiving", description: "Family / gratitude framing. Wholesale: thank carriers." },
    { id: "seed-2026-11-27", dateStart: "2026-11-27", dateEnd: "2026-12-01", title: "Black Friday + Cyber Monday weekend", description: "The biggest discount window of the year — BFCM. Plan separate sale event with promotion type if running offers." },
    { id: "seed-2026-12-13", dateStart: "2026-12-13", dateEnd: "2026-12-19", title: "Last shipping week before Christmas", description: "Gift-deadline urgency. Ship-by reminders." },
    { id: "seed-2026-12-25", dateStart: "2026-12-25", dateEnd: "2026-12-25", title: "Christmas Day", description: "Hold sends on the day itself unless explicitly festive." },
    { id: "seed-2026-12-31", dateStart: "2026-12-31", dateEnd: "2026-12-31", title: "New Year's Eve", description: "Year-end reflection or party angle." },
    { id: "seed-2027-01-01", dateStart: "2027-01-01", dateEnd: "2027-01-01", title: "New Year's Day", description: "Fresh start framing. New-year-new-look angle." },
    { id: "seed-2027-02-14", dateStart: "2027-02-14", dateEnd: "2027-02-14", title: "Valentine's Day", description: "Gift-for-them angle. Pairs well for retail couples / gift sets." },
    { id: "seed-2027-03-17", dateStart: "2027-03-17", dateEnd: "2027-03-17", title: "St Patrick's Day", description: "Light cultural anchor. Skip unless brand has a green colorway." },
    { id: "seed-2027-04-22", dateStart: "2027-04-22", dateEnd: "2027-04-22", title: "Earth Day", description: "Sustainability angle. Wholesale: highlight bio-acetate." },
    { id: "seed-2027-05-09", dateStart: "2027-05-09", dateEnd: "2027-05-09", title: "Mother's Day", description: "Gift / mom-aesthetic framing. Strong retail moment." },
    { id: "seed-2027-05-31", dateStart: "2027-05-31", dateEnd: "2027-05-31", title: "Memorial Day", description: "Long-weekend kickoff to summer. EOSS lite if running a promo." },
    { id: "seed-2027-06-20", dateStart: "2027-06-20", dateEnd: "2027-06-20", title: "Father's Day", description: "Gift / dad-aesthetic angle. Retail: men's classics." },
  ];
  const insertHoliday = sqlite.prepare(
    `INSERT OR IGNORE INTO marketing_calendar_events
       (id, event_type, date_start, date_end, audience, title, description, priority, tag, created_at, updated_at)
     VALUES (?, 'holiday', ?, ?, 'all', ?, ?, 1, 'seed-holidays', datetime('now'), datetime('now'))`,
  );
  for (const h of HOLIDAYS) {
    insertHoliday.run(h.id, h.dateStart, h.dateEnd, h.title, h.description);
  }
} catch (e) { console.error("[db] Marketing calendar tables error:", e); }

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
