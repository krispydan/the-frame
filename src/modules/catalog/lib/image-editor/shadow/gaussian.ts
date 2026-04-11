/**
 * Gaussian drop shadow: a blurred, offset copy of the image's alpha
 * channel rendered as a dark overlay behind the product.
 */
import sharp from "sharp";
import { toRawRGBA, fromRawRGBA } from "../utils/alpha-ops";

/** Options for gaussian drop shadow. */
export interface GaussianShadowOptions {
  /** Horizontal offset in pixels. Default: 0. */
  offsetX?: number;
  /** Vertical offset in pixels. Default: 10. */
  offsetY?: number;
  /** Blur radius (sigma) for the shadow. Default: 15. */
  blurRadius?: number;
  /** Shadow opacity, 0-1. Default: 0.3. */
  opacity?: number;
  /** Shadow color as [R, G, B]. Default: [0, 0, 0] (black). */
  color?: [number, number, number];
}

/**
 * Add a gaussian drop shadow behind an RGBA image.
 *
 * The shadow is created by:
 * 1. Extracting the alpha channel
 * 2. Creating a solid-color layer with that alpha
 * 3. Blurring it
 * 4. Compositing: expanded canvas → shadow → original product
 *
 * The canvas auto-expands to fit both the shadow offset and blur spread.
 *
 * @param buffer - RGBA PNG buffer of the product (transparent bg).
 * @returns RGBA PNG buffer with shadow behind the product.
 */
export async function addGaussianShadow(
  buffer: Buffer,
  options: GaussianShadowOptions = {},
): Promise<Buffer> {
  const {
    offsetX = 0,
    offsetY = 10,
    blurRadius = 15,
    opacity = 0.3,
    color = [0, 0, 0],
  } = options;

  const meta = await sharp(buffer).metadata();
  const srcWidth = meta.width!;
  const srcHeight = meta.height!;

  // Calculate expanded canvas size to accommodate shadow offset + blur spread
  // Blur spread is roughly 3x sigma on each side
  const spread = Math.ceil(blurRadius * 3);
  const expandLeft = Math.max(0, spread - offsetX);
  const expandRight = Math.max(0, spread + offsetX);
  const expandTop = Math.max(0, spread - offsetY);
  const expandBottom = Math.max(0, spread + offsetY);

  const canvasWidth = srcWidth + expandLeft + expandRight;
  const canvasHeight = srcHeight + expandTop + expandBottom;

  // Position of the original image on the expanded canvas
  const productX = expandLeft;
  const productY = expandTop;

  // Position of the shadow on the expanded canvas
  const shadowX = productX + offsetX;
  const shadowY = productY + offsetY;

  // Create the shadow layer: product alpha * shadow color * opacity
  const { data: rawData } = await toRawRGBA(buffer);
  const pixelCount = srcWidth * srcHeight;
  const shadowPixels = Buffer.alloc(pixelCount * 4);

  for (let i = 0; i < pixelCount; i++) {
    const srcAlpha = rawData[i * 4 + 3];
    shadowPixels[i * 4] = color[0];
    shadowPixels[i * 4 + 1] = color[1];
    shadowPixels[i * 4 + 2] = color[2];
    shadowPixels[i * 4 + 3] = Math.round(srcAlpha * opacity);
  }

  // Encode shadow as PNG, then blur it
  const shadowPng = await sharp(shadowPixels, {
    raw: { width: srcWidth, height: srcHeight, channels: 4 },
  })
    .png()
    .toBuffer();

  const blurredShadow = await sharp(shadowPng)
    .blur(Math.max(0.3, blurRadius))
    .png()
    .toBuffer();

  // Composite on expanded transparent canvas: shadow first, then product on top
  const result = await sharp({
    create: {
      width: canvasWidth,
      height: canvasHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .png()
    .composite([
      { input: blurredShadow, left: shadowX, top: shadowY },
      { input: buffer, left: productX, top: productY },
    ])
    .png()
    .toBuffer();

  return result;
}
