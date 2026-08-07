/**
 * Ad renderer — one ffmpeg pass per (ad × ratio), for BOTH kinds:
 *
 *   video: clip → crop (shared engine: upper-centre gravity + stored
 *          nudge) → scale → overlay card PNG → drawtext name/headline →
 *          H.264/AAC faststart mp4 + poster jpg
 *   image: background image → same filtergraph → single-frame jpg
 *          (the jpg doubles as its own poster)
 *
 * One ffmpeg pipeline for both is deliberate: the card, the crop and
 * the text land pixel-identically whether the background moves or not.
 *
 * Idempotent per render row: deterministic output key, row updated in
 * place (queue is at-least-once).
 */
import { writeFile, unlink } from "fs/promises";
import sharp from "sharp";
import { eq, and } from "drizzle-orm";
import { db, sqlite } from "@/lib/db";
import { ads, adRenders, videoClips } from "@/modules/marketing/schema";
import { materializeVideo, storeVideoFile, videoScratchPath } from "@/lib/storage/videos";
import { runFfmpeg, ffprobe } from "../video/ffmpeg";
import { AD_RATIOS, cropWindow, isAdRatio, type AdRatio } from "./ratios";
import { getAdRecipe, effectiveLayout, parseLayoutOverrides } from "./recipes";
import { buildCard, resolveCardImage, loadCardImageBuffer, AD_FONT } from "./card";
import { renderFileName } from "./ad-naming";
import { getFullPath } from "@/lib/storage/local";
import { existsSync } from "fs";
import { readFile } from "fs/promises";

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

export async function renderAd(adId: string, ratio: string): Promise<AdRenderResult> {
  if (!isAdRatio(ratio)) throw new Error(`Unknown ratio: ${ratio}`);
  try {
    return await renderAdInner(adId, ratio);
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

/**
 * The background pixels for an IMAGE ad: a catalog image (volume or
 * R2, same two-generation reality as the card image) or an upload
 * sitting in ads/backgrounds/ on the videos storage.
 */
async function loadImageBackground(ad: { backgroundType: string; backgroundRef: string }): Promise<Buffer> {
  if (ad.backgroundType === "catalog_image") {
    const img = sqlite.prepare(
      `SELECT id, file_path, url FROM catalog_images WHERE id = ?`,
    ).get(ad.backgroundRef) as { id: string; file_path: string | null; url: string | null } | undefined;
    if (!img) throw new Error(`Background catalog image ${ad.backgroundRef} not found`);
    const abs = img.file_path ? getFullPath(img.file_path) : null;
    if (abs && existsSync(abs)) return readFile(abs);
    if (img.url) {
      const res = await fetch(img.url);
      if (!res.ok) throw new Error(`Background image ${img.id}: fetch returned ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    }
    throw new Error(`Background image ${img.id} has no readable bytes (local missing, no R2 url)`);
  }
  if (ad.backgroundType === "upload") {
    const m = await materializeVideo(ad.backgroundRef);
    try {
      return await readFile(m.path);
    } finally {
      await m.cleanup();
    }
  }
  throw new Error(`Unsupported image-ad background type '${ad.backgroundType}'`);
}

async function renderAdInner(adId: string, ratio: AdRatio): Promise<AdRenderResult> {
  const ad = db.select().from(ads).where(eq(ads.id, adId)).get();
  if (!ad) throw new Error(`Ad ${adId} not found`);
  if (ad.kind !== "video" && ad.kind !== "image") {
    throw new Error(`Ad ${adId} kind '${ad.kind}' cannot render yet`);
  }
  const isVideo = ad.kind === "video";
  const recipe = getAdRecipe(ad.recipe);
  if (!recipe) throw new Error(`Ad ${adId} uses unknown recipe '${ad.recipe}'`);

  // ── Background source ──
  let clipPath: string | null = null;
  let srcW: number, srcH: number;
  let bgTmp: string | null = null;
  const cleanups: Array<() => Promise<void>> = [];

  if (isVideo) {
    if (ad.backgroundType !== "clip") throw new Error(`Video ad ${adId} must have a clip background`);
    const clip = db.select().from(videoClips).where(eq(videoClips.id, ad.backgroundRef)).get();
    if (!clip || clip.status !== "ready" || !clip.normalizedPath) {
      throw new Error(`Background clip ${ad.backgroundRef} is not ready`);
    }
    srcW = clip.width ?? 1080;
    srcH = clip.height ?? 1920;
    const src = await materializeVideo(clip.normalizedPath);
    cleanups.push(src.cleanup);
    clipPath = src.path;
  } else {
    const bg = await loadImageBackground(ad);
    const meta = await sharp(bg).metadata();
    if (!meta.width || !meta.height) throw new Error(`Background image for ad ${adId} is unreadable`);
    srcW = meta.width;
    srcH = meta.height;
    bgTmp = videoScratchPath(`ad-${adId}-${ratio}-bg.png`);
    // Normalize exotic formats (HEIC/webp/CMYK) to png for ffmpeg.
    await writeFile(bgTmp, await sharp(bg).rotate().png().toBuffer());
    const bgTmpFixed = bgTmp;
    cleanups.push(async () => unlink(bgTmpFixed).catch(() => {}));
  }

  // ── Card ──
  const sku = sqlite.prepare(`
    SELECT s.id, p.name AS productName FROM catalog_skus s
    JOIN catalog_products p ON p.id = s.product_id WHERE s.id = ?
  `).get(ad.skuId) as { id: string; productName: string } | undefined;
  if (!sku) throw new Error(`SKU ${ad.skuId} not found`);
  const cardImage = resolveCardImage(ad.skuId, ad.cardImageId);
  if (!cardImage) throw new Error(`SKU ${ad.skuId} has no catalog image for the card`);
  const cardImageBuf = await loadCardImageBuffer(cardImage);
  // Product name only on the card (no colourway — deliberate); '' hides it.
  const cardText = (ad.displayNameOverride ?? sku.productName).trim();

  const frame = AD_RATIOS[ratio];
  const layout = effectiveLayout(recipe, ratio, parseLayoutOverrides(ad.layoutOverrides)[ratio]);
  const card = await buildCard({ recipe, ratio, layout, productImage: cardImageBuf });
  const crop = cropWindow(srcW, srcH, ratio, layout.bgOffsetX, layout.bgOffsetY);

  const ext = isVideo ? "mp4" : "jpg";
  const cardTmp = videoScratchPath(`ad-${adId}-${ratio}-card.png`);
  const outTmp = videoScratchPath(`ad-${adId}-${ratio}.${ext}`);
  const posterTmp = videoScratchPath(`ad-${adId}-${ratio}-poster.jpg`);
  cleanups.push(
    async () => unlink(cardTmp).catch(() => {}),
    async () => unlink(outTmp).catch(() => {}),
    async () => unlink(posterTmp).catch(() => {}),
  );

  try {
    await writeFile(cardTmp, card.png);

    // ── Filtergraph — identical for both kinds ──
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
      "-i", isVideo ? clipPath! : bgTmp!,
      "-i", cardTmp,
      "-filter_complex", filters.join(";"),
      "-map", `[${last}]`,
      ...(isVideo
        ? [
            "-map", "0:a?",
            "-c:v", "libx264", "-profile:v", "high", "-level", "4.1",
            "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-ar", "44100", "-ac", "2", "-b:a", "128k",
            "-movflags", "+faststart",
          ]
        : ["-frames:v", "1", "-q:v", "2"]),
      outTmp,
    ]);

    const probe = await ffprobe(outTmp);
    if (probe.width !== frame.width || probe.height !== frame.height) {
      throw new Error(`Render came out ${probe.width}x${probe.height}, expected ${frame.width}x${frame.height}`);
    }

    const createdAt = new Date();
    const r2Key = adRenderPath(ad.name, ratio, ad.kind, createdAt);
    let posterKey: string;
    if (isVideo) {
      await runFfmpeg(["-y", "-i", outTmp, "-frames:v", "1", "-q:v", "3", posterTmp]);
      posterKey = r2Key.replace(/\.mp4$/, "_poster.jpg");
      await storeVideoFile(outTmp, r2Key);
      await storeVideoFile(posterTmp, posterKey);
    } else {
      // The jpg IS its own poster — one file, two roles.
      posterKey = r2Key;
      await storeVideoFile(outTmp, r2Key);
    }

    db.update(adRenders)
      .set({
        status: "done", r2Key, posterKey,
        width: probe.width, height: probe.height,
        durationSec: isVideo ? probe.durationSec : null,
        sizeBytes: probe.sizeBytes,
        error: null, updatedAt: new Date().toISOString(),
      })
      .where(and(eq(adRenders.adId, adId), eq(adRenders.ratio, ratio)))
      .run();
    settleAdStatus(adId);

    return {
      ratio, r2Key,
      width: probe.width, height: probe.height,
      durationSec: isVideo ? probe.durationSec : 0,
      sizeBytes: probe.sizeBytes,
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
