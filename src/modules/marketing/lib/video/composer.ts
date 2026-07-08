/**
 * The composer — turns the clip library into a unique video edit.
 *
 * Flow per posting slot:
 *   1. Pick a recipe (video style) — weighted random over enabled
 *      recipes the current library can actually satisfy.
 *   2. Pick 1–2 focus SKUs — weighted by sales momentum (trend
 *      detector), active/upcoming calendar events, boost flags, and
 *      coverage debt (SKUs we haven't featured lately).
 *   3. Fill the recipe's category pattern with clips, weighted toward
 *      the focus SKUs, away from recently-used clips, with long-run
 *      fairness so the whole library gets exercised.
 *   4. Resolve audio (recipe policy × clip keep-flags).
 *   5. Hash the ordered result. The caller inserts against the DB's
 *      UNIQUE permutation_hash — a collision means "this exact edit
 *      exists", so we recompose (up to maxAttempts) before declaring
 *      the permutation space exhausted.
 *
 * Everything here is deterministic given an injected RNG — unit tests
 * pin sequences by seeding `rand`.
 */
import { createHash } from "crypto";
import type { VideoClip, VideoRecipe, RecipeSlot, CalendarEvent } from "@/modules/marketing/schema";

// ── Types ──

export interface ComposerClip extends Pick<
  VideoClip,
  "id" | "categoryId" | "audioMode" | "durationSec" | "boost" | "timesUsed" | "lastUsedAt"
> {
  /** Category slug (joined from marketing_video_clip_categories). */
  categorySlug: string;
  /** SKU ids tagged on the clip. */
  skuIds: string[];
}

export interface SkuSignal {
  skuId: string;
  /** -100..100 from the trend detector (0 when unknown). */
  momentumScore: number;
  /** Human-readable line for the AI context ("#1 seller, +43% WoW"). */
  trendNote?: string;
}

export interface ComposerContext {
  /** status=ready clips with category + product joins preloaded. */
  clips: ComposerClip[];
  recipes: VideoRecipe[];
  skuSignals: Map<string, SkuSignal>;
  /** Events whose window touches [date, date+7d]. */
  events: CalendarEvent[];
  /** skuId → # of posts featuring it in the last 14 days. */
  recentSkuFeatures: Map<string, number>;
  /** ISO date the post is for (recency math anchors here). */
  forDate: string;
  rand?: () => number;
}

export interface ComposedPost {
  recipeId: string;
  clipIds: string[];
  audibleClipIds: string[];
  audioTreatment: "silent" | "partial" | "full";
  permutationHash: string;
  focusSkuIds: string[];
  durationSec: number;
}

export class ExhaustionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExhaustionError";
  }
}

export const PERMUTATION_VERSION = 1;

// ── Weighted sampling ──

function weightedPick<T>(items: T[], weightOf: (item: T) => number, rand: () => number): T | null {
  let total = 0;
  const weights = items.map((i) => {
    const w = Math.max(weightOf(i), 0);
    total += w;
    return w;
  });
  if (total <= 0) return null;
  let roll = rand() * total;
  for (let i = 0; i < items.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return items[i];
  }
  return items[items.length - 1];
}

// ── Focus SKU selection ──

const RECENT_FEATURE_WINDOW_MAX = 4; // features/14d at which coverage debt hits 0

export function scoreSku(
  skuId: string,
  ctx: Pick<ComposerContext, "skuSignals" | "events" | "recentSkuFeatures" | "clips">,
): number {
  let score = 1.0;

  const signal = ctx.skuSignals.get(skuId);
  if (signal) score += 0.02 * signal.momentumScore; // [-2 .. +2]

  for (const event of ctx.events) {
    const eventSkus = (event.productSkus ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (eventSkus.includes(skuId)) {
      score += 1.5 * (2 - Math.min(event.priority, 2)); // priority 1 → +1.5, 2+ → +0
      score += 0.75; // being on ANY active event still matters
    }
  }

  if (ctx.clips.some((c) => c.skuIds.includes(skuId) && c.boost > 0)) score += 1.0;

  const recentFeatures = ctx.recentSkuFeatures.get(skuId) ?? 0;
  score += Math.max(0, 1 - recentFeatures / RECENT_FEATURE_WINDOW_MAX); // coverage debt

  return Math.max(score, 0.05);
}

export function pickFocusSkus(ctx: ComposerContext, rand: () => number): string[] {
  const allSkus = [...new Set(ctx.clips.flatMap((c) => c.skuIds))];
  if (allSkus.length === 0) return [];

  const picked: string[] = [];
  const pool = [...allSkus];
  const count = allSkus.length === 1 ? 1 : rand() < 0.35 ? 2 : 1;
  for (let i = 0; i < count && pool.length > 0; i++) {
    const sku = weightedPick(pool, (s) => scoreSku(s, ctx), rand);
    if (!sku) break;
    picked.push(sku);
    pool.splice(pool.indexOf(sku), 1);
  }
  return picked;
}

// ── Clip weighting ──

const RECENT_CLIP_DAYS = 5;

export function clipWeight(clip: ComposerClip, focusSkuIds: string[], forDate: string): number {
  let w = 1.0;

  w *= 1 + 0.5 * clip.boost;

  if (clip.skuIds.length > 0) {
    w *= clip.skuIds.some((s) => focusSkuIds.includes(s)) ? 2.0 : 0.6;
  }
  // untagged clips (b-roll glue) stay neutral

  if (clip.lastUsedAt) {
    const daysSince =
      (new Date(forDate).getTime() - new Date(clip.lastUsedAt).getTime()) / 86400000;
    if (daysSince >= 0 && daysSince < RECENT_CLIP_DAYS) w *= 0.15; // soft recency ban
  }

  w *= 1 / (1 + clip.timesUsed / 20); // long-run fairness

  return w;
}

// ── Recipe satisfiability + selection ──

export function parsePattern(recipe: VideoRecipe): RecipeSlot[] {
  const slots = JSON.parse(recipe.patternJson) as RecipeSlot[];
  if (!Array.isArray(slots) || slots.length === 0) {
    throw new Error(`Recipe ${recipe.id} has an empty pattern`);
  }
  return slots;
}

/** Can the library fill every required slot of this recipe? */
export function recipeSatisfiable(recipe: VideoRecipe, clips: ComposerClip[]): boolean {
  try {
    const slots = parsePattern(recipe);
    // Clips can't repeat within a video, so required minimums must be
    // met by DISTINCT clips. Greedy per-slot count check (categories may
    // overlap between slots; this is an optimistic but cheap bound).
    const available = new Map<string, number>();
    for (const clip of clips) {
      available.set(clip.categorySlug, (available.get(clip.categorySlug) ?? 0) + 1);
    }
    for (const slot of slots) {
      if (slot.optional || slot.min === 0) continue;
      const pool = slot.categories.reduce((sum, cat) => sum + (available.get(cat) ?? 0), 0);
      if (pool < slot.min) return false;
      // Consume the minimum from the pool so later slots can't reuse them.
      let toConsume = slot.min;
      for (const cat of slot.categories) {
        const take = Math.min(available.get(cat) ?? 0, toConsume);
        available.set(cat, (available.get(cat) ?? 0) - take);
        toConsume -= take;
        if (toConsume === 0) break;
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function pickRecipe(ctx: ComposerContext, rand: () => number): VideoRecipe | null {
  const candidates = ctx.recipes.filter(
    (r) => r.enabled === 1 && recipeSatisfiable(r, ctx.clips),
  );
  return weightedPick(candidates, (r) => Math.max(r.weight, 0.01), rand);
}

// ── Sequence building ──

function buildSequence(
  recipe: VideoRecipe,
  ctx: ComposerContext,
  focusSkuIds: string[],
  rand: () => number,
): { clipIds: string[]; durationSec: number } | null {
  const slots = parsePattern(recipe);
  const used = new Set<string>();
  const seq: ComposerClip[] = [];
  let duration = 0;
  const maxDur = recipe.durationTargetMax;

  for (const slot of slots) {
    const pool = () =>
      ctx.clips.filter(
        (c) => !used.has(c.id) && slot.categories.includes(c.categorySlug),
      );

    // How many from this slot? Random within [min, max], but stop early
    // if duration would blow past the target.
    const target = slot.min + Math.floor(rand() * (slot.max - slot.min + 1));
    let taken = 0;

    while (taken < target) {
      let candidates = pool().filter(
        (c) => duration + (c.durationSec ?? 0) <= maxDur,
      );
      // Never sacrifice a required minimum to the duration cap — a
      // slightly long video beats an invalid one.
      if (candidates.length === 0 && taken < slot.min) candidates = pool();
      if (candidates.length === 0) break;

      // Variety: avoid same-category back-to-back within multi-category
      // slots when alternatives exist.
      const prev = seq[seq.length - 1];
      if (prev && slot.categories.length > 1) {
        const varied = candidates.filter((c) => c.categorySlug !== prev.categorySlug);
        if (varied.length > 0) candidates = varied;
      }

      // Focus coverage: if no focus clip picked yet and this slot offers
      // one, restrict to focus-tagged clips.
      if (
        focusSkuIds.length > 0 &&
        !seq.some((c) => c.skuIds.some((s) => focusSkuIds.includes(s)))
      ) {
        const focusClips = candidates.filter((c) =>
          c.skuIds.some((s) => focusSkuIds.includes(s)),
        );
        if (focusClips.length > 0) candidates = focusClips;
      }

      const pick = weightedPick(candidates, (c) => clipWeight(c, focusSkuIds, ctx.forDate), rand);
      if (!pick) break;
      seq.push(pick);
      used.add(pick.id);
      duration += pick.durationSec ?? 0;
      taken++;
    }

    if (taken < slot.min && !slot.optional) return null; // couldn't satisfy
  }

  if (duration < recipe.durationTargetMin || seq.length < 2) return null;
  return { clipIds: seq.map((c) => c.id), durationSec: duration };
}

// ── Audio resolution ──

export function resolveAudio(
  recipe: VideoRecipe,
  clipIds: string[],
  clipsById: Map<string, ComposerClip>,
): { audibleClipIds: string[]; audioTreatment: "silent" | "partial" | "full" } {
  let audible: string[] = [];
  if (recipe.audioPolicy === "original") {
    audible = clipIds.filter((id) => clipsById.get(id)?.audioMode === "keep");
  } else if (recipe.audioPolicy === "lead_clip_only") {
    if (clipsById.get(clipIds[0])?.audioMode === "keep") audible = [clipIds[0]];
  }
  const audioTreatment =
    audible.length === 0 ? "silent" : audible.length === clipIds.length ? "full" : "partial";
  return { audibleClipIds: audible, audioTreatment };
}

// ── Hash ──

export function permutationHash(
  recipeId: string,
  clipIds: string[],
  audioTreatment: string,
): string {
  return createHash("sha256")
    .update(`${recipeId}|${clipIds.join("|")}|a=${audioTreatment}|v${PERMUTATION_VERSION}`)
    .digest("hex");
}

// ── Fallback ("freestyle") compose ──

/** Marker recipe id for posts built by the no-recipe fallback. */
export const FALLBACK_RECIPE_ID = "__freestyle__";

const FALLBACK_MAX_DURATION = 30;
const FALLBACK_MAX_CLIPS = 8;

/**
 * Build an edit WITHOUT a recipe pattern — just string together available
 * ready clips (still weighted by focus SKU / boost / fairness). This is the
 * safety net so generation never dead-ends when the library exists but
 * matches no enabled recipe (e.g. everything landed in one category, or the
 * recipes want categories you haven't filled yet). Needs ≥2 ready clips.
 */
export function composeFallback(ctx: ComposerContext, rand: () => number): ComposedPost | null {
  if (ctx.clips.length < 2) return null;

  const focusSkuIds = pickFocusSkus(ctx, rand);
  const used = new Set<string>();
  const seq: ComposerClip[] = [];
  let duration = 0;

  while (seq.length < FALLBACK_MAX_CLIPS) {
    let candidates = ctx.clips.filter(
      (c) => !used.has(c.id) && duration + (c.durationSec ?? 0) <= FALLBACK_MAX_DURATION,
    );
    // Never fail to reach the 2-clip minimum just to honor the duration cap.
    if (candidates.length === 0) {
      if (seq.length < 2) candidates = ctx.clips.filter((c) => !used.has(c.id));
      if (candidates.length === 0) break;
    }
    const pick = weightedPick(candidates, (c) => clipWeight(c, focusSkuIds, ctx.forDate), rand);
    if (!pick) break;
    seq.push(pick);
    used.add(pick.id);
    duration += pick.durationSec ?? 0;
    // Once it's a reasonable length, sometimes stop for variety across posts.
    if (seq.length >= 3 && duration >= 12 && rand() < 0.4) break;
  }

  if (seq.length < 2) return null;

  const clipIds = seq.map((c) => c.id);
  const clipsById = new Map(ctx.clips.map((c) => [c.id, c]));
  // Use each clip's own audio preference (mirrors the "original" policy).
  const audibleClipIds = clipIds.filter((id) => clipsById.get(id)?.audioMode === "keep");
  const audioTreatment =
    audibleClipIds.length === 0 ? "silent" : audibleClipIds.length === clipIds.length ? "full" : "partial";

  return {
    recipeId: FALLBACK_RECIPE_ID,
    clipIds,
    audibleClipIds,
    audioTreatment,
    permutationHash: permutationHash(FALLBACK_RECIPE_ID, clipIds, audioTreatment),
    focusSkuIds,
    durationSec: duration,
  };
}

// ── Top-level compose ──

/**
 * Produce ONE candidate edit. Prefers a real recipe; when none can be
 * satisfied (or the picked one can't build this attempt) it falls back to
 * a freestyle mix of available clips so generation never dead-ends. Returns
 * null only when the library truly can't make a video (< 2 ready clips).
 * The caller owns hash-collision retries (it sees the DB).
 */
export function composeCandidate(ctx: ComposerContext): ComposedPost | null {
  const rand = ctx.rand ?? Math.random;

  const recipe = pickRecipe(ctx, rand);
  if (recipe) {
    const focusSkuIds = pickFocusSkus(ctx, rand);
    const sequence = buildSequence(recipe, ctx, focusSkuIds, rand);
    if (sequence) {
      const clipsById = new Map(ctx.clips.map((c) => [c.id, c]));
      const { audibleClipIds, audioTreatment } = resolveAudio(recipe, sequence.clipIds, clipsById);
      return {
        recipeId: recipe.id,
        clipIds: sequence.clipIds,
        audibleClipIds,
        audioTreatment,
        permutationHash: permutationHash(recipe.id, sequence.clipIds, audioTreatment),
        focusSkuIds,
        durationSec: sequence.durationSec,
      };
    }
  }

  // No satisfiable recipe (or it couldn't build this attempt) → freestyle.
  return composeFallback(ctx, rand);
}
