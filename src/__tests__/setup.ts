import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { vi } from "vitest";

let db: Database.Database;

export function getTestDb() {
  if (!db) {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    // Create core tables
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT, role TEXT DEFAULT 'owner', is_active INTEGER DEFAULT 1, last_login_at TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT);
      CREATE TABLE IF NOT EXISTS error_logs (id TEXT PRIMARY KEY, timestamp TEXT DEFAULT (datetime('now')), level TEXT, source TEXT, message TEXT, stack_trace TEXT, request_method TEXT, request_path TEXT, request_body TEXT, user_id TEXT, ip_address TEXT, metadata TEXT, resolved INTEGER DEFAULT 0, resolved_at TEXT, resolved_by TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS change_logs (id TEXT PRIMARY KEY, entity_type TEXT, entity_id TEXT, field TEXT, old_value TEXT, new_value TEXT, user_id TEXT, source TEXT, agent_type TEXT, request_id TEXT, timestamp TEXT DEFAULT (datetime('now')), created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS reporting_logs (id TEXT PRIMARY KEY, timestamp TEXT DEFAULT (datetime('now')), event_type TEXT, module TEXT, user_id TEXT, metadata TEXT, duration_ms INTEGER, tokens_used INTEGER, cost_cents INTEGER, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS activity_feed (id TEXT PRIMARY KEY, event_type TEXT, module TEXT, entity_type TEXT, entity_id TEXT, data TEXT, user_id TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, type TEXT, module TEXT, status TEXT DEFAULT 'queued', input TEXT, output TEXT, priority INTEGER DEFAULT 0, scheduled_for TEXT, recurring TEXT, attempts INTEGER DEFAULT 0, max_attempts INTEGER DEFAULT 3, error TEXT, created_at TEXT DEFAULT (datetime('now')), started_at TEXT, completed_at TEXT);
      CREATE TABLE IF NOT EXISTS segments (id TEXT PRIMARY KEY, name TEXT, slug TEXT UNIQUE, description TEXT, icp_profile TEXT, email_templates TEXT, outreach_notes TEXT, status TEXT DEFAULT 'active', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT);
      CREATE TABLE IF NOT EXISTS companies (id TEXT PRIMARY KEY, name TEXT, state TEXT, type TEXT, website TEXT, phone TEXT, email TEXT, address TEXT, city TEXT, zip TEXT, country TEXT DEFAULT 'US', status TEXT DEFAULT 'new', source TEXT, source_type TEXT, source_id TEXT, source_query TEXT, icp_tier TEXT, icp_score REAL, icp_reasoning TEXT, owner_id TEXT, owner_name TEXT, domain TEXT, tags TEXT, notes TEXT, enrichment_status TEXT, google_place_id TEXT, google_rating REAL, google_review_count INTEGER, category TEXT, segment TEXT, segment_id TEXT, industry TEXT, updated_at TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS stores (id TEXT PRIMARY KEY, company_id TEXT, name TEXT, address TEXT, city TEXT, state TEXT, zip TEXT, phone TEXT, email TEXT, manager_name TEXT, is_primary INTEGER DEFAULT 1, google_place_id TEXT, google_rating REAL, latitude REAL, longitude REAL, status TEXT DEFAULT 'active', notes TEXT, updated_at TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS contacts (id TEXT PRIMARY KEY, store_id TEXT, company_id TEXT, first_name TEXT, last_name TEXT, email TEXT, phone TEXT, title TEXT, is_primary INTEGER DEFAULT 1, owner_id TEXT, last_contacted_at TEXT, source TEXT, notes TEXT, updated_at TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS deals (id TEXT PRIMARY KEY, company_id TEXT, store_id TEXT, contact_id TEXT, title TEXT, value REAL, stage TEXT, previous_stage TEXT, channel TEXT, owner_id TEXT, snooze_until TEXT, snooze_reason TEXT, last_activity_at TEXT, reorder_due_at TEXT, closed_at TEXT, updated_at TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS deal_activities (id TEXT PRIMARY KEY, deal_id TEXT, company_id TEXT, type TEXT, description TEXT, metadata TEXT, user_id TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, order_number TEXT NOT NULL, company_id TEXT, contact_id TEXT, store_id TEXT, channel TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', payment_terms TEXT, external_id TEXT, subtotal REAL NOT NULL DEFAULT 0, discount REAL NOT NULL DEFAULT 0, shipping REAL NOT NULL DEFAULT 0, tax REAL NOT NULL DEFAULT 0, total REAL NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'USD', notes TEXT, tracking_number TEXT, tracking_carrier TEXT, placed_at TEXT, shipped_at TEXT, delivered_at TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT);
      CREATE TABLE IF NOT EXISTS order_items (id TEXT PRIMARY KEY, order_id TEXT NOT NULL, product_id TEXT, sku_id TEXT, sku TEXT, product_name TEXT NOT NULL, color_name TEXT, quantity INTEGER NOT NULL DEFAULT 1, unit_price REAL NOT NULL DEFAULT 0, total_price REAL NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS returns (id TEXT PRIMARY KEY, order_id TEXT NOT NULL, reason TEXT, status TEXT NOT NULL DEFAULT 'requested', items TEXT, refund_amount REAL, notes TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT);
      CREATE TABLE IF NOT EXISTS order_items (id TEXT PRIMARY KEY, order_id TEXT, sku TEXT, sku_id TEXT, product_name TEXT, color_name TEXT, quantity INTEGER, unit_price REAL, total_price REAL);
      CREATE TABLE IF NOT EXISTS settlements (id TEXT PRIMARY KEY, channel TEXT, period_start TEXT, period_end TEXT, gross_amount REAL DEFAULT 0, fees REAL DEFAULT 0, adjustments REAL DEFAULT 0, net_amount REAL DEFAULT 0, currency TEXT DEFAULT 'USD', external_id TEXT, status TEXT DEFAULT 'pending', received_at TEXT, notes TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS settlement_line_items (id TEXT PRIMARY KEY, settlement_id TEXT, order_id TEXT, type TEXT, description TEXT, amount REAL DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS expense_categories (id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT, budget_monthly REAL, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS expenses (id TEXT PRIMARY KEY, category_id TEXT, description TEXT NOT NULL, amount REAL NOT NULL, vendor TEXT, date TEXT NOT NULL, recurring INTEGER DEFAULT 0, frequency TEXT, notes TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS customer_accounts (id TEXT PRIMARY KEY, company_id TEXT UNIQUE, tier TEXT DEFAULT 'bronze', lifetime_value REAL DEFAULT 0, total_orders INTEGER DEFAULT 0, avg_order_value REAL DEFAULT 0, first_order_at TEXT, last_order_at TEXT, next_reorder_estimate TEXT, health_score REAL DEFAULT 50, health_status TEXT DEFAULT 'healthy', payment_terms TEXT, discount_rate REAL DEFAULT 0, notes TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT);
      CREATE TABLE IF NOT EXISTS smart_lists (id TEXT PRIMARY KEY, name TEXT, description TEXT, filters TEXT, owner_id TEXT, is_shared INTEGER DEFAULT 1, is_default INTEGER DEFAULT 0, result_count INTEGER DEFAULT 0, updated_at TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS campaigns (id TEXT PRIMARY KEY, name TEXT, type TEXT DEFAULT 'email_sequence', status TEXT DEFAULT 'draft', description TEXT, instantly_campaign_id TEXT, target_segment TEXT, target_smart_list_id TEXT, variant_a_subject TEXT, variant_b_subject TEXT, sent INTEGER DEFAULT 0, delivered INTEGER DEFAULT 0, opened INTEGER DEFAULT 0, replied INTEGER DEFAULT 0, bounced INTEGER DEFAULT 0, meetings_booked INTEGER DEFAULT 0, orders_placed INTEGER DEFAULT 0, variant_a_sent INTEGER DEFAULT 0, variant_a_opened INTEGER DEFAULT 0, variant_a_replied INTEGER DEFAULT 0, variant_b_sent INTEGER DEFAULT 0, variant_b_opened INTEGER DEFAULT 0, variant_b_replied INTEGER DEFAULT 0, updated_at TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS campaign_leads (id TEXT PRIMARY KEY, campaign_id TEXT, company_id TEXT, contact_id TEXT, instantly_lead_id TEXT, email TEXT, status TEXT DEFAULT 'queued', reply_text TEXT, reply_classification TEXT, dismissed INTEGER DEFAULT 0, sent_at TEXT, opened_at TEXT, replied_at TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE VIRTUAL TABLE IF NOT EXISTS companies_fts USING fts5(name, city, state, content=companies, content_rowid=rowid);

      -- Inventory module tables
      CREATE TABLE IF NOT EXISTS inventory_factories (id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, contact_name TEXT, contact_email TEXT, contact_phone TEXT, production_lead_days INTEGER NOT NULL DEFAULT 30, transit_lead_days INTEGER NOT NULL DEFAULT 25, moq INTEGER DEFAULT 300, notes TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS inventory (id TEXT PRIMARY KEY, sku_id TEXT NOT NULL, location TEXT NOT NULL DEFAULT 'warehouse', quantity INTEGER NOT NULL DEFAULT 0, reserved_quantity INTEGER NOT NULL DEFAULT 0, reorder_point INTEGER NOT NULL DEFAULT 50, sell_through_weekly REAL DEFAULT 0, days_of_stock REAL DEFAULT 0, reorder_date TEXT, needs_reorder INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS inventory_movements (id TEXT PRIMARY KEY, sku_id TEXT NOT NULL, from_location TEXT, to_location TEXT, quantity INTEGER NOT NULL, reason TEXT NOT NULL, reference_id TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS inventory_purchase_orders (id TEXT PRIMARY KEY, po_number TEXT UNIQUE NOT NULL, factory_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', total_units INTEGER NOT NULL DEFAULT 0, total_cost REAL NOT NULL DEFAULT 0, order_date TEXT, expected_ship_date TEXT, expected_arrival_date TEXT, actual_arrival_date TEXT, tracking_number TEXT, tracking_carrier TEXT, shipping_cost REAL DEFAULT 0, duties_cost REAL DEFAULT 0, freight_cost REAL DEFAULT 0, shipping_method TEXT, notes TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS purchase_orders (id TEXT PRIMARY KEY, po_number TEXT UNIQUE, supplier_id TEXT, supplier_name TEXT, status TEXT DEFAULT 'draft', total_units INTEGER DEFAULT 0, total_cost REAL DEFAULT 0, order_date TEXT, expected_date TEXT, received_date TEXT, notes TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT);
      CREATE TABLE IF NOT EXISTS inventory_po_line_items (id TEXT PRIMARY KEY, po_id TEXT NOT NULL, sku_id TEXT NOT NULL, quantity INTEGER NOT NULL, pack_size INTEGER NOT NULL DEFAULT 1, unit_cost REAL NOT NULL DEFAULT 0, total_cost REAL NOT NULL DEFAULT 0);

      -- FIFO cost layers / depletions / COGS journals + observability
      CREATE TABLE IF NOT EXISTS inventory_cost_layers (id TEXT PRIMARY KEY, sku_id TEXT NOT NULL, po_line_item_id TEXT, po_id TEXT, po_number TEXT, quantity INTEGER NOT NULL, remaining_quantity INTEGER NOT NULL, unit_cost REAL NOT NULL DEFAULT 0, freight_per_unit REAL NOT NULL DEFAULT 0, duties_per_unit REAL NOT NULL DEFAULT 0, landed_cost_per_unit REAL NOT NULL DEFAULT 0, shipping_method TEXT, received_at TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS inventory_cost_depletions (id TEXT PRIMARY KEY, cost_layer_id TEXT NOT NULL, order_item_id TEXT, order_id TEXT, channel TEXT, quantity INTEGER NOT NULL, unit_cost REAL NOT NULL, landed_cost_per_unit REAL NOT NULL, depleted_at TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS cogs_journals (id TEXT PRIMARY KEY, week_start TEXT NOT NULL, week_end TEXT NOT NULL, product_cost REAL NOT NULL DEFAULT 0, freight_cost REAL NOT NULL DEFAULT 0, duties_cost REAL NOT NULL DEFAULT 0, total_cogs REAL NOT NULL DEFAULT 0, unit_count INTEGER NOT NULL DEFAULT 0, channel_breakdown TEXT, status TEXT NOT NULL DEFAULT 'draft', xero_journal_id TEXT, xero_posted_at TEXT, notes TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS cogs_run_log (id TEXT PRIMARY KEY, run_date TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'live', orders_processed INTEGER NOT NULL DEFAULT 0, units_costed INTEGER NOT NULL DEFAULT 0, total_cogs REAL NOT NULL DEFAULT 0, exceptions_opened INTEGER NOT NULL DEFAULT 0, cogs_journal_id TEXT, xero_journal_id TEXT, duration_ms INTEGER, error TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS cogs_exceptions (id TEXT PRIMARY KEY, type TEXT NOT NULL, order_id TEXT, order_item_id TEXT, order_number TEXT, sku TEXT, sku_id TEXT, units INTEGER, channel TEXT, detail TEXT, run_id TEXT, status TEXT NOT NULL DEFAULT 'open', created_at TEXT DEFAULT (datetime('now')), resolved_at TEXT);
      CREATE TABLE IF NOT EXISTS catalog_sku_aliases (alias TEXT PRIMARY KEY NOT NULL, sku_id TEXT NOT NULL, canonical_sku TEXT, note TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS inventory_qc_inspections (id TEXT PRIMARY KEY, po_id TEXT NOT NULL, inspector TEXT, inspection_date TEXT, total_units INTEGER NOT NULL DEFAULT 0, defect_count INTEGER NOT NULL DEFAULT 0, defect_rate REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', notes TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, type TEXT, title TEXT, message TEXT, severity TEXT, module TEXT, entity_id TEXT, entity_type TEXT, read INTEGER DEFAULT 0, dismissed INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));

      -- Catalog tables for inventory joins
      CREATE TABLE IF NOT EXISTS catalog_products (id TEXT PRIMARY KEY, sku_prefix TEXT UNIQUE, name TEXT, description TEXT, short_description TEXT, bullet_points TEXT, category TEXT, frame_shape TEXT, frame_material TEXT, gender TEXT, lens_type TEXT, wholesale_price REAL, retail_price REAL, msrp REAL, purchase_order_id TEXT, factory_name TEXT, factory_sku TEXT, seo_title TEXT, meta_description TEXT, status TEXT DEFAULT 'intake', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS catalog_skus (id TEXT PRIMARY KEY, product_id TEXT NOT NULL, sku TEXT UNIQUE, color_name TEXT, color_hex TEXT, size TEXT, upc TEXT, weight_oz REAL, cost_price REAL, wholesale_price REAL, retail_price REAL, in_stock INTEGER DEFAULT 1, raw_image_filename TEXT, seo_title TEXT, meta_description TEXT, twelve_pack_sku TEXT, twelve_pack_upc TEXT, status TEXT DEFAULT 'intake', created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS catalog_image_types (id TEXT PRIMARY KEY, slug TEXT UNIQUE, label TEXT, aspect_ratio TEXT, min_width INTEGER, min_height INTEGER, platform TEXT DEFAULT 'all', description TEXT, active INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS catalog_images (id TEXT PRIMARY KEY, sku_id TEXT NOT NULL, file_path TEXT, image_type_id TEXT, position INTEGER DEFAULT 0, alt_text TEXT, width INTEGER, height INTEGER, ai_model_used TEXT, ai_prompt TEXT, status TEXT DEFAULT 'draft', is_best INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS catalog_tags (id TEXT PRIMARY KEY, product_id TEXT NOT NULL, tag_name TEXT, dimension TEXT, source TEXT);
      CREATE TABLE IF NOT EXISTS catalog_exports (id TEXT PRIMARY KEY, platform TEXT, file_path TEXT, product_count INTEGER, created_at TEXT DEFAULT (datetime('now')), created_by TEXT DEFAULT 'admin');
      CREATE TABLE IF NOT EXISTS catalog_copy_versions (id TEXT PRIMARY KEY, product_id TEXT NOT NULL, field_name TEXT, content TEXT, ai_model TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS catalog_name_options (id TEXT PRIMARY KEY, product_id TEXT NOT NULL, name TEXT, selected INTEGER DEFAULT 0, ai_generated INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS catalog_notes (id TEXT PRIMARY KEY, entity_type TEXT, entity_id TEXT, author TEXT DEFAULT 'admin', text TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS catalog_purchase_orders (id TEXT PRIMARY KEY, po_number TEXT UNIQUE, supplier TEXT, order_date TEXT, notes TEXT, status TEXT DEFAULT 'ordered', created_at TEXT DEFAULT (datetime('now')));

      -- Marketing tables
      CREATE TABLE IF NOT EXISTS marketing_content_calendar (id TEXT PRIMARY KEY, title TEXT NOT NULL, type TEXT NOT NULL, platform TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'idea', scheduled_date TEXT, published_date TEXT, content TEXT, notes TEXT, tags TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS marketing_ad_campaigns (id TEXT PRIMARY KEY, platform TEXT NOT NULL, campaign_name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', spend REAL NOT NULL DEFAULT 0, impressions INTEGER NOT NULL DEFAULT 0, clicks INTEGER NOT NULL DEFAULT 0, conversions INTEGER NOT NULL DEFAULT 0, revenue REAL NOT NULL DEFAULT 0, start_date TEXT, end_date TEXT, monthly_budget REAL, notes TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS marketing_influencers (id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL, handle TEXT, followers INTEGER, niche TEXT, status TEXT NOT NULL DEFAULT 'identified', cost REAL, posts_delivered INTEGER DEFAULT 0, engagement REAL, notes TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS marketing_seo_keywords (id TEXT PRIMARY KEY, keyword TEXT NOT NULL, current_rank INTEGER, previous_rank INTEGER, url TEXT, search_volume INTEGER, difficulty INTEGER, updated_at TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS marketing_social_posts (id TEXT PRIMARY KEY, content TEXT NOT NULL, platform TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', scheduled_date TEXT, published_date TEXT, likes INTEGER DEFAULT 0, comments INTEGER DEFAULT 0, shares INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS marketing_social_accounts (id TEXT PRIMARY KEY, platform TEXT NOT NULL, handle TEXT, followers INTEGER DEFAULT 0, posts INTEGER DEFAULT 0, engagement_rate REAL DEFAULT 0, growth REAL DEFAULT 0, updated_at TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS marketing_calendar_events (id TEXT PRIMARY KEY, event_type TEXT NOT NULL, date_start TEXT NOT NULL, date_end TEXT NOT NULL, audience TEXT NOT NULL DEFAULT 'all', title TEXT NOT NULL, description TEXT, product_skus TEXT, link_url TEXT, priority INTEGER NOT NULL DEFAULT 2, tag TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));

      -- Video Remix Studio tables (mirror drizzle/migrations/0006)
      CREATE TABLE IF NOT EXISTS marketing_video_clip_categories (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT, is_hook INTEGER DEFAULT 0 NOT NULL, sort_order INTEGER DEFAULT 0 NOT NULL, archived INTEGER DEFAULT 0 NOT NULL, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS marketing_video_clips (id TEXT PRIMARY KEY, file_name TEXT NOT NULL, checksum TEXT NOT NULL UNIQUE, raw_path TEXT NOT NULL, normalized_path TEXT, muted_path TEXT, poster_path TEXT, duration_sec REAL, width INTEGER, height INTEGER, size_bytes INTEGER, category_id TEXT, audio_mode TEXT DEFAULT 'mute' NOT NULL, status TEXT DEFAULT 'uploaded' NOT NULL, boost INTEGER DEFAULT 0 NOT NULL, times_used INTEGER DEFAULT 0 NOT NULL, last_used_at TEXT, norm_version INTEGER DEFAULT 1 NOT NULL, error TEXT, notes TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS marketing_video_clip_products (id TEXT PRIMARY KEY, clip_id TEXT NOT NULL, sku_id TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
      CREATE UNIQUE INDEX IF NOT EXISTS idx_clip_product_unique ON marketing_video_clip_products (clip_id, sku_id);
      CREATE TABLE IF NOT EXISTS marketing_video_recipes (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, pattern_json TEXT NOT NULL, audio_policy TEXT DEFAULT 'silent' NOT NULL, duration_target_min REAL DEFAULT 15 NOT NULL, duration_target_max REAL DEFAULT 30 NOT NULL, weight INTEGER DEFAULT 1 NOT NULL, enabled INTEGER DEFAULT 1 NOT NULL, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS marketing_video_posts (id TEXT PRIMARY KEY, permutation_hash TEXT NOT NULL UNIQUE, recipe_id TEXT, clip_ids TEXT NOT NULL, status TEXT DEFAULT 'queued' NOT NULL, file_path TEXT, poster_path TEXT, duration_sec REAL, size_bytes INTEGER, audio_treatment TEXT DEFAULT 'silent' NOT NULL, audible_clip_ids TEXT, caption TEXT, hashtags TEXT, instructions TEXT, ai_context TEXT, platform TEXT DEFAULT 'both' NOT NULL, scheduled_date TEXT, scheduled_slot TEXT, posted_at TEXT, render_job_id TEXT, error TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
      CREATE UNIQUE INDEX IF NOT EXISTS idx_video_post_slot ON marketing_video_posts (scheduled_date, scheduled_slot);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT, type TEXT DEFAULT 'string', module TEXT, updated_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS agent_runs (id TEXT PRIMARY KEY, agent_name TEXT NOT NULL, module TEXT NOT NULL, status TEXT DEFAULT 'pending', input TEXT, output TEXT, tokens_used INTEGER, cost INTEGER, duration_ms INTEGER, error TEXT, created_at TEXT DEFAULT (datetime('now')), completed_at TEXT);
      CREATE TABLE IF NOT EXISTS account_health_history (id TEXT PRIMARY KEY, customer_account_id TEXT NOT NULL, score INTEGER NOT NULL, status TEXT NOT NULL, factors TEXT, calculated_at TEXT DEFAULT (datetime('now')));
    `);
    // Seed test user
    db.prepare("INSERT INTO users (id, email, name, role) VALUES ('u1', 'daniel@getjaxy.com', 'Daniel', 'owner')").run();
  }
  return db;
}

export function getTestDrizzle() {
  return drizzle(getTestDb());
}

export function resetTestDb() {
  const tables = ["settlement_line_items", "expense_categories", "companies", "segments", "stores", "contacts", "deals", "deal_activities", "orders", "order_items", "settlements", "expenses", "customer_accounts", "smart_lists", "campaigns", "campaign_leads", "inventory", "inventory_factories", "inventory_movements", "inventory_purchase_orders", "inventory_po_line_items", "inventory_qc_inspections", "inventory_cost_layers", "inventory_cost_depletions", "cogs_journals", "cogs_run_log", "cogs_exceptions", "notifications", "catalog_images", "catalog_tags", "catalog_exports", "catalog_copy_versions", "catalog_name_options", "catalog_notes", "catalog_image_types", "catalog_purchase_orders", "catalog_products", "catalog_skus", "marketing_content_calendar", "marketing_ad_campaigns", "marketing_influencers", "marketing_seo_keywords", "marketing_social_posts", "marketing_social_accounts", "marketing_calendar_events", "marketing_video_clip_categories", "marketing_video_clips", "marketing_video_clip_products", "marketing_video_recipes", "marketing_video_posts", "error_logs", "change_logs", "reporting_logs", "activity_feed", "jobs", "settings", "agent_runs", "account_health_history"];
  const d = getTestDb();
  for (const t of tables) { try { d.exec(`DELETE FROM ${t}`); } catch {} }
  // Clear FTS
  try { d.exec(`DELETE FROM companies_fts`); } catch {}
}

// Mock @/lib/db to use the test in-memory database
vi.mock("@/lib/db", async () => {
  const Database = (await import("better-sqlite3")).default;
  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  // Import the setup module to get the singleton
  const setup = await import("./setup");
  const testDb = setup.getTestDb();
  const testDrizzle = drizzle(testDb);
  return { sqlite: testDb, db: testDrizzle };
});

// Mock logger and event-bus to no-ops
vi.mock("@/modules/core/lib/logger", () => ({
  logger: {
    logError: vi.fn(),
    logChange: vi.fn(),
    logEvent: vi.fn(),
    logReport: vi.fn(),
  },
}));

vi.mock("@/modules/core/lib/event-bus", () => ({
  eventBus: {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  },
}));
