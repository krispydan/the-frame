/**
 * /api/v1/marketing/videos/sounds — TikTok trending sounds.
 *
 * GET  — current chart snapshot from the DB (?rankType=popular|breakout,
 *        ?limit=). Includes lastSyncedAt so the UI can show freshness.
 * POST — trigger a sync from Apify NOW (also runs daily via the
 *        tiktok-sounds-sync cron). Body optional:
 *        { countryCode?, rankTypes?, limit? }.
 */
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import {
  getTrendingSounds,
  lastSyncedAt,
  enqueueSoundsSync,
  isSoundsSyncActive,
  type RankType,
} from "@/modules/marketing/lib/video/tiktok-sounds";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const rankType = searchParams.get("rankType") as RankType | null;
  const limit = Math.min(100, parseInt(searchParams.get("limit") || "60", 10));

  const sounds = getTrendingSounds({
    rankType: rankType === "popular" || rankType === "breakout" ? rankType : undefined,
    limit,
  });
  return NextResponse.json({
    sounds,
    lastSyncedAt: lastSyncedAt(),
    configured: Boolean(process.env.APIFY_API_TOKEN),
    // The chart pull takes minutes and runs as a background job — the UI
    // polls this to know when a sync is in progress vs finished.
    syncing: isSoundsSyncActive(),
  });
}

export async function POST() {
  if (!process.env.APIFY_API_TOKEN) {
    return NextResponse.json(
      { error: "Apify not configured — set APIFY_API_TOKEN env" },
      { status: 503 },
    );
  }
  // Enqueue a background job (ONE run, guarded against duplicates) and
  // return immediately — never hold the browser connection open for the
  // multi-minute actor run.
  const result = enqueueSoundsSync();
  return NextResponse.json(result, { status: result.enqueued ? 202 : 200 });
}
