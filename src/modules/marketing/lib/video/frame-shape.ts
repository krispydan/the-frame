/**
 * Frame-shape classification — a cheap, catalog-grounded pre-sort for the
 * SKU identifier.
 *
 * The problem: manually finding which of ~115 colorways a clip shows is
 * slow, and full vision matching against every catalog thumbnail was
 * unreliable. Frame SHAPE, though, is a coarse, robust signal a cheap
 * model reads well ("this is an aviator") — and it's the one attribute
 * Daniel curates per product. So instead of asking "which exact SKU is
 * this?", we ask "what shape is this?" and use the answer to PRE-FILTER
 * the catalog down to the handful of products with that shape. The human
 * still picks the exact product, but from a short, relevant shortlist.
 *
 * Pipeline (per media item, cheap by design):
 *   1. Grab one still (clip poster / catalog image).
 *   2. Crop to a glasses-sized close-up + downscale (fewer image tokens).
 *   3. ONE Haiku call classifies the shape from the catalog's own
 *      frame-shape vocabulary (grounded — the model can only pick shapes
 *      we actually sell).
 *   4. Filter catalog products to those shapes → pre-loaded suggestions.
 *
 * Frame shape alone is NOT unique to a product, so this never auto-tags —
 * it only ever produces `suggested` candidates for human review.
 *
 * The vision primitives (crop + classify) live in frame-shape-vision.ts,
 * DB-free so a harness/test can run them without the app database. This
 * module is the DB orchestration around them.
 */
import { unlink } from "fs/promises";
import { and, eq } from "drizzle-orm";
import { db, sqlite } from "@/lib/db";
import { mediaMatches } from "@/modules/marketing/schema";
import { skuMatchModel } from "../ai-model";
import { runFfmpeg } from "./ffmpeg";
import { materializeVideo, videoScratchPath, saveVideo, videoUrl } from "@/lib/storage/videos";
import { materializeMedia } from "@/lib/storage/media";
import {
  cropGlasses,
  cropToBox,
  encodeImage,
  detectGlassesBox,
  matchProductsFromSheets,
  normShape,
  type ShapeGuess,
  type ProductMatchResult,
  type TokenUsage,
} from "./frame-shape-vision";
import { buildCatalogReference, type CatalogItem } from "./frame-shape-sheet";
import type { MediaType, MatchCandidate } from "./sku-match";

// ── Frame-shape vocabulary (grounded in the catalog) ──

/** Last-resort vocabulary if the catalog has no shape tags yet. Mirrors
 *  TAG_PRESETS.frameShape so the model still has a sane closed set. */
const FALLBACK_SHAPES = [
  "aviator", "cat-eye", "rectangle", "round", "square",
  "oval", "oversized", "geometric", "butterfly", "wayfarer", "hexagonal",
];

/**
 * The distinct frame shapes actually present in the catalog, lowercased
 * and sorted. This is what the model is allowed to choose from, so a
 * classification can always map back onto real products.
 */
export function loadFrameShapeVocabulary(): string[] {
  const rows = sqlite
    .prepare(
      `SELECT DISTINCT LOWER(TRIM(tag_name)) AS shape
         FROM catalog_tags
        WHERE LOWER(REPLACE(dimension,'_','')) = 'frameshape'
          AND tag_name IS NOT NULL AND TRIM(tag_name) != ''`,
    )
    .all() as Array<{ shape: string }>;
  const shapes = rows.map((r) => r.shape).filter(Boolean);
  return shapes.length > 0 ? [...new Set(shapes)].sort() : [...FALLBACK_SHAPES];
}

// ── Catalog filter (shape → candidate products) ──

export interface ShapeProduct {
  productId: string;
  productName: string;
  sku: string;
  skuId: string;
  colorName: string | null;
  shape: string;
}

/**
 * Products whose curated frame-shape tag is one of `shapes`, with a
 * representative SKU each (first colorway alphabetically). Empty when no
 * shape matched — the reviewer falls back to the full catalog.
 */
export function productsByFrameShape(shapes: string[]): ShapeProduct[] {
  const wanted = [...new Set(shapes.map(normShape).filter(Boolean))];
  if (wanted.length === 0) return [];
  const placeholders = wanted.map(() => "?").join(",");
  return sqlite
    .prepare(
      `SELECT p.id AS productId, p.name AS productName,
              LOWER(TRIM(t.tag_name)) AS shape,
              MIN(s.sku) AS sku,
              (SELECT s2.id FROM catalog_skus s2
                WHERE s2.product_id = p.id AND s2.sku IS NOT NULL
                ORDER BY s2.sku ASC LIMIT 1) AS skuId,
              (SELECT s3.color_name FROM catalog_skus s3
                WHERE s3.product_id = p.id AND s3.sku IS NOT NULL
                ORDER BY s3.sku ASC LIMIT 1) AS colorName
         FROM catalog_products p
         JOIN catalog_tags t ON t.product_id = p.id
          AND LOWER(REPLACE(t.dimension,'_','')) = 'frameshape'
          AND LOWER(TRIM(t.tag_name)) IN (${placeholders})
         JOIN catalog_skus s ON s.product_id = p.id AND s.sku IS NOT NULL
        GROUP BY p.id
        ORDER BY p.name ASC`,
    )
    .all(...wanted) as ShapeProduct[];
}

/**
 * Turn ranked shapes into product candidates. A product's confidence is
 * its matched shape's confidence. Pure-ish (reads catalog) — unit tested.
 */
export function shapeCandidates(shapes: ShapeGuess[]): MatchCandidate[] {
  const products = productsByFrameShape(shapes.map((s) => s.shape));
  const confByShape = new Map(shapes.map((s) => [normShape(s.shape), s.confidence]));
  return products
    .map((p) => ({
      productId: p.productId,
      productName: p.productName,
      sku: p.sku,
      skuId: p.skuId,
      colorName: p.colorName,
      confidence: confByShape.get(normShape(p.shape)) ?? 0,
      via: "frameshape" as const,
      shape: p.shape,
    }))
    .sort((a, b) => b.confidence - a.confidence || a.productName.localeCompare(b.productName));
}

// ── Still extraction (clip poster / catalog image) ──

/**
 * Get a local still for the media + a cleanup(). Clips use their poster if
 * present, else a frame is pulled at `atSec`. Catalog images use the file
 * itself. Always call cleanup().
 */
export async function stillForMedia(
  mediaType: MediaType,
  mediaId: string,
  atSec = 0.5,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  if (mediaType === "image") {
    const row = sqlite
      .prepare(`SELECT file_path AS filePath FROM catalog_images WHERE id = ?`)
      .get(mediaId) as { filePath: string | null } | undefined;
    if (!row?.filePath) throw new Error("Image has no file_path");
    // Catalog file_path is stored without the media-space "images/" prefix.
    return materializeMedia(`images/${row.filePath.replace(/^\/*(images\/)?/, "")}`);
  }

  const clip = sqlite
    .prepare(`SELECT poster_path AS posterPath, normalized_path AS normalizedPath, raw_path AS rawPath
                FROM marketing_video_clips WHERE id = ?`)
    .get(mediaId) as { posterPath: string | null; normalizedPath: string | null; rawPath: string | null } | undefined;
  if (!clip) throw new Error("Clip not found");

  // At the default timestamp a ready clip already has a poster — cheapest
  // path, no ffmpeg. Later "clear shot" retries need a fresh frame.
  if (clip.posterPath && atSec === 0.5) return materializeVideo(clip.posterPath);

  const srcRel = clip.normalizedPath || clip.rawPath;
  if (!srcRel) {
    if (clip.posterPath) return materializeVideo(clip.posterPath);
    throw new Error("Clip has no video to extract a frame from");
  }
  const src = await materializeVideo(srcRel);
  const out = videoScratchPath(`shape-${mediaId}.jpg`);
  try {
    await runFfmpeg(["-y", "-ss", String(atSec), "-i", src.path, "-frames:v", "1", "-q:v", "3", out]);
  } finally {
    await src.cleanup();
  }
  return { path: out, cleanup: async () => { await unlink(out).catch(() => {}); } };
}

// ── Orchestration (still → crop → classify → suggestions) ──

export interface SuggestResult {
  status: string; // suggested | none | confirmed | failed
  shapes: ShapeGuess[];
  candidates: MatchCandidate[];
  attempts: number;
  /** Measured API cost of this identification (USD), from token usage. */
  costUsd?: number;
}

// Haiku 4.5 pricing per million tokens; cache writes 1.25x, reads 0.1x.
const IN_PER_M = 1, OUT_PER_M = 5, CACHE_WRITE_MULT = 1.25, CACHE_READ_MULT = 0.1;

function usageCostUsd(usages: Array<TokenUsage | undefined>): number {
  let usd = 0;
  for (const u of usages) {
    if (!u) continue;
    usd +=
      ((u.input_tokens ?? 0) * IN_PER_M +
        (u.cache_creation_input_tokens ?? 0) * IN_PER_M * CACHE_WRITE_MULT +
        (u.cache_read_input_tokens ?? 0) * IN_PER_M * CACHE_READ_MULT +
        (u.output_tokens ?? 0) * OUT_PER_M) /
      1_000_000;
  }
  return usd;
}

/**
 * Match the media against the catalog and store the ranked products as
 * `suggested` candidates for review. Confirmed rows are never touched.
 * Never auto-applies — a shape match isn't proof of the exact product.
 *
 * Clips are sampled at 25% / 50% / 75%; every frame where the detector
 * finds glasses becomes a reference crop, and all crops go to the matcher
 * together (multiple angles of the same pair beat any single frame).
 */
export async function suggestFrameShape(
  mediaType: MediaType,
  mediaId: string,
): Promise<SuggestResult> {
  const existing = db
    .select()
    .from(mediaMatches)
    .where(and(eq(mediaMatches.mediaType, mediaType), eq(mediaMatches.mediaId, mediaId)))
    .get();
  if (existing?.status === "confirmed") {
    return { status: "confirmed", shapes: [], candidates: JSON.parse(existing.candidatesJson ?? "[]"), attempts: 0 };
  }

  // Sample frames from ACROSS the clip (25% / 50% / 75%), not the start —
  // openings are often transitions; the product is usually shown clearly
  // somewhere in the middle. Every frame with a detected pair of glasses
  // becomes a reference; all crops go to the matcher in ONE call.
  let times: number[] = [0.5];
  if (mediaType === "clip") {
    const row = sqlite
      .prepare(`SELECT duration_sec AS d FROM marketing_video_clips WHERE id = ?`)
      .get(mediaId) as { d: number | null } | undefined;
    times =
      row?.d && row.d > 1
        ? [0.25, 0.5, 0.75].map((f) => Math.max(0.2, Math.min(row.d! - 0.2, row.d! * f)))
        : [0.5, 2, 3.5]; // duration unknown — best effort spread
  }

  // Labelled catalog reference (cached) — the model matches the crops
  // against these per-product images by frame shape.
  const catalog = await buildCatalogReference();

  // Video-type classification rides along when the clip has no category
  // yet: the model sees one full frame + the category options and picks one.
  let askVideoTypes: Array<{ slug: string; name: string; description: string | null }> | undefined;
  if (mediaType === "clip") {
    const cat = sqlite
      .prepare(`SELECT category_id AS categoryId FROM marketing_video_clips WHERE id = ?`)
      .get(mediaId) as { categoryId: string | null } | undefined;
    if (cat && !cat.categoryId) {
      const rows = sqlite
        .prepare(
          `SELECT slug, name, description FROM marketing_video_clip_categories WHERE archived = 0 ORDER BY sort_order ASC, name ASC`,
        )
        .all() as Array<{ slug: string; name: string; description: string | null }>;
      if (rows.length > 0) askVideoTypes = rows;
    }
  }

  const crops: Array<{ buffer: Buffer; base64: string; mime: "image/jpeg" }> = [];
  const usages: Array<TokenUsage | undefined> = [];
  let fullFrame: { base64: string; mime: string } | undefined;
  let attempts = 0;
  for (const [fi, t] of times.entries()) {
    attempts++;
    let still: { path: string; cleanup: () => Promise<void> } | null = null;
    try {
      still = await stillForMedia(mediaType, mediaId, t);
      // AI-locate the glasses on the full frame, then crop tight to them.
      // A fixed crop misses worn/off-centre shots; the detector fixes that.
      const full = await encodeImage(still.path, 768);
      // Keep the middle full frame as context for video-type classification.
      if (fi === Math.floor(times.length / 2)) fullFrame = full;
      const det = await detectGlassesBox(full.base64, full.mime);
      usages.push(det.usage);
      if (det.box) crops.push(await cropToBox(still.path, det.box));
      else if (!det.ok) crops.push(await cropGlasses(still.path)); // detector errored — heuristic fallback
      // det.ok && no box → no glasses in this frame; skip it.
    } catch {
      /* one bad frame must not sink the run */
    } finally {
      await still?.cleanup();
    }
  }
  // Nothing detected anywhere — last resort: heuristic crop of the middle frame.
  if (crops.length === 0) {
    let still: { path: string; cleanup: () => Promise<void> } | null = null;
    try {
      still = await stillForMedia(mediaType, mediaId, times[Math.floor(times.length / 2)]);
      crops.push(await cropGlasses(still.path));
    } catch {
      /* media unreadable — handled below as failed */
    } finally {
      await still?.cleanup();
    }
  }

  const result: ProductMatchResult =
    crops.length > 0
      ? await matchProductsFromSheets(crops, catalog.items, { fullFrame, videoTypes: askVideoTypes })
      : { ok: false, clearShot: false, shape: null, matches: [], videoType: null, error: "Could not extract a frame" };
  usages.push(result.usage);
  const costUsd = usageCostUsd(usages);

  // Save the classified video type — only onto a clip that still has no
  // category, so a human pick is never clobbered.
  if (result.videoType && askVideoTypes) {
    const catRow = sqlite
      .prepare(`SELECT id FROM marketing_video_clip_categories WHERE slug = ? AND archived = 0`)
      .get(result.videoType) as { id: string } | undefined;
    if (catRow) {
      sqlite
        .prepare(
          `UPDATE marketing_video_clips SET category_id = ?, updated_at = datetime('now')
            WHERE id = ? AND category_id IS NULL`,
        )
        .run(catRow.id, mediaId);
    }
  }

  console.info(
    `[frame-shape] ${mediaType} ${mediaId}: ${crops.length} crop(s) from ${attempts} frame(s) → ` +
      `${result.matches.length} match(es)${result.videoType ? `, type=${result.videoType}` : ""}, cost ≈ $${costUsd.toFixed(4)}`,
  );

  // Persist the exact crops the model judged, so the review UI can show the
  // AI's actual inputs (crucial for debugging bad classifications).
  const cropPaths: string[] = [];
  for (let i = 0; i < crops.length; i++) {
    const p = `shape-crops/${mediaType}-${mediaId}-${i}.jpg`;
    try {
      await saveVideo(crops[i].buffer, p);
      cropPaths.push(p);
    } catch {
      /* non-fatal */
    }
  }

  // Frame-shape badge: the model's overall shape word, tagged with the top
  // match's confidence.
  const shapes: ShapeGuess[] = result.shape
    ? [{ shape: result.shape, confidence: result.matches[0]?.confidence ?? 0 }]
    : [];

  if (!result.ok) {
    upsertShapeMatch(mediaType, mediaId, "failed", [], shapes, result.error ?? null, cropPaths);
    return { status: "failed", shapes, candidates: [], attempts, costUsd };
  }
  if (!result.clearShot || result.matches.length === 0) {
    upsertShapeMatch(mediaType, mediaId, "suggested", [], shapes, null, cropPaths);
    return { status: "none", shapes, candidates: [], attempts, costUsd };
  }

  const candidates = matchesToCandidates(result.matches, catalog.items, result.shape);
  upsertShapeMatch(mediaType, mediaId, "suggested", candidates, shapes, null, cropPaths);
  return { status: "suggested", shapes, candidates, attempts, costUsd };
}

/** Map the model's ranked tile numbers back onto catalog products. */
function matchesToCandidates(
  matches: ProductMatchResult["matches"],
  entries: CatalogItem[],
  shape: string | null,
): MatchCandidate[] {
  const byIndex = new Map(entries.map((e) => [e.index, e]));
  const out: MatchCandidate[] = [];
  for (const m of matches) {
    const e = byIndex.get(m.index);
    if (!e) continue;
    out.push({
      productId: e.productId,
      productName: e.productName,
      sku: e.sku,
      skuId: e.skuId,
      colorName: null,
      confidence: m.confidence,
      via: "frameshape",
      shape: shape ?? undefined,
    });
  }
  return out.slice(0, 10);
}

/** Public URLs for the stored frame-shape crops. */
export function frameShapeCropUrls(cropPaths: string[] | null | undefined): string[] {
  return (cropPaths ?? []).map((p) => videoUrl(p));
}

function upsertShapeMatch(
  mediaType: MediaType,
  mediaId: string,
  status: string,
  candidates: MatchCandidate[],
  shapes: ShapeGuess[],
  error: string | null,
  cropPaths: string[] = [],
): void {
  const now = new Date().toISOString();
  const attrs = JSON.stringify({ frameShapes: shapes, cropPaths });
  const existing = sqlite
    .prepare(`SELECT id, status FROM marketing_media_matches WHERE media_type = ? AND media_id = ?`)
    .get(mediaType, mediaId) as { id: string; status: string } | undefined;
  if (existing) {
    // Never clobber a human confirmation.
    if (existing.status === "confirmed") return;
    sqlite
      .prepare(
        `UPDATE marketing_media_matches
            SET status = ?, candidates_json = ?, attributes_json = ?, error = ?, model = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(status, JSON.stringify(candidates), attrs, error, skuMatchModel(), now, existing.id);
  } else {
    sqlite
      .prepare(
        `INSERT INTO marketing_media_matches
           (id, media_type, media_id, status, candidates_json, attributes_json, error, model, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(crypto.randomUUID(), mediaType, mediaId, status, JSON.stringify(candidates), attrs, error, skuMatchModel(), now, now);
  }
}
