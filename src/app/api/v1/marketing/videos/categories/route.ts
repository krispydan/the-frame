/**
 * /api/v1/marketing/videos/categories
 *
 * GET  — list categories (with per-category ready-clip counts)
 * POST — create: { name, slug?, description?, isHook?, sortOrder? }
 *        slug derives from name when omitted.
 */
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { db, sqlite } from "@/lib/db";
import { videoClipCategories } from "@/modules/marketing/schema";

function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export async function GET() {
  const rows = sqlite.prepare(`
    SELECT cat.*,
      (SELECT COUNT(*) FROM marketing_video_clips c WHERE c.category_id = cat.id AND c.status = 'ready') AS ready_clips,
      (SELECT COUNT(*) FROM marketing_video_clips c WHERE c.category_id = cat.id AND c.status != 'archived') AS total_clips
    FROM marketing_video_clip_categories cat
    ORDER BY cat.archived ASC, cat.sort_order ASC, cat.name ASC
  `).all();
  return NextResponse.json({ categories: rows });
}

export async function POST(request: NextRequest) {
  let body: { name?: string; slug?: string; description?: string; isHook?: boolean; sortOrder?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.name?.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  const slug = slugify(body.slug || body.name);
  if (!slug) return NextResponse.json({ error: "Could not derive a slug" }, { status: 400 });

  const id = crypto.randomUUID();
  try {
    db.insert(videoClipCategories)
      .values({
        id,
        slug,
        name: body.name.trim(),
        description: body.description?.trim() || null,
        isHook: body.isHook ? 1 : 0,
        sortOrder: body.sortOrder ?? 100,
      })
      .run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("UNIQUE")) {
      return NextResponse.json({ error: `Category slug '${slug}' already exists` }, { status: 409 });
    }
    throw e;
  }

  const row = sqlite.prepare(`SELECT * FROM marketing_video_clip_categories WHERE id = ?`).get(id);
  return NextResponse.json({ category: row }, { status: 201 });
}
