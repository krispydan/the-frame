/**
 * Video Remix Studio — recipes (video styles) + generated posts.
 *
 * A RECIPE is a named video style: an ordered pattern of clip-category
 * slots plus an audio policy. Examples:
 *   "Flat-lay compilation"  → [{categories:["flat_lay"], min:4, max:6}], silent
 *   "UGC unboxing"          → [{categories:["ugc_unboxing"], min:1, max:1},
 *                              {categories:["broll"], min:2, max:3}], original
 * The composer picks a weighted recipe per posting slot, fills the
 * pattern with clips (weighted by best sellers / calendar events /
 * boosts), and the permutation hash guarantees no two generated videos
 * are ever identical.
 *
 * A POST is one rendered permutation bound to a posting slot, carrying
 * the AI caption + hashtags + manual posting instructions (trending
 * audio and on-screen text get added in the TikTok/IG apps).
 */
import { sqliteTable, text, integer, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

const id = () => text("id").primaryKey().$defaultFn(() => crypto.randomUUID());
const timestamp = (name: string) => text(name).default(sql`(datetime('now'))`);

// ── Recipes (video styles) ──
export const videoRecipes = sqliteTable("marketing_video_recipes", {
  id: id(),
  name: text("name").notNull(),
  description: text("description"),
  /**
   * Ordered slots: JSON Array<{ categories: string[] (slugs, any-of);
   * min: number; max: number; optional?: boolean }>.
   * Slot 0 opens the video.
   */
  patternJson: text("pattern_json").notNull(),
  /**
   * silent          → strip all audio (trending audio added in TikTok)
   * original        → keep audio of clips flagged audioMode=keep, mute rest
   * lead_clip_only  → first clip audible (if flagged keep), mute rest
   */
  audioPolicy: text("audio_policy", { enum: ["silent", "original", "lead_clip_only"] })
    .notNull()
    .default("silent"),
  durationTargetMin: real("duration_target_min").notNull().default(15),
  durationTargetMax: real("duration_target_max").notNull().default(30),
  /** Relative frequency in the daily mix (weighted-random pick). */
  weight: integer("weight").notNull().default(1),
  enabled: integer("enabled").notNull().default(1),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
});

// ── Generated posts ──
export const videoPosts = sqliteTable("marketing_video_posts", {
  id: id(),
  /**
   * sha256 of recipeId + ordered clip ids + audio treatment + version.
   * UNIQUE — the DB, not application code, guarantees we never publish
   * the same video twice (survives concurrent generate calls).
   */
  permutationHash: text("permutation_hash").notNull().unique(),
  recipeId: text("recipe_id"),
  /** JSON string[] of clip ids — ORDER MATTERS (it's the edit). */
  clipIds: text("clip_ids").notNull(),
  status: text("status", {
    enum: ["queued", "rendering", "rendered", "ready", "posted", "failed", "discarded"],
  }).notNull().default("queued"),
  /** renders/{YYYY-MM}/{id}.mp4|.jpg — relative to VIDEOS_PATH. */
  filePath: text("file_path"),
  posterPath: text("poster_path"),
  durationSec: real("duration_sec"),
  sizeBytes: integer("size_bytes"),
  /**
   * Resolved audio outcome: silent (no audio track), partial (some
   * clips audible), full (all audible). Drives the AI's posting
   * instructions ("add trending audio" vs "keep original sound").
   */
  audioTreatment: text("audio_treatment", { enum: ["silent", "partial", "full"] })
    .notNull()
    .default("silent"),
  /** JSON string[] of clip ids whose ORIGINAL audio is audible. */
  audibleClipIds: text("audible_clip_ids"),
  caption: text("caption"),
  /** JSON string[]. */
  hashtags: text("hashtags"),
  /** JSON PostingInstructions — see video-ai.ts. */
  instructions: text("instructions"),
  /** JSON snapshot of what the composer/AI saw (recipe, focus SKUs,
   *  trends, events) — audit trail for "why this video". */
  aiContext: text("ai_context"),
  platform: text("platform", { enum: ["tiktok", "instagram", "both"] })
    .notNull()
    .default("both"),
  scheduledDate: text("scheduled_date"), // YYYY-MM-DD
  scheduledSlot: text("scheduled_slot", { enum: ["morning", "midday", "evening"] }),
  postedAt: text("posted_at"),
  renderJobId: text("render_job_id"),
  error: text("error"),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
}, (table) => ({
  statusIdx: index("idx_video_post_status").on(table.status),
  schedIdx: index("idx_video_post_sched").on(table.scheduledDate),
  // One live post per slot. Discard/reschedule must NULL the slot pair
  // so the slot can refill (SQLite treats NULLs as distinct here).
  slotUnique: uniqueIndex("idx_video_post_slot").on(table.scheduledDate, table.scheduledSlot),
}));

export type VideoRecipe = typeof videoRecipes.$inferSelect;
export type VideoPost = typeof videoPosts.$inferSelect;
export type VideoPostInsert = typeof videoPosts.$inferInsert;

/** Parsed shape of videoRecipes.patternJson. */
export interface RecipeSlot {
  categories: string[];
  min: number;
  max: number;
  optional?: boolean;
}
