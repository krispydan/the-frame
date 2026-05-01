export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { postDailyDigest, postWeeklyDigest } from "@/modules/integrations/lib/slack/digests";

/**
 * POST/GET /api/v1/integrations/slack/digest?kind=daily|weekly
 *
 * Triggers a Slack digest. Wire to Railway cron:
 *   Daily:  ?kind=daily  at 14:00 UTC (~7am PT, mostly — DST drift is fine)
 *   Weekly: ?kind=weekly at 15:00 UTC Monday (~8am PT)
 */
async function handle(req: NextRequest) {
  const kind = req.nextUrl.searchParams.get("kind") || "daily";
  if (kind !== "daily" && kind !== "weekly") {
    return NextResponse.json({ error: 'kind must be "daily" or "weekly"' }, { status: 400 });
  }
  try {
    const result = kind === "weekly" ? await postWeeklyDigest() : await postDailyDigest();
    return NextResponse.json({ ok: result.ok, kind });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) { return handle(req); }
export async function GET(req: NextRequest)  { return handle(req); }
