/**
 * Video Remix Studio — clip library schema.
 *
 * The raw material: 300+ short (5–10s) product clips, each uploaded once,
 * normalized once (1080x1920@30 cache on the volume), and reused across
 * hundreds of rendered permutations.
 *
 * Categories are USER-MANAGED rows, not a hardcoded enum — the team
 * invents shot vocabularies as they film ("in-car", "flat lay", "UGC
 * unboxing"...). Recipes (see video-posts.ts) reference category slugs
 * to define what kinds of videos get stitched together.
 */
import { sqliteTable, text, integer, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

const id = () => text("id").primaryKey().$defaultFn(() => crypto.randomUUID());
const timestamp = (name: string) => text(name).default(sql`(datetime('now'))`);

// ── Clip categories (user-managed vocabulary) ──
export const videoClipCategories = sqliteTable("marketing_video_clip_categories", {
  id: id(),
  /** Stable machine key referenced by recipe patterns (kebab/snake). */
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  /** Can a clip of this category open a video? Recipes may still
   *  override by putting any category in slot 0. */
  isHook: integer("is_hook").notNull().default(0),
  sortOrder: integer("sort_order").notNull().default(0),
  /** Archive instead of delete once clips reference it. */
  archived: integer("archived").notNull().default(0),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
});

// ── Clips ──
export const videoClips = sqliteTable("marketing_video_clips", {
  id: id(),
  fileName: text("file_name").notNull(),
  /** sha256[:16] of the raw upload bytes — dedupe key + content address. */
  checksum: text("checksum").notNull().unique(),
  /** Paths relative to VIDEOS_PATH (see src/lib/storage/videos.ts). */
  rawPath: text("raw_path").notNull(),
  normalizedPath: text("normalized_path"),
  mutedPath: text("muted_path"),
  posterPath: text("poster_path"),
  /** Duration of the NORMALIZED output (what concat math uses). */
  durationSec: real("duration_sec"),
  width: integer("width"),
  height: integer("height"),
  sizeBytes: integer("size_bytes"),
  /** Nullable = untagged; untagged clips never enter the composer. */
  categoryId: text("category_id"),
  /**
   * "Is this clip's audio worth keeping" (unboxing sounds, voiceover).
   * Whether it's actually USED is the recipe audioPolicy's decision.
   */
  audioMode: text("audio_mode", { enum: ["mute", "keep"] }).notNull().default("mute"),
  status: text("status", { enum: ["uploaded", "normalizing", "ready", "failed", "archived"] })
    .notNull()
    .default("uploaded"),
  /** Manual "use me more" lever: 0 = normal, 1 = boosted, 2 = heavy. */
  boost: integer("boost").notNull().default(0),
  timesUsed: integer("times_used").notNull().default(0),
  lastUsedAt: text("last_used_at"),
  /** Normalization profile version — never mix versions in one concat. */
  normVersion: integer("norm_version").notNull().default(1),
  error: text("error"),
  notes: text("notes"),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
}, (table) => ({
  statusIdx: index("idx_video_clip_status").on(table.status),
  categoryIdx: index("idx_video_clip_category").on(table.categoryId),
}));

// ── Clip ↔ SKU (products visible in the clip) ──
// SKU-level (not product-level) so weighting can join the trend
// detector, which keys on order_items.sku_id.
export const videoClipProducts = sqliteTable("marketing_video_clip_products", {
  id: id(),
  clipId: text("clip_id").notNull(),
  skuId: text("sku_id").notNull(),
  createdAt: timestamp("created_at"),
}, (table) => ({
  clipSkuUnique: uniqueIndex("idx_clip_product_unique").on(table.clipId, table.skuId),
  skuIdx: index("idx_clip_product_sku").on(table.skuId),
}));

export type VideoClipCategory = typeof videoClipCategories.$inferSelect;
export type VideoClip = typeof videoClips.$inferSelect;
export type VideoClipInsert = typeof videoClips.$inferInsert;
export type VideoClipProduct = typeof videoClipProducts.$inferSelect;
