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
