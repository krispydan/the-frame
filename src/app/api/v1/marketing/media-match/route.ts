/**
 * /api/v1/marketing/media-match — AI SKU identification review queue.
 *
 * GET  ?type=clip|image&filter=queue|all&limit=
 *   List media of that type with their match state. `queue` (default)
 *   returns items still needing attention (no confirmed match), newest
 *   first; `all` includes confirmed/no_product.
 *
 * POST — queue identification jobs.
 *   Body: { mediaType: "clip"|"image", mediaIds?: string[], all?: true, force?: boolean }
 *   `all` targets every eligible item that doesn't already have a
 *   suggestion/confirmation (force re-runs suggested/failed too).
 *
 * PATCH — confirm a review decision + write the tags.
 *   Body: { mediaType, mediaId, productIds: string[] }  → tag products
 *         { mediaType, mediaId, noProduct: true }       → nothing identifiable
 *   For clips, productIds replace the clip's product tags (expanded to
 *   all the products' SKUs — we tag parent products). For catalog
 *   images, the image's sku_id is reassigned to the confirmed product's
 *   matched colorway.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { videoUrl } from "@/lib/storage/videos";
import { jobQueue } from "@/modules/core/lib/job-queue";

type MediaType = "clip" | "image";

function parseType(v: string | null): MediaType {
  return v === "image" ? "image" : "clip";
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const type = parseType(searchParams.get("type"));
  const filter = searchParams.get("filter") === "all" ? "all" : "queue";
  const limit = Math.min(Math.max(Number(searchParams.get("limit")) || 100, 1), 300);

  let items: Array<Record<string, unknown>>;
  if (type === "clip") {
    // "Untagged only" (queue) = clips with NO product tags yet, minus ones
    // already reviewed as "no product". "All" shows tagged clips too so you
    // can change/add their products.
    const queueClause =
      filter === "queue"
        ? `AND NOT EXISTS (SELECT 1 FROM marketing_video_clip_products cp2 WHERE cp2.clip_id = c.id)
           AND (m.status IS NULL OR m.status != 'no_product')`
        : "";
    const rows = sqlite.prepare(`
      SELECT c.id, c.file_name AS fileName, c.poster_path AS posterPath,
             c.normalized_path AS normalizedPath, c.duration_sec AS durationSec,
             m.id AS matchId, m.status AS matchStatus, m.candidates_json AS candidatesJson,
             m.confirmed_product_ids AS confirmedProductIds, m.error AS matchError
      FROM marketing_video_clips c
      LEFT JOIN marketing_media_matches m ON m.media_type = 'clip' AND m.media_id = c.id
      WHERE c.status = 'ready' ${queueClause}
      ORDER BY (m.status = 'suggested') DESC, c.created_at DESC
      LIMIT ?
    `).all(limit) as Array<Record<string, unknown>>;

    const productStmt = sqlite.prepare(`
      SELECT DISTINCT p.id, p.name
      FROM marketing_video_clip_products cp
      JOIN catalog_skus s ON s.id = cp.sku_id
      JOIN catalog_products p ON p.id = s.product_id
      WHERE cp.clip_id = ?
    `);
    items = rows.map((r) => ({
      mediaType: "clip",
      mediaId: r.id,
      fileName: r.fileName,
      mediaUrl: r.posterPath ? videoUrl(String(r.posterPath)) : null,
      previewUrl: r.normalizedPath ? videoUrl(String(r.normalizedPath)) : null,
      durationSec: r.durationSec,
      currentProducts: productStmt.all(r.id),
      matchStatus: r.matchStatus ?? null,
      candidates: r.candidatesJson ? JSON.parse(String(r.candidatesJson)) : [],
      confirmedProductIds: r.confirmedProductIds ? JSON.parse(String(r.confirmedProductIds)) : [],
      matchError: r.matchError ?? null,
    }));
  } else {
    // Catalog images already belong to a SKU, so "untagged" = no SKU
    // assigned. Use "All" to review/reassign images that already have one.
    const queueClause =
      filter === "queue"
        ? `AND i.sku_id IS NULL AND (m.status IS NULL OR m.status != 'no_product')`
        : "";
    const rows = sqlite.prepare(`
      SELECT i.id, i.file_path AS filePath, i.alt_text AS altText,
             s.sku, s.color_name AS colorName, p.name AS productName, p.id AS productId,
             m.status AS matchStatus, m.candidates_json AS candidatesJson,
             m.confirmed_product_ids AS confirmedProductIds, m.error AS matchError
      FROM catalog_images i
      LEFT JOIN catalog_skus s ON s.id = i.sku_id
      LEFT JOIN catalog_products p ON p.id = s.product_id
      LEFT JOIN marketing_media_matches m ON m.media_type = 'image' AND m.media_id = i.id
      WHERE i.file_path IS NOT NULL ${queueClause}
      ORDER BY (m.status = 'suggested') DESC, i.created_at DESC
      LIMIT ?
    `).all(limit) as Array<Record<string, unknown>>;
    items = rows.map((r) => ({
      mediaType: "image",
      mediaId: r.id,
      fileName: r.altText || r.filePath,
      mediaUrl: r.filePath ? `/api/images/${r.filePath}` : null,
      previewUrl: null,
      currentProducts: r.productId ? [{ id: r.productId, name: r.productName }] : [],
      currentSku: r.sku ?? null,
      matchStatus: r.matchStatus ?? null,
      candidates: r.candidatesJson ? JSON.parse(String(r.candidatesJson)) : [],
      confirmedProductIds: r.confirmedProductIds ? JSON.parse(String(r.confirmedProductIds)) : [],
      matchError: r.matchError ?? null,
    }));
  }

  // Products list for the manual-pick fallback (same grouping as /skus).
  const skuRows = sqlite.prepare(`
    SELECT s.id, p.id AS productId, p.name
    FROM catalog_skus s JOIN catalog_products p ON p.id = s.product_id
  `).all() as Array<{ id: string; productId: string; name: string | null }>;
  const byProduct = new Map<string, { id: string; name: string | null; skuIds: string[] }>();
  for (const r of skuRows) {
    const e = byProduct.get(r.productId) ?? { id: r.productId, name: r.name, skuIds: [] };
    e.skuIds.push(r.id);
    byProduct.set(r.productId, e);
  }

  return NextResponse.json({
    items,
    products: [...byProduct.values()].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")),
    aiConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
  });
}

export async function POST(request: NextRequest) {
  let body: { mediaType?: string; mediaIds?: string[]; all?: boolean; force?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const mediaType = parseType(body.mediaType ?? null);
  const force = body.force === true;

  let ids: string[];
  if (body.all) {
    // Everything eligible that still needs a suggestion. force also
    // re-runs items that already have one (or failed).
    const skipStatuses = force ? `('confirmed')` : `('confirmed','suggested','no_product')`;
    if (mediaType === "clip") {
      // Only spend AI on clips that still have NO product tags.
      ids = (sqlite.prepare(`
        SELECT c.id FROM marketing_video_clips c
        LEFT JOIN marketing_media_matches m ON m.media_type = 'clip' AND m.media_id = c.id
        WHERE c.status = 'ready' AND c.poster_path IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM marketing_video_clip_products cp WHERE cp.clip_id = c.id)
          AND (m.status IS NULL OR m.status NOT IN ${skipStatuses})
        LIMIT 500
      `).all() as Array<{ id: string }>).map((r) => r.id);
    } else {
      ids = (sqlite.prepare(`
        SELECT i.id FROM catalog_images i
        LEFT JOIN marketing_media_matches m ON m.media_type = 'image' AND m.media_id = i.id
        WHERE i.file_path IS NOT NULL AND i.sku_id IS NULL
          AND (m.status IS NULL OR m.status NOT IN ${skipStatuses})
        LIMIT 500
      `).all() as Array<{ id: string }>).map((r) => r.id);
    }
  } else {
    ids = (body.mediaIds ?? []).map(String).filter(Boolean);
  }
  if (ids.length === 0) {
    return NextResponse.json({ enqueued: 0, message: "Nothing to identify" });
  }

  for (const mediaId of ids) {
    jobQueue.enqueue("marketing.media.identify", "marketing", { mediaType, mediaId, force }, { priority: 4 });
  }
  return NextResponse.json({ enqueued: ids.length });
}

export async function PATCH(request: NextRequest) {
  let body: { mediaType?: string; mediaId?: string; productIds?: string[]; noProduct?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const mediaType = parseType(body.mediaType ?? null);
  const mediaId = String(body.mediaId ?? "");
  if (!mediaId) return NextResponse.json({ error: "mediaId is required" }, { status: 400 });

  const now = new Date().toISOString();
  const match = sqlite
    .prepare(`SELECT id, candidates_json AS candidatesJson FROM marketing_media_matches WHERE media_type = ? AND media_id = ?`)
    .get(mediaType, mediaId) as { id: string; candidatesJson: string | null } | undefined;

  const upsert = (status: string, confirmed: string[] | null) => {
    if (match) {
      sqlite
        .prepare(`UPDATE marketing_media_matches SET status = ?, confirmed_product_ids = ?, updated_at = ? WHERE id = ?`)
        .run(status, confirmed ? JSON.stringify(confirmed) : null, now, match.id);
    } else {
      sqlite
        .prepare(
          `INSERT INTO marketing_media_matches (id, media_type, media_id, status, confirmed_product_ids, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(crypto.randomUUID(), mediaType, mediaId, status, confirmed ? JSON.stringify(confirmed) : null, now, now);
    }
  };

  if (body.noProduct) {
    upsert("no_product", null);
    return NextResponse.json({ saved: true, status: "no_product" });
  }

  const productIds = (body.productIds ?? []).map(String).filter(Boolean);
  if (productIds.length === 0) {
    return NextResponse.json({ error: "productIds (or noProduct) is required" }, { status: 400 });
  }

  if (mediaType === "clip") {
    const clip = sqlite.prepare(`SELECT id FROM marketing_video_clips WHERE id = ?`).get(mediaId);
    if (!clip) return NextResponse.json({ error: "Clip not found" }, { status: 404 });
    // Product-level tagging: replace the clip's tags with every SKU of the
    // confirmed products (same expansion the pickers do).
    const skuIds = (sqlite
      .prepare(`SELECT id FROM catalog_skus WHERE product_id IN (${productIds.map(() => "?").join(",")})`)
      .all(...productIds) as Array<{ id: string }>).map((r) => r.id);
    sqlite.prepare(`DELETE FROM marketing_video_clip_products WHERE clip_id = ?`).run(mediaId);
    const insert = sqlite.prepare(
      `INSERT OR IGNORE INTO marketing_video_clip_products (id, clip_id, sku_id) VALUES (?, ?, ?)`,
    );
    for (const skuId of skuIds) insert.run(crypto.randomUUID(), mediaId, skuId);
  } else {
    const image = sqlite.prepare(`SELECT id FROM catalog_images WHERE id = ?`).get(mediaId);
    if (!image) return NextResponse.json({ error: "Image not found" }, { status: 404 });
    // A catalog image belongs to exactly one SKU. Prefer the matched
    // colorway from the AI candidates; fall back to the product's first SKU.
    const productId = productIds[0];
    const candidates = (match?.candidatesJson ? JSON.parse(match.candidatesJson) : []) as Array<{
      productId: string;
      skuId: string;
    }>;
    const fromCandidate = candidates.find((c) => c.productId === productId)?.skuId;
    const skuId =
      fromCandidate ??
      (sqlite.prepare(`SELECT id FROM catalog_skus WHERE product_id = ? ORDER BY sku ASC LIMIT 1`).get(productId) as
        | { id: string }
        | undefined)?.id;
    if (!skuId) return NextResponse.json({ error: "Product has no SKUs" }, { status: 400 });
    sqlite.prepare(`UPDATE catalog_images SET sku_id = ? WHERE id = ?`).run(skuId, mediaId);
  }

  upsert("confirmed", productIds);
  return NextResponse.json({ saved: true, status: "confirmed" });
}
