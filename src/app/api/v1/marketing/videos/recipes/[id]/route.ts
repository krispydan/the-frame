/**
 * /api/v1/marketing/videos/recipes/[id]
 *
 * GET    — recipe detail (parsed pattern)
 * PATCH  — edit: { name?, description?, pattern?, audioPolicy?, weight?,
 *          durationTargetMin?, durationTargetMax?, enabled? }
 * DELETE — delete; posts keep their recipeId (history) so this is safe.
 */
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { videoRecipes } from "@/modules/marketing/schema";
import { eq } from "drizzle-orm";
import { validatePattern } from "@/modules/marketing/lib/video/recipe-validation";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  const { id } = await params;
  const recipe = db.select().from(videoRecipes).where(eq(videoRecipes.id, id)).get();
  if (!recipe) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ recipe: { ...recipe, pattern: JSON.parse(recipe.patternJson) } });
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const { id } = await params;
  const existing = db.select().from(videoRecipes).where(eq(videoRecipes.id, id)).get();
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const updates: Partial<typeof videoRecipes.$inferInsert> = { updatedAt: new Date().toISOString() };

  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim()) {
      return NextResponse.json({ error: "name cannot be empty" }, { status: 400 });
    }
    updates.name = body.name.trim();
  }
  if (body.description !== undefined) {
    updates.description = typeof body.description === "string" ? body.description.trim() || null : null;
  }
  if (body.pattern !== undefined) {
    const pattern = validatePattern(body.pattern);
    if (!pattern.ok) return NextResponse.json({ error: pattern.error }, { status: 400 });
    updates.patternJson = JSON.stringify(pattern.slots);
  }
  if (body.audioPolicy !== undefined) {
    if (!["silent", "original", "lead_clip_only"].includes(String(body.audioPolicy))) {
      return NextResponse.json({ error: "audioPolicy must be silent | original | lead_clip_only" }, { status: 400 });
    }
    updates.audioPolicy = body.audioPolicy as "silent" | "original" | "lead_clip_only";
  }
  if (body.weight !== undefined) updates.weight = Math.max(1, Number(body.weight) || 1);
  if (body.durationTargetMin !== undefined) updates.durationTargetMin = Number(body.durationTargetMin) || 15;
  if (body.durationTargetMax !== undefined) updates.durationTargetMax = Number(body.durationTargetMax) || 30;
  if (body.enabled !== undefined) updates.enabled = body.enabled ? 1 : 0;

  db.update(videoRecipes).set(updates).where(eq(videoRecipes.id, id)).run();
  const row = db.select().from(videoRecipes).where(eq(videoRecipes.id, id)).get()!;
  return NextResponse.json({ recipe: { ...row, pattern: JSON.parse(row.patternJson) } });
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  const { id } = await params;
  const existing = db.select().from(videoRecipes).where(eq(videoRecipes.id, id)).get();
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  db.delete(videoRecipes).where(eq(videoRecipes.id, id)).run();
  return NextResponse.json({ deleted: true });
}
