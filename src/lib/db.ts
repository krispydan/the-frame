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

// Warehouse/ShipHero exports: PO line items, freight info on POs, shiphero sync timestamps
try { sqlite.exec("ALTER TABLE catalog_skus ADD COLUMN shiphero_synced_at TEXT"); } catch { /* exists */ }
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
} catch (e) { console.error("[db] Xero ops tables error:", e); }

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

}  // end if (!IS_BUILD_PHASE)

