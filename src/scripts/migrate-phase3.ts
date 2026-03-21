/**
 * Phase 3 Migration: campaigns, campaign_leads, instantly_sync tables
 */
import Database from "better-sqlite3";
import path from "path";

const DB_PATH = process.env.DATABASE_URL || path.join(process.cwd(), "data", "the-frame.db");
const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

console.log("🔧 Phase 3 Migration: Campaign tables...\n");

db.exec(`
  CREATE TABLE IF NOT EXISTS campaigns (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'email_sequence' CHECK(type IN ('email_sequence','calling','re_engagement','ab_test')),
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','paused','completed')),
    description TEXT,
    instantly_campaign_id TEXT,
    target_segment TEXT,
    target_smart_list_id TEXT REFERENCES smart_lists(id),
    variant_a_subject TEXT,
    variant_b_subject TEXT,
    sent INTEGER DEFAULT 0,
    delivered INTEGER DEFAULT 0,
    opened INTEGER DEFAULT 0,
    replied INTEGER DEFAULT 0,
    bounced INTEGER DEFAULT 0,
    meetings_booked INTEGER DEFAULT 0,
    orders_placed INTEGER DEFAULT 0,
    variant_a_sent INTEGER DEFAULT 0,
    variant_a_opened INTEGER DEFAULT 0,
    variant_a_replied INTEGER DEFAULT 0,
    variant_b_sent INTEGER DEFAULT 0,
    variant_b_opened INTEGER DEFAULT 0,
    variant_b_replied INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);
  CREATE INDEX IF NOT EXISTS idx_campaigns_type ON campaigns(type);
  CREATE INDEX IF NOT EXISTS idx_campaigns_instantly ON campaigns(instantly_campaign_id);
`);

console.log("✅ campaigns table created");

db.exec(`
  CREATE TABLE IF NOT EXISTS campaign_leads (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL REFERENCES campaigns(id),
    company_id TEXT NOT NULL REFERENCES companies(id),
    contact_id TEXT REFERENCES contacts(id),
    instantly_lead_id TEXT,
    email TEXT,
    status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sent','opened','replied','bounced','unsubscribed')),
    reply_text TEXT,
    reply_classification TEXT,
    sent_at TEXT,
    opened_at TEXT,
    replied_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_cl_campaign ON campaign_leads(campaign_id);
  CREATE INDEX IF NOT EXISTS idx_cl_company ON campaign_leads(company_id);
  CREATE INDEX IF NOT EXISTS idx_cl_status ON campaign_leads(status);
  CREATE INDEX IF NOT EXISTS idx_cl_instantly ON campaign_leads(instantly_lead_id);
`);

console.log("✅ campaign_leads table created");

db.exec(`
  CREATE TABLE IF NOT EXISTS instantly_sync (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    instantly_id TEXT NOT NULL,
    last_synced_at TEXT DEFAULT (datetime('now')),
    sync_status TEXT NOT NULL DEFAULT 'pending' CHECK(sync_status IN ('pending','synced','error')),
    error_message TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_sync_entity ON instantly_sync(entity_type, entity_id);
  CREATE INDEX IF NOT EXISTS idx_sync_instantly ON instantly_sync(instantly_id);
`);

console.log("✅ instantly_sync table created");

// Seed some mock campaigns for dev
const existing = db.prepare("SELECT count(*) as c FROM campaigns").get() as { c: number };
if (existing.c === 0) {
  const insert = db.prepare(`INSERT INTO campaigns (id, name, type, status, description, instantly_campaign_id, sent, delivered, opened, replied, bounced, meetings_booked, orders_placed, variant_a_subject, variant_b_subject, variant_a_sent, variant_a_opened, variant_a_replied, variant_b_sent, variant_b_opened, variant_b_replied) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  
  insert.run("camp-001", "Q1 Boutique Outreach — Tier A", "email_sequence", "active", "Premium outreach to Tier A boutiques", "mock-camp-001", 1269, 1251, 584, 73, 18, 12, 3, null, null, 0, 0, 0, 0, 0, 0);
  insert.run("camp-002", "West Coast Re-engagement", "re_engagement", "active", "Re-engage west coast stores that went cold", "mock-camp-002", 530, 518, 227, 34, 12, 5, 1, null, null, 0, 0, 0, 0, 0, 0);
  insert.run("camp-003", "A/B Test — Subject Lines March", "ab_test", "active", "Testing personalized vs generic subject lines", "mock-camp-003", 1160, 1145, 580, 87, 15, 8, 2, "{{first_name}}, Jaxy eyewear for {{company_name}}", "New wholesale eyewear opportunity", 580, 310, 52, 580, 270, 35);
  insert.run("camp-004", "Holiday Preview — Independents", "email_sequence", "paused", "Holiday collection preview for independent stores", "mock-camp-004", 178, 172, 71, 11, 6, 2, 0, null, null, 0, 0, 0, 0, 0, 0);
  insert.run("camp-005", "New Arrivals — Chain Stores", "email_sequence", "completed", "Chain store outreach for new arrivals", "mock-camp-005", 960, 938, 403, 58, 22, 9, 4, null, null, 0, 0, 0, 0, 0, 0);
  
  console.log("✅ 5 seed campaigns inserted");
}

console.log("\n🎉 Phase 3 migration complete!");
db.close();
