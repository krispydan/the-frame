/**
 * Product videos — one canonical video per parent frame, for Shopify
 * product pages, Faire, and (via a separate social cut) TikTok/Reels.
 *
 * DELIBERATELY NOT the social composer. That one is random by design —
 * weighted picks, permutation hashes, "never repeat an edit" — which is
 * right for a feed and wrong for a product page. Here the build is
 * DETERMINISTIC: the same footage always yields the same edit, and
 * re-generating a product simply replaces its video when better clips
 * land. There is exactly one video per product (product_id is the key).
 *
 * PDP rules baked in:
 *   • only clips tagged to THIS product — no foreign product, no generic
 *     b-roll glue. A product page video is about one frame.
 *   • must contain at least one clip that SHOWS the frame.
 *   • silent master, no burned hook — PDP videos autoplay muted next to
 *     the photos; the hook/trending-audio treatment belongs to the
 *     social cut only.
 */
import { unlink, writeFile } from "fs/promises";
import { sqlite } from "@/lib/db";
import {
  materializeVideo,
  storeVideoFile,
  videoScratchPath,
  videoUrl,
} from "@/lib/storage/videos";
import { runFfmpeg, ffprobe } from "./ffmpeg";

/** Keep PDP videos tight — shoppers bounce, and Faire tiles are small. */
export const MAX_CLIPS = 5;
export const MAX_DURATION_SEC = 20;

export type ProductVideoStatus = "pending" | "rendering" | "ready" | "failed";

export interface ProductVideoRow {
  productId: string;
  productName: string;
  clipIds: string[];
  status: ProductVideoStatus;
  filePath: string | null;
  posterPath: string | null;
  videoUrl: string | null;
  posterUrl: string | null;
  durationSec: number | null;
  caption: string | null;
  approvedAt: string | null;
  shopifyPublishedAt: string | null;
  error: string | null;
  updatedAt: string | null;
}

let ensured = false;
function ensureTable(): void {
  if (ensured) return;
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS marketing_product_videos (
      product_id TEXT PRIMARY KEY,
      clip_ids TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      file_path TEXT,
      poster_path TEXT,
      duration_sec REAL,
      size_bytes INTEGER,
      caption TEXT,
      approved_at TEXT,
      shopify_published_at TEXT,
      error TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
  ensured = true;
}

interface CandidateClip {
  id: string;
  durationSec: number;
  categorySlug: string | null;
  isProductShot: boolean;
  sortOrder: number;
}

const LEGACY_PRODUCT_SHOT = ["flat_lay", "on_model", "detail", "lifestyle", "in_car"];

/**
 * Clips usable for this product's video, already in the order they'll be
 * cut. Deterministic: product shots first (by the operator's category
 * order), then supporting clips; longer takes win ties; id breaks the
 * rest so the result never wobbles between runs.
 */
export function selectClipsForProduct(productId: string): CandidateClip[] {
  const anyFlagged = (sqlite
    .prepare(`SELECT COUNT(*) AS n FROM marketing_video_clip_categories WHERE is_product_shot = 1`)
    .get() as { n: number }).n > 0;

  const rows = sqlite.prepare(`
    SELECT DISTINCT c.id            AS id,
           c.duration_sec           AS durationSec,
           cat.slug                 AS categorySlug,
           cat.is_product_shot      AS isProductShot,
           COALESCE(cat.sort_order, 999) AS sortOrder
      FROM marketing_video_clips c
      JOIN marketing_video_clip_products cp ON cp.clip_id = c.id
      JOIN catalog_skus s ON s.id = cp.sku_id
      LEFT JOIN marketing_video_clip_categories cat ON cat.id = c.category_id
     WHERE s.product_id = ?
       AND c.status = 'ready'
       AND c.duration_sec IS NOT NULL
       AND NOT EXISTS (
         -- product coherence: exclude a clip that also shows another product
         SELECT 1 FROM marketing_video_clip_products cp2
           JOIN catalog_skus s2 ON s2.id = cp2.sku_id
          WHERE cp2.clip_id = c.id AND s2.product_id != ?
       )
  `).all(productId, productId) as Array<{
    id: string; durationSec: number; categorySlug: string | null; isProductShot: number | null; sortOrder: number;
  }>;

  const candidates: CandidateClip[] = rows.map((r) => ({
    id: r.id,
    durationSec: r.durationSec,
    categorySlug: r.categorySlug,
    isProductShot: anyFlagged
      ? r.isProductShot === 1
      : LEGACY_PRODUCT_SHOT.includes(r.categorySlug ?? ""),
    sortOrder: r.sortOrder,
  }));

  candidates.sort(
    (a, b) =>
      Number(b.isProductShot) - Number(a.isProductShot) ||
      a.sortOrder - b.sortOrder ||
      b.durationSec - a.durationSec ||
      a.id.localeCompare(b.id),
  );

  // Take up to MAX_CLIPS while respecting the duration ceiling — but never
  // drop the opening product shot to satisfy it.
  const picked: CandidateClip[] = [];
  let total = 0;
  for (const c of candidates) {
    if (picked.length >= MAX_CLIPS) break;
    if (picked.length > 0 && total + c.durationSec > MAX_DURATION_SEC) continue;
    picked.push(c);
    total += c.durationSec;
  }
  return picked;
}

/** Where a product's master + poster live (deterministic, overwritten). */
export function productVideoPath(productId: string, ext: "mp4" | "jpg"): string {
  return `products/${productId}.${ext}`;
}

export interface BuildResult {
  ok: boolean;
  productId: string;
  clipIds?: string[];
  durationSec?: number;
  reason?: string;
}

/**
 * Build (or rebuild) the product's video. Concats the selected clips
 * SILENT — a PDP video autoplays muted — writes the master + poster to a
 * deterministic path, and upserts the product's row.
 */
export async function buildProductVideo(productId: string): Promise<BuildResult> {
  ensureTable();
  const product = sqlite
    .prepare(`SELECT id, name FROM catalog_products WHERE id = ?`)
    .get(productId) as { id: string; name: string } | undefined;
  if (!product) throw new Error(`Product not found: ${productId}`);

  const picked = selectClipsForProduct(productId);
  if (picked.length === 0) {
    upsert(productId, { clipIds: [], status: "failed", error: "No clips tagged to this product" });
    return { ok: false, productId, reason: "no clips" };
  }
  if (!picked.some((c) => c.isProductShot)) {
    upsert(productId, {
      clipIds: [],
      status: "failed",
      error: "No clip shows the product — needs a product shot before a PDP video is worth publishing",
    });
    return { ok: false, productId, reason: "no product shot" };
  }

  const clipIds = picked.map((c) => c.id);
  upsert(productId, { clipIds, status: "rendering", error: null });

  const cleanups: Array<() => Promise<void>> = [];
  const scratch = (name: string) => {
    const p = videoScratchPath(name);
    cleanups.push(() => unlink(p).catch(() => {}));
    return p;
  };

  try {
    // Always the MUTED variant — the master is silent by design.
    const sources: string[] = [];
    for (const id of clipIds) {
      const clip = sqlite
        .prepare(`SELECT muted_path AS mutedPath, normalized_path AS normalizedPath, file_name AS fileName FROM marketing_video_clips WHERE id = ?`)
        .get(id) as { mutedPath: string | null; normalizedPath: string | null; fileName: string } | undefined;
      const rel = clip?.mutedPath || clip?.normalizedPath;
      if (!rel) throw new Error(`Clip ${clip?.fileName ?? id} has no normalized video`);
      const m = await materializeVideo(rel);
      cleanups.push(m.cleanup);
      sources.push(m.path);
    }

    const list = scratch(`pv-${productId}.txt`);
    const outTmp = scratch(`pv-${productId}.mp4`);
    const posterTmp = scratch(`pv-${productId}.jpg`);
    await writeFile(list, sources.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n") + "\n");

    // Every input shares the normalization profile, so the video stream
    // copies losslessly; -an drops audio entirely (silent master).
    await runFfmpeg([
      "-y", "-f", "concat", "-safe", "0", "-i", list,
      "-c:v", "copy", "-an", "-movflags", "+faststart", outTmp,
    ]);
    await runFfmpeg(["-y", "-ss", "0.5", "-i", outTmp, "-frames:v", "1", "-q:v", "3", posterTmp]);

    const probe = await ffprobe(outTmp);
    const fileRel = productVideoPath(productId, "mp4");
    const posterRel = productVideoPath(productId, "jpg");
    await storeVideoFile(posterTmp, posterRel);
    await storeVideoFile(outTmp, fileRel);

    upsert(productId, {
      clipIds,
      status: "ready",
      filePath: fileRel,
      posterPath: posterRel,
      durationSec: probe.durationSec,
      sizeBytes: probe.sizeBytes,
      error: null,
    });
    return { ok: true, productId, clipIds, durationSec: probe.durationSec };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    upsert(productId, { clipIds, status: "failed", error: message.slice(0, 2000) });
    throw e;
  } finally {
    for (const c of cleanups) await c();
  }
}

function upsert(
  productId: string,
  v: {
    clipIds: string[];
    status: ProductVideoStatus;
    filePath?: string | null;
    posterPath?: string | null;
    durationSec?: number | null;
    sizeBytes?: number | null;
    error?: string | null;
  },
): void {
  ensureTable();
  sqlite
    .prepare(
      `INSERT INTO marketing_product_videos
         (product_id, clip_ids, status, file_path, poster_path, duration_sec, size_bytes, error, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(product_id) DO UPDATE SET
         clip_ids = excluded.clip_ids,
         status = excluded.status,
         file_path = COALESCE(excluded.file_path, marketing_product_videos.file_path),
         poster_path = COALESCE(excluded.poster_path, marketing_product_videos.poster_path),
         duration_sec = COALESCE(excluded.duration_sec, marketing_product_videos.duration_sec),
         size_bytes = COALESCE(excluded.size_bytes, marketing_product_videos.size_bytes),
         error = excluded.error,
         updated_at = datetime('now')`,
    )
    .run(
      productId,
      JSON.stringify(v.clipIds),
      v.status,
      v.filePath ?? null,
      v.posterPath ?? null,
      v.durationSec ?? null,
      v.sizeBytes ?? null,
      v.error ?? null,
    );
}

/**
 * A single clean line for the product page / Faire.
 *
 * Deliberately NOT the social caption engine: no hashtags, no trending
 * hooks, no slang. This text sits next to the product photos and can
 * flow into marketplace feeds, so it stays plain and on-brand.
 */
export async function generateProductCaption(productId: string): Promise<{ ok: boolean; caption?: string; error?: string }> {
  ensureTable();
  const product = sqlite
    .prepare(`SELECT p.id, p.name, p.short_description AS shortDescription, p.description
                FROM catalog_products p WHERE p.id = ?`)
    .get(productId) as { id: string; name: string; shortDescription: string | null; description: string | null } | undefined;
  if (!product) throw new Error(`Product not found: ${productId}`);

  const { callClaude, extractPromptBody } = await import("../email-ai");
  const { getDocContent } = await import("../prompt-store");
  const { videoModel } = await import("../ai-model");

  const systemPrompt =
    extractPromptBody(getDocContent("system-prompt-base"))
      .replace(/\{\{?AUDIENCE\}?\}/g, "retail")
      .replace(/\{IF\s+audience[^}]*\}([\s\S]*?)\{(ELSE[^}]*|ENDIF)\}/g, "$1") +
    "\n\nYou are writing the one-line caption that sits UNDER A PRODUCT VIDEO on a " +
    "Shopify product page and a Faire wholesale listing. This is not social media.";

  const userPrompt = [
    `Product: ${product.name}`,
    product.shortDescription ? `Short description: ${product.shortDescription}` : "",
    product.description ? `Description: ${product.description.slice(0, 600)}` : "",
    "",
    "Write ONE line (max 90 characters) to caption this product's video.",
    "Rules: no hashtags. No emoji. No slang or trend phrases. No 'Introducing…'.",
    "Say something true and specific about how the frame looks or wears.",
    "It should read well beside the product photos and in a wholesale catalogue.",
  ].filter(Boolean).join("\n");

  const result = await callClaude({
    systemPrompt,
    userPrompt,
    tool: {
      name: "submit_product_caption",
      description: "Submit the product video caption",
      input_schema: {
        type: "object",
        required: ["caption"],
        properties: { caption: { type: "string", description: "One clean line, ≤90 chars, no hashtags" } },
      },
    },
    maxTokens: 512,
    model: videoModel(),
  });
  if (!result.ok) return { ok: false, error: result.error };

  const caption = String((result.output as { caption?: unknown }).caption ?? "").trim();
  if (!caption) return { ok: false, error: "Empty caption" };
  sqlite
    .prepare(`UPDATE marketing_product_videos SET caption = ?, updated_at = datetime('now') WHERE product_id = ?`)
    .run(caption, productId);
  return { ok: true, caption };
}

/** Approve a product's video for publishing (the human gate). */
export function setApproved(productId: string, approved: boolean): boolean {
  ensureTable();
  const res = sqlite
    .prepare(
      `UPDATE marketing_product_videos
          SET approved_at = ${approved ? "datetime('now')" : "NULL"}, updated_at = datetime('now')
        WHERE product_id = ? AND status = 'ready'`,
    )
    .run(productId);
  return res.changes > 0;
}

/** Every product video we've built, newest activity first. */
export function listProductVideos(): ProductVideoRow[] {
  ensureTable();
  const rows = sqlite.prepare(`
    SELECT pv.*, p.name AS productName
      FROM marketing_product_videos pv
      JOIN catalog_products p ON p.id = pv.product_id
     ORDER BY pv.updated_at DESC
  `).all() as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    productId: String(r.product_id),
    productName: String(r.productName),
    clipIds: JSON.parse(String(r.clip_ids || "[]")) as string[],
    status: (r.status as ProductVideoStatus) ?? "pending",
    filePath: (r.file_path as string) ?? null,
    posterPath: (r.poster_path as string) ?? null,
    // Deterministic paths are overwritten on rebuild — version the URL so
    // the browser never serves a stale cut.
    videoUrl: r.file_path ? `${videoUrl(String(r.file_path))}?v=${String(r.updated_at ?? "").replace(/\D/g, "")}` : null,
    posterUrl: r.poster_path ? `${videoUrl(String(r.poster_path))}?v=${String(r.updated_at ?? "").replace(/\D/g, "")}` : null,
    durationSec: (r.duration_sec as number) ?? null,
    caption: (r.caption as string) ?? null,
    approvedAt: (r.approved_at as string) ?? null,
    shopifyPublishedAt: (r.shopify_published_at as string) ?? null,
    error: (r.error as string) ?? null,
    updatedAt: (r.updated_at as string) ?? null,
  }));
}
