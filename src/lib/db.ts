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
sqlite.pragma("busy_timeout = 5000");
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
