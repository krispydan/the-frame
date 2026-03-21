export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { activityFeed } from "@/modules/core/schema";
import { desc, eq, and } from "drizzle-orm";

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const module = searchParams.get("module");
  const limit = Math.min(parseInt(searchParams.get("limit") || "50", 10), 200);
  const entityType = searchParams.get("entity_type");

  const conditions = [];
  if (module) conditions.push(eq(activityFeed.module, module));
  if (entityType) conditions.push(eq(activityFeed.entityType, entityType));

  const events = db
    .select()
    .from(activityFeed)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(activityFeed.createdAt))
    .limit(limit)
    .all();

  return NextResponse.json({ events, count: events.length });
}
