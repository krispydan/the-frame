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
  syncTrendingSounds,
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
  });
}

export async function POST(request: NextRequest) {
  let body: { countryCode?: string; rankTypes?: RankType[]; limit?: number } = {};
  try {
    body = await request.json();
  } catch {
    /* empty body = defaults */
  }
  try {
    const result = await syncTrendingSounds(body);
    return NextResponse.json(result, { status: 200 });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const status = /not configured/i.test(message) ? 503 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
