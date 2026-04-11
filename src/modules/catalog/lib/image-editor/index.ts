/**
 * Image Editor module — public API.
 *
 * This is the main entry point for the image processing pipeline used
 * to turn raw factory photos into Shopify-ready product images.
 *
 * Pipeline stages: raw → no_bg → crop → shadow → final
 */

// ---------------------------------------------------------------------------
// Pipeline orchestrator
// ---------------------------------------------------------------------------
export {
  runPipeline,
  runFromStage,
  PIPELINE_STAGES,
  type PipelineStage,
  type PipelineConfig,
  type PipelineResult,
  type StageResult,
} from "./pipeline";

// ---------------------------------------------------------------------------
// Background removal
// ---------------------------------------------------------------------------
export {
  removeBackground,
  removeBackgroundThreshold,
  autoDetectThreshold,
  generateThresholdVariations,
  type BgRemovalMethod,
  type BgRemovalOptions,
  type ThresholdOptions,
  type AutoDetectResult,
  type ThresholdVariation,
} from "./bg-removal";

// ---------------------------------------------------------------------------
// Auto-crop
// ---------------------------------------------------------------------------
export {
  autoCrop,
  type AutoCropOptions,
  type AutoCropResult,
} from "./crop/auto-crop";

// ---------------------------------------------------------------------------
// Shadows
// ---------------------------------------------------------------------------
export {
  addShadow,
  addGaussianShadow,
  addSilhouetteShadow,
  addBottomEdgeShadow,
  type ShadowMethod,
  type ShadowOptions,
  type GaussianShadowOptions,
  type SilhouetteShadowOptions,
  type BottomEdgeShadowOptions,
} from "./shadow";

// ---------------------------------------------------------------------------
// Canvas
// ---------------------------------------------------------------------------
export {
  placeOnSquareCanvas,
  type SquareCanvasOptions,
  type SquareCanvasResult,
} from "./canvas/square";

export {
  generateCollectionImage,
  type CollectionVariant,
  type CollectionImageOptions,
  type CollectionImageResult,
} from "./canvas/collection";

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
export {
  sampleCorners,
  isWhiteBackground,
  type RGBColor,
  type CornerSamples,
} from "./utils/color-sample";

export {
  toRawRGBA,
  fromRawRGBA,
  extractAlpha,
  applyAlpha,
  findAlphaBoundingBox,
  type RawImageData,
} from "./utils/alpha-ops";
