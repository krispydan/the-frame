/**
 * AI SKU identification — match a media frame against the catalog.
 *
 * Flow per media item (video clip poster or catalog image):
 *   1. getReferenceSheets() — labeled catalog contact sheets (cached).
 *   2. One vision request: sheets + the frame, forced tool-use returning
 *      candidate SKU codes with 0-100 confidence (or "no product").
 *   3. mapCandidates() folds colorway-level answers into parent products
 *      (we tag products, not colors) and stores them on the match row
 *      for the review UI, where a human confirms.
 *
 * Uses the same direct-fetch + forced-tool pattern as email-ai.ts, but
 * with base64 image blocks (media bytes live server-side, not at URLs
 * the API could fetch).
 */
import { readFile, unlink } from "fs/promises";
import sharp from "sharp";
import { db, sqlite } from "@/lib/db";
import { mediaMatches } from "@/modules/marketing/schema";
import { and, eq } from "drizzle-orm";
import { readVideo, materializeVideo, videoScratchPath } from "@/lib/storage/videos";
import { readImage } from "@/lib/storage/local";
import { readFromR2IfPresent } from "@/lib/storage/media";
import { videoModel } from "@/modules/marketing/lib/ai-model";
import { runFfmpeg } from "./ffmpeg";
import { getReferenceSheets, loadReferenceSkus, type ReferenceSku } from "./sku-reference";

// Progressive frame sampling for clips: if the poster (≈0.5s) isn't a
// clear shot of a product, keep pulling a frame every 2s until one is, up
// to this many EXTRA frames (so at most 1 + MAX_EXTRA_FRAMES vision calls).
const CONFIDENT_THRESHOLD = 55;
const MAX_EXTRA_FRAMES = 4;

export type MediaType = "clip" | "image";

export interface MatchCandidate {
  productId: string;
  productName: string;
  /** Best-matching colorway code, e.g. JX1005-OLV (evidence, not the tag). */
  sku: string;
  skuId: string;
  colorName: string | null;
  /** 0-100. */
  confidence: number;
  /** Where the match came from — shown in the UI. */
  via?: "filename" | "vision" | "both";
}

// ── Filename signal ──
//
// Shoot files are named with the product, e.g.
// "05_21_26_studio_Solstice_02__10.mp4" → Solstice. That's a far stronger
// signal than matching a worn frame against 100+ tiny thumbnails, so when a
// catalog product name appears in the filename we lead with it. These words
// are shoot descriptors, not products — ignored even when a product happens
// to share the name (e.g. the "Studio" product vs a "studio" shoot).
const SHOOT_TERMS = new Set([
  "studio", "video", "reel", "final", "edit", "raw", "export", "render",
  "clip", "master", "take", "shoot", "footage", "story", "post", "ad", "ugc",
]);

function normToken(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Find catalog products whose name appears in the media filename. Returns
 * `strong` when a real (non-shoot-term) product name matched — that's a
 * confident answer we can use without vision. A shoot-term-only match
 * (e.g. just "studio") comes back weak so vision can still lead.
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

/** Merge filename candidates with vision candidates (highest confidence per
 *  product wins; agreement is marked "both"), best-first. */
export function mergeCandidates(fnCands: MatchCandidate[], visionCands: MatchCandidate[]): MatchCandidate[] {
  const map = new Map<string, MatchCandidate>();
  for (const c of fnCands) map.set(c.productId, { ...c });
  for (const c of visionCands) {
    const existing = map.get(c.productId);
    if (existing) {
      map.set(c.productId, {
        ...c,
        confidence: Math.max(existing.confidence, c.confidence),
        via: "both",
      });
    } else {
      map.set(c.productId, { ...c, via: "vision" });
    }
  }
  return [...map.values()].sort((a, b) => b.confidence - a.confidence);
}

// ── Model answer → catalog candidates ──

interface RawCandidate {
  sku?: unknown;
  confidence?: unknown;
}

/**
 * Map the model's colorway-level answers onto catalog rows and fold to
 * parent products (max confidence per product wins). Unknown SKU codes
 * are dropped — the model must pick from the sheets, not invent.
 */
export function mapCandidates(raw: RawCandidate[], skus: ReferenceSku[]): MatchCandidate[] {
  const bySku = new Map(skus.map((s) => [s.sku.toUpperCase(), s]));
  const byProduct = new Map<string, MatchCandidate>();

  for (const item of raw) {
    if (typeof item?.sku !== "string") continue;
    const ref = bySku.get(item.sku.trim().toUpperCase());
    if (!ref) continue;
    const confidence = Math.max(0, Math.min(100, Math.round(Number(item.confidence) || 0)));
    const existing = byProduct.get(ref.productId);
    if (!existing || confidence > existing.confidence) {
      byProduct.set(ref.productId, {
        productId: ref.productId,
        productName: ref.productName,
        sku: ref.sku,
        skuId: ref.skuId,
        colorName: ref.colorName,
        confidence,
      });
    }
  }
  return [...byProduct.values()].sort((a, b) => b.confidence - a.confidence);
}

// ── Vision request ──

const MATCH_TOOL = {
  name: "report_sku_matches",
  description: "Report which catalog SKUs appear in the media frame.",
  input_schema: {
    type: "object",
    properties: {
      candidates: {
        type: "array",
        description:
          "Catalog SKU codes that plausibly match, best first. Include several options when unsure. Empty if no catalog product is identifiable.",
        items: {
          type: "object",
          properties: {
            sku: { type: "string", description: "Exact SKU code from a reference sheet, e.g. JX1005-OLV" },
            confidence: { type: "number", description: "0-100 — how confident this product is in the frame" },
          },
          required: ["sku", "confidence"],
        },
      },
      noProductVisible: {
        type: "boolean",
        description: "True when no catalog eyewear is identifiable in the frame at all",
      },
    },
    required: ["candidates", "noProductVisible"],
  },
} as const;

function b64Image(buf: Buffer): { type: "image"; source: { type: "base64"; media_type: "image/jpeg"; data: string } } {
  return { type: "image", source: { type: "base64", media_type: "image/jpeg", data: buf.toString("base64") } };
}

async function callVision(content: unknown[]): Promise<{ candidates: RawCandidate[]; noProductVisible: boolean }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: videoModel(),
      max_tokens: 1024,
      system:
        "You identify Jaxy eyewear products in marketing media. You are given labeled catalog reference sheets " +
        "(each cell shows one colorway with its SKU code) followed by ONE media frame to identify. Match by frame " +
        "shape, color/pattern, temple details and lens tint. Sunglasses are often worn on a model at an angle — " +
        "judge carefully. Only report SKU codes that appear on the sheets. Be honest: high confidence (80+) only " +
        "for clear matches; when torn between look-alikes, list each with moderate confidence.",
      tools: [MATCH_TOOL],
      tool_choice: { type: "tool", name: MATCH_TOOL.name },
      messages: [{ role: "user", content }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const data = (await res.json()) as { content: Array<{ type: string; input?: Record<string, unknown> }> };
  const toolCall = data.content.find((c) => c.type === "tool_use");
  if (!toolCall?.input) throw new Error("Model returned no tool_use block");
  return {
    candidates: Array.isArray(toolCall.input.candidates) ? (toolCall.input.candidates as RawCandidate[]) : [],
    noProductVisible: toolCall.input.noProductVisible === true,
  };
}

// ── Media frame loading ──

/** Normalize any frame to a bounded JPEG for the vision request. */
async function normFrame(buf: Buffer): Promise<Buffer> {
  return sharp(buf).resize(1000, 1000, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
}

async function loadImageBytes(mediaId: string): Promise<Buffer> {
  const image = sqlite
    .prepare(`SELECT file_path AS filePath FROM catalog_images WHERE id = ?`)
    .get(mediaId) as { filePath: string | null } | undefined;
  if (!image?.filePath) throw new Error(`Image not found or has no file: ${mediaId}`);
  try {
    return await readImage(image.filePath);
  } catch {
    const r2 = await readFromR2IfPresent(`images/${image.filePath}`);
    if (!r2) throw new Error(`Image bytes unreadable: ${image.filePath}`);
    return r2;
  }
}

/**
 * Lazy frame source for a clip: the poster (≈0.5s) up front, then extra
 * frames every 2s pulled from the normalized video ON DEMAND — the
 * (expensive) materialize + ffmpeg only happens if the first frame wasn't
 * a clear shot. Always call cleanup().
 */
async function clipFrameSource(mediaId: string): Promise<{
  poster: Buffer;
  extraTimestamps: number[];
  getExtra: (i: number) => Promise<Buffer | null>;
  cleanup: () => Promise<void>;
}> {
  const clip = sqlite
    .prepare(`SELECT poster_path AS posterPath, normalized_path AS normalizedPath, duration_sec AS durationSec FROM marketing_video_clips WHERE id = ?`)
    .get(mediaId) as { posterPath: string | null; normalizedPath: string | null; durationSec: number | null } | undefined;
  if (!clip) throw new Error(`Clip not found: ${mediaId}`);
  if (!clip.posterPath) throw new Error("Clip has no poster frame yet (still normalizing?)");
  const poster = await readVideo(clip.posterPath);

  const dur = clip.durationSec ?? 0;
  const extraTimestamps: number[] = [];
  for (let t = 2; t < dur - 0.1 && extraTimestamps.length < MAX_EXTRA_FRAMES; t += 2) extraTimestamps.push(t);

  let mat: { path: string; cleanup: () => Promise<void> } | null = null;
  const getExtra = async (i: number): Promise<Buffer | null> => {
    if (!clip.normalizedPath || i >= extraTimestamps.length) return null;
    if (!mat) mat = await materializeVideo(clip.normalizedPath);
    const out = videoScratchPath(`match-${i}.jpg`);
    await runFfmpeg(["-y", "-ss", extraTimestamps[i].toFixed(2), "-i", mat.path, "-frames:v", "1", "-q:v", "3", out]);
    const buf = await readFile(out);
    await unlink(out).catch(() => {});
    return buf;
  };

  return {
    poster,
    extraTimestamps,
    getExtra,
    cleanup: async () => {
      if (mat) await mat.cleanup();
    },
  };
}

interface FrameResult {
  candidates: MatchCandidate[];
  noProductVisible: boolean;
  top: number;
}

// ── Public API ──

function upsertMatch(
  mediaType: MediaType,
  mediaId: string,
  fields: Partial<{ status: string; candidatesJson: string | null; error: string | null; model: string }>,
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
           candidates_json = COALESCE(?, candidates_json), error = ?, model = COALESCE(?, model), updated_at = ?
         WHERE id = ?`,
      )
      .run(fields.status ?? null, fields.candidatesJson ?? null, fields.error ?? null, fields.model ?? null, now, existing.id);
  } else {
    sqlite
      .prepare(
        `INSERT INTO marketing_media_matches (id, media_type, media_id, status, candidates_json, error, model, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(crypto.randomUUID(), mediaType, mediaId, fields.status ?? "pending", fields.candidatesJson ?? null, fields.error ?? null, fields.model ?? null, now, now);
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

/**
 * Run identification for one media item and store the suggestion.
 *
 * Strategy: the shoot filename usually NAMES the product (e.g.
 * "…_Solstice_02.mp4"), which is far more reliable than matching a worn
 * frame against 100+ tiny thumbnails — so a confident filename hit is used
 * directly (no vision call). Otherwise we run the vision matcher (poster,
 * escalating frames for clips) with the filename passed as a hint, and
 * merge in any weak filename signal.
 *
 * Idempotent for the job queue: a confirmed row is never overwritten; a
 * suggested row is only re-run with force.
 */
export async function identifyMedia(
  mediaType: MediaType,
  mediaId: string,
  opts: { force?: boolean } = {},
): Promise<{ status: string; candidates: MatchCandidate[] }> {
  const existing = db
    .select()
    .from(mediaMatches)
    .where(and(eq(mediaMatches.mediaType, mediaType), eq(mediaMatches.mediaId, mediaId)))
    .get();
  if (existing?.status === "confirmed") {
    return { status: "confirmed", candidates: JSON.parse(existing.candidatesJson ?? "[]") };
  }
  if (existing?.status === "suggested" && !opts.force) {
    return { status: "suggested", candidates: JSON.parse(existing.candidatesJson ?? "[]") };
  }

  try {
    const fileName = getMediaFileName(mediaType, mediaId);
    const fn = matchFilenameToProducts(fileName, loadReferenceSkus());

    // Strong filename match → trust the shoot naming; skip vision entirely.
    if (fn.strong) {
      upsertMatch(mediaType, mediaId, {
        status: "suggested",
        candidatesJson: JSON.stringify(fn.candidates),
        error: null,
        model: "filename",
      });
      return { status: "suggested", candidates: fn.candidates };
    }

    // Otherwise fall back to vision (with the filename as a hint).
    const { sheets, skus } = await getReferenceSheets();
    const sheetPreamble = {
      type: "text",
      text:
        `CATALOG REFERENCE SHEETS (${skus.length} colorways across ${sheets.length} sheets). ` +
        `Each cell: product photo, product name, SKU code.`,
    };
    const frameLabel =
      `MEDIA FRAME TO IDENTIFY${fileName ? ` (file name: "${fileName}")` : ""} — which catalog product(s) appear here? ` +
      `If a catalog product name appears in the file name, prioritize confirming that exact product.`;

    const askFrame = async (frame: Buffer): Promise<FrameResult> => {
      const content: unknown[] = [
        sheetPreamble,
        ...sheets.map(b64Image),
        { type: "text", text: frameLabel },
        b64Image(await normFrame(frame)),
      ];
      const answer = await callVision(content);
      const candidates = mapCandidates(answer.candidates, skus);
      return { candidates, noProductVisible: answer.noProductVisible, top: candidates[0]?.confidence ?? -1 };
    };

    let best: FrameResult = { candidates: [], noProductVisible: true, top: -1 };
    const keepBest = (r: FrameResult) => {
      if (r.top > best.top) best = r;
    };
    const clear = (r: FrameResult) => !r.noProductVisible && r.candidates.length > 0 && r.top >= CONFIDENT_THRESHOLD;

    if (mediaType === "image") {
      keepBest(await askFrame(await loadImageBytes(mediaId)));
    } else {
      const src = await clipFrameSource(mediaId);
      try {
        keepBest(await askFrame(src.poster));
        let i = 0;
        while (!clear(best) && i < src.extraTimestamps.length) {
          const extra = await src.getExtra(i++);
          if (!extra) break;
          keepBest(await askFrame(extra));
        }
      } finally {
        await src.cleanup();
      }
    }

    // Fold in a weak filename signal (e.g. only "studio" matched).
    const candidates = mergeCandidates(fn.candidates, best.candidates);
    const status = candidates.length === 0 ? "no_product" : "suggested";
    upsertMatch(mediaType, mediaId, {
      status,
      candidatesJson: JSON.stringify(candidates),
      error: null,
      model: videoModel(),
    });
    return { status, candidates };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    upsertMatch(mediaType, mediaId, { status: "failed", error: message.slice(0, 1000) });
    throw e;
  }
}
