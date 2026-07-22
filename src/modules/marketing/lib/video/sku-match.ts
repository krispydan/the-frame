/**
 * SKU identification for media — filename matching + manual review.
 *
 * The AI vision matcher was removed: matching a worn frame against 100+
 * catalog thumbnails was unreliable in practice. What actually works:
 *   1. FILENAME — shoot files name the product (e.g.
 *      "05_21_26_studio_Solstice_02__10.mp4" → Solstice). A strong
 *      filename hit is suggested (and can be bulk auto-applied).
 *   2. HUMAN — everything else is tagged manually in the review UI,
 *      which shows the full product catalog with photos next to the
 *      media. Applies to video clips AND product/lifestyle photos.
 *
 * marketing_media_matches tracks the state per media item:
 *   suggested  — filename produced a candidate, awaiting review
 *   confirmed  — a human (or filename auto-tag) applied the products
 *   no_product — reviewer said nothing identifiable is in the media
 */
import { db, sqlite } from "@/lib/db";
import { mediaMatches } from "@/modules/marketing/schema";
import { and, eq } from "drizzle-orm";
import { loadReferenceSkus, type ReferenceSku } from "./sku-reference";

export type MediaType = "clip" | "image";

export interface MatchCandidate {
  productId: string;
  productName: string;
  /** A representative colorway code, e.g. JX1005-OLV. */
  sku: string;
  skuId: string;
  colorName: string | null;
  /** 0-100. Filename hits are 90 (strong) / 55 (weak descriptor-only). */
  confidence: number;
  via?: "filename";
}

// ── Filename signal ──
//
// These words are shoot descriptors, not products — ignored even when a
// product happens to share the name (e.g. the "Studio" product vs a
// "studio" shoot).
const SHOOT_TERMS = new Set([
  "studio", "video", "reel", "final", "edit", "raw", "export", "render",
  "clip", "master", "take", "shoot", "footage", "story", "post", "ad", "ugc",
  "lifestyle", "product", "photo", "image",
]);

function normToken(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Find catalog products whose name appears in the media filename. Returns
 * `strong` when a real (non-shoot-term) product name matched — reliable
 * enough to auto-apply. A shoot-term-only match (e.g. just "studio")
 * comes back weak and is only ever a suggestion.
 */
export function matchFilenameToProducts(
  fileName: string | null | undefined,
  refs: ReferenceSku[],
): { candidates: MatchCandidate[]; strong: boolean } {
  if (!fileName) return { candidates: [], strong: false };
  const fn = normToken(fileName);
  const firstByProduct = new Map<string, ReferenceSku>();
  for (const r of refs) if (!firstByProduct.has(r.productId)) firstByProduct.set(r.productId, r);

  const hits: Array<{ ref: ReferenceSku; generic: boolean }> = [];
  for (const ref of firstByProduct.values()) {
    const pn = normToken(ref.productName ?? "");
    if (pn.length < 4) continue;
    // Also try the name without a leading "the" (e.g. "The Regent" → "regent").
    const alt = pn.startsWith("the") && pn.length > 6 ? pn.slice(3) : null;
    if (fn.includes(pn) || (alt && alt.length >= 4 && fn.includes(alt))) {
      hits.push({ ref, generic: SHOOT_TERMS.has(pn) });
    }
  }

  const nonGeneric = hits.filter((h) => !h.generic);
  const strong = nonGeneric.length > 0;
  const chosen = strong ? nonGeneric : hits;
  const candidates: MatchCandidate[] = chosen.map((h) => ({
    productId: h.ref.productId,
    productName: h.ref.productName,
    sku: h.ref.sku,
    skuId: h.ref.skuId,
    colorName: h.ref.colorName,
    confidence: strong ? 90 : 55,
    via: "filename",
  }));
  return { candidates, strong };
}

// ── Match-row persistence ──

function upsertMatch(
  mediaType: MediaType,
  mediaId: string,
  fields: Partial<{ status: string; candidatesJson: string | null; confirmedProductIds: string | null; model: string }>,
): void {
  const existing = db
    .select({ id: mediaMatches.id })
    .from(mediaMatches)
    .where(and(eq(mediaMatches.mediaType, mediaType), eq(mediaMatches.mediaId, mediaId)))
    .get();
  const now = new Date().toISOString();
  if (existing) {
    sqlite
      .prepare(
        `UPDATE marketing_media_matches SET status = COALESCE(?, status),
           candidates_json = COALESCE(?, candidates_json),
           confirmed_product_ids = COALESCE(?, confirmed_product_ids),
           error = NULL, model = COALESCE(?, model), updated_at = ?
         WHERE id = ?`,
      )
      .run(fields.status ?? null, fields.candidatesJson ?? null, fields.confirmedProductIds ?? null, fields.model ?? null, now, existing.id);
  } else {
    sqlite
      .prepare(
        `INSERT INTO marketing_media_matches (id, media_type, media_id, status, candidates_json, confirmed_product_ids, model, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(crypto.randomUUID(), mediaType, mediaId, fields.status ?? "pending", fields.candidatesJson ?? null, fields.confirmedProductIds ?? null, fields.model ?? null, now, now);
  }
}

function getMediaFileName(mediaType: MediaType, mediaId: string): string | null {
  if (mediaType === "clip") {
    const r = sqlite.prepare(`SELECT file_name AS fileName FROM marketing_video_clips WHERE id = ?`).get(mediaId) as
      | { fileName: string | null }
      | undefined;
    return r?.fileName ?? null;
  }
  const r = sqlite.prepare(`SELECT alt_text AS altText, file_path AS filePath FROM catalog_images WHERE id = ?`).get(mediaId) as
    | { altText: string | null; filePath: string | null }
    | undefined;
  return r?.altText || r?.filePath || null;
}

// ── Tag writing (shared by review confirm + bulk auto-tag) ──

/**
 * Write the confirmed products onto the media and mark the match row
 * confirmed. Clips get product-level tags (expanded to every SKU of each
 * product); a catalog image is reassigned to one SKU of the first product
 * (preferring a matched colorway from `candidates`).
 */
export function confirmMediaProducts(
  mediaType: MediaType,
  mediaId: string,
  productIds: string[],
  candidates: Array<{ productId: string; skuId: string }> = [],
): void {
  if (productIds.length === 0) throw new Error("productIds is required");

  if (mediaType === "clip") {
    const skuIds = (sqlite
      .prepare(`SELECT id FROM catalog_skus WHERE product_id IN (${productIds.map(() => "?").join(",")})`)
      .all(...productIds) as Array<{ id: string }>).map((r) => r.id);
    sqlite.prepare(`DELETE FROM marketing_video_clip_products WHERE clip_id = ?`).run(mediaId);
    const insert = sqlite.prepare(
      `INSERT OR IGNORE INTO marketing_video_clip_products (id, clip_id, sku_id) VALUES (?, ?, ?)`,
    );
    for (const skuId of skuIds) insert.run(crypto.randomUUID(), mediaId, skuId);
  } else {
    const productId = productIds[0];
    const fromCandidate = candidates.find((c) => c.productId === productId)?.skuId;
    const skuId =
      fromCandidate ??
      (sqlite.prepare(`SELECT id FROM catalog_skus WHERE product_id = ? ORDER BY sku ASC LIMIT 1`).get(productId) as
        | { id: string }
        | undefined)?.id;
    if (!skuId) throw new Error("Product has no SKUs");
    sqlite.prepare(`UPDATE catalog_images SET sku_id = ? WHERE id = ?`).run(skuId, mediaId);
  }

  upsertMatch(mediaType, mediaId, {
    status: "confirmed",
    confirmedProductIds: JSON.stringify(productIds),
  });
}

/** Save free-form reviewer notes on the media (what the shot shows).
 *  Empty string clears; null/undefined leaves the notes untouched. */
export function saveMediaNotes(mediaType: MediaType, mediaId: string, notes: string | null | undefined): void {
  if (notes == null) return;
  const value = notes.trim() || null;
  if (mediaType === "clip") {
    sqlite
      .prepare(`UPDATE marketing_video_clips SET notes = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(value, mediaId);
  } else {
    sqlite.prepare(`UPDATE catalog_images SET notes = ? WHERE id = ?`).run(value, mediaId);
  }
}

// ── Identification (filename only) ──

export interface IdentifyResult {
  /** suggested | confirmed | none (no filename signal — manual review). */
  status: string;
  candidates: MatchCandidate[];
  applied: boolean;
}

/**
 * Identify one media item from its filename. With `apply`, a STRONG
 * filename match is written straight onto the media (the shoot naming
 * convention is trusted); otherwise it's stored as a suggestion for the
 * review UI. No filename signal → returns "none" and stores nothing, so
 * the item stays in the manual-review queue. Idempotent: a confirmed row
 * is never overwritten.
 */
export function identifyMedia(
  mediaType: MediaType,
  mediaId: string,
  opts: { apply?: boolean } = {},
): IdentifyResult {
  const existing = db
    .select()
    .from(mediaMatches)
    .where(and(eq(mediaMatches.mediaType, mediaType), eq(mediaMatches.mediaId, mediaId)))
    .get();
  if (existing?.status === "confirmed") {
    return { status: "confirmed", candidates: JSON.parse(existing.candidatesJson ?? "[]"), applied: false };
  }

  const fileName = getMediaFileName(mediaType, mediaId);
  const fn = matchFilenameToProducts(fileName, loadReferenceSkus());
  if (fn.candidates.length === 0) {
    return { status: "none", candidates: [], applied: false };
  }

  if (fn.strong && opts.apply) {
    upsertMatch(mediaType, mediaId, {
      status: "suggested", // confirmMediaProducts flips to confirmed
      candidatesJson: JSON.stringify(fn.candidates),
      model: "filename",
    });
    confirmMediaProducts(mediaType, mediaId, fn.candidates.map((c) => c.productId), fn.candidates);
    return { status: "confirmed", candidates: fn.candidates, applied: true };
  }

  upsertMatch(mediaType, mediaId, {
    status: "suggested",
    candidatesJson: JSON.stringify(fn.candidates),
    model: "filename",
  });
  return { status: "suggested", candidates: fn.candidates, applied: false };
}
