/**
 * Collection image compositing: combine multiple variant images of the
 * same product into a single collection/overview image.
 *
 * Layout rules:
 *   - 1-5 variants: single column, stacked vertically
 *   - 6+ variants: 2-column grid
 *   - Variants are ordered dark-to-light (by average luminance)
 */
import sharp from "sharp";
import { toRawRGBA } from "../utils/alpha-ops";

/** A single variant to include in the collection image. */
export interface CollectionVariant {
  /** Label for this variant (e.g. "Black", "Natural Oak"). */
  label: string;
  /** RGBA PNG buffer of the processed product. */
  buffer: Buffer;
}

/** Options for collection image generation. */
export interface CollectionImageOptions {
  /** Canvas width. Default: 2048. */
  canvasWidth?: number;
  /** Canvas height. Default: 2048. */
  canvasHeight?: number;
  /** Background color hex. Default: "#F8F9FA". */
  background?: string;
  /**
   * Padding around each cell as a fraction of cell size.
   * Default: 0.05 (5%).
   */
  cellPadding?: number;
  /** JPEG quality. Default: 95. */
  quality?: number;
}

/** Result of a collection image generation. */
export interface CollectionImageResult {
  /** Final JPEG buffer. */
  buffer: Buffer;
  /** Output width. */
  width: number;
  /** Output height. */
  height: number;
  /** File size in bytes. */
  fileSize: number;
  /** Number of variants included. */
  variantCount: number;
  /** Layout used. */
  layout: "single-column" | "two-column";
}

/**
 * Compute the average luminance of an RGBA image (ignoring transparent pixels).
 * Used for dark-to-light ordering of variants.
 */
async function averageLuminance(buffer: Buffer): Promise<number> {
  const { data, width, height } = await toRawRGBA(buffer);
  const pixelCount = width * height;
  let lumSum = 0;
  let opaqueCount = 0;

  for (let i = 0; i < pixelCount; i++) {
    const alpha = data[i * 4 + 3];
    if (alpha < 10) continue; // skip nearly-transparent pixels
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    // Perceived luminance (BT.601)
    lumSum += 0.299 * r + 0.587 * g + 0.114 * b;
    opaqueCount++;
  }

  return opaqueCount > 0 ? lumSum / opaqueCount : 128;
}

/**
 * Parse a hex color string to Sharp-compatible RGB components.
 */
function parseHexColor(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace("#", "");
  return {
    r: parseInt(clean.substring(0, 2), 16),
    g: parseInt(clean.substring(2, 4), 16),
    b: parseInt(clean.substring(4, 6), 16),
  };
}

/**
 * Generate a collection image by compositing multiple product variants
 * onto a single canvas.
 *
 * Variants are automatically sorted dark-to-light by average luminance.
 * Layout adapts based on count: single column for 1-5, 2-column grid for 6+.
 *
 * @param variants - Array of labeled variant buffers.
 * @param options - Canvas size, background, and quality settings.
 * @returns JPEG collection image buffer with metadata.
 * @throws If no variants are provided.
 */
export async function generateCollectionImage(
  variants: CollectionVariant[],
  options: CollectionImageOptions = {},
): Promise<CollectionImageResult> {
  if (variants.length === 0) {
    throw new Error("Cannot generate collection image: no variants provided.");
  }

  const {
    canvasWidth = 2048,
    canvasHeight = 2048,
    background = "#F8F9FA",
    cellPadding = 0.05,
    quality = 95,
  } = options;

  const bg = parseHexColor(background);

  // Sort variants dark-to-light
  const luminances = await Promise.all(
    variants.map(async (v) => ({
      variant: v,
      luminance: await averageLuminance(v.buffer),
    })),
  );
  luminances.sort((a, b) => a.luminance - b.luminance);
  const sorted = luminances.map((l) => l.variant);

  // Determine layout
  const count = sorted.length;
  const useTwoColumns = count >= 6;
  const columns = useTwoColumns ? 2 : 1;
  const rows = Math.ceil(count / columns);

  const cellWidth = Math.floor(canvasWidth / columns);
  const cellHeight = Math.floor(canvasHeight / rows);
  const padX = Math.round(cellWidth * cellPadding);
  const padY = Math.round(cellHeight * cellPadding);
  const innerWidth = cellWidth - padX * 2;
  const innerHeight = cellHeight - padY * 2;

  // Resize each variant to fit its cell
  const compositeInputs: { input: Buffer; left: number; top: number }[] = [];

  for (let i = 0; i < count; i++) {
    const col = i % columns;
    const row = Math.floor(i / columns);

    // Auto-crop transparent padding before resizing so the product
    // fills the cell instead of being tiny with huge margins
    const trimmed = await sharp(sorted[i].buffer)
      .trim()
      .png()
      .toBuffer();

    const resized = await sharp(trimmed)
      .resize({
        width: innerWidth,
        height: innerHeight,
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();

    const resizedMeta = await sharp(resized).metadata();
    const rw = resizedMeta.width!;
    const rh = resizedMeta.height!;

    // Center within the cell
    const cellLeft = col * cellWidth;
    const cellTop = row * cellHeight;
    const left = cellLeft + padX + Math.round((innerWidth - rw) / 2);
    const top = cellTop + padY + Math.round((innerHeight - rh) / 2);

    compositeInputs.push({ input: resized, left, top });
  }

  // Create the final canvas
  const result = await sharp({
    create: {
      width: canvasWidth,
      height: canvasHeight,
      channels: 3,
      background: bg,
    },
  })
    .jpeg({ quality, mozjpeg: true })
    .composite(compositeInputs)
    .jpeg({ quality, mozjpeg: true })
    .toBuffer();

  return {
    buffer: result,
    width: canvasWidth,
    height: canvasHeight,
    fileSize: result.length,
    variantCount: count,
    layout: useTwoColumns ? "two-column" : "single-column",
  };
}
