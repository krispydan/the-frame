/**
 * /api/v1/marketing/media-match — SKU identification review queue.
 *
 * Identification is FILENAME matching + manual review (the AI vision
 * matcher was removed — it couldn't reliably tell the catalog apart).
 *
 * GET  ?type=clip|image&filter=queue|all&limit=
 *   List media of that type with their match state. `queue` (default)
 *   returns items still needing attention (untagged), newest first;
 *   `all` includes tagged media for re-review.
 *
 * POST — run filename matching NOW (synchronous, no AI, no jobs).
 *   Body: { mediaType: "clip"|"image", mediaIds?: string[], all?: true, apply?: boolean }
 *   apply (default true): strong filename matches are written straight
 *   onto the media; apply:false stores them as suggestions only.
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
import { identifyMedia, confirmMediaProducts, saveMediaNotes } from "@/modules/marketing/lib/video/sku-match";

type MediaType = "clip" | "image";

function parseType(v: string | null): MediaType {
  return v === "image" ? "image" : "clip";
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const type = parseType(searchParams.get("type"));
  const filter = searchParams.get("filter") === "all" ? "all" : "queue";
  const limit = Math.min(Math.max(Number(searchParams.get("limit")) || 100, 1), 300);

  // Best catalog image for a colorway (or the parent product) — shown on the
  // candidate cards so a reviewer can eyeball the media against the product.
  const skuImageStmt = sqlite.prepare(
    `SELECT file_path AS filePath FROM catalog_images WHERE sku_id = ? AND file_path IS NOT NULL
     ORDER BY is_best DESC, CASE status WHEN 'approved' THEN 0 WHEN 'review' THEN 1 ELSE 2 END, position ASC LIMIT 1`,
  );
  const productImageStmt = sqlite.prepare(
    `SELECT i.file_path AS filePath FROM catalog_images i JOIN catalog_skus s ON s.id = i.sku_id
     WHERE s.product_id = ? AND i.file_path IS NOT NULL
     ORDER BY i.is_best DESC, CASE i.status WHEN 'approved' THEN 0 WHEN 'review' THEN 1 ELSE 2 END, i.position ASC LIMIT 1`,
  );
  const imgUrlFor = (skuId?: string | null, productId?: string | null): string | null => {
    let fp: string | undefined;
    if (skuId) fp = (skuImageStmt.get(skuId) as { filePath?: string } | undefined)?.filePath;
    if (!fp && productId) fp = (productImageStmt.get(productId) as { filePath?: string } | undefined)?.filePath;
    return fp ? `/api/images/${fp}` : null;
  };
  const enrichCandidates = (cands: Array<Record<string, unknown>>) =>
    cands.map((c) => ({ ...c, imageUrl: imgUrlFor(c.skuId as string, c.productId as string) }));

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
             c.normalized_path AS normalizedPath, c.duration_sec AS durationSec, c.notes,
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
      currentProducts: (productStmt.all(r.id) as Array<{ id: string; name: string }>).map((p) => ({
        ...p,
        imageUrl: imgUrlFor(null, p.id),
      })),
      notes: r.notes ?? null,
      matchStatus: r.matchStatus ?? null,
      candidates: r.candidatesJson ? enrichCandidates(JSON.parse(String(r.candidatesJson))) : [],
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
      SELECT i.id, i.file_path AS filePath, i.alt_text AS altText, i.notes,
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
      currentProducts: r.productId
        ? [{ id: r.productId, name: r.productName, imageUrl: imgUrlFor(null, String(r.productId)) }]
        : [],
      currentSku: r.sku ?? null,
      notes: r.notes ?? null,
      matchStatus: r.matchStatus ?? null,
      candidates: r.candidatesJson ? enrichCandidates(JSON.parse(String(r.candidatesJson))) : [],
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
  const products = [...byProduct.values()]
    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""))
    .map((p) => ({ ...p, imageUrl: imgUrlFor(null, p.id) }));

  return NextResponse.json({
    items,
    products,
    aiConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
  });
}

export async function POST(request: NextRequest) {
  let body: { mediaType?: string; mediaIds?: string[]; all?: boolean; apply?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const mediaType = parseType(body.mediaType ?? null);
  // apply=true: strong filename matches are written straight onto the
  // media (the shoot naming convention is trusted); otherwise they're
  // stored as pre-ticked suggestions for review.
  const apply = body.apply !== false;

  let ids: string[];
  if (body.all) {
    if (mediaType === "clip") {
      ids = (sqlite.prepare(`
        SELECT c.id FROM marketing_video_clips c
        LEFT JOIN marketing_media_matches m ON m.media_type = 'clip' AND m.media_id = c.id
        WHERE c.status = 'ready'
          AND NOT EXISTS (SELECT 1 FROM marketing_video_clip_products cp WHERE cp.clip_id = c.id)
          AND (m.status IS NULL OR m.status NOT IN ('confirmed','no_product'))
        LIMIT 1000
      `).all() as Array<{ id: string }>).map((r) => r.id);
    } else {
      ids = (sqlite.prepare(`
        SELECT i.id FROM catalog_images i
        LEFT JOIN marketing_media_matches m ON m.media_type = 'image' AND m.media_id = i.id
        WHERE i.file_path IS NOT NULL AND i.sku_id IS NULL
          AND (m.status IS NULL OR m.status NOT IN ('confirmed','no_product'))
        LIMIT 1000
      `).all() as Array<{ id: string }>).map((r) => r.id);
    }
  } else {
    ids = (body.mediaIds ?? []).map(String).filter(Boolean);
  }
  if (ids.length === 0) {
    return NextResponse.json({ scanned: 0, applied: 0, suggested: 0, message: "Nothing to match" });
  }

  // Filename matching is pure string work — run it synchronously, no jobs.
  let applied = 0;
  let suggested = 0;
  for (const mediaId of ids) {
    try {
      const r = identifyMedia(mediaType, mediaId, { apply });
      if (r.applied) applied++;
      else if (r.status === "suggested") suggested++;
    } catch {
      /* one bad row must not sink the batch */
    }
  }
  return NextResponse.json({ scanned: ids.length, applied, suggested });
}

export async function PATCH(request: NextRequest) {
  let body: {
    mediaType?: string;
    mediaId?: string;
    productIds?: string[];
    noProduct?: boolean;
    /** Free-form reviewer notes; saved with either decision. Omit to leave untouched. */
    notes?: string | null;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const mediaType = parseType(body.mediaType ?? null);
  const mediaId = String(body.mediaId ?? "");
  if (!mediaId) return NextResponse.json({ error: "mediaId is required" }, { status: 400 });

  if (typeof body.notes === "string") saveMediaNotes(mediaType, mediaId, body.notes);

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
    // Notes-only save: keep the item in the queue, just persist the note.
    if (typeof body.notes === "string") {
      return NextResponse.json({ saved: true, status: "notes_only" });
    }
    return NextResponse.json({ error: "productIds (or noProduct) is required" }, { status: 400 });
  }

  const exists =
    mediaType === "clip"
      ? sqlite.prepare(`SELECT id FROM marketing_video_clips WHERE id = ?`).get(mediaId)
      : sqlite.prepare(`SELECT id FROM catalog_images WHERE id = ?`).get(mediaId);
  if (!exists) return NextResponse.json({ error: "Media not found" }, { status: 404 });

  const candidates = (match?.candidatesJson ? JSON.parse(match.candidatesJson) : []) as Array<{
    productId: string;
    skuId: string;
  }>;
  try {
    confirmMediaProducts(mediaType, mediaId, productIds, candidates);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
  return NextResponse.json({ saved: true, status: "confirmed" });
}
