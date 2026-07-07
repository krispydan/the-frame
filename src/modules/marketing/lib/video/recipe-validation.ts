/**
 * Recipe pattern validation — shared by the recipes create/update routes.
 * Checks slot shape and that every referenced category slug exists.
 */
import { sqlite } from "@/lib/db";
import type { RecipeSlot } from "@/modules/marketing/schema";

export function validatePattern(
  pattern: unknown,
): { ok: true; slots: RecipeSlot[] } | { ok: false; error: string } {
  if (!Array.isArray(pattern) || pattern.length === 0) {
    return { ok: false, error: "pattern must be a non-empty array of slots" };
  }
  const knownSlugs = new Set(
    (sqlite
      .prepare(`SELECT slug FROM marketing_video_clip_categories WHERE archived = 0`)
      .all() as Array<{ slug: string }>).map((r) => r.slug),
  );
  for (const [i, slot] of (pattern as Array<{ categories?: unknown; min?: unknown; max?: unknown }>).entries()) {
    if (!Array.isArray(slot?.categories) || slot.categories.length === 0) {
      return { ok: false, error: `Slot ${i + 1}: categories is required` };
    }
    for (const cat of slot.categories) {
      if (!knownSlugs.has(String(cat))) {
        return { ok: false, error: `Slot ${i + 1}: unknown category '${cat}'` };
      }
    }
    const min = Number(slot.min);
    const max = Number(slot.max);
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < 1 || min > max) {
      return { ok: false, error: `Slot ${i + 1}: need integers 0 <= min <= max, max >= 1` };
    }
  }
  return { ok: true, slots: pattern as RecipeSlot[] };
}
