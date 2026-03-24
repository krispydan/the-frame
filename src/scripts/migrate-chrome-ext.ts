/**
 * Chrome Extension Migration: Add socials and contact_form_url columns to companies
 */
import Database from "better-sqlite3";
import path from "path";

const DB_PATH = path.resolve(process.cwd(), "data", "frame.db");
const db = new Database(DB_PATH);

function migrate() {
  console.log("🔄 Running Chrome Extension migration...");

  // Check if columns already exist
  const columns = db.prepare("PRAGMA table_info(companies)").all() as { name: string }[];
  const colNames = columns.map((c) => c.name);

  if (!colNames.includes("socials")) {
    db.prepare("ALTER TABLE companies ADD COLUMN socials TEXT").run();
    console.log("  ✅ Added socials column");
  } else {
    console.log("  ⏭️  socials column already exists");
  }

  if (!colNames.includes("contact_form_url")) {
    db.prepare("ALTER TABLE companies ADD COLUMN contact_form_url TEXT").run();
    console.log("  ✅ Added contact_form_url column");
  } else {
    console.log("  ⏭️  contact_form_url column already exists");
  }

  console.log("✅ Chrome Extension migration complete!");
}

migrate();
db.close();
