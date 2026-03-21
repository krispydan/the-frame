export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { reportingLogs } from "@/modules/core/schema";
import { desc, eq, and } from "drizzle-orm";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const eventType = params.get("event_type");
  const module = params.get("module");
  const limit = Math.min(parseInt(params.get("limit") || "50", 10), 200);

  const conditions = [];
  if (eventType) conditions.push(eq(reportingLogs.eventType, eventType));
  if (module) conditions.push(eq(reportingLogs.module, module));

  const logs = db
    .select()
    .from(reportingLogs)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(reportingLogs.timestamp))
    .limit(limit)
    .all();

  return NextResponse.json({ logs, count: logs.length });
}
