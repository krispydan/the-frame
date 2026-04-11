/**
 * Shadow method router.
 *
 * Dispatches to the appropriate shadow implementation based on the
 * requested method:
 *   - `gaussian`: classic drop shadow (offset + blur)
 *   - `silhouette`: squashed contact shadow beneath the product
 *   - `bottom-edge`: subtle gradient along the product's bottom
 *   - `none`: no shadow (pass-through)
 *   - `gemini`: (future) AI-generated realistic shadows
 */
import {
  addGaussianShadow,
  type GaussianShadowOptions,
} from "./gaussian";
import {
  addSilhouetteShadow,
  type SilhouetteShadowOptions,
} from "./silhouette";
import {
  addBottomEdgeShadow,
  type BottomEdgeShadowOptions,
} from "./bottom-edge";

/** Supported shadow methods. */
export type ShadowMethod = "none" | "gaussian" | "silhouette" | "bottom-edge" | "gemini";

/** Union of all method-specific shadow option types. */
export type ShadowOptions =
  | { method: "none" }
  | ({ method: "gaussian" } & GaussianShadowOptions)
  | ({ method: "silhouette" } & SilhouetteShadowOptions)
  | ({ method: "bottom-edge" } & BottomEdgeShadowOptions)
  | { method: "gemini" };

/**
 * Add a shadow to an RGBA image using the specified method.
 *
 * @param buffer - RGBA PNG buffer of the product (transparent bg).
 * @param options - Method selection and method-specific parameters.
 * @returns RGBA PNG buffer with shadow applied (or unchanged for "none").
 * @throws If the requested method is not yet implemented.
 */
export async function addShadow(
  buffer: Buffer,
  options: ShadowOptions,
): Promise<Buffer> {
  switch (options.method) {
    case "none":
      return buffer;

    case "gaussian": {
      const { method: _, ...opts } = options;
      return addGaussianShadow(buffer, opts);
    }

    case "silhouette": {
      const { method: _, ...opts } = options;
      return addSilhouetteShadow(buffer, opts);
    }

    case "bottom-edge": {
      const { method: _, ...opts } = options;
      return addBottomEdgeShadow(buffer, opts);
    }

    case "gemini":
      throw new Error(
        "Gemini shadow generation is not yet implemented. Use 'gaussian', 'silhouette', or 'bottom-edge'.",
      );

    default:
      throw new Error(
        `Unknown shadow method: ${(options as { method: string }).method}`,
      );
  }
}

export {
  addGaussianShadow,
  addSilhouetteShadow,
  addBottomEdgeShadow,
  type GaussianShadowOptions,
  type SilhouetteShadowOptions,
  type BottomEdgeShadowOptions,
};
