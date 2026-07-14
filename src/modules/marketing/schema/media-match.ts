/**
 * AI SKU identification for media (video clips + catalog images).
 *
 * One row per media item that's been through (or queued for) the
 * identifier. The vision model compares the media against generated
 * catalog reference sheets and proposes candidate SKUs with confidence;
 * a human confirms in the review UI and the choice is written back to
 * the media's product tags.
 */
import { sqliteTable, text, uniqueIndex, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

const id = () => text("id").primaryKey().$defaultFn(() => crypto.randomUUID());
const timestamp = (name: string) => text(name).default(sql`(datetime('now'))`);

export const mediaMatches = sqliteTable("marketing_media_matches", {
  id: id(),
  /** What kind of media this row identifies. */
  mediaType: text("media_type", { enum: ["clip", "image"] }).notNull(),
  /** marketing_video_clips.id or catalog_images.id. */
  mediaId: text("media_id").notNull(),
  /**
   * pending    — queued, model hasn't run yet
   * suggested  — candidates ready for review
   * confirmed  — a human picked the product(s); tags written
   * no_product — model (or human) says nothing identifiable is visible
   * failed     — model call errored (see error)
   */
  status: text("status", { enum: ["pending", "suggested", "confirmed", "no_product", "failed"] })
    .notNull()
    .default("pending"),
  /** JSON MatchCandidate[] — see sku-match.ts. Grouped per product. */
  candidatesJson: text("candidates_json"),
  /** JSON string[] of catalog_products ids the reviewer confirmed. */
  confirmedProductIds: text("confirmed_product_ids"),
  error: text("error"),
  /** Model id that produced the suggestion (for audit/debug). */
  model: text("model"),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
}, (table) => ({
  mediaIdx: uniqueIndex("idx_media_match_media").on(table.mediaType, table.mediaId),
  statusIdx: index("idx_media_match_status").on(table.status),
}));

export type MediaMatch = typeof mediaMatches.$inferSelect;
export type MediaMatchInsert = typeof mediaMatches.$inferInsert;
