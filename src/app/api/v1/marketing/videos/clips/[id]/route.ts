/**
 * /api/v1/marketing/videos/clips/[id]
 *
 * GET    — clip detail (with category + products)
 * PATCH  — edit tags: { categoryId?, skuIds?, audioMode?, boost?, talent?, notes? }
 *          categoryId accepts an id or slug; skuIds replaces the set;
 *          talent is the person in the clip (null/empty = no one).
 * DELETE — archive by default; hard-deletes (row + volume files) only
 *          when the clip has never been used in a post AND ?hard=1.
 */
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { db, sqlite } from "@/lib/db";
import { videoClips } from "@/modules/marketing/schema";
import { eq } from "drizzle-orm";
import { deleteVideo, videoUrl } from "@/lib/storage/videos";

type Params = { params: Promise<{ id: string }> };

function loadClip(id: string) {
  return sqlite.prepare(`
    SELECT c.*, cat.slug AS category_slug, cat.name AS category_name
    FROM marketing_video_clips c
    LEFT JOIN marketing_video_clip_categories cat ON cat.id = c.category_id
    WHERE c.id = ?
  `).get(id) as Record<string, unknown> | undefined;
}

export async function GET(_request: NextRequest, { params }: Params) {
  const { id } = await params;
  const clip = loadClip(id);
  if (!clip) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const products = sqlite.prepare(`
    SELECT cp.sku_id AS skuId, s.sku, s.color_name AS colorName, p.name AS productName
    FROM marketing_video_clip_products cp
    LEFT JOIN catalog_skus s ON s.id = cp.sku_id
    LEFT JOIN catalog_products p ON p.id = s.product_id
    WHERE cp.clip_id = ?
  `).all(id);

  return NextResponse.json({
    clip: {
      ...clip,
      posterUrl: clip.poster_path ? videoUrl(String(clip.poster_path)) : null,
      previewUrl: clip.normalized_path ? videoUrl(String(clip.normalized_path)) : null,
      products,
    },
  });
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const { id } = await params;
  const existing = db.select().from(videoClips).where(eq(videoClips.id, id)).get();
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const updates: Partial<typeof videoClips.$inferInsert> = { updatedAt: new Date().toISOString() };

  if ("categoryId" in body) {
    if (body.categoryId === null || body.categoryId === "") {
      updates.categoryId = null;
    } else {
      const cat = sqlite
        .prepare(`SELECT id FROM marketing_video_clip_categories WHERE (id = ? OR slug = ?) AND archived = 0`)
        .get(String(body.categoryId), String(body.categoryId)) as { id: string } | undefined;
      if (!cat) return NextResponse.json({ error: `Unknown category: ${body.categoryId}` }, { status: 400 });
      updates.categoryId = cat.id;
    }
  }
  if ("audioMode" in body) {
    if (body.audioMode !== "mute" && body.audioMode !== "keep") {
      return NextResponse.json({ error: "audioMode must be 'mute' or 'keep'" }, { status: 400 });
    }
    updates.audioMode = body.audioMode;
  }
  if ("boost" in body) {
    const boost = Number(body.boost);
    if (![0, 1, 2].includes(boost)) {
      return NextResponse.json({ error: "boost must be 0, 1 or 2" }, { status: 400 });
    }
    updates.boost = boost;
  }
  if ("talent" in body) {
    const talent = body.talent == null ? "" : String(body.talent).trim();
    updates.talent = talent || null; // empty = no one appears
  }
  if ("notes" in body) updates.notes = body.notes == null ? null : String(body.notes);
  if ("status" in body) {
    if (body.status !== "archived" && body.status !== "ready") {
      return NextResponse.json({ error: "status can only be set to 'archived' or 'ready'" }, { status: 400 });
    }
    // un-archiving only makes sense when the normalized artifacts exist
    if (body.status === "ready" && !existing.normalizedPath) {
      return NextResponse.json({ error: "Clip has no normalized file — renormalize instead" }, { status: 400 });
    }
    updates.status = body.status;
  }

  db.update(videoClips).set(updates).where(eq(videoClips.id, id)).run();

  if (Array.isArray(body.skuIds)) {
    sqlite.prepare(`DELETE FROM marketing_video_clip_products WHERE clip_id = ?`).run(id);
    const insert = sqlite.prepare(
      `INSERT OR IGNORE INTO marketing_video_clip_products (id, clip_id, sku_id) VALUES (?, ?, ?)`,
    );
    for (const skuId of body.skuIds.map(String).filter(Boolean)) {
      insert.run(crypto.randomUUID(), id, skuId);
    }
  }

  return NextResponse.json({ clip: loadClip(id) });
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const { id } = await params;
  const clip = db.select().from(videoClips).where(eq(videoClips.id, id)).get();
  if (!clip) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const hard = request.nextUrl.searchParams.get("hard") === "1";
  const usedInPosts = (sqlite.prepare(
    `SELECT COUNT(*) AS n FROM marketing_video_posts WHERE clip_ids LIKE ?`,
  ).get(`%"${id}"%`) as { n: number }).n;

  if (hard && usedInPosts === 0) {
    sqlite.prepare(`DELETE FROM marketing_video_clip_products WHERE clip_id = ?`).run(id);
    db.delete(videoClips).where(eq(videoClips.id, id)).run();
    for (const rel of [clip.rawPath, clip.normalizedPath, clip.mutedPath, clip.posterPath]) {
      if (rel) await deleteVideo(rel).catch(() => {});
    }
    return NextResponse.json({ deleted: true });
  }

  // Default (or clip is referenced by posts): archive — it stops being
  // composable but existing renders keep their history intact.
  db.update(videoClips)
    .set({ status: "archived", updatedAt: new Date().toISOString() })
    .where(eq(videoClips.id, id))
    .run();
  return NextResponse.json({ deleted: false, archived: true, usedInPosts });
}
