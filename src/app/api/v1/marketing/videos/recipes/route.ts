/**
 * /api/v1/marketing/videos/recipes — video styles.
 *
 * GET  — list recipes with live satisfiability + permutation headroom
 *        against the current ready library.
 * POST — create: { name, description?, pattern, audioPolicy?, weight?,
 *        durationTargetMin?, durationTargetMax?, enabled? }
 *        pattern = Array<{ categories: string[], min, max, optional? }>
 */
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { videoRecipes } from "@/modules/marketing/schema";
import { recipeSatisfiable } from "@/modules/marketing/lib/video/composer";
import { estimateRecipeHeadroom } from "@/modules/marketing/lib/video/cleanup";
import { loadComposerClips } from "@/modules/marketing/lib/video/scheduler";
import { validatePattern } from "@/modules/marketing/lib/video/recipe-validation";

export async function GET() {
  const recipes = db.select().from(videoRecipes).all();
  const clips = loadComposerClips();
  const countMap = new Map<string, number>();
  for (const clip of clips) countMap.set(clip.categorySlug, (countMap.get(clip.categorySlug) ?? 0) + 1);

  return NextResponse.json({
    recipes: recipes.map((r) => ({
      ...r,
      pattern: JSON.parse(r.patternJson),
      satisfiable: recipeSatisfiable(r, clips),
      estimatedHeadroom: estimateRecipeHeadroom(r.patternJson, countMap),
    })),
    readyClips: clips.length,
  });
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  const pattern = validatePattern(body.pattern);
  if (!pattern.ok) return NextResponse.json({ error: pattern.error }, { status: 400 });

  const audioPolicy = String(body.audioPolicy ?? "silent");
  if (!["silent", "original", "lead_clip_only"].includes(audioPolicy)) {
    return NextResponse.json({ error: "audioPolicy must be silent | original | lead_clip_only" }, { status: 400 });
  }

  const id = crypto.randomUUID();
  db.insert(videoRecipes)
    .values({
      id,
      name: body.name.trim(),
      description: typeof body.description === "string" ? body.description.trim() || null : null,
      patternJson: JSON.stringify(pattern.slots),
      audioPolicy: audioPolicy as "silent" | "original" | "lead_clip_only",
      durationTargetMin: Number(body.durationTargetMin) || 15,
      durationTargetMax: Number(body.durationTargetMax) || 30,
      weight: Math.max(1, Number(body.weight) || 1),
      enabled: body.enabled === false ? 0 : 1,
    })
    .run();

  const row = db.select().from(videoRecipes).all().find((r) => r.id === id);
  return NextResponse.json({ recipe: row }, { status: 201 });
}
