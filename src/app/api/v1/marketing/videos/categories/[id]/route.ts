/**
 * /api/v1/marketing/videos/categories/[id]
 *
 * PATCH  — rename / edit: { name?, description?, isHook?, sortOrder?, archived? }
 *          (slug is immutable — recipes reference it)
 * DELETE — hard-delete only when no clips reference it; otherwise 409
 *          telling the caller to archive.
 */
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { db, sqlite } from "@/lib/db";
import { videoClipCategories } from "@/modules/marketing/schema";
import { eq } from "drizzle-orm";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, { params }: Params) {
  const { id } = await params;
  const existing = db.select().from(videoClipCategories).where(eq(videoClipCategories.id, id)).get();
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: { name?: string; description?: string | null; isHook?: boolean; sortOrder?: number; archived?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const updates: Partial<typeof videoClipCategories.$inferInsert> = { updatedAt: new Date().toISOString() };
  if (body.name !== undefined) {
    if (!body.name.trim()) return NextResponse.json({ error: "name cannot be empty" }, { status: 400 });
    updates.name = body.name.trim();
  }
  if (body.description !== undefined) updates.description = body.description?.trim() || null;
  if (body.isHook !== undefined) updates.isHook = body.isHook ? 1 : 0;
  if (body.sortOrder !== undefined) updates.sortOrder = Number(body.sortOrder) || 0;
  if (body.archived !== undefined) updates.archived = body.archived ? 1 : 0;

  db.update(videoClipCategories).set(updates).where(eq(videoClipCategories.id, id)).run();
  const row = sqlite.prepare(`SELECT * FROM marketing_video_clip_categories WHERE id = ?`).get(id);
  return NextResponse.json({ category: row });
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  const { id } = await params;
  const existing = db.select().from(videoClipCategories).where(eq(videoClipCategories.id, id)).get();
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const inUse = (sqlite.prepare(
    `SELECT COUNT(*) AS n FROM marketing_video_clips WHERE category_id = ?`,
  ).get(id) as { n: number }).n;
  if (inUse > 0) {
    return NextResponse.json(
      { error: `${inUse} clips use this category — archive it instead`, clipCount: inUse },
      { status: 409 },
    );
  }

  db.delete(videoClipCategories).where(eq(videoClipCategories.id, id)).run();
  return NextResponse.json({ deleted: true });
}
