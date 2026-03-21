export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

export async function GET() {
  try {
    const rows = db.all(sql`SELECT * FROM inventory_factories ORDER BY code`);
    return NextResponse.json({ factories: rows });
  } catch (error) {
    console.error("Factories API error:", error);
    return NextResponse.json({ error: "Failed to fetch factories" }, { status: 500 });
  }
}
