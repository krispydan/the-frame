/**
 * Ad Studio collection routes.
 *
 * GET  /api/v1/marketing/ads — library list. Filters: status, recipe,
 *      skuId, kind, search (matches the generated name — the convention
 *      makes plain LIKE surprisingly capable: "JADE", "PCARD", "BLK").
 * POST /api/v1/marketing/ads — create an ad from wizard inputs, insert
 *      one render row per enabled ratio and queue the render jobs. The
 *      name is generated here (buildAdName) and versioned _v01; a
 *      uniqueness collision bumps a numeric suffix on the product
 *      segment is NOT done — instead the same inputs at v01 mean "you
 *      already made this ad", surfaced as a 409 with the existing id.
 */
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { db, sqlite } from "@/lib/db";
import { ads, adRenders } from "@/modules/marketing/schema";
import { jobQueue } from "@/modules/core/lib/job-queue";
import { buildAdName } from "@/modules/marketing/lib/ads/ad-naming";
import { getAdRecipe } from "@/modules/marketing/lib/ads/recipes";
import { DEFAULT_RATIOS, isAdRatio, type AdRatio } from "@/modules/marketing/lib/ads/ratios";
import { resolveCardImage } from "@/modules/marketing/lib/ads/card";
import { videoUrl } from "@/lib/storage/videos";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const status = searchParams.get("status") || "";
  const recipe = searchParams.get("recipe") || "";
  const skuId = searchParams.get("skuId") || "";
  const kind = searchParams.get("kind") || "";
  const search = searchParams.get("search") || "";
  const limit = Math.min(200, parseInt(searchParams.get("limit") || "60", 10));
  const offset = parseInt(searchParams.get("offset") || "0", 10);

  const clauses: string[] = ["a.status != 'archived'"];
  const params: unknown[] = [];
  if (status) {
    clauses.length = 0;
    clauses.push("a.status = ?");
    params.push(status);
  }
  if (recipe) { clauses.push("a.recipe = ?"); params.push(recipe); }
  if (skuId) { clauses.push("a.sku_id = ?"); params.push(skuId); }
  if (kind) { clauses.push("a.kind = ?"); params.push(kind); }
  // One LIKE per word so "JADE TIGYEL" matches regardless of the order
  // the segments appear in the name.
  for (const term of search.split(/\s+/).filter(Boolean)) {
    clauses.push("a.name LIKE ?");
    params.push(`%${term}%`);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;

  const total = (sqlite.prepare(`SELECT COUNT(*) n FROM marketing_ads a ${where}`)
    .get(...params) as { n: number }).n;
  const rows = sqlite.prepare(`
    SELECT a.*, s.sku, p.name AS product_name
    FROM marketing_ads a
    LEFT JOIN catalog_skus s ON s.id = a.sku_id
    LEFT JOIN catalog_products p ON p.id = s.product_id
    ${where}
    ORDER BY a.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as Array<Record<string, unknown>>;

  const renderRows = rows.length
    ? sqlite.prepare(`
        SELECT ad_id, ratio, kind, status, r2_key, poster_key
        FROM marketing_ad_renders
        WHERE ad_id IN (${rows.map(() => "?").join(",")})
      `).all(...rows.map((r) => r.id)) as Array<Record<string, unknown>>
    : [];
  const byAd = new Map<string, Array<Record<string, unknown>>>();
  for (const r of renderRows) {
    const list = byAd.get(r.ad_id as string) ?? [];
    list.push({
      ratio: r.ratio, kind: r.kind, status: r.status,
      url: r.r2_key ? videoUrl(r.r2_key as string) : null,
      posterUrl: r.poster_key ? videoUrl(r.poster_key as string) : null,
    });
    byAd.set(r.ad_id as string, list);
  }

  return NextResponse.json({
    total,
    ads: rows.map((a) => ({ ...a, renders: byAd.get(a.id as string) ?? [] })),
  });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { backgroundType, backgroundRef, skuId } = body as Record<string, unknown>;
  const recipeSlug = typeof body.recipe === "string" ? body.recipe : "pcard";
  const recipe = getAdRecipe(recipeSlug);
  if (!recipe) return NextResponse.json({ error: `Unknown recipe '${recipeSlug}'` }, { status: 400 });
  // A1 scope: clip-backed video ads. Image backgrounds arrive with the
  // image renderer — reject rather than accept-and-fail-at-render.
  if (backgroundType !== "clip" || typeof backgroundRef !== "string" || !backgroundRef) {
    return NextResponse.json({ error: "backgroundType must be 'clip' with a clip id" }, { status: 400 });
  }
  if (typeof skuId !== "string" || !skuId) {
    return NextResponse.json({ error: "skuId is required" }, { status: 400 });
  }

  const clip = sqlite.prepare(
    `SELECT id, status, talent, duration_sec FROM marketing_video_clips WHERE id = ?`,
  ).get(backgroundRef) as { id: string; status: string; talent: string | null; duration_sec: number | null } | undefined;
  if (!clip) return NextResponse.json({ error: "Background clip not found" }, { status: 404 });
  if (clip.status !== "ready") {
    return NextResponse.json({ error: `Clip is not ready (status=${clip.status})` }, { status: 400 });
  }
  const sku = sqlite.prepare(`
    SELECT s.id, s.sku, p.name AS productName FROM catalog_skus s
    JOIN catalog_products p ON p.id = s.product_id WHERE s.id = ?
  `).get(skuId) as { id: string; sku: string; productName: string } | undefined;
  if (!sku) return NextResponse.json({ error: "SKU not found" }, { status: 404 });
  if (!resolveCardImage(sku.id, null)) {
    return NextResponse.json(
      { error: `${sku.sku} has no catalog image to put on the card` },
      { status: 400 },
    );
  }

  const ratios: AdRatio[] = Array.isArray(body.ratios) && body.ratios.length
    ? (body.ratios as unknown[]).filter(isAdRatio)
    : [...DEFAULT_RATIOS];
  if (!ratios.length) return NextResponse.json({ error: "No valid ratios" }, { status: 400 });

  const copyVariant = typeof body.copyVariant === "string" && /^C\d{2}$/.test(body.copyVariant)
    ? body.copyVariant : "C00";

  // Same inputs → same name; the unique index makes duplicates explicit.
  const name = buildAdName({
    recipe: recipe.code,
    kind: "video",
    productName: sku.productName,
    sku: sku.sku,
    talent: clip.talent,
    copyVariant,
    version: 1,
  });
  const existing = sqlite.prepare(`SELECT id FROM marketing_ads WHERE name = ?`).get(name) as { id: string } | undefined;
  if (existing) {
    return NextResponse.json(
      { error: `An ad with these exact inputs already exists (${name})`, id: existing.id, name },
      { status: 409 },
    );
  }

  const inserted = db.insert(ads).values({
    name,
    recipe: recipe.slug,
    kind: "video",
    backgroundType: "clip",
    backgroundRef,
    skuId: sku.id,
    cardImageId: typeof body.cardImageId === "string" ? body.cardImageId : null,
    displayNameOverride: typeof body.displayNameOverride === "string" ? body.displayNameOverride : null,
    headline: typeof body.headline === "string" && body.headline.trim() ? body.headline.trim() : null,
    talent: clip.talent ?? "none",
    copyVariant,
    ratios: JSON.stringify(ratios),
    status: "rendering",
  }).returning({ id: ads.id }).get();

  for (const ratio of ratios) {
    db.insert(adRenders).values({ adId: inserted.id, ratio, kind: "video", status: "queued" }).run();
    jobQueue.enqueue("marketing.ads.render", "marketing", { adId: inserted.id, ratio }, { priority: 3 });
  }

  return NextResponse.json({ id: inserted.id, name, ratios }, { status: 201 });
}
