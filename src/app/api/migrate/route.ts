export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { db, sqlite } from "@/lib/db";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import fs from "fs";

export async function POST() {
  try {
    const migrationsFolder = path.join(process.cwd(), "drizzle", "migrations");
    
    // Check what exists
    const exists = fs.existsSync(migrationsFolder);
    const files = exists ? fs.readdirSync(migrationsFolder) : [];
    
    // Check current tables
    const tablesBefore = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
    
    // Ensure notifications table exists (may not be in drizzle migrations yet)
    sqlite.exec(`CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      severity TEXT NOT NULL,
      module TEXT NOT NULL,
      entity_id TEXT,
      entity_type TEXT,
      read INTEGER NOT NULL DEFAULT 0,
      dismissed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )`);

    // Run migrations
    migrate(db, { migrationsFolder });
    
    // Check tables after
    const tablesAfter = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
    
    return NextResponse.json({
      success: true,
      migrationsFolder,
      exists,
      files,
      tablesBefore: tablesBefore.map((t: any) => t.name),
      tablesAfter: tablesAfter.map((t: any) => t.name),
    });
  } catch (error: any) {
    return NextResponse.json({ 
      error: error.message,
      cause: error.cause?.message,
      stack: error.stack?.split('\n').slice(0, 5),
    }, { status: 500 });
  }
}
