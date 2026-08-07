/**
 * One ad.
 *
 * GET    — full detail: ad + renders (with URLs) + background clip info
 *          + card image URL, everything the detail page needs in one call.
 * PATCH  — edits. Layout/text/card changes mark affected renders stale;
 *          pass rerender=1 to also queue the re-renders immediately.
 *          Publishing stamps published_at; editing a PUBLISHED ad bumps
 *          version and regenerates the name (the old name keeps meaning
 *          the old creative in Ads Manager — names are immutable facts).
 * DELETE — archive (soft). Files stay in storage; storage hygiene can
 *          reap archived ads' renders later if we ever care.
 */
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { jobQueue } from "@/modules/core/lib/job-queue";
import { buildAdName } from "@/modules/marketing/lib/ads/ad-naming";
import { getAdRecipe, parseLayoutOverrides } from "@/modules/marketing/lib/ads/recipes";
import { isAdRatio } from "@/modules/marketing/lib/ads/ratios";
import { resolveCardImage } from "@/modules/marketing/lib/ads/card";
import { videoUrl } from "@/lib/storage/videos";
import { catalogImageUrl } from "@/lib/storage/image-url";

function loadAd(id: string) {
  return sqlite.prepare(`
    SELECT a.*, s.sku, s.color_name, p.name AS product_name
    FROM marketing_ads a
    LEFT JOIN catalog_skus s ON s.id = a.sku_id
    LEFT JOIN catalog_products p ON p.id = s.product_id
    WHERE a.id = ?
  `).get(id) as Record<string, unknown> | undefined;
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ad = loadAd(id);
  if (!ad) return NextResponse.json({ error: "Ad not found" }, { status: 404 });

  const renders = (sqlite.prepare(
    `SELECT * FROM marketing_ad_renders WHERE ad_id = ? ORDER BY ratio`,
  ).all(id) as Array<Record<string, unknown>>).map((r) => ({
    ...r,
    url: r.r2_key ? videoUrl(r.r2_key as string) : null,
    posterUrl: r.poster_key ? videoUrl(r.poster_key as string) : null,
  }));

  const clip = ad.background_type === "clip"
    ? sqlite.prepare(`
        SELECT id, file_name, duration_sec, width, height, talent, poster_path
        FROM marketing_video_clips WHERE id = ?
      `).get(ad.background_ref as string) as Record<string, unknown> | undefined
    : undefined;
  if (clip?.poster_path) clip.posterUrl = videoUrl(clip.poster_path as string);

  const cardImage = resolveCardImage(ad.sku_id as string, ad.card_image_id as string | null);
  return NextResponse.json({
    ad: {
      ...ad,
      layout_overrides: parseLayoutOverrides(ad.layout_overrides as string | null),
      ratios: JSON.parse((ad.ratios as string) || "[]"),
    },
    renders,
    clip: clip ?? null,
    cardImage: cardImage
      ? { imageId: cardImage.imageId, source: cardImage.source, url: catalogImageUrl(cardImage.relPath, cardImage.url) }
      : null,
  });
}

export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ad = loadAd(id);
  if (!ad) return NextResponse.json({ error: "Ad not found" }, { status: 404 });
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  let visualsChanged = false;

  if (typeof body.layoutOverrides === "object" && body.layoutOverrides !== null) {
    // Accept only known ratios and plain objects — the canvas editor
    // sends partials and garbage must not reach the renderer.
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body.layoutOverrides as Record<string, unknown>)) {
      if (isAdRatio(k) && v && typeof v === "object" && !Array.isArray(v)) clean[k] = v;
    }
    sets.push("layout_overrides = ?");
    params.push(JSON.stringify(clean));
    visualsChanged = true;
  }
  if (typeof body.displayNameOverride === "string" || body.displayNameOverride === null) {
    sets.push("display_name_override = ?");
    params.push(body.displayNameOverride);
    visualsChanged = true;
  }
  if (typeof body.headline === "string" || body.headline === null) {
    sets.push("headline = ?");
    params.push(typeof body.headline === "string" && body.headline.trim() ? body.headline.trim() : null);
    visualsChanged = true;
  }
  if (typeof body.cardImageId === "string" || body.cardImageId === null) {
    sets.push("card_image_id = ?");
    params.push(body.cardImageId);
    visualsChanged = true;
  }
  if (typeof body.copyVariant === "string" && /^C\d{2}$/.test(body.copyVariant)) {
    sets.push("copy_variant = ?");
    params.push(body.copyVariant);
  }

  let statusChange: string | null = null;
  if (body.status === "published" && ad.status === "ready") {
    sets.push("status = 'published'", "published_at = datetime('now')");
    statusChange = "published";
  } else if (body.status === "archived") {
    sets.push("status = 'archived'");
    statusChange = "archived";
  } else if (typeof body.status === "string" && body.status !== ad.status) {
    return NextResponse.json(
      { error: `Cannot set status '${body.status}' from '${ad.status}'` },
      { status: 400 },
    );
  }

  // Version bump: editing the visuals or copy of a PUBLISHED ad makes it
  // a new creative — same inputs, next version, regenerated name. The ad
  // returns to rendering and its renders are requeued below.
  const editingPublished = ad.status === "published" && (visualsChanged || typeof body.copyVariant === "string") && statusChange === null;
  if (editingPublished) {
    const recipe = getAdRecipe(ad.recipe as string);
    const nextVersion = (ad.version as number) + 1;
    const nextName = buildAdName({
      recipe: recipe?.code ?? (ad.recipe as string),
      kind: ad.kind as "video" | "image" | "carousel",
      productName: (ad.product_name as string) ?? "PRODUCT",
      sku: (ad.sku as string) ?? "NA-NA",
      talent: ad.talent as string,
      copyVariant: typeof body.copyVariant === "string" ? body.copyVariant : (ad.copy_variant as string),
      version: nextVersion,
    });
    sets.push("version = ?", "name = ?", "status = 'rendering'", "published_at = NULL");
    params.push(nextVersion, nextName);
  }

  if (!sets.length) return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  sets.push("updated_at = datetime('now')");
  sqlite.prepare(`UPDATE marketing_ads SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);

  // Re-render when visuals changed and the caller asked for it (the
  // canvas editor batches drag edits and re-renders once on save).
  const wantsRerender = request.nextUrl.searchParams.get("rerender") === "1" || editingPublished;
  if (visualsChanged && wantsRerender && ad.kind === "video") {
    const ratios = (JSON.parse((ad.ratios as string) || "[]") as string[]).filter(isAdRatio);
    for (const ratio of ratios) {
      sqlite.prepare(`
        INSERT INTO marketing_ad_renders (id, ad_id, ratio, kind, status)
        VALUES (lower(hex(randomblob(16))), ?, ?, 'video', 'queued')
        ON CONFLICT (ad_id, ratio)
        DO UPDATE SET status = 'queued', error = NULL, updated_at = datetime('now')
      `).run(id, ratio);
      jobQueue.enqueue("marketing.ads.render", "marketing", { adId: id, ratio }, { priority: 3 });
    }
    if (!editingPublished) {
      sqlite.prepare(`UPDATE marketing_ads SET status = 'rendering' WHERE id = ? AND status IN ('ready','failed')`).run(id);
    }
  }

  return NextResponse.json({ ok: true, ad: loadAd(id) });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const res = sqlite.prepare(
    `UPDATE marketing_ads SET status = 'archived', updated_at = datetime('now') WHERE id = ?`,
  ).run(id);
  if (res.changes === 0) return NextResponse.json({ error: "Ad not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
