export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { errorLogs } from "@/modules/core/schema";
import { desc, eq, and, gte } from "drizzle-orm";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const level = params.get("level") as "error" | "warn" | "critical" | null;
  const since = params.get("since");
  const limit = Math.min(parseInt(params.get("limit") || "50", 10), 200);

  const conditions = [];
  if (level) conditions.push(eq(errorLogs.level, level));
  if (since) conditions.push(gte(errorLogs.timestamp, since));

  const logs = db
    .select()
    .from(errorLogs)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(errorLogs.timestamp))
    .limit(limit)
    .all();

  return NextResponse.json({ logs, count: logs.length });
}
