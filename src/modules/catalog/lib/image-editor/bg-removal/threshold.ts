/**
 * Threshold-based background removal for white/light backgrounds.
 *
 * Iterates raw pixel data: any pixel where `min(R,G,B) >= threshold`
 * becomes transparent. An optional feather range creates a linear alpha
 * falloff near the threshold boundary for smoother edges.
 */
import sharp from "sharp";
import { sampleCorners, type CornerSamples } from "../utils/color-sample";
import { toRawRGBA, fromRawRGBA } from "../utils/alpha-ops";

/** Options for threshold-based background removal. */
export interface ThresholdOptions {
  /**
   * Pixels with `min(R,G,B) >= threshold` are made fully transparent.
   * Range: 0-255. Typical values for white backgrounds: 220-245.
   */
  threshold: number;
  /**
   * Width of the feather band below the threshold. Within this range,
   * alpha falls off linearly from 255 to 0.
   *
   * Example: threshold=240, feather=20 means:
   *   min >= 240 → alpha 0 (transparent)
   *   min 220-239 → alpha ramps 0..255
   *   min < 220 → alpha 255 (opaque)
   *
   * Default: 0 (hard cutoff, no feathering).
   */
  feather?: number;
}

/** Result from auto-detection including suggested values and raw samples. */
export interface AutoDetectResult {
  /** Suggested threshold that should work for this image. */
  suggestedThreshold: number;
  /** Suggested feather value. */
  suggestedFeather: number;
  /** Raw corner sample data for inspection. */
  cornerSamples: CornerSamples;
  /** Whether the background appears to be white/light. */
  isLikelyWhiteBg: boolean;
}

/** A labeled variation buffer for comparison. */
export interface ThresholdVariation {
  label: string;
  threshold: number;
  feather: number;
  buffer: Buffer;
}

/**
 * Remove the background from an image using threshold-based alpha masking.
 *
 * For each pixel, computes `min(R, G, B)`. If that value is at or above
 * the threshold, the pixel is made transparent. If feathering is enabled,
 * pixels in the feather band get partial transparency.
 *
 * @param buffer - Source image buffer (any format Sharp can decode).
 * @param options - Threshold and feather settings.
 * @returns PNG buffer with RGBA channels (background pixels transparent).
 */
export async function removeBackgroundThreshold(
  buffer: Buffer,
  options: ThresholdOptions,
): Promise<Buffer> {
  const { threshold, feather = 0 } = options;
  const { data, width, height } = await toRawRGBA(buffer);

  const featherStart = threshold - feather; // below this → fully opaque
  const pixelCount = width * height;

  for (let i = 0; i < pixelCount; i++) {
    const offset = i * 4;
    const r = data[offset];
    const g = data[offset + 1];
    const b = data[offset + 2];
    const minChannel = Math.min(r, g, b);

    if (minChannel >= threshold) {
      // Fully transparent — background pixel
      data[offset + 3] = 0;
    } else if (feather > 0 && minChannel > featherStart) {
      // Feather band — linear falloff
      // At minChannel == featherStart → alpha 255
      // At minChannel == threshold - 1 → alpha ~0
      const t = (threshold - minChannel) / feather; // 0..1 (0 at threshold, 1 at featherStart)
      data[offset + 3] = Math.round(t * 255);
    }
    // else: leave alpha unchanged (255 from ensureAlpha)
  }

  return fromRawRGBA(data, width, height);
}

/**
 * Analyze an image and suggest threshold/feather values for background
 * removal. Samples the four corners to determine background color.
 *
 * @param buffer - Source image buffer.
 * @returns Detection result with suggested values and diagnostic data.
 */
export async function autoDetectThreshold(
  buffer: Buffer,
): Promise<AutoDetectResult> {
  const cornerSamples = await sampleCorners(buffer);
  const { minChannel } = cornerSamples;

  // If the darkest corner channel is above 200, it's a white/light bg
  const isLikelyWhiteBg = minChannel >= 200;

  // Suggested threshold: slightly below the detected background level
  // to avoid eating into the product. We subtract 10 from the min channel.
  const suggestedThreshold = isLikelyWhiteBg
    ? Math.max(200, minChannel - 10)
    : Math.max(180, minChannel - 20);

  // Feather: 10-15 for clean white bgs, wider for noisier bgs
  const suggestedFeather = isLikelyWhiteBg ? 10 : 20;

  return {
    suggestedThreshold,
    suggestedFeather,
    cornerSamples,
    isLikelyWhiteBg,
  };
}

/**
 * Generate multiple threshold/feather variations of background removal
 * so the user can compare and pick the best result.
 *
 * @param buffer - Source image buffer.
 * @param thresholds - Array of threshold values to test.
 * @param feathers - Array of feather values to test (crossed with thresholds).
 * @returns Array of labeled variation buffers.
 */
export async function generateThresholdVariations(
  buffer: Buffer,
  thresholds: number[],
  feathers: number[],
): Promise<ThresholdVariation[]> {
  const variations: ThresholdVariation[] = [];

  for (const threshold of thresholds) {
    for (const feather of feathers) {
      const result = await removeBackgroundThreshold(buffer, {
        threshold,
        feather,
      });
      variations.push({
        label: `t${threshold}_f${feather}`,
        threshold,
        feather,
        buffer: result,
      });
    }
  }

  return variations;
}
