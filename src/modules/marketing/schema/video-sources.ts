/**
 * Raw footage sources for the auto-clipper.
 *
 * A source is a long raw video from a shoot. The split job runs ffmpeg
 * scene detection over it, carves each scene into contiguous 3-5s
 * windows, and extracts every window as a clip in the normal library
 * (marketing_video_clips rows carrying this source's id + its default
 * tags). From there the clips flow through the standard pipeline:
 * normalize → ready → composable.
 */
import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

const id = () => text("id").primaryKey().$defaultFn(() => crypto.randomUUID());
const timestamp = (name: string) => text(name).default(sql`(datetime('now'))`);

export const videoSources = sqliteTable("marketing_video_sources", {
  id: id(),
  fileName: text("file_name").notNull(),
  /** sha256[:16] of the raw bytes — dedupe key + content address. */
  checksum: text("checksum").notNull().unique(),
  /** sources/{checksum}.{ext} relative to VIDEOS_PATH. */
  rawPath: text("raw_path").notNull(),
  durationSec: real("duration_sec"),
  width: integer("width"),
  height: integer("height"),
  sizeBytes: integer("size_bytes"),
  status: text("status", { enum: ["uploaded", "splitting", "done", "failed"] })
    .notNull()
    .default("uploaded"),
  /** How many clips the split produced (set when done). */
  clipCount: integer("clip_count").notNull().default(0),
  /** 1 once the raw footage file has been deleted post-split — the clips
   *  are all we keep. The row stays as a lightweight record. */
  rawDeleted: integer("raw_deleted").notNull().default(0),
  // ── Split settings ──
  minClipSec: real("min_clip_sec").notNull().default(3),
  maxClipSec: real("max_clip_sec").notNull().default(5),
  maxClips: integer("max_clips").notNull().default(40),
  // ── Defaults stamped onto every generated clip ──
  categoryId: text("category_id"),
  talent: text("talent"),
  audioMode: text("audio_mode", { enum: ["mute", "keep"] }).notNull().default("mute"),
  /** JSON string[] of catalog_skus ids. */
  skuIds: text("sku_ids"),
  error: text("error"),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
}, (table) => ({
  statusIdx: index("idx_video_source_status").on(table.status),
}));

export type VideoSource = typeof videoSources.$inferSelect;
export type VideoSourceInsert = typeof videoSources.$inferInsert;
