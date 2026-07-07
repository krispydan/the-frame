/**
 * Scheduling + generation orchestration for the video post queue.
 *
 * Slots: 3/day (morning / midday / evening ≈ 8am / 12pm / 6pm PT —
 * advisory, since posting is manual). The unique DB index on
 * (scheduled_date, scheduled_slot) makes top-up idempotent: generating
 * the same week twice creates nothing new.
 *
 * Composition context (trends, events, clip library) loads once per
 * batch and is shared across slots for speed; the permutation-hash
 * unique index still guarantees uniqueness per insert.
 */
import { and, eq, gte, inArray, isNotNull } from "drizzle-orm";
import { db, sqlite } from "@/lib/db";
import {
  videoPosts,
  videoRecipes,
  calendarEvents,
  type CalendarEvent,
} from "@/modules/marketing/schema";
import { jobQueue } from "@/modules/core/lib/job-queue";
import { detectTrends } from "@/modules/intelligence/agents/trend-detector";
import {
  composeCandidate,
  ExhaustionError,
  type ComposerClip,
  type ComposerContext,
  type SkuSignal,
} from "./composer";

export const SLOTS = ["morning", "midday", "evening"] as const;
export type Slot = (typeof SLOTS)[number];

/** Advisory posting times shown in the UI (PT). */
export const SLOT_TIMES: Record<Slot, string> = {
  morning: "8:00am PT",
  midday: "12:00pm PT",
  evening: "6:00pm PT",
};

const HASH_ATTEMPTS = 25;

// ── Context loading ──

export function loadComposerClips(): ComposerClip[] {
  const rows = sqlite.prepare(`
    SELECT c.id, c.category_id AS categoryId, c.audio_mode AS audioMode,
           c.duration_sec AS durationSec, c.boost, c.times_used AS timesUsed,
           c.last_used_at AS lastUsedAt, cat.slug AS categorySlug
    FROM marketing_video_clips c
    JOIN marketing_video_clip_categories cat ON cat.id = c.category_id AND cat.archived = 0
    WHERE c.status = 'ready' AND c.duration_sec IS NOT NULL
  `).all() as Array<Omit<ComposerClip, "skuIds">>;

  if (rows.length === 0) return [];

  const products = sqlite.prepare(`
    SELECT clip_id AS clipId, sku_id AS skuId FROM marketing_video_clip_products
  `).all() as Array<{ clipId: string; skuId: string }>;
  const skusByClip = new Map<string, string[]>();
  for (const p of products) {
    const list = skusByClip.get(p.clipId) ?? [];
    list.push(p.skuId);
    skusByClip.set(p.clipId, list);
  }

  return rows.map((r) => ({ ...r, skuIds: skusByClip.get(r.id) ?? [] }));
}

function loadSkuSignals(): Map<string, SkuSignal> {
  const signals = new Map<string, SkuSignal>();
  try {
    const trends = detectTrends(7);
    const ranked = [...trends.trending_up, ...trends.flat, ...trends.trending_down];
    ranked.forEach((t, i) => {
      if (!t.skuId) return;
      const direction = t.direction === "up" ? "+" : t.direction === "down" ? "" : "±";
      signals.set(t.skuId, {
        skuId: t.skuId,
        momentumScore: t.momentumScore,
        trendNote:
          `${t.productName}${t.colorName ? ` (${t.colorName})` : ""}: ` +
          `#${i + 1} by units this week, ${direction}${t.growthRate.toFixed(0)}% WoW`,
      });
    });
  } catch (e) {
    // Trends are a weighting signal, not a dependency — compose without them.
    console.warn(`[video] trend detection unavailable: ${e instanceof Error ? e.message : e}`);
  }
  return signals;
}

function loadEvents(forDate: string): CalendarEvent[] {
  const horizon = new Date(new Date(forDate).getTime() + 7 * 86400000)
    .toISOString()
    .slice(0, 10);
  return db
    .select()
    .from(calendarEvents)
    .where(and(gte(calendarEvents.dateEnd, forDate)))
    .all()
    .filter((e) => e.dateStart <= horizon);
}

function loadRecentSkuFeatures(): Map<string, number> {
  const since = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
  const rows = sqlite.prepare(`
    SELECT p.ai_context AS aiContext
    FROM marketing_video_posts p
    WHERE p.status NOT IN ('discarded','failed')
      AND p.created_at >= ?
  `).all(since) as Array<{ aiContext: string | null }>;

  const counts = new Map<string, number>();
  for (const row of rows) {
    try {
      const ctx = JSON.parse(row.aiContext ?? "{}") as { focusSkuIds?: string[] };
      for (const sku of ctx.focusSkuIds ?? []) {
        counts.set(sku, (counts.get(sku) ?? 0) + 1);
      }
    } catch {
      /* ignore malformed rows */
    }
  }
  return counts;
}

export function loadComposerContext(forDate: string): ComposerContext {
  return {
    clips: loadComposerClips(),
    recipes: db.select().from(videoRecipes).where(eq(videoRecipes.enabled, 1)).all(),
    skuSignals: loadSkuSignals(),
    events: loadEvents(forDate),
    recentSkuFeatures: loadRecentSkuFeatures(),
    forDate,
  };
}

// ── Compose + insert (collision-safe) ──

export interface GeneratedPost {
  postId: string;
  recipeId: string;
  scheduledDate: string | null;
  scheduledSlot: Slot | null;
  durationSec: number;
}

/**
 * Compose a unique edit and insert its row (status=queued), retrying on
 * permutation-hash collisions. Returns null with a warning string when
 * the permutation space looks exhausted.
 */
export function composeAndInsertPost(
  ctx: ComposerContext,
  slot: { date: string; slot: Slot } | null,
): { post: GeneratedPost | null; warning?: string } {
  if (ctx.clips.length === 0) {
    return { post: null, warning: "No ready, categorized clips in the library" };
  }

  for (let attempt = 0; attempt < HASH_ATTEMPTS; attempt++) {
    const candidate = composeCandidate(ctx);
    if (!candidate) {
      return {
        post: null,
        warning:
          "No enabled recipe can be satisfied by the current clip library — upload more clips or relax recipe patterns",
      };
    }

    const id = crypto.randomUUID();
    const aiContext = JSON.stringify({
      recipeId: candidate.recipeId,
      focusSkuIds: candidate.focusSkuIds,
      // Human-readable sales-momentum lines for the caption prompt.
      trendNotes: candidate.focusSkuIds
        .map((s) => ctx.skuSignals.get(s)?.trendNote)
        .filter(Boolean),
      composedAt: new Date().toISOString(),
    });
    try {
      db.insert(videoPosts)
        .values({
          id,
          permutationHash: candidate.permutationHash,
          recipeId: candidate.recipeId,
          clipIds: JSON.stringify(candidate.clipIds),
          audibleClipIds: JSON.stringify(candidate.audibleClipIds),
          audioTreatment: candidate.audioTreatment,
          status: "queued",
          aiContext,
          scheduledDate: slot?.date ?? null,
          scheduledSlot: slot?.slot ?? null,
        })
        .run();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("UNIQUE") && msg.includes("permutation_hash")) {
        continue; // this exact edit already exists — recompose
      }
      if (msg.includes("UNIQUE") && msg.includes("idx_video_post_slot")) {
        return { post: null, warning: `Slot ${slot?.date} ${slot?.slot} already filled` };
      }
      throw e;
    }

    const jobId = jobQueue.enqueue("marketing.video.render-post", "marketing", { postId: id }, { priority: 3 });
    db.update(videoPosts).set({ renderJobId: jobId }).where(eq(videoPosts.id, id)).run();

    return {
      post: {
        postId: id,
        recipeId: candidate.recipeId,
        scheduledDate: slot?.date ?? null,
        scheduledSlot: slot?.slot ?? null,
        durationSec: candidate.durationSec,
      },
    };
  }

  throw new ExhaustionError(
    `Could not find an unused clip permutation after ${HASH_ATTEMPTS} attempts — ` +
    `the library is running out of fresh combinations. Upload more clips.`,
  );
}

// ── Queue top-up (cron + "generate next week" button) ──

export interface TopUpResult {
  created: number;
  skipped: number;
  warnings: string[];
  posts: GeneratedPost[];
}

function emptySlots(startDate: string, days: number, slotsPerDay: number): Array<{ date: string; slot: Slot }> {
  const start = new Date(startDate);
  const wanted: Array<{ date: string; slot: Slot }> = [];
  const dates: string[] = [];
  for (let d = 0; d < days; d++) {
    const date = new Date(start.getTime() + d * 86400000).toISOString().slice(0, 10);
    dates.push(date);
    for (const slot of SLOTS.slice(0, slotsPerDay)) wanted.push({ date, slot });
  }

  const taken = dates.length
    ? db
        .select({ date: videoPosts.scheduledDate, slot: videoPosts.scheduledSlot })
        .from(videoPosts)
        .where(and(inArray(videoPosts.scheduledDate, dates), isNotNull(videoPosts.scheduledSlot)))
        .all()
    : [];
  const takenKeys = new Set(taken.map((t) => `${t.date}|${t.slot}`));
  return wanted.filter((w) => !takenKeys.has(`${w.date}|${w.slot}`));
}

export function topUpVideoQueue(opts: {
  startDate?: string;
  horizonDays?: number;
  slotsPerDay?: number;
} = {}): TopUpResult {
  const startDate = opts.startDate ?? new Date().toISOString().slice(0, 10);
  const horizonDays = opts.horizonDays ?? 7;
  const slotsPerDay = Math.min(Math.max(opts.slotsPerDay ?? 3, 1), SLOTS.length);

  const slots = emptySlots(startDate, horizonDays, slotsPerDay);
  const result: TopUpResult = { created: 0, skipped: 0, warnings: [], posts: [] };
  if (slots.length === 0) return result;

  const ctx = loadComposerContext(startDate);

  for (const slot of slots) {
    try {
      const { post, warning } = composeAndInsertPost(ctx, slot);
      if (post) {
        result.created++;
        result.posts.push(post);
        // Reflect usage into the shared context so the NEXT slot's
        // recency/fairness weighting sees this pick immediately.
        const composed = db.select().from(videoPosts).where(eq(videoPosts.id, post.postId)).get();
        if (composed) {
          const ids = new Set(JSON.parse(composed.clipIds) as string[]);
          for (const clip of ctx.clips) {
            if (ids.has(clip.id)) {
              clip.timesUsed += 1;
              clip.lastUsedAt = slot.date;
            }
          }
        }
      } else {
        result.skipped++;
        if (warning && !result.warnings.includes(warning)) result.warnings.push(warning);
      }
    } catch (e) {
      if (e instanceof ExhaustionError) {
        result.skipped++;
        if (!result.warnings.includes(e.message)) result.warnings.push(e.message);
      } else {
        throw e;
      }
    }
  }

  if (result.warnings.length > 0) {
    console.warn(`[video] top-up warnings: ${result.warnings.join(" | ")}`);
  }
  return result;
}

/** Unscheduled batch — "give me N fresh videos" without slot binding. */
export function generateUnscheduled(count: number): TopUpResult {
  const ctx = loadComposerContext(new Date().toISOString().slice(0, 10));
  const result: TopUpResult = { created: 0, skipped: 0, warnings: [], posts: [] };
  for (let i = 0; i < count; i++) {
    try {
      const { post, warning } = composeAndInsertPost(ctx, null);
      if (post) {
        result.created++;
        result.posts.push(post);
      } else {
        result.skipped++;
        if (warning && !result.warnings.includes(warning)) result.warnings.push(warning);
        break; // library-level problem — more attempts won't help
      }
    } catch (e) {
      if (e instanceof ExhaustionError) {
        result.skipped++;
        if (!result.warnings.includes(e.message)) result.warnings.push(e.message);
        break;
      }
      throw e;
    }
  }
  return result;
}
