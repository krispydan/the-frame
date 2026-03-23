export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

export async function POST(request: NextRequest) {
  const key = request.headers.get("x-admin-key");
  if (key !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const results: string[] = [];

  // Add missing columns to companies
  const companyColumns = [
    { column: "enrichment_status", type: "TEXT DEFAULT 'pending'" },
    { column: "segment", type: "TEXT" },
    { column: "category", type: "TEXT" },
    { column: "disqualify_reason", type: "TEXT" },
    { column: "lead_source_detail", type: "TEXT" },
  ];

  for (const { column, type } of companyColumns) {
    try {
      sqlite.exec(`ALTER TABLE companies ADD COLUMN ${column} ${type}`);
      results.push(`✅ Added companies.${column}`);
    } catch (e: unknown) {
      const msg = (e as Error).message || "";
      results.push(msg.includes("duplicate") ? `⏭️ companies.${column} exists` : `❌ companies.${column}: ${msg}`);
    }
  }

  // Add missing columns to users
  const userColumns = [
    { column: "password_reset_token", type: "TEXT" },
    { column: "password_reset_expires", type: "TEXT" },
  ];

  for (const { column, type } of userColumns) {
    try {
      sqlite.exec(`ALTER TABLE users ADD COLUMN ${column} ${type}`);
      results.push(`✅ Added users.${column}`);
    } catch (e: unknown) {
      const msg = (e as Error).message || "";
      results.push(msg.includes("duplicate") ? `⏭️ users.${column} exists` : `❌ users.${column}: ${msg}`);
    }
  }

  // Create missing tables
  try {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS catalog_products (
      id TEXT PRIMARY KEY, sku_prefix TEXT, name TEXT, description TEXT,
      category TEXT, status TEXT DEFAULT 'draft', created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`);
    results.push("✅ catalog_products table ready");
  } catch (e: unknown) { results.push(`❌ catalog_products: ${(e as Error).message}`); }

  try {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS deals (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, company_id TEXT, stage TEXT DEFAULT 'lead',
      value REAL, status TEXT DEFAULT 'open', created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`);
    results.push("✅ deals table ready");
  } catch (e: unknown) { results.push(`❌ deals: ${(e as Error).message}`); }

  try {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, order_number TEXT, status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    results.push("✅ orders table ready");
  } catch (e: unknown) { results.push(`❌ orders: ${(e as Error).message}`); }

  // Stats
  const companyCount = (sqlite.prepare("SELECT COUNT(*) as c FROM companies").get() as { c: number }).c;
  const userCount = (sqlite.prepare("SELECT COUNT(*) as c FROM users").get() as { c: number }).c;

  return NextResponse.json({ results, companyCount, userCount });
}
