/**
 * GET /api/v1/media — Media Center API
 *
 * Returns all catalog images with SKU + product context for the media center.
 * Supports search, pagination, filtering by status/product/type/pipeline.
 */
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const search = searchParams.get("search") || "";
  const status = searchParams.get("status") || "";
  const productId = searchParams.get("productId") || "";
  const imageType = searchParams.get("imageType") || "";
  const pipelineStatus = searchParams.get("pipelineStatus") || "";
  const source = searchParams.get("source") || "";
  const limit = Math.min(200, parseInt(searchParams.get("limit") || "60", 10));
  const offset = parseInt(searchParams.get("offset") || "0", 10);
  const sort = searchParams.get("sort") || "newest"; // newest, oldest, name, size

  const clauses: string[] = [];
  const params: unknown[] = [];

  if (search) {
    clauses.push("(cs.sku LIKE ? OR cp.name LIKE ? OR ci.alt_text LIKE ? OR cp.sku_prefix LIKE ?)");
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (status) {
    clauses.push("ci.status = ?");
    params.push(status);
  }
  if (productId) {
    clauses.push("cs.product_id = ?");
    params.push(productId);
  }
  if (imageType) {
    clauses.push("cit.slug = ?");
    params.push(imageType);
  }
  if (pipelineStatus) {
    clauses.push("ci.pipeline_status = ?");
    params.push(pipelineStatus);
  }
  if (source) {
    clauses.push("ci.source = ?");
    params.push(source);
  }

  // Only show images that have a file
  clauses.push("ci.file_path IS NOT NULL");

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

  const orderBy = sort === "oldest" ? "ci.created_at ASC"
    : sort === "name" ? "cs.sku ASC, ci.position ASC"
    : sort === "size" ? "ci.file_size DESC"
    : "ci.created_at DESC";

  const images = sqlite.prepare(`
    SELECT
      ci.id, ci.sku_id, ci.file_path, ci.url, ci.file_size, ci.mime_type,
      ci.checksum, ci.width, ci.height, ci.position, ci.alt_text,
      ci.status, ci.is_best, ci.pipeline_status, ci.source,
      ci.created_at,
      cs.sku, cs.color_name, cs.product_id,
      cp.name as product_name, cp.sku_prefix,
      cit.slug as image_type_slug, cit.label as image_type_label
    FROM catalog_images ci
    LEFT JOIN catalog_skus cs ON ci.sku_id = cs.id
    LEFT JOIN catalog_products cp ON cs.product_id = cp.id
    LEFT JOIN catalog_image_types cit ON ci.image_type_id = cit.id
    ${where}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const totalRow = sqlite.prepare(`
    SELECT COUNT(*) as count
    FROM catalog_images ci
    LEFT JOIN catalog_skus cs ON ci.sku_id = cs.id
    LEFT JOIN catalog_products cp ON cs.product_id = cp.id
    LEFT JOIN catalog_image_types cit ON ci.image_type_id = cit.id
    ${where}
  `).get(...params) as { count: number };

  // Aggregate stats
  const stats = sqlite.prepare(`
    SELECT
      COUNT(*) as total,
      COUNT(CASE WHEN ci.status = 'approved' THEN 1 END) as approved,
      COUNT(CASE WHEN ci.status = 'review' THEN 1 END) as review,
      COUNT(CASE WHEN ci.status = 'draft' THEN 1 END) as draft,
      COUNT(CASE WHEN ci.status = 'rejected' THEN 1 END) as rejected,
      COUNT(CASE WHEN ci.pipeline_status = 'completed' THEN 1 END) as processed,
      COUNT(CASE WHEN ci.pipeline_status = 'none' THEN 1 END) as unprocessed,
      COALESCE(SUM(ci.file_size), 0) as total_size,
      COUNT(DISTINCT cs.product_id) as product_count,
      COUNT(DISTINCT ci.sku_id) as sku_count
    FROM catalog_images ci
    LEFT JOIN catalog_skus cs ON ci.sku_id = cs.id
    WHERE ci.file_path IS NOT NULL
  `).get() as Record<string, number>;

  // Products for filter dropdown
  const products = sqlite.prepare(`
    SELECT DISTINCT cp.id, cp.sku_prefix, cp.name,
      COUNT(ci.id) as image_count
    FROM catalog_products cp
    JOIN catalog_skus cs ON cs.product_id = cp.id
    JOIN catalog_images ci ON ci.sku_id = cs.id
    WHERE ci.file_path IS NOT NULL
    GROUP BY cp.id
    ORDER BY cp.sku_prefix
  `).all();

  // Image types for filter dropdown
  const imageTypes = sqlite.prepare(
    "SELECT slug, label FROM catalog_image_types WHERE active = 1 ORDER BY sort_order"
  ).all();

  // Sources for filter dropdown
  const sources = sqlite.prepare(`
    SELECT ci.source, COUNT(*) as count
    FROM catalog_images ci
    WHERE ci.file_path IS NOT NULL AND ci.source IS NOT NULL
    GROUP BY ci.source
    ORDER BY ci.source
  `).all();

  return NextResponse.json({
    images,
    total: totalRow.count,
    limit,
    offset,
    stats,
    filters: { products, imageTypes, sources },
  });
}
