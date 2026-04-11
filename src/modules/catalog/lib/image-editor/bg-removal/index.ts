/**
 * Background removal method router.
 *
 * Dispatches to the appropriate background removal implementation
 * based on the requested method. Currently supports:
 *   - `threshold`: fast, pixel-level removal for white/light backgrounds
 *   - `gemini`: (future) AI-powered removal via Gemini API
 */
import {
  removeBackgroundThreshold,
  autoDetectThreshold,
  generateThresholdVariations,
  type ThresholdOptions,
  type AutoDetectResult,
  type ThresholdVariation,
} from "./threshold";

/** Supported background removal methods. */
export type BgRemovalMethod = "threshold" | "gemini";

/** Union of all method-specific option types. */
export type BgRemovalOptions =
  | { method: "threshold"; threshold: number; feather?: number }
  | { method: "gemini" };

/**
 * Remove the background from an image using the specified method.
 *
 * @param buffer - Source image buffer.
 * @param options - Method selection and method-specific parameters.
 * @returns PNG buffer with transparent background.
 * @throws If the requested method is not yet implemented.
 */
export async function removeBackground(
  buffer: Buffer,
  options: BgRemovalOptions,
): Promise<Buffer> {
  switch (options.method) {
    case "threshold":
      return removeBackgroundThreshold(buffer, {
        threshold: options.threshold,
        feather: options.feather,
      });

    case "gemini":
      throw new Error(
        "Gemini background removal is not yet implemented. Use 'threshold' method for now.",
      );

    default:
      throw new Error(
        `Unknown background removal method: ${(options as { method: string }).method}`,
      );
  }
}

export {
  removeBackgroundThreshold,
  autoDetectThreshold,
  generateThresholdVariations,
  type ThresholdOptions,
  type AutoDetectResult,
  type ThresholdVariation,
};
