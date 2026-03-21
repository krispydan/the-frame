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
