/**
 * GET /api/v1/marketing/videos/clips — clip library list.
 *
 * Filters: status, category (id or slug), skuId, talent (name, or "none"
 * for clips with nobody in them), untagged=1, search.
 * Returns clips with category + product joins and public asset URLs,
 * plus the distinct talent list for the UI's pickers/datalists.
 */
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { videoUrl } from "@/lib/storage/videos";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const status = searchParams.get("status") || "";
  const category = searchParams.get("category") || "";
  const skuId = searchParams.get("skuId") || "";
  const talent = searchParams.get("talent") || "";
  const untagged = searchParams.get("untagged") === "1";
  const search = searchParams.get("search") || "";
  const limit = Math.min(500, parseInt(searchParams.get("limit") || "200", 10));
  const offset = parseInt(searchParams.get("offset") || "0", 10);

  const clauses: string[] = ["c.status != 'archived'"];
  const params: unknown[] = [];

  if (status) {
    clauses.length = 0; // explicit status filter includes archived
    clauses.push("c.status = ?");
    params.push(status);
  }
  if (category) {
    clauses.push("(cat.id = ? OR cat.slug = ?)");
    params.push(category, category);
  }
  if (untagged) clauses.push("c.category_id IS NULL");
  if (talent === "none") {
    clauses.push("c.talent IS NULL");
  } else if (talent) {
    clauses.push("c.talent = ?");
    params.push(talent);
  }
  if (skuId) {
    clauses.push("EXISTS (SELECT 1 FROM marketing_video_clip_products cp WHERE cp.clip_id = c.id AND cp.sku_id = ?)");
    params.push(skuId);
  }
  if (search) {
    clauses.push("(c.file_name LIKE ? OR c.notes LIKE ?)");
    params.push(`%${search}%`, `%${search}%`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = sqlite.prepare(`
    SELECT c.*, cat.slug AS category_slug, cat.name AS category_name
    FROM marketing_video_clips c
    LEFT JOIN marketing_video_clip_categories cat ON cat.id = c.category_id
    ${where}
    ORDER BY c.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as Array<Record<string, unknown>>;

  const total = (sqlite.prepare(`
    SELECT COUNT(*) AS n
    FROM marketing_video_clips c
    LEFT JOIN marketing_video_clip_categories cat ON cat.id = c.category_id
    ${where}
  `).get(...params) as { n: number }).n;

  const productStmt = sqlite.prepare(`
    SELECT cp.sku_id AS skuId, s.sku, s.color_name AS colorName, p.name AS productName
    FROM marketing_video_clip_products cp
    LEFT JOIN catalog_skus s ON s.id = cp.sku_id
    LEFT JOIN catalog_products p ON p.id = s.product_id
    WHERE cp.clip_id = ?
  `);

  const clips = rows.map((row) => ({
    ...row,
    posterUrl: row.poster_path ? videoUrl(String(row.poster_path)) : null,
    previewUrl: row.normalized_path ? videoUrl(String(row.normalized_path)) : null,
    products: productStmt.all(row.id) as Array<Record<string, unknown>>,
  }));

  // Distinct people across the whole library (not just this page) so
  // pickers always offer every known name — consistent spelling matters.
  const talents = (sqlite.prepare(`
    SELECT DISTINCT talent FROM marketing_video_clips
    WHERE talent IS NOT NULL AND talent != '' ORDER BY talent COLLATE NOCASE
  `).all() as Array<{ talent: string }>).map((r) => r.talent);

  return NextResponse.json({ clips, total, talents });
}
