/**
 * Ad Studio — generated Meta ad creatives.
 *
 * An AD is one creative: a recipe (code-registered layout, see
 * lib/ads/recipes.ts) + inputs (background media, SKU on the card, copy
 * variant) + per-ratio layout overrides from the canvas editor. Each ad
 * renders once per enabled aspect ratio; a RENDER row is one output file
 * in R2. The generated `name` follows the ad-naming convention
 * (lib/ads/ad-naming.ts) and is used verbatim as the ad name in Meta
 * Ads Manager — the name IS the performance-tracking key, so it is
 * immutable once published (edits bump `version` instead).
 *
 * Full scope + decisions: docs/ads-studio-plan.md.
 */
import { sqliteTable, text, integer, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

const id = () => text("id").primaryKey().$defaultFn(() => crypto.randomUUID());
const timestamp = (name: string) => text(name).default(sql`(datetime('now'))`);

// ── Copy variants ──
// Small shared pool (C01, C02, …) so the naming convention can encode
// which copy an ad ran with. C00 = no copy and has no row here.
export const adCopyVariants = sqliteTable("marketing_ad_copy", {
  id: id(),
  /** Convention code: 'C01', 'C02', … — unique, assigned sequentially. */
  code: text("code").notNull().unique(),
  primaryText: text("primary_text").notNull(),
  headline: text("headline"),
  description: text("description"),
  notes: text("notes"),
  createdAt: timestamp("created_at"),
});

// ── Ads ──
export const ads = sqliteTable("marketing_ads", {
  id: id(),
  /**
   * Generated, convention-shaped, unique:
   *   JX_{RECIPE}_{FMT}_{PRODUCT}-{COLOR}_{MODEL}_{COPY}_{vNN}
   * Never hand-edited; regenerated only when version bumps.
   */
  name: text("name").notNull().unique(),
  /** Recipe registry slug — 'pcard' first. */
  recipe: text("recipe").notNull(),
  kind: text("kind", { enum: ["video", "image", "carousel"] }).notNull(),
  /** Where the background media comes from. */
  backgroundType: text("background_type", { enum: ["clip", "catalog_image", "upload"] }).notNull(),
  /** clip id | catalog_images id | R2 key, per backgroundType. */
  backgroundRef: text("background_ref").notNull(),
  /** SKU shown on the product card. */
  skuId: text("sku_id").notNull(),
  /** Catalog image on the card; null → best front image resolved at render. */
  cardImageId: text("card_image_id"),
  /** Card text if not the product's catalog name; '' hides the name. */
  displayNameOverride: text("display_name_override"),
  /** Optional text drawn on the media itself (outside the card). */
  headline: text("headline"),
  /** Denormalized from the clip at creation ('none' for image bgs). */
  talent: text("talent").notNull().default("none"),
  /** 'C00' (no copy) or adCopyVariants.code. */
  copyVariant: text("copy_variant").notNull().default("C00"),
  /**
   * Canvas-editor state: JSON { [ratio]: { cardX, cardY, cardScale,
   * bgOffsetX, bgOffsetY, headlineX?, headlineY? } }, all coordinates
   * normalized 0–1 of frame width/height so the browser preview and the
   * server render consume identical numbers. Absent ratio → recipe
   * defaults.
   */
  layoutOverrides: text("layout_overrides"),
  /** JSON string[] of enabled ratios, e.g. ["4x5","1x1","9x16"]. */
  ratios: text("ratios").notNull().default('["4x5","1x1","9x16"]'),
  status: text("status", {
    enum: ["draft", "rendering", "ready", "published", "archived", "failed"],
  }).notNull().default("draft"),
  /** Bumps when a published ad is edited; part of the name. */
  version: integer("version").notNull().default(1),
  error: text("error"),
  publishedAt: text("published_at"),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
}, (t) => [
  index("idx_ads_status").on(t.status),
  index("idx_ads_sku").on(t.skuId),
  index("idx_ads_recipe").on(t.recipe),
]);

// ── Renders (ad × ratio = one file) ──
export const adRenders = sqliteTable("marketing_ad_renders", {
  id: id(),
  adId: text("ad_id").notNull(),
  ratio: text("ratio", { enum: ["1x1", "4x5", "9x16", "16x9"] }).notNull(),
  kind: text("kind", { enum: ["video", "image"] }).notNull(),
  /** R2 object key under ads/ (media facade). */
  r2Key: text("r2_key"),
  posterKey: text("poster_key"),
  width: integer("width"),
  height: integer("height"),
  durationSec: real("duration_sec"),
  sizeBytes: integer("size_bytes"),
  status: text("status", { enum: ["queued", "rendering", "done", "failed"] })
    .notNull().default("queued"),
  error: text("error"),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
}, (t) => [
  // One live render per ad+ratio; re-renders update the row (idempotent
  // jobs), they don't accumulate history.
  uniqueIndex("uq_ad_render_ratio").on(t.adId, t.ratio),
  index("idx_ad_renders_status").on(t.status),
]);

export type Ad = typeof ads.$inferSelect;
export type AdInsert = typeof ads.$inferInsert;
export type AdRender = typeof adRenders.$inferSelect;
export type AdCopyVariant = typeof adCopyVariants.$inferSelect;
