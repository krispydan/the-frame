/**
 * GET /api/v1/marketing/videos/posts — the post queue.
 *
 * Filters: status, from/to (scheduled_date range), unscheduled=1.
 * Default view: everything not discarded, scheduled from 3 days ago
 * forward plus unscheduled, newest first within a day.
 */
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { videoUrl } from "@/lib/storage/videos";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const status = searchParams.get("status") || "";
  const from = searchParams.get("from") || "";
  const to = searchParams.get("to") || "";
  const unscheduledOnly = searchParams.get("unscheduled") === "1";
  const limit = Math.min(300, parseInt(searchParams.get("limit") || "120", 10));

  const clauses: string[] = [];
  const params: unknown[] = [];

  if (status) {
    clauses.push("p.status = ?");
    params.push(status);
  } else {
    clauses.push("p.status != 'discarded'");
  }
  if (unscheduledOnly) {
    clauses.push("p.scheduled_date IS NULL");
  } else {
    if (from) {
      clauses.push("(p.scheduled_date >= ? OR p.scheduled_date IS NULL)");
      params.push(from);
    }
    if (to) {
      clauses.push("(p.scheduled_date <= ? OR p.scheduled_date IS NULL)");
      params.push(to);
    }
  }

  const rows = sqlite.prepare(`
    SELECT p.*, r.name AS recipe_name, r.audio_policy AS recipe_audio_policy
    FROM marketing_video_posts p
    LEFT JOIN marketing_video_recipes r ON r.id = p.recipe_id
    WHERE ${clauses.join(" AND ")}
    ORDER BY p.scheduled_date IS NULL, p.scheduled_date ASC,
      CASE p.scheduled_slot WHEN 'morning' THEN 0 WHEN 'midday' THEN 1 WHEN 'evening' THEN 2 ELSE 3 END,
      p.created_at DESC
    LIMIT ?
  `).all(...params, limit) as Array<Record<string, unknown>>;

  const clipStmt = sqlite.prepare(`
    SELECT c.id, c.file_name AS fileName, c.duration_sec AS durationSec,
           c.poster_path AS posterPath, cat.slug AS category
    FROM marketing_video_clips c
    LEFT JOIN marketing_video_clip_categories cat ON cat.id = c.category_id
    WHERE c.id = ?
  `);

  const posts = rows.map((row) => {
    const clipIds = JSON.parse(String(row.clip_ids || "[]")) as string[];
    return {
      ...row,
      videoUrl: row.file_path ? videoUrl(String(row.file_path)) : null,
      posterUrl: row.poster_path ? videoUrl(String(row.poster_path)) : null,
      hashtags: row.hashtags ? JSON.parse(String(row.hashtags)) : [],
      instructions: row.instructions ? JSON.parse(String(row.instructions)) : null,
      clips: clipIds.map((id, i) => {
        const clip = clipStmt.get(id) as Record<string, unknown> | undefined;
        return {
          position: i + 1,
          id,
          ...clip,
          posterUrl: clip?.posterPath ? videoUrl(String(clip.posterPath)) : null,
        };
      }),
    };
  });

  return NextResponse.json({ posts, total: posts.length });
}
