/**
 * POST /api/v1/marketing/ads/[id]/render — (re)queue this ad's renders.
 * Body {ratios?: string[]} narrows to specific ratios (default: the
 * ad's enabled set). Used by the detail page's "re-render" after a
 * failure and by the canvas editor's explicit re-render.
 */
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { jobQueue } from "@/modules/core/lib/job-queue";
import { isAdRatio } from "@/modules/marketing/lib/ads/ratios";

export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ad = sqlite.prepare(`SELECT id, kind, ratios, status FROM marketing_ads WHERE id = ?`).get(id) as
    | { id: string; kind: string; ratios: string; status: string } | undefined;
  if (!ad) return NextResponse.json({ error: "Ad not found" }, { status: 404 });
  if (ad.kind !== "video" && ad.kind !== "image") {
    return NextResponse.json({ error: `Kind '${ad.kind}' cannot render yet` }, { status: 400 });
  }

  const body = await request.json().catch(() => ({}));
  const enabled = (JSON.parse(ad.ratios || "[]") as string[]).filter(isAdRatio);
  const requested = Array.isArray(body?.ratios) && body.ratios.length
    ? (body.ratios as string[]).filter((r) => isAdRatio(r) && enabled.includes(r))
    : enabled;
  if (!requested.length) return NextResponse.json({ error: "No valid ratios" }, { status: 400 });

  for (const ratio of requested) {
    sqlite.prepare(`
      INSERT INTO marketing_ad_renders (id, ad_id, ratio, kind, status)
      VALUES (lower(hex(randomblob(16))), ?, ?, ?, 'queued')
      ON CONFLICT (ad_id, ratio)
      DO UPDATE SET status = 'queued', error = NULL, updated_at = datetime('now')
    `).run(id, ratio, ad.kind);
    jobQueue.enqueue("marketing.ads.render", "marketing", { adId: id, ratio }, { priority: 3 });
  }
  sqlite.prepare(
    `UPDATE marketing_ads SET status = 'rendering', error = NULL, updated_at = datetime('now')
      WHERE id = ? AND status IN ('ready', 'failed', 'rendering')`,
  ).run(id);

  return NextResponse.json({ ok: true, queued: requested });
}
