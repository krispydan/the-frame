export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { jobs } from "@/modules/core/schema";
import { eq, and, desc } from "drizzle-orm";
import { apiHandler } from "@/lib/api-middleware";

export const GET = apiHandler(
  async (request: NextRequest) => {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status");
    const module = searchParams.get("module");
    const limit = Math.min(parseInt(searchParams.get("limit") || "50"), 200);

    const conditions = [];
    if (status) conditions.push(eq(jobs.status, status as "pending" | "running" | "completed" | "failed" | "cancelled"));
    if (module) conditions.push(eq(jobs.module, module));

    const results = db
      .select()
      .from(jobs)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(jobs.createdAt))
      .limit(limit)
      .all();

    return NextResponse.json({ jobs: results, count: results.length });
  },
  { auth: true }
);
