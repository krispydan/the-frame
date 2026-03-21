export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

const startTime = Date.now();

export async function GET() {
  // Quick DB check
  let dbOk = false;
  try {
    db.get(sql`SELECT 1`);
    dbOk = true;
  } catch {
    dbOk = false;
  }

  return NextResponse.json({
    status: dbOk ? "ok" : "degraded",
    version: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) || "dev",
    uptime: Math.floor((Date.now() - startTime) / 1000),
    modules: ["core", "sales", "catalog", "orders", "inventory", "finance", "customers", "marketing", "intelligence"],
    database: dbOk ? "connected" : "error",
    timestamp: new Date().toISOString(),
  });
}
