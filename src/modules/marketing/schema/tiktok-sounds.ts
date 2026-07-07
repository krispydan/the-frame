/**
 * TikTok trending sounds — synced from the Apify actor
 * novi~tiktok-music-trend-api (which relays TikTok Creative Center's
 * trending music charts).
 *
 * Each sync replaces the snapshot for its (countryCode, rankType)
 * slice. The AI caption generator reads the current chart and names
 * 2-3 concrete sounds per post; the queue UI links straight to them
 * so whoever posts can grab the sound in the TikTok app.
 *
 * `raw` keeps the full actor item verbatim — actor field names have
 * been known to drift across revisions, so nothing is thrown away
 * even when the mapped columns miss something.
 */
import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

const id = () => text("id").primaryKey().$defaultFn(() => crypto.randomUUID());

export const tiktokSounds = sqliteTable("marketing_tiktok_sounds", {
  id: id(),
  /** TikTok song/clip id from the actor — stable across syncs. */
  externalId: text("external_id").notNull(),
  title: text("title").notNull(),
  author: text("author"),
  coverUrl: text("cover_url"),
  /** Link to the sound on TikTok (Creative Center or music page). */
  tiktokLink: text("tiktok_link"),
  durationSec: real("duration_sec"),
  /** 1 = hottest. */
  rank: integer("rank"),
  /** Rank movement vs the prior chart (positive = climbing). */
  rankDiff: integer("rank_diff"),
  /** up | down | flat | new — derived from rankDiff/diff type. */
  trendDirection: text("trend_direction"),
  /** How many videos/creators used the sound, when the actor exposes it. */
  usageCount: integer("usage_count"),
  countryCode: text("country_code").notNull().default("US"),
  /** popular (established chart) | breakout (surging). */
  rankType: text("rank_type").notNull().default("popular"),
  isPromoted: integer("is_promoted").notNull().default(0),
  /** Verbatim actor item JSON. */
  raw: text("raw"),
  syncedAt: text("synced_at").default(sql`(datetime('now'))`),
}, (table) => ({
  chartIdx: index("idx_tiktok_sound_chart").on(table.countryCode, table.rankType, table.rank),
  externalIdx: index("idx_tiktok_sound_external").on(table.externalId),
}));

export type TiktokSound = typeof tiktokSounds.$inferSelect;
export type TiktokSoundInsert = typeof tiktokSounds.$inferInsert;
