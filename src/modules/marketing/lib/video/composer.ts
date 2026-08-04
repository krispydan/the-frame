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
  /**
   * True when a human explicitly marked this clip "no product visible" in
   * the SKU identifier (a confirmed-empty match). Distinct from UNTAGGED
   * (never identified) — an untagged clip may secretly contain a product,
   * so it can't be used as safe glue in a product-focused video.
   */
  noProductConfirmed?: boolean;
  /**
   * Whether this clip's video type shows the product on screen (from the
   * category's operator-owned flag). Undefined falls back to the legacy
   * slug list — see showsProduct().
   */
  isProductShot?: boolean;
}

/**
 * Clips eligible for a video with these focus SKUs. When the video is
 * ABOUT a product (focus non-empty), only include clips that feature ONLY
 * focus products, plus clips confirmed to contain no product — so the
 * caption's product claim can never contradict what's on screen. Untagged
 * (unknown) clips and other-product clips are excluded. No focus → no
 * restriction (a generic video can mix anything).
 */
export function eligibleForFocus(clips: ComposerClip[], focusSkuIds: string[]): ComposerClip[] {
  if (focusSkuIds.length === 0) return clips;
  const focus = new Set(focusSkuIds);
  return clips.filter((c) => {
    if (c.skuIds.length > 0) return c.skuIds.every((s) => focus.has(s));
    return c.noProductConfirmed === true;
  });
}

/**
 * Fallback list of categories that show the product, used ONLY when a
 * clip carries no `isProductShot` flag (unseeded data, or a fixture).
 * The real source of truth is the per-category flag operators own — a
 * hardcoded list can't know about categories the team invents later
 * (product-showcase, try-on-haul, …).
 */
export const PRODUCT_SHOWING_CATEGORIES = new Set([
  "flat_lay", "on_model", "detail", "lifestyle", "in_car",
]);

/**
 * Does this clip actually show the product on screen — as opposed to
 * unboxing the box, packaging, atmosphere b-roll, or a text outro? A
 * video with none of these shows everything BUT the product (the
 * "unboxing over and over, no actual product" failure), so every
 * composed video must contain at least one.
 */
export function showsProduct(clip: ComposerClip): boolean {
  if (typeof clip.isProductShot === "boolean") return clip.isProductShot;
  return PRODUCT_SHOWING_CATEGORIES.has(clip.categorySlug);
}

export function hasProductPresence(seq: ComposerClip[]): boolean {
  return seq.some(showsProduct);
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

  // A product-focused video may only draw from focus-product + confirmed
  // no-product clips (never other-product or untagged/unknown ones).
  const eligible = eligibleForFocus(ctx.clips, focusSkuIds);

  for (const slot of slots) {
    const pool = () =>
      eligible.filter(
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

      // Product coverage: on the LAST chance to include one, if the video
      // still shows no product and this slot can supply one, force it —
      // so we never ship a video that never shows the frames.
      const isLastPick = slot === slots[slots.length - 1] && taken === target - 1;
      if (isLastPick && !hasProductPresence(seq)) {
        const showing = candidates.filter(showsProduct);
        if (showing.length > 0) candidates = showing;
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
  // Reject a product-less edit (all unboxing / packaging / b-roll) — the
  // caller falls back to freestyle (which guarantees a product shot) or
  // recomposes. Better no video than one that never shows the product.
  if (!hasProductPresence(seq)) return null;
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

/**
 * Identity of a permutation — the UNIQUE key that stops us building the
 * same video twice.
 *
 * Trims are part of that identity: the same three clips cut 1.0–2.5 make
 * a different video from the same three cut 3.0–4.0, and without them in
 * the hash the second one 409s against the first.
 *
 * The trim segment is APPENDED and only when something is actually
 * trimmed, so every already-stored hash (all of which are untrimmed)
 * still matches — no rehash migration, no orphaned rows.
 */
export function permutationHash(
  recipeId: string,
  clipIds: string[],
  audioTreatment: string,
  clipTrims?: Array<{ inSec: number; outSec: number } | null>,
): string {
  const base = `${recipeId}|${clipIds.join("|")}|a=${audioTreatment}|v${PERMUTATION_VERSION}`;
  const trimPart = clipTrims?.some(Boolean)
    ? `|t=${clipTrims.map((t) => (t ? `${t.inSec.toFixed(3)}-${t.outSec.toFixed(3)}` : "")).join(",")}`
    : "";
  return createHash("sha256").update(base + trimPart).digest("hex");
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

  let focusSkuIds = pickFocusSkus(ctx, rand);
  // Same product-coherence rule as buildSequence: a focused video only
  // uses focus-product + confirmed no-product clips. If that pool is too
  // thin to build anything, drop the focus and make a GENERIC video (no
  // product claim) rather than dead-ending or lying in the caption.
  let eligible = eligibleForFocus(ctx.clips, focusSkuIds);
  if (eligible.length < 2) {
    focusSkuIds = [];
    eligible = ctx.clips;
  }
  // A freestyle mix must still show the product — if nothing in the pool
  // does, there's no good video to make here.
  if (!eligible.some(showsProduct)) return null;

  const used = new Set<string>();
  const seq: ComposerClip[] = [];
  const catCounts = new Map<string, number>();
  let duration = 0;
  // No single category may dominate — this is what stops "unboxing over
  // and over". At most half the clips (min 2) from any one category.
  const catCap = Math.max(2, Math.ceil(FALLBACK_MAX_CLIPS / 2));

  while (seq.length < FALLBACK_MAX_CLIPS) {
    const withinBudget = eligible.filter(
      (c) => !used.has(c.id) && duration + (c.durationSec ?? 0) <= FALLBACK_MAX_DURATION,
    );
    // Never fail to reach the 2-clip minimum just to honor the duration cap.
    let candidates = withinBudget.length > 0 || seq.length >= 2
      ? withinBudget
      : eligible.filter((c) => !used.has(c.id));
    if (candidates.length === 0) break;

    // Anti-monotony: drop categories already at the cap (unless nothing
    // else is left).
    const notCapped = candidates.filter((c) => (catCounts.get(c.categorySlug) ?? 0) < catCap);
    if (notCapped.length > 0) candidates = notCapped;

    // Variety: avoid repeating the previous clip's category when we can.
    const prev = seq[seq.length - 1];
    if (prev) {
      const varied = candidates.filter((c) => c.categorySlug !== prev.categorySlug);
      if (varied.length > 0) candidates = varied;
    }

    // Guarantee a product shot: seed the first pick with a product-showing
    // clip, and force one on the last pick if we still have none.
    const needProduct =
      !hasProductPresence(seq) && (seq.length === 0 || seq.length === FALLBACK_MAX_CLIPS - 1);
    if (needProduct) {
      const showing = candidates.filter(showsProduct);
      if (showing.length > 0) candidates = showing;
    }

    const pick = weightedPick(candidates, (c) => clipWeight(c, focusSkuIds, ctx.forDate), rand);
    if (!pick) break;
    seq.push(pick);
    used.add(pick.id);
    catCounts.set(pick.categorySlug, (catCounts.get(pick.categorySlug) ?? 0) + 1);
    duration += pick.durationSec ?? 0;
    // Once it's a reasonable length, sometimes stop for variety across posts
    // — but only once the product is actually on screen.
    if (seq.length >= 3 && duration >= 12 && hasProductPresence(seq) && rand() < 0.4) break;
  }

  if (seq.length < 2 || !hasProductPresence(seq)) return null;

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
