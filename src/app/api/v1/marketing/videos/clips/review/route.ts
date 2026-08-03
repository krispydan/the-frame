/**
 * GET /api/v1/marketing/videos/clips/review?minSec=10
 *
 * The split-review queue: clips too long to use as-is that nobody has
 * triaged yet, longest first, plus the counts for the progress readout.
 *
 * Only `ready` clips — one still normalizing has no reliable duration and
 * no playable file to scrub.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { videoUrl } from "@/lib/storage/videos";
import { LONG_CLIP_SEC, reviewQueueStats } from "@/modules/marketing/lib/video/split-review";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const minSec = Number(searchParams.get("minSec")) || LONG_CLIP_SEC;
  const includeReviewed = searchParams.get("includeReviewed") === "1";
  const limit = Math.min(200, parseInt(searchParams.get("limit") || "100", 10));

  const rows = sqlite
    .prepare(
      `SELECT c.id, c.file_name AS fileName, c.duration_sec AS durationSec,
              c.normalized_path AS normalizedPath, c.poster_path AS posterPath,
              c.split_reviewed_at AS splitReviewedAt, c.talent,
              cat.name AS categoryName, cat.slug AS categorySlug,
              (SELECT COUNT(*) FROM marketing_video_clip_products cp WHERE cp.clip_id = c.id) AS productCount
         FROM marketing_video_clips c
         LEFT JOIN marketing_video_clip_categories cat ON cat.id = c.category_id
        WHERE c.status = 'ready'
          AND c.duration_sec IS NOT NULL
          AND c.duration_sec >= ?
          ${includeReviewed ? "" : "AND c.split_reviewed_at IS NULL"}
        ORDER BY c.duration_sec DESC, c.created_at DESC
        LIMIT ?`,
    )
    .all(minSec, limit) as Array<Record<string, unknown>>;

  return NextResponse.json({
    minSec,
    stats: reviewQueueStats(minSec),
    clips: rows.map((r) => ({
      id: r.id,
      fileName: r.fileName,
      durationSec: r.durationSec,
      categoryName: r.categoryName ?? null,
      categorySlug: r.categorySlug ?? null,
      talent: r.talent ?? null,
      productCount: r.productCount ?? 0,
      splitReviewedAt: r.splitReviewedAt ?? null,
      posterUrl: r.posterPath ? videoUrl(String(r.posterPath)) : null,
      previewUrl: r.normalizedPath ? videoUrl(String(r.normalizedPath)) : null,
    })),
  });
}
