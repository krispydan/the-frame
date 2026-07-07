/**
 * PATCH /api/v1/marketing/videos/clips/bulk — bulk retag.
 *
 * Body: { clipIds: string[], categoryId?, audioMode?, boost?, addSkuIds?, removeSkuIds? }
 * categoryId accepts an id or slug. Only provided fields change.
 * Tagging 300 clips one-by-one is not a workflow; this is.
 */
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

export async function PATCH(request: NextRequest) {
  let body: {
    clipIds?: string[];
    categoryId?: string | null;
    audioMode?: string;
    boost?: number;
    addSkuIds?: string[];
    removeSkuIds?: string[];
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const clipIds = (body.clipIds ?? []).map(String).filter(Boolean);
  if (clipIds.length === 0) {
    return NextResponse.json({ error: "clipIds is required" }, { status: 400 });
  }

  const sets: string[] = [];
  const setParams: unknown[] = [];

  if ("categoryId" in body) {
    if (body.categoryId == null || body.categoryId === "") {
      sets.push("category_id = NULL");
    } else {
      const cat = sqlite
        .prepare(`SELECT id FROM marketing_video_clip_categories WHERE (id = ? OR slug = ?) AND archived = 0`)
        .get(body.categoryId, body.categoryId) as { id: string } | undefined;
      if (!cat) return NextResponse.json({ error: `Unknown category: ${body.categoryId}` }, { status: 400 });
      sets.push("category_id = ?");
      setParams.push(cat.id);
    }
  }
  if (body.audioMode !== undefined) {
    if (body.audioMode !== "mute" && body.audioMode !== "keep") {
      return NextResponse.json({ error: "audioMode must be 'mute' or 'keep'" }, { status: 400 });
    }
    sets.push("audio_mode = ?");
    setParams.push(body.audioMode);
  }
  if (body.boost !== undefined) {
    if (![0, 1, 2].includes(Number(body.boost))) {
      return NextResponse.json({ error: "boost must be 0, 1 or 2" }, { status: 400 });
    }
    sets.push("boost = ?");
    setParams.push(Number(body.boost));
  }

  let updated = 0;
  if (sets.length > 0) {
    sets.push("updated_at = datetime('now')");
    const placeholders = clipIds.map(() => "?").join(",");
    const result = sqlite
      .prepare(`UPDATE marketing_video_clips SET ${sets.join(", ")} WHERE id IN (${placeholders})`)
      .run(...setParams, ...clipIds);
    updated = result.changes;
  }

  if (body.addSkuIds?.length) {
    const insert = sqlite.prepare(
      `INSERT OR IGNORE INTO marketing_video_clip_products (id, clip_id, sku_id) VALUES (?, ?, ?)`,
    );
    for (const clipId of clipIds) {
      for (const skuId of body.addSkuIds.map(String).filter(Boolean)) {
        insert.run(crypto.randomUUID(), clipId, skuId);
      }
    }
  }
  if (body.removeSkuIds?.length) {
    const placeholders = clipIds.map(() => "?").join(",");
    const skuPlaceholders = body.removeSkuIds.map(() => "?").join(",");
    sqlite
      .prepare(
        `DELETE FROM marketing_video_clip_products WHERE clip_id IN (${placeholders}) AND sku_id IN (${skuPlaceholders})`,
      )
      .run(...clipIds, ...body.removeSkuIds);
  }

  return NextResponse.json({ updated, clipCount: clipIds.length });
}
