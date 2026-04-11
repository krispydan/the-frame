/**
 * Bottom-edge shadow: a subtle gradient shadow along the bottom of the
 * product, simulating the way light falls off where an object meets
 * a surface.
 */
import sharp from "sharp";
import { findAlphaBoundingBox, toRawRGBA } from "../utils/alpha-ops";

/** Options for bottom-edge shadow. */
export interface BottomEdgeShadowOptions {
  /**
   * Height of the shadow gradient as a fraction of the product height.
   * Default: 0.08 (8% of product height).
   */
  heightFraction?: number;
  /** Shadow opacity at the darkest point, 0-1. Default: 0.2. */
  opacity?: number;
  /** Blur radius (sigma) for softening. Default: 5. */
  blurRadius?: number;
  /** Shadow color as [R, G, B]. Default: [0, 0, 0]. */
  color?: [number, number, number];
}

/**
 * Add a subtle bottom-edge shadow to an RGBA image.
 *
 * The shadow is a horizontal gradient band placed just below the product's
 * bottom edge, fading from `opacity` at the top to 0 at the bottom.
 * The band width is constrained to the product's horizontal extent.
 *
 * @param buffer - RGBA PNG buffer of the product (transparent bg).
 * @param options - Shadow appearance settings.
 * @returns RGBA PNG buffer with bottom-edge shadow behind the product.
 */
export async function addBottomEdgeShadow(
  buffer: Buffer,
  options: BottomEdgeShadowOptions = {},
): Promise<Buffer> {
  const {
    heightFraction = 0.08,
    opacity = 0.2,
    blurRadius = 5,
    color = [0, 0, 0],
  } = options;

  const meta = await sharp(buffer).metadata();
  const srcWidth = meta.width!;
  const srcHeight = meta.height!;

  // Find the content bounding box to know where the bottom edge is
  const bbox = await findAlphaBoundingBox(buffer);
  if (!bbox) {
    // Fully transparent — just return the input
    return buffer;
  }

  const productBottom = bbox.top + bbox.height;
  const shadowHeight = Math.max(2, Math.round(bbox.height * heightFraction));

  // Expand canvas if shadow extends beyond current bounds
  const canvasHeight = Math.max(srcHeight, productBottom + shadowHeight);

  // Build the shadow gradient band as raw pixels
  const bandWidth = bbox.width;
  const bandPixels = Buffer.alloc(bandWidth * shadowHeight * 4);

  for (let y = 0; y < shadowHeight; y++) {
    // Linear falloff: full opacity at y=0, zero at y=shadowHeight
    const t = 1 - y / shadowHeight;
    const alpha = Math.round(t * opacity * 255);

    for (let x = 0; x < bandWidth; x++) {
      const offset = (y * bandWidth + x) * 4;
      bandPixels[offset] = color[0];
      bandPixels[offset + 1] = color[1];
      bandPixels[offset + 2] = color[2];
      bandPixels[offset + 3] = alpha;
    }
  }

  // Encode and blur the shadow band
  const bandPng = await sharp(bandPixels, {
    raw: { width: bandWidth, height: shadowHeight, channels: 4 },
  })
    .png()
    .toBuffer();

  const blurredBand = await sharp(bandPng)
    .blur(Math.max(0.3, blurRadius))
    .png()
    .toBuffer();

  // Composite: shadow band behind product on (possibly expanded) canvas
  const result = await sharp({
    create: {
      width: srcWidth,
      height: canvasHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .png()
    .composite([
      { input: blurredBand, left: bbox.left, top: productBottom },
      { input: buffer, left: 0, top: 0 },
    ])
    .png()
    .toBuffer();

  return result;
}
