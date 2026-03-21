/**
 * Phase 2 Migration: Create deals + deal_activities tables
 */
import Database from "better-sqlite3";
import path from "path";

const DB_PATH = process.env.DATABASE_URL || path.join(process.cwd(), "data", "the-frame.db");
const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

console.log("🔧 Phase 2 Migration: Pipeline & Activities tables...\n");

// ── deals table ──
db.exec(`
  CREATE TABLE IF NOT EXISTS deals (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id),
    store_id TEXT REFERENCES stores(id),
    contact_id TEXT REFERENCES contacts(id),
    title TEXT NOT NULL,
    value REAL,
    stage TEXT NOT NULL DEFAULT 'outreach' CHECK(stage IN ('outreach','contact_made','interested','order_placed','interested_later','not_interested')),
    previous_stage TEXT CHECK(previous_stage IN ('outreach','contact_made','interested','order_placed','interested_later','not_interested')),
    channel TEXT CHECK(channel IN ('shopify','faire','phone','direct','other')),
    owner_id TEXT REFERENCES users(id),
    snooze_until TEXT,
    snooze_reason TEXT,
    last_activity_at TEXT DEFAULT (datetime('now')),
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    closed_at TEXT,
    reorder_due_at TEXT
  );
`);

// ── indexes ──
db.exec(`CREATE INDEX IF NOT EXISTS idx_deals_stage ON deals(stage);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_deals_owner ON deals(owner_id);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_deals_company ON deals(company_id);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_deals_snooze ON deals(snooze_until);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_deals_reorder ON deals(reorder_due_at);`);

// ── deal_activities table ──
db.exec(`
  CREATE TABLE IF NOT EXISTS deal_activities (
    id TEXT PRIMARY KEY,
    deal_id TEXT NOT NULL REFERENCES deals(id),
    company_id TEXT REFERENCES companies(id),
    type TEXT NOT NULL CHECK(type IN ('note','email','call','meeting','stage_change','snooze','reorder','enrichment','owner_change')),
    description TEXT,
    metadata TEXT,
    user_id TEXT REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_activities_deal ON deal_activities(deal_id);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_activities_company ON deal_activities(company_id);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_activities_created ON deal_activities(created_at);`);

// ── Add prospect_score to companies if missing ──
try {
  db.exec(`ALTER TABLE companies ADD COLUMN prospect_score INTEGER;`);
  console.log("✅ Added prospect_score column to companies");
} catch {
  console.log("ℹ️  prospect_score column already exists");
}

// ── Add enrichment_status to companies if missing ──
try {
  db.exec(`ALTER TABLE companies ADD COLUMN enrichment_status TEXT DEFAULT 'not_enriched' CHECK(enrichment_status IN ('not_enriched','queued','enriched','failed'));`);
  console.log("✅ Added enrichment_status column to companies");
} catch {
  console.log("ℹ️  enrichment_status column already exists");
}

// Verify
const dealCount = (db.prepare("SELECT count(*) as c FROM deals").get() as { c: number }).c;
const activityCount = (db.prepare("SELECT count(*) as c FROM deal_activities").get() as { c: number }).c;
console.log(`\n✅ Migration complete!`);
console.log(`   deals: ${dealCount} rows`);
console.log(`   deal_activities: ${activityCount} rows`);

db.close();
