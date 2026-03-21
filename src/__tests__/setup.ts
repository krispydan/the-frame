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
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT, role TEXT DEFAULT 'owner', is_active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS error_logs (id TEXT PRIMARY KEY, level TEXT, source TEXT, message TEXT, stack_trace TEXT, request_path TEXT, user_id TEXT, metadata TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS change_logs (id TEXT PRIMARY KEY, entity_type TEXT, entity_id TEXT, field TEXT, old_value TEXT, new_value TEXT, user_id TEXT, source TEXT, request_id TEXT, timestamp TEXT DEFAULT (datetime('now')), created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS reporting_logs (id TEXT PRIMARY KEY, event_type TEXT, module TEXT, user_id TEXT, metadata TEXT, duration_ms INTEGER, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS activity_feed (id TEXT PRIMARY KEY, event_type TEXT, module TEXT, entity_type TEXT, entity_id TEXT, data TEXT, user_id TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, type TEXT, module TEXT, status TEXT DEFAULT 'queued', input TEXT, output TEXT, priority INTEGER DEFAULT 0, attempts INTEGER DEFAULT 0, max_attempts INTEGER DEFAULT 3, error TEXT, created_at TEXT DEFAULT (datetime('now')), started_at TEXT, completed_at TEXT);
      CREATE TABLE IF NOT EXISTS companies (id TEXT PRIMARY KEY, name TEXT, state TEXT, type TEXT, website TEXT, phone TEXT, email TEXT, address TEXT, city TEXT, zip TEXT, country TEXT DEFAULT 'US', status TEXT DEFAULT 'new', source TEXT, icp_tier TEXT, icp_score REAL, icp_reasoning TEXT, owner_id TEXT, domain TEXT, tags TEXT, notes TEXT, enrichment_status TEXT, google_place_id TEXT, google_rating REAL, google_review_count INTEGER, updated_at TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS stores (id TEXT PRIMARY KEY, company_id TEXT, name TEXT, address TEXT, city TEXT, state TEXT, zip TEXT, phone TEXT, email TEXT, manager_name TEXT, is_primary INTEGER DEFAULT 1, google_place_id TEXT, google_rating REAL, latitude REAL, longitude REAL, status TEXT DEFAULT 'active', notes TEXT, updated_at TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS contacts (id TEXT PRIMARY KEY, store_id TEXT, company_id TEXT, first_name TEXT, last_name TEXT, email TEXT, phone TEXT, title TEXT, is_primary INTEGER DEFAULT 1, owner_id TEXT, last_contacted_at TEXT, source TEXT, notes TEXT, updated_at TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS deals (id TEXT PRIMARY KEY, company_id TEXT, store_id TEXT, contact_id TEXT, title TEXT, value REAL, stage TEXT, previous_stage TEXT, channel TEXT, owner_id TEXT, snooze_until TEXT, snooze_reason TEXT, last_activity_at TEXT, reorder_due_at TEXT, closed_at TEXT, updated_at TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS deal_activities (id TEXT PRIMARY KEY, deal_id TEXT, company_id TEXT, type TEXT, description TEXT, metadata TEXT, user_id TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, order_number TEXT, company_id TEXT, store_id TEXT, channel TEXT, status TEXT DEFAULT 'pending', subtotal REAL, tax REAL, shipping REAL, discount REAL, total REAL, placed_at TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS order_items (id TEXT PRIMARY KEY, order_id TEXT, sku TEXT, sku_id TEXT, product_name TEXT, color_name TEXT, quantity INTEGER, unit_price REAL, total_price REAL);
      CREATE TABLE IF NOT EXISTS settlements (id TEXT PRIMARY KEY, channel TEXT, period_start TEXT, period_end TEXT, gross_amount REAL DEFAULT 0, fees REAL DEFAULT 0, adjustments REAL DEFAULT 0, net_amount REAL DEFAULT 0, currency TEXT DEFAULT 'USD', external_id TEXT, status TEXT DEFAULT 'pending', received_at TEXT, notes TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS settlement_line_items (id TEXT PRIMARY KEY, settlement_id TEXT, order_id TEXT, type TEXT, description TEXT, amount REAL DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS expense_categories (id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT, budget_monthly REAL, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS expenses (id TEXT PRIMARY KEY, category_id TEXT, description TEXT NOT NULL, amount REAL NOT NULL, vendor TEXT, date TEXT NOT NULL, recurring INTEGER DEFAULT 0, frequency TEXT, notes TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS customer_accounts (id TEXT PRIMARY KEY, company_id TEXT, tier TEXT DEFAULT 'bronze', lifetime_value REAL DEFAULT 0, total_orders INTEGER DEFAULT 0, health_score REAL DEFAULT 50, health_status TEXT DEFAULT 'healthy', created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS smart_lists (id TEXT PRIMARY KEY, name TEXT, description TEXT, filters TEXT, owner_id TEXT, is_shared INTEGER DEFAULT 1, is_default INTEGER DEFAULT 0, result_count INTEGER DEFAULT 0, updated_at TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS campaigns (id TEXT PRIMARY KEY, name TEXT, type TEXT DEFAULT 'email_sequence', status TEXT DEFAULT 'draft', description TEXT, instantly_campaign_id TEXT, target_segment TEXT, target_smart_list_id TEXT, variant_a_subject TEXT, variant_b_subject TEXT, sent INTEGER DEFAULT 0, delivered INTEGER DEFAULT 0, opened INTEGER DEFAULT 0, replied INTEGER DEFAULT 0, bounced INTEGER DEFAULT 0, meetings_booked INTEGER DEFAULT 0, orders_placed INTEGER DEFAULT 0, variant_a_sent INTEGER DEFAULT 0, variant_a_opened INTEGER DEFAULT 0, variant_a_replied INTEGER DEFAULT 0, variant_b_sent INTEGER DEFAULT 0, variant_b_opened INTEGER DEFAULT 0, variant_b_replied INTEGER DEFAULT 0, updated_at TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS campaign_leads (id TEXT PRIMARY KEY, campaign_id TEXT, company_id TEXT, contact_id TEXT, instantly_lead_id TEXT, email TEXT, status TEXT DEFAULT 'queued', reply_text TEXT, reply_classification TEXT, dismissed INTEGER DEFAULT 0, sent_at TEXT, opened_at TEXT, replied_at TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE VIRTUAL TABLE IF NOT EXISTS companies_fts USING fts5(name, city, state, content=companies, content_rowid=rowid);

      -- Inventory module tables
      CREATE TABLE IF NOT EXISTS inventory_factories (id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, contact_name TEXT, contact_email TEXT, contact_phone TEXT, production_lead_days INTEGER NOT NULL DEFAULT 30, transit_lead_days INTEGER NOT NULL DEFAULT 25, moq INTEGER DEFAULT 300, notes TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS inventory (id TEXT PRIMARY KEY, sku_id TEXT NOT NULL, location TEXT NOT NULL DEFAULT 'warehouse', quantity INTEGER NOT NULL DEFAULT 0, reserved_quantity INTEGER NOT NULL DEFAULT 0, reorder_point INTEGER NOT NULL DEFAULT 50, sell_through_weekly REAL DEFAULT 0, days_of_stock REAL DEFAULT 0, reorder_date TEXT, needs_reorder INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS inventory_movements (id TEXT PRIMARY KEY, sku_id TEXT NOT NULL, from_location TEXT, to_location TEXT, quantity INTEGER NOT NULL, reason TEXT NOT NULL, reference_id TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS inventory_purchase_orders (id TEXT PRIMARY KEY, po_number TEXT UNIQUE NOT NULL, factory_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', total_units INTEGER NOT NULL DEFAULT 0, total_cost REAL NOT NULL DEFAULT 0, order_date TEXT, expected_ship_date TEXT, expected_arrival_date TEXT, actual_arrival_date TEXT, tracking_number TEXT, tracking_carrier TEXT, shipping_cost REAL DEFAULT 0, duties_cost REAL DEFAULT 0, freight_cost REAL DEFAULT 0, notes TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS inventory_po_line_items (id TEXT PRIMARY KEY, po_id TEXT NOT NULL, sku_id TEXT NOT NULL, quantity INTEGER NOT NULL, unit_cost REAL NOT NULL DEFAULT 0, total_cost REAL NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS inventory_qc_inspections (id TEXT PRIMARY KEY, po_id TEXT NOT NULL, inspector TEXT, inspection_date TEXT, total_units INTEGER NOT NULL DEFAULT 0, defect_count INTEGER NOT NULL DEFAULT 0, defect_rate REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', notes TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, type TEXT, title TEXT, message TEXT, severity TEXT, module TEXT, entity_id TEXT, entity_type TEXT, read INTEGER DEFAULT 0, dismissed INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));

      -- Catalog tables for inventory joins
      CREATE TABLE IF NOT EXISTS catalog_products (id TEXT PRIMARY KEY, sku_prefix TEXT UNIQUE, name TEXT, description TEXT, category TEXT, frame_shape TEXT, frame_material TEXT, gender TEXT, lens_type TEXT, wholesale_price REAL, retail_price REAL, msrp REAL, factory_name TEXT, factory_sku TEXT, status TEXT DEFAULT 'intake', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS catalog_skus (id TEXT PRIMARY KEY, product_id TEXT NOT NULL, sku TEXT UNIQUE, color_name TEXT, color_hex TEXT, cost_price REAL, wholesale_price REAL, retail_price REAL, created_at TEXT DEFAULT (datetime('now')));
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
  const tables = ["settlement_line_items", "expense_categories", "companies", "stores", "contacts", "deals", "deal_activities", "orders", "order_items", "settlements", "expenses", "customer_accounts", "smart_lists", "campaigns", "campaign_leads", "inventory", "inventory_factories", "inventory_movements", "inventory_purchase_orders", "inventory_po_line_items", "inventory_qc_inspections", "notifications", "catalog_products", "catalog_skus", "error_logs", "change_logs", "reporting_logs", "activity_feed", "jobs"];
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
