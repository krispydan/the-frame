/**
 * Import 121K prospects from master CSV into The Frame database.
 * Usage: npx tsx src/scripts/import-prospects.ts
 */
import path from "path";

// Set DB path before importing db module
const dbPath = path.join(process.cwd(), "data", "the-frame.db");
process.env.DATABASE_URL = dbPath;

import { importProspectsFromCSV } from "@/modules/sales/lib/import-engine";
import { db, sqlite } from "@/lib/db";
import { companies, stores, contacts } from "@/modules/sales/schema";
import { sql } from "drizzle-orm";

const CSV_PATH = path.resolve(
  process.env.HOME || "~",
  "Library/CloudStorage/Dropbox/Obsidian/jaxy/sales/prospect-data/master-db/jaxy-prospect-master.csv"
);

async function main() {
  console.log("🚀 Starting prospect import...");
  console.log(`📂 CSV: ${CSV_PATH}`);
  console.log(`💾 DB: ${dbPath}`);

  // Ensure tables exist
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS companies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT,
      website TEXT,
      domain TEXT,
      phone TEXT,
      email TEXT,
      address TEXT,
      city TEXT,
      state TEXT,
      zip TEXT,
      country TEXT DEFAULT 'US',
      google_place_id TEXT,
      google_rating REAL,
      google_review_count INTEGER,
      status TEXT NOT NULL DEFAULT 'new',
      source TEXT,
      icp_tier TEXT,
      icp_score INTEGER,
      icp_reasoning TEXT,
      owner_id TEXT,
      tags TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
  
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_companies_icp_tier ON companies(icp_tier)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_companies_status ON companies(status)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_companies_state ON companies(state)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_companies_owner ON companies(owner_id)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_companies_domain ON companies(domain)`);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS stores (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id),
      name TEXT NOT NULL,
      is_primary INTEGER NOT NULL DEFAULT 0,
      address TEXT,
      city TEXT,
      state TEXT,
      zip TEXT,
      phone TEXT,
      email TEXT,
      manager_name TEXT,
      google_place_id TEXT,
      google_rating REAL,
      latitude REAL,
      longitude REAL,
      status TEXT NOT NULL DEFAULT 'active',
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_stores_company ON stores(company_id)`);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      store_id TEXT REFERENCES stores(id),
      company_id TEXT NOT NULL REFERENCES companies(id),
      first_name TEXT,
      last_name TEXT,
      title TEXT,
      email TEXT,
      phone TEXT,
      is_primary INTEGER NOT NULL DEFAULT 0,
      owner_id TEXT,
      last_contacted_at TEXT,
      source TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_id)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_contacts_store ON contacts(store_id)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email)`);

  // FTS5 index
  sqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS companies_fts USING fts5(
      name, city, state, website, domain, notes,
      content='companies',
      content_rowid='rowid'
    )
  `);

  const stats = await importProspectsFromCSV(CSV_PATH, {
    batchSize: 500,
    onProgress: (processed, total) => {
      if (processed % 5000 === 0 || processed === total) {
        console.log(`  📊 ${processed.toLocaleString()} / ${total.toLocaleString()} (${Math.round(processed / total * 100)}%)`);
      }
    },
  });

  console.log("\n✅ Import complete!");
  console.log(`  📋 Total rows: ${stats.totalRows.toLocaleString()}`);
  console.log(`  🏢 Companies created: ${stats.companiesCreated.toLocaleString()}`);
  console.log(`  🏪 Stores created: ${stats.storesCreated.toLocaleString()}`);
  console.log(`  👤 Contacts created: ${stats.contactsCreated.toLocaleString()}`);
  console.log(`  ⏭️  Skipped (dupes): ${stats.skipped.toLocaleString()}`);
  console.log(`  ❌ Errors: ${stats.errors.length}`);
  console.log(`  ⏱️  Duration: ${(stats.durationMs / 1000).toFixed(1)}s`);

  if (stats.errors.length > 0) {
    console.log("\n  First 5 errors:");
    stats.errors.slice(0, 5).forEach(e => console.log(`    Row ${e.row}: ${e.message}`));
  }

  // Verify counts
  const companyCount = db.select({ count: sql<number>`count(*)` }).from(companies).get();
  const storeCount = db.select({ count: sql<number>`count(*)` }).from(stores).get();
  const contactCount = db.select({ count: sql<number>`count(*)` }).from(contacts).get();
  console.log(`\n📊 Database verification:`);
  console.log(`  Companies: ${companyCount?.count.toLocaleString()}`);
  console.log(`  Stores: ${storeCount?.count.toLocaleString()}`);
  console.log(`  Contacts: ${contactCount?.count.toLocaleString()}`);

  // Test FTS5
  const ftsResults = sqlite.prepare(`
    SELECT count(*) as cnt FROM companies_fts WHERE companies_fts MATCH 'boutique'
  `).get() as { cnt: number };
  console.log(`\n🔍 FTS5 test: "boutique" → ${ftsResults.cnt} results`);
}

main().catch(console.error);
