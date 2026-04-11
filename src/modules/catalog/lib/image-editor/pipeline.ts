/**
 * Pipeline orchestrator: chains image processing stages together.
 *
 * Stages (in order):
 *   1. raw     — original factory photo (input)
 *   2. no_bg   — background removed (transparent PNG)
 *   3. crop    — auto-cropped to content bounding box
 *   4. shadow  — shadow added beneath product
 *   5. final   — placed on square canvas (JPEG output)
 *
 * Each stage records timing, dimensions, file size, and a SHA-256 checksum.
 */
import { createHash } from "crypto";
import sharp from "sharp";
import { removeBackground, type BgRemovalOptions } from "./bg-removal";
import { autoCrop, type AutoCropOptions } from "./crop/auto-crop";
import { addShadow, type ShadowOptions } from "./shadow";
import { placeOnSquareCanvas, type SquareCanvasOptions } from "./canvas/square";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The five pipeline stages in processing order. */
export type PipelineStage = "raw" | "no_bg" | "crop" | "shadow" | "final";

/** Ordered list of all stages. */
export const PIPELINE_STAGES: PipelineStage[] = [
  "raw",
  "no_bg",
  "crop",
  "shadow",
  "final",
];

/** Metadata recorded for each completed stage. */
export interface StageResult {
  stage: PipelineStage;
  buffer: Buffer;
  width: number;
  height: number;
  fileSize: number;
  checksum: string;
  processingTimeMs: number;
  /** MIME type of the output ("image/png" for intermediate, "image/jpeg" for final). */
  mimeType: string;
}

/** Full pipeline configuration. */
export interface PipelineConfig {
  /** Background removal settings. */
  bgRemoval: BgRemovalOptions;
  /** Auto-crop settings. */
  crop?: AutoCropOptions;
  /** Shadow settings. */
  shadow: ShadowOptions;
  /** Canvas placement settings. */
  canvas?: SquareCanvasOptions;
}

/** Result of a full pipeline run. */
export interface PipelineResult {
  /** All stage results in order. */
  stages: StageResult[];
  /** Map of stage name to its result for quick access. */
  stageMap: Record<PipelineStage, StageResult | undefined>;
  /** Total wall-clock time across all processing stages. */
  totalProcessingTimeMs: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compute SHA-256 hex digest of a buffer. */
function checksum(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Build a StageResult from a buffer and timing. */
async function buildStageResult(
  stage: PipelineStage,
  buffer: Buffer,
  startMs: number,
): Promise<StageResult> {
  const meta = await sharp(buffer).metadata();
  const mimeType = stage === "final" ? "image/jpeg" : "image/png";

  return {
    stage,
    buffer,
    width: meta.width!,
    height: meta.height!,
    fileSize: buffer.length,
    checksum: checksum(buffer),
    processingTimeMs: Date.now() - startMs,
    mimeType,
  };
}

// ---------------------------------------------------------------------------
// Pipeline runners
// ---------------------------------------------------------------------------

/**
 * Run the full processing pipeline on a raw image buffer.
 *
 * @param buffer - Raw factory photo buffer (any format Sharp can decode).
 * @param config - Processing configuration for each stage.
 * @returns Pipeline result with all stage outputs and metadata.
 */
export async function runPipeline(
  buffer: Buffer,
  config: PipelineConfig,
): Promise<PipelineResult> {
  const stages: StageResult[] = [];
  let totalMs = 0;

  // Stage 1: raw (just record metadata, no processing)
  const rawStart = Date.now();
  const rawResult = await buildStageResult("raw", buffer, rawStart);
  stages.push(rawResult);
  totalMs += rawResult.processingTimeMs;

  // Stage 2: background removal
  const bgStart = Date.now();
  const noBgBuffer = await removeBackground(buffer, config.bgRemoval);
  const noBgResult = await buildStageResult("no_bg", noBgBuffer, bgStart);
  stages.push(noBgResult);
  totalMs += noBgResult.processingTimeMs;

  // Stage 3: auto-crop
  const cropStart = Date.now();
  const cropResult = await autoCrop(noBgBuffer, config.crop);
  const cropStageResult = await buildStageResult("crop", cropResult.buffer, cropStart);
  stages.push(cropStageResult);
  totalMs += cropStageResult.processingTimeMs;

  // Stage 4: shadow
  const shadowStart = Date.now();
  const shadowBuffer = await addShadow(cropResult.buffer, config.shadow);
  const shadowResult = await buildStageResult("shadow", shadowBuffer, shadowStart);
  stages.push(shadowResult);
  totalMs += shadowResult.processingTimeMs;

  // Stage 5: final canvas placement
  const canvasStart = Date.now();
  const canvasResult = await placeOnSquareCanvas(shadowBuffer, config.canvas);
  const finalResult = await buildStageResult("final", canvasResult.buffer, canvasStart);
  stages.push(finalResult);
  totalMs += finalResult.processingTimeMs;

  return {
    stages,
    stageMap: buildStageMap(stages),
    totalProcessingTimeMs: totalMs,
  };
}

/**
 * Re-run the pipeline starting from a specific stage, using pre-existing
 * stage buffers for earlier stages.
 *
 * This is useful when you want to change shadow settings without
 * re-doing background removal, for example.
 *
 * @param stageBuffers - Map of stage name to its already-computed buffer.
 *   Must include all stages before `fromStage`.
 * @param fromStage - The stage to start processing from (inclusive).
 * @param config - Processing configuration (only stages >= fromStage are used).
 * @returns Pipeline result with all stage outputs (earlier ones carried forward).
 */
export async function runFromStage(
  stageBuffers: Partial<Record<PipelineStage, Buffer>>,
  fromStage: PipelineStage,
  config: PipelineConfig,
): Promise<PipelineResult> {
  const stages: StageResult[] = [];
  let totalMs = 0;
  const fromIndex = PIPELINE_STAGES.indexOf(fromStage);

  if (fromIndex < 0) {
    throw new Error(`Unknown pipeline stage: ${fromStage}`);
  }

  // Carry forward existing stages before fromStage
  for (let i = 0; i < fromIndex; i++) {
    const stageName = PIPELINE_STAGES[i];
    const buf = stageBuffers[stageName];
    if (!buf) {
      throw new Error(
        `Missing buffer for stage "${stageName}" — required when starting from "${fromStage}".`,
      );
    }
    const start = Date.now();
    const result = await buildStageResult(stageName, buf, start);
    result.processingTimeMs = 0; // not reprocessed
    stages.push(result);
  }

  // Determine the input buffer for the fromStage
  let currentBuffer: Buffer;
  if (fromIndex === 0) {
    // Starting from raw — need the raw buffer
    const rawBuf = stageBuffers.raw;
    if (!rawBuf) throw new Error('Missing "raw" buffer.');
    currentBuffer = rawBuf;
  } else {
    // The input to fromStage is the output of the stage before it
    const prevStage = PIPELINE_STAGES[fromIndex - 1];
    const prevBuf = stageBuffers[prevStage];
    if (!prevBuf) {
      throw new Error(`Missing buffer for stage "${prevStage}".`);
    }
    currentBuffer = prevBuf;
  }

  // Process from fromStage onward
  for (let i = fromIndex; i < PIPELINE_STAGES.length; i++) {
    const stageName = PIPELINE_STAGES[i];
    const start = Date.now();

    switch (stageName) {
      case "raw": {
        const result = await buildStageResult("raw", currentBuffer, start);
        stages.push(result);
        totalMs += result.processingTimeMs;
        break;
      }
      case "no_bg": {
        currentBuffer = await removeBackground(currentBuffer, config.bgRemoval);
        const result = await buildStageResult("no_bg", currentBuffer, start);
        stages.push(result);
        totalMs += result.processingTimeMs;
        break;
      }
      case "crop": {
        const cropResult = await autoCrop(currentBuffer, config.crop);
        currentBuffer = cropResult.buffer;
        const result = await buildStageResult("crop", currentBuffer, start);
        stages.push(result);
        totalMs += result.processingTimeMs;
        break;
      }
      case "shadow": {
        currentBuffer = await addShadow(currentBuffer, config.shadow);
        const result = await buildStageResult("shadow", currentBuffer, start);
        stages.push(result);
        totalMs += result.processingTimeMs;
        break;
      }
      case "final": {
        const canvasResult = await placeOnSquareCanvas(currentBuffer, config.canvas);
        currentBuffer = canvasResult.buffer;
        const result = await buildStageResult("final", currentBuffer, start);
        stages.push(result);
        totalMs += result.processingTimeMs;
        break;
      }
    }
  }

  return {
    stages,
    stageMap: buildStageMap(stages),
    totalProcessingTimeMs: totalMs,
  };
}

/**
 * Build a lookup map from stage name to result.
 */
function buildStageMap(
  stages: StageResult[],
): Record<PipelineStage, StageResult | undefined> {
  const map: Record<string, StageResult | undefined> = {};
  for (const s of stages) {
    map[s.stage] = s;
  }
  return map as Record<PipelineStage, StageResult | undefined>;
}
