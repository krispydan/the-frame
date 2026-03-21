export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { changeLogs } from "@/modules/core/schema";
import { desc, eq, and } from "drizzle-orm";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const entityType = params.get("entity_type");
  const entityId = params.get("entity_id");
  const limit = Math.min(parseInt(params.get("limit") || "50", 10), 200);

  const conditions = [];
  if (entityType) conditions.push(eq(changeLogs.entityType, entityType));
  if (entityId) conditions.push(eq(changeLogs.entityId, entityId));

  const logs = db
    .select()
    .from(changeLogs)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(changeLogs.timestamp))
    .limit(limit)
    .all();

  return NextResponse.json({ logs, count: logs.length });
}
