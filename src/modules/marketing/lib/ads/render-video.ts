/**
 * Video ad renderer — one ffmpeg pass per (ad × ratio):
 *
 *   clip → crop to ratio (shared crop engine, upper-centre gravity +
 *   the ad's stored nudge) → scale to output px → overlay the card PNG
 *   (built by card.ts at final pixel size) → drawtext the product name
 *   into the card's text band (+ optional headline on the media) →
 *   H.264/AAC, faststart → ads/{yyyy-mm}/{convention-named file}.
 *
 * Idempotent per render row: re-running a done render overwrites the
 * same key and updates the same row (queue is at-least-once).
 */
import { writeFile, unlink } from "fs/promises";
import { eq, and } from "drizzle-orm";
import { db, sqlite } from "@/lib/db";
import { ads, adRenders, videoClips } from "@/modules/marketing/schema";
import { materializeVideo, storeVideoFile, videoScratchPath } from "@/lib/storage/videos";
import { runFfmpeg, ffprobe } from "../video/ffmpeg";
import { AD_RATIOS, cropWindow, isAdRatio, type AdRatio } from "./ratios";
import { getAdRecipe, effectiveLayout, parseLayoutOverrides } from "./recipes";
import { buildCard, resolveCardImage, AD_FONT } from "./card";
import { renderFileName } from "./ad-naming";

/** R2/volume key for a render: ads/{YYYY-MM}/{convention file name}. */
export function adRenderPath(adName: string, ratio: AdRatio, kind: "video" | "image", createdAt: Date): string {
  const yyyymm = `${createdAt.getFullYear()}-${String(createdAt.getMonth() + 1).padStart(2, "0")}`;
  return `ads/${yyyymm}/${renderFileName(adName, ratio, kind)}`;
}

/** drawtext-safe escaping for text baked into a filtergraph. */
export function escapeDrawtext(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/:/g, "\\:").replace(/%/g, "\\%");
}

export interface AdRenderResult {
  ratio: AdRatio;
  r2Key: string;
  width: number;
  height: number;
  durationSec: number;
  sizeBytes: number;
}

export async function renderVideoAd(adId: string, ratio: string): Promise<AdRenderResult> {
  if (!isAdRatio(ratio)) throw new Error(`Unknown ratio: ${ratio}`);
  try {
    return await renderVideoAdInner(adId, ratio);
  } catch (e) {
    // Mark the render row failed for ANY error — a validation failure
    // (clip archived, image deleted) must not leave the row 'queued'
    // forever while the job retries toward the same wall.
    db.update(adRenders)
      .set({ status: "failed", error: String(e), updatedAt: new Date().toISOString() })
      .where(and(eq(adRenders.adId, adId), eq(adRenders.ratio, ratio)))
      .run();
    settleAdStatus(adId);
    throw e;
  }
}

async function renderVideoAdInner(adId: string, ratio: AdRatio): Promise<AdRenderResult> {
  const ad = db.select().from(ads).where(eq(ads.id, adId)).get();
  if (!ad) throw new Error(`Ad ${adId} not found`);
  if (ad.kind !== "video" || ad.backgroundType !== "clip") {
    throw new Error(`Ad ${adId} is not a clip-backed video ad`);
  }
  const recipe = getAdRecipe(ad.recipe);
  if (!recipe) throw new Error(`Ad ${adId} uses unknown recipe '${ad.recipe}'`);

  const clip = db.select().from(videoClips).where(eq(videoClips.id, ad.backgroundRef)).get();
  if (!clip || clip.status !== "ready" || !clip.normalizedPath) {
    throw new Error(`Background clip ${ad.backgroundRef} is not ready`);
  }

  // Card contents: product name + front image.
  const sku = sqlite.prepare(`
    SELECT s.id, p.name AS productName FROM catalog_skus s
    JOIN catalog_products p ON p.id = s.product_id WHERE s.id = ?
  `).get(ad.skuId) as { id: string; productName: string } | undefined;
  if (!sku) throw new Error(`SKU ${ad.skuId} not found`);
  const cardImage = resolveCardImage(ad.skuId, ad.cardImageId);
  if (!cardImage) throw new Error(`SKU ${ad.skuId} has no catalog image for the card`);
  // '' override = hide the name entirely.
  const cardText = (ad.displayNameOverride ?? sku.productName).trim();

  const frame = AD_RATIOS[ratio];
  const layout = effectiveLayout(recipe, ratio, parseLayoutOverrides(ad.layoutOverrides)[ratio]);
  const card = await buildCard({ recipe, ratio, layout, productImagePath: cardImage.absPath });

  const crop = cropWindow(clip.width ?? 1080, clip.height ?? 1920, ratio, layout.bgOffsetX, layout.bgOffsetY);

  const cardTmp = videoScratchPath(`ad-${adId}-${ratio}-card.png`);
  const outTmp = videoScratchPath(`ad-${adId}-${ratio}.mp4`);
  const posterTmp = videoScratchPath(`ad-${adId}-${ratio}-poster.jpg`);
  const cleanups: Array<() => Promise<void>> = [
    async () => unlink(cardTmp).catch(() => {}),
    async () => unlink(outTmp).catch(() => {}),
    async () => unlink(posterTmp).catch(() => {}),
  ];

  try {
    await writeFile(cardTmp, card.png);
    const src = await materializeVideo(clip.normalizedPath);
    cleanups.push(src.cleanup);

    // Filtergraph: crop+scale the clip, overlay the card, then text.
    const filters: string[] = [
      `[0:v]crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},` +
        `scale=${frame.width}:${frame.height},setsar=1[bg]`,
      `[bg][1:v]overlay=${card.x}:${card.y}[withcard]`,
    ];
    let last = "withcard";
    if (cardText) {
      // Centred inside the card's text band (frame-absolute geometry
      // reported by buildCard). Uppercase — matches the reference look.
      filters.push(
        `[${last}]drawtext=fontfile=${AD_FONT}:text='${escapeDrawtext(cardText.toUpperCase())}':` +
          `fontcolor=black:fontsize=${card.text.fontSize}:` +
          `x=${card.text.x}+(${card.text.width}-text_w)/2:` +
          `y=${card.text.y}+(${card.text.height}-text_h)/2[named]`,
      );
      last = "named";
    }
    if (ad.headline?.trim()) {
      // Headline sits in the top safe area, white with a soft shadow.
      filters.push(
        `[${last}]drawtext=fontfile=${AD_FONT}:text='${escapeDrawtext(ad.headline.trim())}':` +
          `fontcolor=white:shadowcolor=black@0.5:shadowx=2:shadowy=2:` +
          `fontsize=${Math.round(frame.width * 0.055)}:` +
          `x=(w-text_w)/2:y=h*0.08[headlined]`,
      );
      last = "headlined";
    }

    await runFfmpeg([
      "-y",
      "-i", src.path,
      "-i", cardTmp,
      "-filter_complex", filters.join(";"),
      "-map", `[${last}]`, "-map", "0:a?",
      "-c:v", "libx264", "-profile:v", "high", "-level", "4.1",
      "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-ar", "44100", "-ac", "2", "-b:a", "128k",
      "-movflags", "+faststart",
      outTmp,
    ]);

    const probe = await ffprobe(outTmp);
    if (probe.width !== frame.width || probe.height !== frame.height) {
      throw new Error(`Render came out ${probe.width}x${probe.height}, expected ${frame.width}x${frame.height}`);
    }

    await runFfmpeg(["-y", "-i", outTmp, "-frames:v", "1", "-q:v", "3", posterTmp]);

    const createdAt = new Date();
    const r2Key = adRenderPath(ad.name, ratio, "video", createdAt);
    const posterKey = r2Key.replace(/\.mp4$/, "_poster.jpg");
    await storeVideoFile(outTmp, r2Key);
    await storeVideoFile(posterTmp, posterKey);

    db.update(adRenders)
      .set({
        status: "done", r2Key, posterKey,
        width: probe.width, height: probe.height,
        durationSec: probe.durationSec, sizeBytes: probe.sizeBytes,
        error: null, updatedAt: new Date().toISOString(),
      })
      .where(and(eq(adRenders.adId, adId), eq(adRenders.ratio, ratio)))
      .run();
    settleAdStatus(adId);

    return {
      ratio, r2Key,
      width: probe.width, height: probe.height,
      durationSec: probe.durationSec, sizeBytes: probe.sizeBytes,
    };
  } finally {
    for (const c of cleanups) await c();
  }
}

/**
 * Roll the renders' states up into the ad's status: any failed → failed,
 * any still pending → rendering, else ready. Draft/published/archived
 * ads are not touched by late-arriving render completions.
 */
export function settleAdStatus(adId: string): void {
  const rows = sqlite.prepare(
    `SELECT status, COUNT(*) n FROM marketing_ad_renders WHERE ad_id = ? GROUP BY status`,
  ).all(adId) as Array<{ status: string; n: number }>;
  const count = (s: string) => rows.find((r) => r.status === s)?.n ?? 0;
  const next =
    count("failed") > 0 ? "failed"
    : count("queued") + count("rendering") > 0 ? "rendering"
    : "ready";
  sqlite.prepare(
    `UPDATE marketing_ads SET status = ?, error = ?, updated_at = datetime('now')
      WHERE id = ? AND status IN ('rendering', 'ready', 'failed')`,
  ).run(
    next,
    next === "failed"
      ? (sqlite.prepare(
          `SELECT error FROM marketing_ad_renders WHERE ad_id = ? AND status='failed' AND error IS NOT NULL LIMIT 1`,
        ).get(adId) as { error: string } | undefined)?.error ?? null
      : null,
    adId,
  );
}
