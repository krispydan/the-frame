/**
 * The product card — one sharp implementation shared by video ads
 * (composited by ffmpeg `overlay`) and image ads (composited by sharp),
 * so the card is pixel-identical across formats.
 *
 * The card PNG contains the white rounded rect + the product image.
 * The NAME TEXT is deliberately NOT in the PNG: text is drawn by ffmpeg
 * drawtext with the bundled brand font — the one text engine this repo
 * trusts in production (system fonts caused tofu before; see
 * caption-burn.ts). `buildCard` returns the text band geometry in
 * frame-absolute pixels so the renderer can place drawtext exactly.
 */
import path from "path";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import sharp from "sharp";
import { sqlite } from "@/lib/db";
import { getFullPath } from "@/lib/storage/local";
import { AD_RATIOS, type AdRatio } from "./ratios";
import type { AdRecipe, RatioLayout } from "./recipes";

/** Bundled brand font — same file caption-burn uses. */
export const AD_FONT = path.join(
  process.cwd(), "src", "modules", "marketing", "assets", "fonts", "HookText-Bold.ttf",
);

export interface ResolvedCardImage {
  /** Absolute path on the images volume — may not exist (see url). */
  absPath: string | null;
  /** IMAGES_PATH-relative path (what catalogImageUrl serves). */
  relPath: string | null;
  /** R2/public URL fallback — newer catalog images live on R2 only. */
  url: string | null;
  imageId: string;
  /** Which artifact won: pipeline cutout or the base photo. */
  source: "final" | "no_bg" | "base";
}

/**
 * The image that goes on the card for a SKU: the requested catalog
 * image (or the SKU's best one — isBest, then approved, same order the
 * SKU reference uses), preferring its background-removed pipeline
 * artifact (`final` = cutout + shadow, then `no_bg`) over the raw
 * photo, since the card is a white surface.
 *
 * A catalog image's bytes live EITHER on the images volume (file_path,
 * older uploads + all pipeline artifacts) OR on R2 (url, newer uploads
 * via the MCP tool) — production has both generations, so the render
 * must be able to feed on either (loadCardImageBuffer).
 */
export function resolveCardImage(skuId: string, cardImageId?: string | null): ResolvedCardImage | null {
  const image = cardImageId
    ? sqlite.prepare(
        `SELECT id, file_path, url FROM catalog_images
          WHERE id = ? AND (file_path IS NOT NULL OR url IS NOT NULL)`,
      ).get(cardImageId) as { id: string; file_path: string | null; url: string | null } | undefined
    : sqlite.prepare(`
        SELECT id, file_path, url FROM catalog_images
         WHERE sku_id = ? AND (file_path IS NOT NULL OR url IS NOT NULL)
         ORDER BY is_best DESC,
                  CASE status WHEN 'approved' THEN 0 WHEN 'review' THEN 1 ELSE 2 END,
                  position ASC
         LIMIT 1
      `).get(skuId) as { id: string; file_path: string | null; url: string | null } | undefined;
  if (!image) return null;

  const artifact = sqlite.prepare(`
    SELECT stage, file_path FROM catalog_image_pipelines
     WHERE image_id = ? AND status = 'completed' AND stage IN ('final', 'no_bg')
     ORDER BY CASE stage WHEN 'final' THEN 0 ELSE 1 END
     LIMIT 1
  `).get(image.id) as { stage: "final" | "no_bg"; file_path: string } | undefined;

  const rel = artifact?.file_path ?? image.file_path;
  return {
    absPath: rel ? getFullPath(rel) : null,
    relPath: rel,
    // Pipeline artifacts are always local; the R2 url belongs to the
    // BASE image, so it only stands in when we're using the base.
    url: artifact ? null : image.url,
    imageId: image.id,
    source: artifact?.stage ?? "base",
  };
}

/**
 * The actual pixels for the card: local file when it exists, else the
 * R2 url. The explicit existence check turns "sharp: Input file is
 * missing" into an error that names the image and what was tried.
 */
export async function loadCardImageBuffer(resolved: ResolvedCardImage): Promise<Buffer> {
  if (resolved.absPath && existsSync(resolved.absPath)) {
    return readFile(resolved.absPath);
  }
  if (resolved.url) {
    const res = await fetch(resolved.url);
    if (!res.ok) {
      throw new Error(`Card image ${resolved.imageId}: fetch of ${resolved.url} returned ${res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }
  throw new Error(
    `Card image ${resolved.imageId} has no readable bytes ` +
    `(local ${resolved.relPath ?? "—"} missing, no R2 url)`,
  );
}

export interface BuiltCard {
  /** RGBA PNG of the card (rect + product image, no text). */
  png: Buffer;
  /** Frame-absolute top-left where the renderer overlays the PNG. */
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * Frame-absolute band where the product name goes, plus the font
   * size — the renderer centres drawtext inside it.
   */
  text: { x: number; y: number; width: number; height: number; fontSize: number };
}

/**
 * Build the card PNG for one ratio at final pixel size (no scaling
 * after compositing — text and corners stay crisp).
 */
export async function buildCard(opts: {
  recipe: AdRecipe;
  ratio: AdRatio;
  layout: RatioLayout;
  /** Path on disk or the image bytes (R2-backed images arrive as buffers). */
  productImage: string | Buffer;
}): Promise<BuiltCard> {
  const frame = AD_RATIOS[opts.ratio];
  const width = Math.round(opts.layout.cardW * frame.width);
  const height = Math.round(width / opts.recipe.cardAspect);
  const x = Math.round(opts.layout.cardX * frame.width);
  const y = Math.round(opts.layout.cardY * frame.height);

  // Card-local geometry: padding all round, image area above the text
  // band. Fractions of card size so every ratio renders the same card.
  const pad = Math.round(width * 0.045);
  const radius = Math.round(width * 0.035);
  const bandH = Math.round(height * 0.24);
  const imgBoxW = width - pad * 2;
  const imgBoxH = height - bandH - pad * 2;

  const rect = Buffer.from(
    `<svg width="${width}" height="${height}"><rect width="${width}" height="${height}" rx="${radius}" ry="${radius}" fill="#ffffff"/></svg>`,
  );

  const product = await sharp(opts.productImage)
    .trim({ threshold: 12 }) // tighten around the cutout/photo
    .resize(imgBoxW, imgBoxH, { fit: "inside", withoutEnlargement: false })
    .png()
    .toBuffer();
  const meta = await sharp(product).metadata();
  const pw = meta.width ?? imgBoxW;
  const ph = meta.height ?? imgBoxH;

  const png = await sharp(rect)
    .composite([{
      input: product,
      left: pad + Math.round((imgBoxW - pw) / 2),
      top: pad + Math.round((imgBoxH - ph) / 2),
    }])
    .png()
    .toBuffer();

  return {
    png,
    x, y, width, height,
    text: {
      x,
      y: y + height - bandH - Math.round(pad / 2),
      width,
      height: bandH,
      fontSize: Math.round(bandH * 0.42),
    },
  };
}
