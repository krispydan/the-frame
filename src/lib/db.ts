import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import fs from "fs";

const DB_PATH = process.env.DATABASE_PATH || process.env.DATABASE_URL || path.join(process.cwd(), "data", "the-frame.db");

// Ensure directory exists (important for Railway where /data is a volume)
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const sqlite = new Database(DB_PATH);

// Performance PRAGMAs per CTO review
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("busy_timeout = 15000");
sqlite.pragma("synchronous = NORMAL");
sqlite.pragma("cache_size = -64000"); // 64MB
sqlite.pragma("foreign_keys = ON");
sqlite.pragma("temp_store = MEMORY");

export const db = drizzle(sqlite);
export { sqlite };

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
