/**
 * POST /api/v1/marketing/videos/posts/generate
 *
 * Two modes:
 *   { count: 5 }                                  → N unscheduled videos
 *   { startDate, endDate, slotsPerDay? }          → fill every empty slot
 *     in the date range (inclusive) — "generate next week's posts".
 *
 * Composition is synchronous (fast); rendering happens in background
 * jobs. Returns { created, skipped, warnings, posts }.
 */
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { generateUnscheduled, topUpVideoQueue } from "@/modules/marketing/lib/video/scheduler";

const MAX_BATCH = 50;

export async function POST(request: NextRequest) {
  let body: { count?: number; startDate?: string; endDate?: string; slotsPerDay?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const isoDate = /^\d{4}-\d{2}-\d{2}$/;

  if (body.startDate || body.endDate) {
    if (!body.startDate || !isoDate.test(body.startDate) || !body.endDate || !isoDate.test(body.endDate)) {
      return NextResponse.json({ error: "startDate and endDate must be YYYY-MM-DD" }, { status: 400 });
    }
    const days =
      Math.floor(
        (new Date(body.endDate).getTime() - new Date(body.startDate).getTime()) / 86400000,
      ) + 1;
    if (days < 1 || days > 31) {
      return NextResponse.json({ error: "Date range must be 1-31 days" }, { status: 400 });
    }
    const result = topUpVideoQueue({
      startDate: body.startDate,
      horizonDays: days,
      slotsPerDay: body.slotsPerDay,
    });
    return NextResponse.json(result, { status: result.created > 0 ? 201 : 200 });
  }

  const count = Math.min(Math.max(Number(body.count) || 0, 1), MAX_BATCH);
  const result = generateUnscheduled(count);
  return NextResponse.json(result, { status: result.created > 0 ? 201 : 200 });
}
