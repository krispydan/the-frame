/**
 * Image-ad backgrounds.
 *
 * GET  — browse catalog images for the wizard's background picker
 *        (?search= matches product name / SKU / colour; ?skuId= narrows
 *        to one SKU). Returns servable URLs for both storage
 *        generations (volume via /api/images, R2 via its public URL).
 * POST — upload a custom background (raw body; ?filename= for the
 *        extension). Stored content-addressed under ads/backgrounds/ on
 *        the videos storage, so R2 serves it where configured. Returns
 *        the key to pass as backgroundRef with backgroundType 'upload'.
 */
export const dynamic = "force-dynamic";

import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { sqlite } from "@/lib/db";
import { catalogImageUrl } from "@/lib/storage/image-url";
import { saveVideo, videoUrl } from "@/lib/storage/videos";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const search = searchParams.get("search") || "";
  const skuId = searchParams.get("skuId") || "";
  const limit = Math.min(120, parseInt(searchParams.get("limit") || "60", 10));

  const clauses = ["(i.file_path IS NOT NULL OR i.url IS NOT NULL)"];
  const params: unknown[] = [];
  if (skuId) { clauses.push("i.sku_id = ?"); params.push(skuId); }
  for (const term of search.split(/\s+/).filter(Boolean)) {
    clauses.push("(p.name LIKE ? OR s.sku LIKE ? OR s.color_name LIKE ?)");
    const like = `%${term}%`;
    params.push(like, like, like);
  }

  const rows = sqlite.prepare(`
    SELECT i.id, i.file_path, i.url, i.width, i.height, i.is_best,
           s.sku, p.name AS productName
    FROM catalog_images i
    JOIN catalog_skus s ON s.id = i.sku_id
    JOIN catalog_products p ON p.id = s.product_id
    WHERE ${clauses.join(" AND ")}
    ORDER BY i.is_best DESC,
             CASE i.status WHEN 'approved' THEN 0 WHEN 'review' THEN 1 ELSE 2 END,
             i.position ASC
    LIMIT ?
  `).all(...params, limit) as Array<Record<string, unknown>>;

  return NextResponse.json({
    images: rows.map((r) => ({
      id: r.id,
      sku: r.sku,
      productName: r.productName,
      width: r.width,
      height: r.height,
      url: catalogImageUrl(r.file_path as string | null, r.url as string | null),
    })),
  });
}

export async function POST(request: NextRequest) {
  const buf = Buffer.from(await request.arrayBuffer());
  if (!buf.length) return NextResponse.json({ error: "Empty body" }, { status: 400 });
  if (buf.length > 30 * 1024 * 1024) {
    return NextResponse.json({ error: "Background too large (30MB max)" }, { status: 413 });
  }
  // Must actually be an image, and big enough that a 1080px crop of it
  // won't ship blurry to Meta.
  let width = 0, height = 0, format = "";
  try {
    const meta = await sharp(buf).metadata();
    width = meta.width ?? 0;
    height = meta.height ?? 0;
    format = meta.format ?? "";
  } catch {
    return NextResponse.json({ error: "Not a readable image" }, { status: 400 });
  }
  if (Math.min(width, height) < 800) {
    return NextResponse.json(
      { error: `Image is ${width}x${height} — shortest side must be ≥800px for a usable crop` },
      { status: 400 },
    );
  }

  const ext = format === "png" ? "png" : "jpg";
  const key = `ads/backgrounds/${createHash("sha256").update(buf).digest("hex").slice(0, 16)}.${ext}`;
  // Content-addressed: re-uploading the same file is a no-op overwrite.
  await saveVideo(buf, key);
  return NextResponse.json({ key, url: videoUrl(key), width, height }, { status: 201 });
}
