/**
 * Silhouette contact shadow: the product's alpha shape squashed
 * vertically and placed beneath the product, then blurred to create
 * a realistic "contact with surface" shadow.
 */
import sharp from "sharp";
import { toRawRGBA } from "../utils/alpha-ops";

/** Options for silhouette contact shadow. */
export interface SilhouetteShadowOptions {
  /**
   * Vertical squash factor (0-1). The shadow height is multiplied by this.
   * Lower = flatter shadow. Default: 0.15.
   */
  squash?: number;
  /** Blur radius (sigma) for the shadow. Default: 12. */
  blurRadius?: number;
  /** Shadow opacity, 0-1. Default: 0.25. */
  opacity?: number;
  /** Shadow color as [R, G, B]. Default: [0, 0, 0] (black). */
  color?: [number, number, number];
  /**
   * How far below the product's bottom edge the shadow center sits,
   * as a fraction of the product height. Default: 0.02 (2%).
   */
  yOffset?: number;
}

/**
 * Add a silhouette contact shadow beneath an RGBA image.
 *
 * The shadow is created by:
 * 1. Creating a solid-color version of the product's alpha silhouette
 * 2. Squashing it vertically (resize height)
 * 3. Blurring it
 * 4. Positioning it beneath the product's bottom edge
 * 5. Compositing shadow behind the product on an expanded canvas
 *
 * @param buffer - RGBA PNG buffer of the product (transparent bg).
 * @param options - Shadow appearance settings.
 * @returns RGBA PNG buffer with contact shadow behind the product.
 */
export async function addSilhouetteShadow(
  buffer: Buffer,
  options: SilhouetteShadowOptions = {},
): Promise<Buffer> {
  const {
    squash = 0.15,
    blurRadius = 12,
    opacity = 0.25,
    color = [0, 0, 0],
    yOffset = 0.02,
  } = options;

  const meta = await sharp(buffer).metadata();
  const srcWidth = meta.width!;
  const srcHeight = meta.height!;

  // Create silhouette: same shape as product but solid shadow color
  const { data: rawData } = await toRawRGBA(buffer);
  const pixelCount = srcWidth * srcHeight;
  const silhouettePixels = Buffer.alloc(pixelCount * 4);

  for (let i = 0; i < pixelCount; i++) {
    const srcAlpha = rawData[i * 4 + 3];
    silhouettePixels[i * 4] = color[0];
    silhouettePixels[i * 4 + 1] = color[1];
    silhouettePixels[i * 4 + 2] = color[2];
    silhouettePixels[i * 4 + 3] = Math.round(srcAlpha * opacity);
  }

  // Squash the silhouette vertically
  const squashedHeight = Math.max(1, Math.round(srcHeight * squash));

  const squashedSilhouette = await sharp(silhouettePixels, {
    raw: { width: srcWidth, height: srcHeight, channels: 4 },
  })
    .resize({ width: srcWidth, height: squashedHeight, fit: "fill" })
    .png()
    .toBuffer();

  // Blur the squashed silhouette
  const blurredShadow = await sharp(squashedSilhouette)
    .blur(Math.max(0.3, blurRadius))
    .png()
    .toBuffer();

  const blurredMeta = await sharp(blurredShadow).metadata();
  const shadowWidth = blurredMeta.width!;
  const shadowHeight = blurredMeta.height!;

  // Calculate canvas: product + shadow below
  const shadowYPos = srcHeight + Math.round(srcHeight * yOffset) - Math.round(shadowHeight / 2);
  const canvasHeight = Math.max(srcHeight, shadowYPos + shadowHeight);
  const canvasWidth = Math.max(srcWidth, shadowWidth);

  // Center shadow horizontally relative to product
  const shadowXPos = Math.round((canvasWidth - shadowWidth) / 2);
  const productXPos = Math.round((canvasWidth - srcWidth) / 2);

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
      { input: blurredShadow, left: shadowXPos, top: shadowYPos },
      { input: buffer, left: productXPos, top: 0 },
    ])
    .png()
    .toBuffer();

  return result;
}
