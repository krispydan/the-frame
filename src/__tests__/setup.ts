import Database from "better-sqlite3";

let db: Database.Database;

export function getTestDb() {
  if (!db) {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    // Create core tables
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT, role TEXT DEFAULT 'owner', is_active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS error_logs (id TEXT PRIMARY KEY, level TEXT, source TEXT, message TEXT, stack_trace TEXT, request_path TEXT, user_id TEXT, metadata TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS change_logs (id TEXT PRIMARY KEY, entity_type TEXT, entity_id TEXT, field TEXT, old_value TEXT, new_value TEXT, user_id TEXT, source TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS reporting_logs (id TEXT PRIMARY KEY, event_type TEXT, module TEXT, user_id TEXT, metadata TEXT, duration_ms INTEGER, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS activity_feed (id TEXT PRIMARY KEY, event_type TEXT, module TEXT, entity_type TEXT, entity_id TEXT, data TEXT, user_id TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, type TEXT, module TEXT, status TEXT DEFAULT 'queued', input TEXT, output TEXT, priority INTEGER DEFAULT 0, attempts INTEGER DEFAULT 0, max_attempts INTEGER DEFAULT 3, error TEXT, created_at TEXT DEFAULT (datetime('now')), started_at TEXT, completed_at TEXT);
      CREATE TABLE IF NOT EXISTS companies (id TEXT PRIMARY KEY, name TEXT, state TEXT, type TEXT, website TEXT, phone TEXT, email TEXT, status TEXT DEFAULT 'new', source TEXT, icp_tier TEXT, icp_score REAL, owner_id TEXT, domain TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS stores (id TEXT PRIMARY KEY, company_id TEXT, name TEXT, address TEXT, city TEXT, state TEXT, zip TEXT, phone TEXT, is_primary INTEGER DEFAULT 1, google_rating REAL, google_review_count INTEGER, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS contacts (id TEXT PRIMARY KEY, store_id TEXT, company_id TEXT, first_name TEXT, last_name TEXT, email TEXT, phone TEXT, title TEXT, is_primary INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS deals (id TEXT PRIMARY KEY, company_id TEXT, title TEXT, value REAL, stage TEXT, channel TEXT, owner_id TEXT, snooze_until TEXT, last_activity_at TEXT, reorder_due_at TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, order_number TEXT, company_id TEXT, channel TEXT, status TEXT DEFAULT 'pending', subtotal REAL, tax REAL, shipping REAL, discount REAL, total REAL, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS order_items (id TEXT PRIMARY KEY, order_id TEXT, sku TEXT, product_name TEXT, quantity INTEGER, unit_price REAL, total_price REAL);
      CREATE TABLE IF NOT EXISTS settlements (id TEXT PRIMARY KEY, channel TEXT, gross_amount REAL, fees REAL, net_amount REAL, status TEXT DEFAULT 'pending', created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS expenses (id TEXT PRIMARY KEY, category TEXT, description TEXT, amount REAL, vendor TEXT, date TEXT, recurring INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS customer_accounts (id TEXT PRIMARY KEY, company_id TEXT, tier TEXT DEFAULT 'bronze', lifetime_value REAL DEFAULT 0, total_orders INTEGER DEFAULT 0, health_score REAL DEFAULT 50, health_status TEXT DEFAULT 'healthy', created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS smart_lists (id TEXT PRIMARY KEY, name TEXT, filters TEXT, result_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
      CREATE VIRTUAL TABLE IF NOT EXISTS companies_fts USING fts5(name, city, state, content=companies, content_rowid=rowid);
    `);
    // Seed test user
    db.prepare("INSERT INTO users (id, email, name, role) VALUES ('u1', 'daniel@getjaxy.com', 'Daniel', 'owner')").run();
  }
  return db;
}

export function resetTestDb() {
  const tables = ["companies", "stores", "contacts", "deals", "orders", "order_items", "settlements", "expenses", "customer_accounts", "smart_lists", "error_logs", "change_logs", "reporting_logs", "activity_feed", "jobs"];
  const d = getTestDb();
  for (const t of tables) { try { d.exec(`DELETE FROM ${t}`); } catch {} }
}
