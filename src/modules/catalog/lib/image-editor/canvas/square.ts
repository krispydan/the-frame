/**
 * Square canvas placement: center a product image on a square canvas
 * with configurable size, background color, padding, and JPEG quality.
 */
import sharp from "sharp";

/** Options for square canvas placement. */
export interface SquareCanvasOptions {
  /** Canvas size in pixels (square). Default: 2048. */
  size?: number;
  /**
   * Background color as a hex string (e.g. "#F8F9FA") or CSS-style.
   * Default: "#F8F9FA".
   */
  background?: string;
  /**
   * Padding as a fraction of the canvas size (0-0.5).
   * The product is scaled to fit within `(1 - padding*2) * size`.
   * Default: 0.
   */
  padding?: number;
  /** JPEG quality (1-100). Default: 95. */
  quality?: number;
}

/** Result of a canvas placement operation. */
export interface SquareCanvasResult {
  /** Final JPEG buffer. */
  buffer: Buffer;
  /** Output width (same as size). */
  width: number;
  /** Output height (same as size). */
  height: number;
  /** File size in bytes. */
  fileSize: number;
}

/**
 * Parse a hex color string to Sharp-compatible RGBA components.
 */
function parseHexColor(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);
  return { r, g, b };
}

/**
 * Place an RGBA image centered on a square canvas and output as JPEG.
 *
 * The product is resized to fit within the padded area (maintaining
 * aspect ratio) and composited on top of the solid background color.
 * The output is a flat RGB JPEG with no alpha channel.
 *
 * @param buffer - RGBA PNG buffer of the product (with or without shadow).
 * @param options - Canvas size, background, padding, and quality settings.
 * @returns JPEG buffer with metadata.
 */
export async function placeOnSquareCanvas(
  buffer: Buffer,
  options: SquareCanvasOptions = {},
): Promise<SquareCanvasResult> {
  const {
    size = 2048,
    background = "#F8F9FA",
    padding = 0,
    quality = 95,
  } = options;

  const bg = parseHexColor(background);

  // Calculate the available area after padding
  const clampedPadding = Math.max(0, Math.min(0.5, padding));
  const availableSize = Math.round(size * (1 - clampedPadding * 2));

  // Resize the product to fit within the available area
  const resized = await sharp(buffer)
    .resize({
      width: availableSize,
      height: availableSize,
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  const resizedMeta = await sharp(resized).metadata();
  const resizedWidth = resizedMeta.width!;
  const resizedHeight = resizedMeta.height!;

  // Center the product on the canvas
  const left = Math.round((size - resizedWidth) / 2);
  const top = Math.round((size - resizedHeight) / 2);

  // Create background canvas and composite the product
  const result = await sharp({
    create: {
      width: size,
      height: size,
      channels: 3,
      background: bg,
    },
  })
    .jpeg({ quality, mozjpeg: true, chromaSubsampling: "4:2:0" })
    .composite([{ input: resized, left, top }])
    .jpeg({ quality, mozjpeg: true, chromaSubsampling: "4:2:0" })
    .toBuffer();

  return {
    buffer: result,
    width: size,
    height: size,
    fileSize: result.length,
  };
}
