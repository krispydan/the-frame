/**
 * GET /api/v1/marketing/videos/stats — dashboard strip for the studio.
 *
 * Library counts, queue counts, product coverage, per-recipe
 * satisfiability + permutation headroom. Read-only (no deletions —
 * that's the weekly hygiene cron).
 */
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { db, sqlite } from "@/lib/db";
import { videoRecipes } from "@/modules/marketing/schema";
import { recipeSatisfiable } from "@/modules/marketing/lib/video/composer";
import { estimateRecipeHeadroom } from "@/modules/marketing/lib/video/cleanup";
import { loadComposerClips } from "@/modules/marketing/lib/video/scheduler";

export async function GET() {
  const clipsByStatus = Object.fromEntries(
    (sqlite.prepare(
      `SELECT status, COUNT(*) AS n FROM marketing_video_clips GROUP BY status`,
    ).all() as Array<{ status: string; n: number }>).map((r) => [r.status, r.n]),
  );
  const postsByStatus = Object.fromEntries(
    (sqlite.prepare(
      `SELECT status, COUNT(*) AS n FROM marketing_video_posts GROUP BY status`,
    ).all() as Array<{ status: string; n: number }>).map((r) => [r.status, r.n]),
  );

  const clips = loadComposerClips();
  const byCategory: Record<string, number> = {};
  const countMap = new Map<string, number>();
  for (const clip of clips) {
    byCategory[clip.categorySlug] = (byCategory[clip.categorySlug] ?? 0) + 1;
    countMap.set(clip.categorySlug, (countMap.get(clip.categorySlug) ?? 0) + 1);
  }

  const taggedSkus = (sqlite.prepare(
    `SELECT COUNT(DISTINCT sku_id) AS n FROM marketing_video_clip_products`,
  ).get() as { n: number }).n;

  const untagged = (sqlite.prepare(
    `SELECT COUNT(*) AS n FROM marketing_video_clips WHERE category_id IS NULL AND status NOT IN ('archived')`,
  ).get() as { n: number }).n;

  const recipes = db.select().from(videoRecipes).all().map((r) => ({
    id: r.id,
    name: r.name,
    enabled: r.enabled === 1,
    satisfiable: recipeSatisfiable(r, clips),
    estimatedHeadroom: estimateRecipeHeadroom(r.patternJson, countMap),
  }));

  const readyForToday = (sqlite.prepare(
    `SELECT COUNT(*) AS n FROM marketing_video_posts WHERE status = 'ready' AND (scheduled_date IS NULL OR scheduled_date <= date('now'))`,
  ).get() as { n: number }).n;

  return NextResponse.json({
    clips: { byStatus: clipsByStatus, byCategory, untagged, ready: clips.length },
    posts: { byStatus: postsByStatus, readyForToday },
    products: { taggedSkus },
    recipes,
  });
}
