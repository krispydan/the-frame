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
} from "./frame-shape-vision";
import { buildContactSheets, type SheetEntry } from "./frame-shape-sheet";
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
}

/**
 * Map classified shapes onto catalog products and store them as
 * `suggested` candidates for review. Confirmed rows are never touched.
 * Never auto-applies — shape isn't unique to one product.
 *
 * "clear shot" retry: if the first still doesn't show a frame clearly and
 * the media is a clip, walk forward every `stepSec` (up to `maxSec`)
 * pulling a new frame until the model reports a clear shot. Cheap stills,
 * bounded attempts.
 */
export async function suggestFrameShape(
  mediaType: MediaType,
  mediaId: string,
  opts: { stepSec?: number; maxSec?: number; maxAttempts?: number } = {},
): Promise<SuggestResult> {
  const existing = db
    .select()
    .from(mediaMatches)
    .where(and(eq(mediaMatches.mediaType, mediaType), eq(mediaMatches.mediaId, mediaId)))
    .get();
  if (existing?.status === "confirmed") {
    return { status: "confirmed", shapes: [], candidates: JSON.parse(existing.candidatesJson ?? "[]"), attempts: 0 };
  }

  const stepSec = opts.stepSec ?? 2;
  const maxSec = opts.maxSec ?? (mediaType === "clip" ? 8 : 0);
  const maxAttempts = opts.maxAttempts ?? 5;

  // Numbered catalog contact sheet (cached) — the model matches the crop
  // against this by frame shape.
  const sheet = await buildContactSheets();

  let result: ProductMatchResult = { ok: false, clearShot: false, shape: null, matches: [] };
  let attempts = 0;
  let lastCrop: Buffer | null = null;
  for (let t = 0.5; ; t += stepSec) {
    if (attempts >= maxAttempts) break;
    attempts++;
    const still = await stillForMedia(mediaType, mediaId, t);
    try {
      // AI-locate the glasses on the full frame, then crop tight to them.
      // A fixed crop misses worn/off-centre shots; the detector fixes that.
      const full = await encodeImage(still.path, 768);
      const det = await detectGlassesBox(full.base64, full.mime);
      const crop = det.box
        ? await cropToBox(still.path, det.box)
        : await cropGlasses(still.path); // heuristic fallback if detection fails
      lastCrop = crop.buffer;
      // Detector ran and found no glasses on this frame — try a later one
      // before giving up (cheap; the match call is the expensive part).
      if (det.ok && !det.box && t + stepSec <= maxSec) continue;
      result = await matchProductsFromSheets(crop.base64, crop.mime, sheet.sheets, sheet.entries.length);
    } finally {
      await still.cleanup();
    }
    // Stop on a clear read, a hard error, or once we've walked past maxSec.
    if (!result.ok || result.clearShot || t + stepSec > maxSec) break;
  }

  // Persist the exact crop the model judged, so the review UI can show the
  // AI's actual input (crucial for debugging bad classifications).
  let cropPath: string | null = null;
  if (lastCrop) {
    cropPath = `shape-crops/${mediaType}-${mediaId}.jpg`;
    try {
      await saveVideo(lastCrop, cropPath);
    } catch {
      cropPath = null;
    }
  }

  // Frame-shape badge: the model's overall shape word, tagged with the top
  // match's confidence.
  const shapes: ShapeGuess[] = result.shape
    ? [{ shape: result.shape, confidence: result.matches[0]?.confidence ?? 0 }]
    : [];

  if (!result.ok) {
    upsertShapeMatch(mediaType, mediaId, "failed", [], shapes, result.error ?? null, cropPath);
    return { status: "failed", shapes, candidates: [], attempts };
  }
  if (!result.clearShot || result.matches.length === 0) {
    upsertShapeMatch(mediaType, mediaId, "suggested", [], shapes, null, cropPath);
    return { status: "none", shapes, candidates: [], attempts };
  }

  const candidates = matchesToCandidates(result.matches, sheet.entries, result.shape);
  upsertShapeMatch(mediaType, mediaId, "suggested", candidates, shapes, null, cropPath);
  return { status: "suggested", shapes, candidates, attempts };
}

/** Map the model's ranked tile numbers back onto catalog products. */
function matchesToCandidates(
  matches: ProductMatchResult["matches"],
  entries: SheetEntry[],
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

/** Public URL for a stored frame-shape crop (or null). */
export function frameShapeCropUrl(cropPath: string | null | undefined): string | null {
  return cropPath ? videoUrl(cropPath) : null;
}

function upsertShapeMatch(
  mediaType: MediaType,
  mediaId: string,
  status: string,
  candidates: MatchCandidate[],
  shapes: ShapeGuess[],
  error: string | null,
  cropPath: string | null = null,
): void {
  const now = new Date().toISOString();
  const attrs = JSON.stringify({ frameShapes: shapes, cropPath });
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
