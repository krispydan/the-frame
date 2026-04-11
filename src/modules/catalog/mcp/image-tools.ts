/**
 * Phase 3: MCP Tools — Image Editor Module
 *
 * Registers image processing tools on the MCP registry so Claude can
 * process product images via conversation. Tools follow the consolidated
 * ~12-tool design from the technical review.
 *
 * Side-effect import — importing this file registers all tools.
 */
import { mcpRegistry } from "@/modules/core/mcp/server";
import { sqlite } from "@/lib/db";
import { z } from "zod";
import { readImage } from "@/lib/storage/local";
import {
  runPipeline,
  runFromStage,
  removeBackground,
  autoCrop,
  addShadow,
  placeOnSquareCanvas,
  isWhiteBackground,
  sampleCorners,
  autoDetectThreshold,
  generateThresholdVariations,
  generateCollectionImage,
  PIPELINE_STAGES,
  type PipelineConfig,
  type PipelineStage,
  type BgRemovalMethod,
  type ShadowMethod,
} from "@/modules/catalog/lib/image-editor";
import {
  saveStageArtifact,
  saveVariation,
  saveCollectionImage as saveCollectionImageToDisk,
} from "@/modules/catalog/lib/image-editor/storage";

// ─── Helper: load image buffer from a catalog image record ───

async function loadImageBuffer(imageId: string): Promise<{ buffer: Buffer; image: Record<string, unknown> }> {
  const image = sqlite.prepare("SELECT * FROM catalog_images WHERE id = ?").get(imageId) as Record<string, unknown> | undefined;
  if (!image) throw new Error(`Image not found: ${imageId}`);
  if (!image.file_path) throw new Error(`Image ${imageId} has no file_path`);
  const buffer = await readImage(image.file_path as string);
  return { buffer, image };
}

// ─── Helper: build pipeline config from MCP args ───

function buildPipelineConfig(args: {
  bgMethod?: string;
  bgThreshold?: number;
  bgFeather?: number;
  shadowMethod?: string;
  shadowOpacity?: number;
  shadowBlur?: number;
  shadowOffsetY?: number;
  canvasSize?: number;
  canvasBg?: string;
  canvasPadding?: number;
  outputQuality?: number;
}): PipelineConfig {
  const bgMethod = (args.bgMethod ?? "threshold") as BgRemovalMethod;
  const bgRemoval = bgMethod === "gemini"
    ? { method: "gemini" as const }
    : { method: "threshold" as const, threshold: args.bgThreshold ?? 245, feather: args.bgFeather ?? 3 };

  const shadowMethod = (args.shadowMethod ?? "gaussian") as ShadowMethod;
  const shadow = {
    method: shadowMethod,
    opacity: args.shadowOpacity,
    blur: args.shadowBlur,
    offsetY: args.shadowOffsetY,
  };

  const canvas = {
    size: args.canvasSize ?? 2048,
    background: args.canvasBg ?? "#F8F9FA",
    padding: args.canvasPadding ?? 0,
    quality: args.outputQuality ?? 95,
  };

  return { bgRemoval, shadow, canvas };
}

// ─── Helper: record a pipeline stage to the DB ───

function recordPipelineStage(
  imageId: string,
  stage: string,
  method: string,
  methodParams: string | null,
  artifact: { filePath: string; fileSize: number; width: number; height: number; checksum: string },
  processingTimeMs: number,
  status: string = "completed",
  errorMessage: string | null = null,
) {
  sqlite.prepare(`
    INSERT INTO catalog_image_pipelines
      (id, image_id, stage, method, method_params, file_path, file_size, width, height, checksum, status, error_message, processing_time_ms, created_at, updated_at)
    VALUES
      (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(image_id, stage) DO UPDATE SET
      method = excluded.method, method_params = excluded.method_params,
      file_path = excluded.file_path, file_size = excluded.file_size,
      width = excluded.width, height = excluded.height,
      checksum = excluded.checksum, status = excluded.status,
      error_message = excluded.error_message, processing_time_ms = excluded.processing_time_ms,
      updated_at = datetime('now')
  `).run(
    imageId, stage, method, methodParams,
    artifact.filePath, artifact.fileSize, artifact.width, artifact.height, artifact.checksum,
    status, errorMessage, processingTimeMs,
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 1. catalog.images.process — Full pipeline processing
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

mcpRegistry.register(
  "catalog.images.process",
  "Run the full image processing pipeline (raw → no_bg → crop → shadow → final) on a catalog image. Returns stage metadata and saves all artifacts. Example: process image abc-123 with threshold bg removal and gaussian shadow.",
  z.object({
    imageId: z.string().describe("Catalog image ID to process"),
    bgMethod: z.string().optional().describe("Background removal method: 'threshold' or 'gemini' (default: threshold)"),
    bgThreshold: z.number().optional().describe("Threshold value for white bg removal, 0-255 (default: 245)"),
    bgFeather: z.number().optional().describe("Feather pixels for soft edges (default: 3)"),
    shadowMethod: z.string().optional().describe("Shadow method: 'gaussian', 'silhouette', 'bottom_edge', or 'none' (default: gaussian)"),
    shadowOpacity: z.number().optional().describe("Shadow opacity 0-1 (default: 0.3)"),
    shadowBlur: z.number().optional().describe("Shadow blur radius in pixels (default: 25)"),
    shadowOffsetY: z.number().optional().describe("Shadow vertical offset in pixels (default: 15)"),
    canvasSize: z.number().optional().describe("Square canvas size in pixels (default: 2048)"),
    canvasBg: z.string().optional().describe("Canvas background color hex (default: #F8F9FA)"),
    canvasPadding: z.number().optional().describe("Canvas padding as fraction 0-0.5 (default: 0 = edge-to-edge)"),
    outputQuality: z.number().optional().describe("JPEG output quality 1-100 (default: 95)"),
  }),
  async (args) => {
    try {
      const { buffer, image } = await loadImageBuffer(args.imageId);
      const config = buildPipelineConfig(args);

      // Update pipeline status
      sqlite.prepare("UPDATE catalog_images SET pipeline_status = 'processing' WHERE id = ?").run(args.imageId);

      const result = await runPipeline(buffer, config);

      // Save each stage artifact and record in DB
      const skuId = image.sku_id as string;
      const stageSummaries = [];

      for (const stageResult of result.stages) {
        const artifact = await saveStageArtifact(skuId, stageResult.stage, stageResult.buffer);
        const methodStr = stageResult.stage === "no_bg" ? args.bgMethod ?? "threshold"
          : stageResult.stage === "shadow" ? args.shadowMethod ?? "gaussian"
          : stageResult.stage;
        const methodParams = stageResult.stage === "no_bg" && args.bgMethod !== "gemini"
          ? JSON.stringify({ threshold: args.bgThreshold ?? 245, feather: args.bgFeather ?? 3 })
          : null;

        recordPipelineStage(args.imageId, stageResult.stage, methodStr, methodParams, artifact, stageResult.processingTimeMs);

        stageSummaries.push({
          stage: stageResult.stage,
          width: stageResult.width,
          height: stageResult.height,
          fileSize: stageResult.fileSize,
          processingTimeMs: stageResult.processingTimeMs,
          filePath: artifact.filePath,
        });
      }

      // Update image record with final artifact info (already saved in loop above)
      const finalSummary = stageSummaries.find((s) => s.stage === "final");
      if (finalSummary) {
        sqlite.prepare(`
          UPDATE catalog_images
          SET pipeline_status = 'completed', file_path = ?, file_size = ?, width = ?, height = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(finalSummary.filePath, finalSummary.fileSize, finalSummary.width, finalSummary.height, args.imageId);
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            imageId: args.imageId,
            status: "completed",
            stages: stageSummaries,
            totalProcessingTimeMs: result.totalProcessingTimeMs,
          }, null, 2),
        }],
      };
    } catch (e: any) {
      sqlite.prepare("UPDATE catalog_images SET pipeline_status = 'failed' WHERE id = ?").run(args.imageId);
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: e.message }) }], isError: true };
    }
  }
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 2. catalog.images.reprocess — Re-run from a specific stage
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

mcpRegistry.register(
  "catalog.images.reprocess",
  "Re-run the pipeline from a specific stage onward, using previously saved stage artifacts for earlier stages. Useful for changing shadow settings without re-doing background removal. Example: reprocess image abc-123 from 'shadow' stage with silhouette method.",
  z.object({
    imageId: z.string().describe("Catalog image ID to reprocess"),
    fromStage: z.string().describe("Stage to start from: 'no_bg', 'crop', 'shadow', or 'final'"),
    bgMethod: z.string().optional().describe("Background removal method (if reprocessing from no_bg)"),
    bgThreshold: z.number().optional().describe("Threshold value 0-255"),
    bgFeather: z.number().optional().describe("Feather pixels"),
    shadowMethod: z.string().optional().describe("Shadow method: gaussian, silhouette, bottom_edge, none"),
    shadowOpacity: z.number().optional().describe("Shadow opacity 0-1"),
    shadowBlur: z.number().optional().describe("Shadow blur radius"),
    shadowOffsetY: z.number().optional().describe("Shadow vertical offset"),
    canvasSize: z.number().optional().describe("Square canvas size (default: 2048)"),
    canvasBg: z.string().optional().describe("Canvas background hex (default: #F8F9FA)"),
    canvasPadding: z.number().optional().describe("Canvas padding fraction 0-0.5"),
    outputQuality: z.number().optional().describe("JPEG quality 1-100"),
  }),
  async (args) => {
    try {
      const fromStage = args.fromStage as PipelineStage;
      if (!PIPELINE_STAGES.includes(fromStage)) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: `Invalid stage: ${args.fromStage}. Must be one of: ${PIPELINE_STAGES.join(", ")}` }) }], isError: true };
      }

      const image = sqlite.prepare("SELECT * FROM catalog_images WHERE id = ?").get(args.imageId) as Record<string, unknown> | undefined;
      if (!image) return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Image not found" }) }], isError: true };

      // Load existing stage artifacts from DB
      const existingStages = sqlite.prepare(
        "SELECT stage, file_path FROM catalog_image_pipelines WHERE image_id = ? AND status = 'completed' ORDER BY stage"
      ).all(args.imageId) as Array<{ stage: string; file_path: string }>;

      const stageBuffers: Partial<Record<PipelineStage, Buffer>> = {};
      for (const es of existingStages) {
        try {
          stageBuffers[es.stage as PipelineStage] = await readImage(es.file_path);
        } catch {
          // Missing file — skip
        }
      }

      const config = buildPipelineConfig(args);
      sqlite.prepare("UPDATE catalog_images SET pipeline_status = 'processing' WHERE id = ?").run(args.imageId);

      const result = await runFromStage(stageBuffers, fromStage, config);

      // Save reprocessed stages
      const skuId = image.sku_id as string;
      const fromIndex = PIPELINE_STAGES.indexOf(fromStage);
      const stageSummaries = [];

      for (const stageResult of result.stages) {
        const stageIndex = PIPELINE_STAGES.indexOf(stageResult.stage);
        if (stageIndex >= fromIndex) {
          const artifact = await saveStageArtifact(skuId, stageResult.stage, stageResult.buffer);
          const methodStr = stageResult.stage === "no_bg" ? args.bgMethod ?? "threshold"
            : stageResult.stage === "shadow" ? args.shadowMethod ?? "gaussian"
            : stageResult.stage;
          recordPipelineStage(args.imageId, stageResult.stage, methodStr, null, artifact, stageResult.processingTimeMs);

          stageSummaries.push({
            stage: stageResult.stage,
            width: stageResult.width,
            height: stageResult.height,
            fileSize: stageResult.fileSize,
            processingTimeMs: stageResult.processingTimeMs,
            filePath: artifact.filePath,
          });
        }
      }

      // Update image record with final artifact info (already saved in loop above)
      const finalSummary = stageSummaries.find((s) => s.stage === "final");
      if (finalSummary) {
        sqlite.prepare(`
          UPDATE catalog_images
          SET pipeline_status = 'completed', file_path = ?, file_size = ?, width = ?, height = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(finalSummary.filePath, finalSummary.fileSize, finalSummary.width, finalSummary.height, args.imageId);
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            imageId: args.imageId,
            fromStage: args.fromStage,
            status: "completed",
            reprocessedStages: stageSummaries,
            totalProcessingTimeMs: result.totalProcessingTimeMs,
          }, null, 2),
        }],
      };
    } catch (e: any) {
      sqlite.prepare("UPDATE catalog_images SET pipeline_status = 'failed' WHERE id = ?").run(args.imageId);
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: e.message }) }], isError: true };
    }
  }
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 3. catalog.images.detect_bg — Analyze background for method recommendation
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

mcpRegistry.register(
  "catalog.images.detect_bg",
  "Analyze an image's background to detect color and recommend the best removal method. Returns corner samples, white/colored bg detection, and suggested threshold. Use this before processing to choose threshold vs gemini. Example: detect_bg for image abc-123.",
  z.object({
    imageId: z.string().describe("Catalog image ID to analyze"),
  }),
  async (args) => {
    try {
      const { buffer } = await loadImageBuffer(args.imageId);
      const corners = await sampleCorners(buffer);
      const isWhite = await isWhiteBackground(buffer);
      const autoThreshold = await autoDetectThreshold(buffer);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            imageId: args.imageId,
            corners,
            isWhiteBackground: isWhite,
            autoDetect: autoThreshold,
            recommendation: isWhite
              ? `White background detected — use threshold method (suggested value: ${autoThreshold.suggestedThreshold})`
              : "Non-white background detected — use gemini method for best results",
            suggestedConfig: isWhite
              ? { bgMethod: "threshold", bgThreshold: autoThreshold.suggestedThreshold, bgFeather: 3 }
              : { bgMethod: "gemini" },
          }, null, 2),
        }],
      };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: e.message }) }], isError: true };
    }
  }
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 4. catalog.images.generate_variations — Test different methods side by side
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

mcpRegistry.register(
  "catalog.images.generate_variations",
  "Generate multiple background removal or shadow variations for an image to compare methods side-by-side. Saves each as a named variation artifact. Example: generate threshold variations at 235, 240, 245, 250 for image abc-123.",
  z.object({
    imageId: z.string().describe("Catalog image ID"),
    stage: z.string().describe("Which stage to vary: 'no_bg' or 'shadow'"),
    thresholds: z.string().optional().describe("Comma-separated threshold values for bg removal variations (e.g. '235,240,245,250')"),
    shadowMethods: z.string().optional().describe("Comma-separated shadow methods to test (e.g. 'gaussian,silhouette,bottom_edge')"),
  }),
  async (args) => {
    try {
      const { buffer, image } = await loadImageBuffer(args.imageId);
      const skuId = image.sku_id as string;
      const variations: Array<{
        label: string;
        width: number;
        height: number;
        fileSize: number;
        filePath: string;
      }> = [];

      if (args.stage === "no_bg") {
        // Generate threshold variations
        const thresholds = args.thresholds
          ? args.thresholds.split(",").map((t) => parseInt(t.trim(), 10))
          : [235, 240, 245, 250];

        for (const threshold of thresholds) {
          const label = `threshold_${threshold}`;
          const noBgBuf = await removeBackground(buffer, { method: "threshold", threshold, feather: 3 });
          const artifact = await saveVariation(skuId, noBgBuf, label);

          // Record variation in DB
          sqlite.prepare(`
            INSERT INTO catalog_image_variations
              (id, image_id, stage, method, method_params, file_path, file_size, width, height, label, is_selected, created_at)
            VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))
          `).run(args.imageId, "no_bg", "threshold", JSON.stringify({ threshold, feather: 3 }),
            artifact.filePath, artifact.fileSize, artifact.width, artifact.height, label);

          variations.push({ label, width: artifact.width, height: artifact.height, fileSize: artifact.fileSize, filePath: artifact.filePath });
        }
      } else if (args.stage === "shadow") {
        // Need a cropped image first — check pipeline
        const cropStage = sqlite.prepare(
          "SELECT file_path FROM catalog_image_pipelines WHERE image_id = ? AND stage = 'crop' AND status = 'completed'"
        ).get(args.imageId) as { file_path: string } | undefined;

        let croppedBuffer: Buffer;
        if (cropStage) {
          croppedBuffer = await readImage(cropStage.file_path);
        } else {
          // Auto-crop from the source image
          const cropResult = await autoCrop(buffer);
          croppedBuffer = cropResult.buffer;
        }

        const methods = args.shadowMethods
          ? args.shadowMethods.split(",").map((m) => m.trim()) as ShadowMethod[]
          : ["gaussian", "silhouette", "bottom_edge"] as ShadowMethod[];

        for (const method of methods) {
          const label = `shadow_${method}`;
          const shadowBuf = await addShadow(croppedBuffer, { method });
          const artifact = await saveVariation(skuId, shadowBuf, label);

          sqlite.prepare(`
            INSERT INTO catalog_image_variations
              (id, image_id, stage, method, method_params, file_path, file_size, width, height, label, is_selected, created_at)
            VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))
          `).run(args.imageId, "shadow", method, null,
            artifact.filePath, artifact.fileSize, artifact.width, artifact.height, label);

          variations.push({ label, width: artifact.width, height: artifact.height, fileSize: artifact.fileSize, filePath: artifact.filePath });
        }
      } else {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: "stage must be 'no_bg' or 'shadow'" }) }], isError: true };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            imageId: args.imageId,
            stage: args.stage,
            variationCount: variations.length,
            variations,
          }, null, 2),
        }],
      };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: e.message }) }], isError: true };
    }
  }
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 5. catalog.images.select_variation — Pick the winning variation
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

mcpRegistry.register(
  "catalog.images.select_variation",
  "Select a variation as the winner for a specific stage. Deselects other variations for that image+stage and optionally reprocesses downstream stages. Example: select variation 'threshold_245' for image abc-123.",
  z.object({
    imageId: z.string().describe("Catalog image ID"),
    variationLabel: z.string().describe("Label of the variation to select (e.g. 'threshold_245', 'shadow_gaussian')"),
    reprocessDownstream: z.boolean().optional().describe("If true, re-run pipeline from the selected variation's stage onward (default: true)"),
  }),
  async (args) => {
    try {
      // Find the variation
      const variation = sqlite.prepare(
        "SELECT * FROM catalog_image_variations WHERE image_id = ? AND label = ?"
      ).get(args.imageId, args.variationLabel) as Record<string, unknown> | undefined;

      if (!variation) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: `Variation '${args.variationLabel}' not found for image ${args.imageId}` }) }], isError: true };
      }

      const stage = variation.stage as string;

      // Deselect all variations for this image+stage, then select this one
      sqlite.prepare(
        "UPDATE catalog_image_variations SET is_selected = 0 WHERE image_id = ? AND stage = ?"
      ).run(args.imageId, stage);

      sqlite.prepare(
        "UPDATE catalog_image_variations SET is_selected = 1 WHERE id = ?"
      ).run(variation.id);

      // Copy the selected variation into the pipeline as the active stage artifact
      const image = sqlite.prepare("SELECT * FROM catalog_images WHERE id = ?").get(args.imageId) as Record<string, unknown>;
      const skuId = image.sku_id as string;
      const variationBuffer = await readImage(variation.file_path as string);
      const artifact = await saveStageArtifact(skuId, stage, variationBuffer);
      recordPipelineStage(args.imageId, stage, variation.method as string, variation.method_params as string | null, artifact, 0);

      const result: Record<string, unknown> = {
        imageId: args.imageId,
        selectedVariation: args.variationLabel,
        stage,
        filePath: artifact.filePath,
      };

      // Optionally reprocess downstream stages
      if (args.reprocessDownstream !== false) {
        const stageIndex = PIPELINE_STAGES.indexOf(stage as PipelineStage);
        if (stageIndex < PIPELINE_STAGES.length - 1) {
          const nextStage = PIPELINE_STAGES[stageIndex + 1] as PipelineStage;
          // Load all existing stage buffers
          const existingStages = sqlite.prepare(
            "SELECT stage, file_path FROM catalog_image_pipelines WHERE image_id = ? AND status = 'completed'"
          ).all(args.imageId) as Array<{ stage: string; file_path: string }>;

          const stageBuffers: Partial<Record<PipelineStage, Buffer>> = {};
          for (const es of existingStages) {
            try {
              stageBuffers[es.stage as PipelineStage] = await readImage(es.file_path);
            } catch { /* skip missing */ }
          }
          // Overwrite with the just-selected variation
          stageBuffers[stage as PipelineStage] = variationBuffer;

          const config = buildPipelineConfig({});
          const pipelineResult = await runFromStage(stageBuffers, nextStage, config);

          // Save reprocessed stages
          const fromIndex = PIPELINE_STAGES.indexOf(nextStage);
          for (const sr of pipelineResult.stages) {
            const srIndex = PIPELINE_STAGES.indexOf(sr.stage);
            if (srIndex >= fromIndex) {
              const art = await saveStageArtifact(skuId, sr.stage, sr.buffer);
              recordPipelineStage(args.imageId, sr.stage, sr.stage, null, art, sr.processingTimeMs);
            }
          }

          result.reprocessed = true;
          result.reprocessedFrom = nextStage;
        }
      }

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: e.message }) }], isError: true };
    }
  }
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 6. catalog.images.list — List images with pipeline status
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

mcpRegistry.register(
  "catalog.images.list",
  "List catalog images with filtering by SKU, product, pipeline status, and image type. Includes pipeline stage information. Example: list all images for product JX3-005 that haven't been processed yet.",
  z.object({
    skuId: z.string().optional().describe("Filter by SKU ID"),
    productId: z.string().optional().describe("Filter by product ID"),
    skuPrefix: z.string().optional().describe("Filter by SKU prefix pattern (e.g. 'JX3')"),
    pipelineStatus: z.string().optional().describe("Filter by pipeline status: none, processing, completed, failed"),
    imageTypeSlug: z.string().optional().describe("Filter by image type slug: front, side, other-side, top, back-crossed, crossed, inside, name, closed, above"),
    limit: z.number().optional().describe("Max results (default 50)"),
    offset: z.number().optional().describe("Offset for pagination"),
  }),
  async (args) => {
    try {
      const limit = Math.min(200, args.limit ?? 50);
      const offset = args.offset ?? 0;
      const clauses: string[] = [];
      const params: unknown[] = [];

      if (args.skuId) { clauses.push("ci.sku_id = ?"); params.push(args.skuId); }
      if (args.productId) { clauses.push("cs.product_id = ?"); params.push(args.productId); }
      if (args.skuPrefix) { clauses.push("cs.sku LIKE ?"); params.push(`${args.skuPrefix}%`); }
      if (args.pipelineStatus) { clauses.push("ci.pipeline_status = ?"); params.push(args.pipelineStatus); }
      if (args.imageTypeSlug) {
        clauses.push("cit.slug = ?");
        params.push(args.imageTypeSlug);
      }

      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

      const images = sqlite.prepare(`
        SELECT ci.*, cs.sku, cs.color_name, cs.product_id,
          cit.slug as image_type_slug, cit.label as image_type_label,
          (SELECT COUNT(*) FROM catalog_image_pipelines WHERE image_id = ci.id AND status = 'completed') as completed_stages,
          (SELECT GROUP_CONCAT(stage, ',') FROM catalog_image_pipelines WHERE image_id = ci.id AND status = 'completed') as pipeline_stages
        FROM catalog_images ci
        LEFT JOIN catalog_skus cs ON ci.sku_id = cs.id
        LEFT JOIN catalog_image_types cit ON ci.image_type_id = cit.id
        ${where}
        ORDER BY cs.sku, ci.position
        LIMIT ? OFFSET ?
      `).all(...params, limit, offset);

      const total = sqlite.prepare(`
        SELECT COUNT(*) as count
        FROM catalog_images ci
        LEFT JOIN catalog_skus cs ON ci.sku_id = cs.id
        LEFT JOIN catalog_image_types cit ON ci.image_type_id = cit.id
        ${where}
      `).get(...params) as { count: number };

      return { content: [{ type: "text" as const, text: JSON.stringify({ images, total: total.count, limit, offset }, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: e.message }) }], isError: true };
    }
  }
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 7. catalog.images.get — Get single image with full pipeline detail
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

mcpRegistry.register(
  "catalog.images.get",
  "Get detailed information about a single catalog image including all pipeline stages, variations, and metadata. Example: get image abc-123.",
  z.object({
    imageId: z.string().describe("Catalog image ID"),
  }),
  async (args) => {
    try {
      const image = sqlite.prepare(`
        SELECT ci.*, cs.sku, cs.color_name, cs.product_id,
          cit.slug as image_type_slug, cit.label as image_type_label
        FROM catalog_images ci
        LEFT JOIN catalog_skus cs ON ci.sku_id = cs.id
        LEFT JOIN catalog_image_types cit ON ci.image_type_id = cit.id
        WHERE ci.id = ?
      `).get(args.imageId);

      if (!image) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Image not found" }) }], isError: true };
      }

      const pipelineStages = sqlite.prepare(
        "SELECT stage, method, method_params, file_path, file_size, width, height, checksum, status, processing_time_ms, created_at FROM catalog_image_pipelines WHERE image_id = ? ORDER BY created_at"
      ).all(args.imageId);

      const variations = sqlite.prepare(
        "SELECT stage, method, method_params, file_path, file_size, width, height, label, is_selected, created_at FROM catalog_image_variations WHERE image_id = ? ORDER BY stage, label"
      ).all(args.imageId);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ image, pipelineStages, variations }, null, 2),
        }],
      };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: e.message }) }], isError: true };
    }
  }
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 8. catalog.images.update — Update image metadata
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

mcpRegistry.register(
  "catalog.images.update",
  "Update image metadata fields like position, alt text, image type, status, or is_best flag. Example: set image abc-123 as the best image with alt text 'JX3005 sunglasses front view'.",
  z.object({
    imageId: z.string().describe("Catalog image ID to update"),
    position: z.number().optional().describe("Sort position (0-based)"),
    altText: z.string().optional().describe("Alt text for accessibility/SEO"),
    imageTypeSlug: z.string().optional().describe("Image type slug: front, side, other-side, top, back-crossed, crossed, inside, name, closed, above"),
    status: z.enum(["draft", "review", "approved", "rejected"]).optional().describe("Image status"),
    isBest: z.boolean().optional().describe("Mark as the best/hero image for this SKU"),
  }),
  async (args) => {
    try {
      const { imageId, ...updates } = args;
      const fields: string[] = [];
      const values: unknown[] = [];

      if (updates.position !== undefined) { fields.push("position = ?"); values.push(updates.position); }
      if (updates.altText !== undefined) { fields.push("alt_text = ?"); values.push(updates.altText); }
      if (updates.status !== undefined) { fields.push("status = ?"); values.push(updates.status); }
      if (updates.isBest !== undefined) {
        // If setting as best, unset others for same SKU first
        if (updates.isBest) {
          const img = sqlite.prepare("SELECT sku_id FROM catalog_images WHERE id = ?").get(imageId) as { sku_id: string } | undefined;
          if (img) {
            sqlite.prepare("UPDATE catalog_images SET is_best = 0 WHERE sku_id = ?").run(img.sku_id);
          }
        }
        fields.push("is_best = ?");
        values.push(updates.isBest ? 1 : 0);
      }
      if (updates.imageTypeSlug !== undefined) {
        const imageType = sqlite.prepare("SELECT id FROM catalog_image_types WHERE slug = ?").get(updates.imageTypeSlug) as { id: string } | undefined;
        if (imageType) {
          fields.push("image_type_id = ?");
          values.push(imageType.id);
        } else {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: `Unknown image type slug: ${updates.imageTypeSlug}` }) }], isError: true };
        }
      }

      if (fields.length === 0) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: "No fields to update" }) }], isError: true };
      }

      fields.push("updated_at = datetime('now')");
      sqlite.prepare(`UPDATE catalog_images SET ${fields.join(", ")} WHERE id = ?`).run(...values, imageId);

      const updated = sqlite.prepare(`
        SELECT ci.*, cs.sku, cit.slug as image_type_slug
        FROM catalog_images ci
        LEFT JOIN catalog_skus cs ON ci.sku_id = cs.id
        LEFT JOIN catalog_image_types cit ON ci.image_type_id = cit.id
        WHERE ci.id = ?
      `).get(imageId);

      return { content: [{ type: "text" as const, text: JSON.stringify({ image: updated }, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: e.message }) }], isError: true };
    }
  }
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 9. catalog.images.delete — Delete image and all artifacts
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

mcpRegistry.register(
  "catalog.images.delete",
  "Delete a catalog image and all its pipeline artifacts, variations, and files from disk. This is permanent. Example: delete image abc-123.",
  z.object({
    imageId: z.string().describe("Catalog image ID to delete"),
  }),
  async (args) => {
    try {
      const { deleteImage } = await import("@/lib/storage/local");

      // Gather all file paths to clean up
      const pipelineFiles = sqlite.prepare(
        "SELECT file_path FROM catalog_image_pipelines WHERE image_id = ?"
      ).all(args.imageId) as Array<{ file_path: string }>;

      const variationFiles = sqlite.prepare(
        "SELECT file_path FROM catalog_image_variations WHERE image_id = ?"
      ).all(args.imageId) as Array<{ file_path: string }>;

      const image = sqlite.prepare("SELECT file_path FROM catalog_images WHERE id = ?").get(args.imageId) as { file_path: string } | undefined;

      // Delete files from disk (silent on missing)
      const allPaths = [
        ...pipelineFiles.map((f) => f.file_path),
        ...variationFiles.map((f) => f.file_path),
        ...(image?.file_path ? [image.file_path] : []),
      ];

      for (const fp of allPaths) {
        await deleteImage(fp);
      }

      // Delete DB records (cascade handles pipelines and variations via FK)
      sqlite.prepare("DELETE FROM catalog_image_pipelines WHERE image_id = ?").run(args.imageId);
      sqlite.prepare("DELETE FROM catalog_image_variations WHERE image_id = ?").run(args.imageId);
      sqlite.prepare("DELETE FROM catalog_images WHERE id = ?").run(args.imageId);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            deleted: true,
            imageId: args.imageId,
            filesRemoved: allPaths.length,
          }),
        }],
      };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: e.message }) }], isError: true };
    }
  }
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 10. catalog.images.batch_process — Process multiple images
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

mcpRegistry.register(
  "catalog.images.batch_process",
  "Process multiple images through the pipeline. Specify image IDs or filter by product/SKU prefix. Processes sequentially with progress tracking. Returns a summary of successes and failures. Example: batch process all unprocessed images for product JX3-005.",
  z.object({
    imageIds: z.string().optional().describe("Comma-separated image IDs to process"),
    productId: z.string().optional().describe("Process all images for this product ID"),
    skuPrefix: z.string().optional().describe("Process all images matching this SKU prefix"),
    pipelineStatus: z.string().optional().describe("Only process images with this pipeline status (e.g. 'none' for unprocessed). Default: 'none'"),
    bgMethod: z.string().optional().describe("Background removal method (default: threshold)"),
    bgThreshold: z.number().optional().describe("Threshold value 0-255 (default: 245)"),
    shadowMethod: z.string().optional().describe("Shadow method (default: gaussian)"),
    canvasSize: z.number().optional().describe("Canvas size (default: 2048)"),
    concurrency: z.number().optional().describe("Max concurrent processes (default: 1, max: 5)"),
    limit: z.number().optional().describe("Max images to process (default: 50)"),
  }),
  async (args) => {
    try {
      // Gather images to process
      let imageIds: string[] = [];

      if (args.imageIds) {
        imageIds = args.imageIds.split(",").map((id) => id.trim());
      } else {
        const clauses: string[] = [];
        const params: unknown[] = [];
        const statusFilter = args.pipelineStatus ?? "none";
        clauses.push("ci.pipeline_status = ?");
        params.push(statusFilter);

        if (args.productId) { clauses.push("cs.product_id = ?"); params.push(args.productId); }
        if (args.skuPrefix) { clauses.push("cs.sku LIKE ?"); params.push(`${args.skuPrefix}%`); }

        const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
        const limit = Math.min(200, args.limit ?? 50);

        const rows = sqlite.prepare(`
          SELECT ci.id FROM catalog_images ci
          LEFT JOIN catalog_skus cs ON ci.sku_id = cs.id
          ${where}
          ORDER BY cs.sku, ci.position
          LIMIT ?
        `).all(...params, limit) as Array<{ id: string }>;

        imageIds = rows.map((r) => r.id);
      }

      if (imageIds.length === 0) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ message: "No images found matching the criteria", processed: 0 }) }] };
      }

      const config = buildPipelineConfig(args);
      const results: Array<{ imageId: string; status: string; error?: string; processingTimeMs?: number }> = [];
      let succeeded = 0;
      let failed = 0;

      // Process sequentially (concurrency support deferred to job queue in Phase 4)
      for (const imageId of imageIds) {
        const start = Date.now();
        try {
          const { buffer, image } = await loadImageBuffer(imageId);
          sqlite.prepare("UPDATE catalog_images SET pipeline_status = 'processing' WHERE id = ?").run(imageId);

          const result = await runPipeline(buffer, config);
          const skuId = image.sku_id as string;

          // Save all stages
          for (const stageResult of result.stages) {
            const artifact = await saveStageArtifact(skuId, stageResult.stage, stageResult.buffer);
            const methodStr = stageResult.stage === "no_bg" ? args.bgMethod ?? "threshold"
              : stageResult.stage === "shadow" ? args.shadowMethod ?? "gaussian"
              : stageResult.stage;
            recordPipelineStage(imageId, stageResult.stage, methodStr, null, artifact, stageResult.processingTimeMs);
          }

          // Update image record with final artifact info (already saved in loop above)
          const finalPipeline = sqlite.prepare(
            "SELECT file_path, file_size, width, height FROM catalog_image_pipelines WHERE image_id = ? AND stage = 'final' AND status = 'completed'"
          ).get(imageId) as { file_path: string; file_size: number; width: number; height: number } | undefined;
          if (finalPipeline) {
            sqlite.prepare(`
              UPDATE catalog_images
              SET pipeline_status = 'completed', file_path = ?, file_size = ?, width = ?, height = ?, updated_at = datetime('now')
              WHERE id = ?
            `).run(finalPipeline.file_path, finalPipeline.file_size, finalPipeline.width, finalPipeline.height, imageId);
          }

          succeeded++;
          results.push({ imageId, status: "completed", processingTimeMs: Date.now() - start });
        } catch (e: any) {
          failed++;
          sqlite.prepare("UPDATE catalog_images SET pipeline_status = 'failed' WHERE id = ?").run(imageId);
          results.push({ imageId, status: "failed", error: e.message, processingTimeMs: Date.now() - start });
        }
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            totalRequested: imageIds.length,
            succeeded,
            failed,
            results,
          }, null, 2),
        }],
      };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: e.message }) }], isError: true };
    }
  }
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 11. catalog.images.generate_collection — Create composite collection image
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

mcpRegistry.register(
  "catalog.images.generate_collection",
  "Generate a composite collection image showing multiple SKU variants for a product. Uses single column layout for 1-5 variants, tight 2-col grid for 6+. Example: generate collection image for product JX3-005.",
  z.object({
    productId: z.string().describe("Product ID to generate collection image for"),
    skuIds: z.string().optional().describe("Comma-separated SKU IDs to include (default: all SKUs for the product)"),
    imageTypeSlug: z.string().optional().describe("Which image type to use per SKU (default: front)"),
    canvasSize: z.number().optional().describe("Canvas size in pixels (default: 2048)"),
    canvasBg: z.string().optional().describe("Background color hex (default: #F8F9FA)"),
  }),
  async (args) => {
    try {
      // Get SKUs for the product
      let skuRows: Array<{ id: string; sku: string; color_name: string }>;
      if (args.skuIds) {
        const ids = args.skuIds.split(",").map((id) => id.trim());
        skuRows = sqlite.prepare(
          `SELECT id, sku, color_name FROM catalog_skus WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY sku`
        ).all(...ids) as typeof skuRows;
      } else {
        skuRows = sqlite.prepare(
          "SELECT id, sku, color_name FROM catalog_skus WHERE product_id = ? ORDER BY sku"
        ).all(args.productId) as typeof skuRows;
      }

      if (skuRows.length === 0) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: "No SKUs found for this product" }) }], isError: true };
      }

      // Find the best image for each SKU (prefer approved, then is_best, then front type)
      const imageTypeSlug = args.imageTypeSlug ?? "front";
      const variants: Array<{ buffer: Buffer; label: string }> = [];

      for (const sku of skuRows) {
        // Try to find the best processed image: approved front > is_best > any with file
        const img = sqlite.prepare(`
          SELECT ci.file_path, ci.id FROM catalog_images ci
          LEFT JOIN catalog_image_types cit ON ci.image_type_id = cit.id
          WHERE ci.sku_id = ? AND ci.file_path IS NOT NULL
          ORDER BY
            CASE WHEN cit.slug = ? THEN 0 ELSE 1 END,
            CASE WHEN ci.is_best = 1 THEN 0 ELSE 1 END,
            CASE WHEN ci.status = 'approved' THEN 0 WHEN ci.status = 'review' THEN 1 ELSE 2 END,
            ci.position
          LIMIT 1
        `).get(sku.id, imageTypeSlug) as { file_path: string; id: string } | undefined;

        if (img) {
          try {
            const buffer = await readImage(img.file_path);
            variants.push({ buffer, label: sku.color_name || sku.sku });
          } catch {
            // Skip if file missing
          }
        }
      }

      if (variants.length === 0) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: "No images found for any SKU. Process images first." }) }], isError: true };
      }

      const collectionResult = await generateCollectionImage(
        variants.map((v) => ({ buffer: v.buffer, label: v.label })),
        {
          canvasWidth: args.canvasSize ?? 2048,
          canvasHeight: args.canvasSize ?? 2048,
          background: args.canvasBg ?? "#F8F9FA",
        }
      );

      // Save to disk and DB
      const artifact = await saveCollectionImageToDisk(args.productId, collectionResult.buffer);

      // Upsert collection image record
      sqlite.prepare(`
        INSERT INTO catalog_collection_images (id, product_id, file_path, file_size, width, height, layout, variant_count, created_at, updated_at)
        VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        ON CONFLICT(product_id) DO UPDATE SET
          file_path = excluded.file_path, file_size = excluded.file_size,
          width = excluded.width, height = excluded.height,
          layout = excluded.layout, variant_count = excluded.variant_count,
          updated_at = datetime('now')
      `).run(
        args.productId, artifact.filePath, artifact.fileSize, artifact.width, artifact.height,
        collectionResult.layout, variants.length
      );

      // Update junction table
      const collRow = sqlite.prepare("SELECT id FROM catalog_collection_images WHERE product_id = ?").get(args.productId) as { id: string };
      sqlite.prepare("DELETE FROM catalog_collection_image_skus WHERE collection_image_id = ?").run(collRow.id);

      for (let i = 0; i < skuRows.length; i++) {
        sqlite.prepare(`
          INSERT INTO catalog_collection_image_skus (id, collection_image_id, sku_id, position)
          VALUES (lower(hex(randomblob(16))), ?, ?, ?)
        `).run(collRow.id, skuRows[i].id, i);
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            productId: args.productId,
            layout: collectionResult.layout,
            variantCount: variants.length,
            width: artifact.width,
            height: artifact.height,
            fileSize: artifact.fileSize,
            filePath: artifact.filePath,
          }, null, 2),
        }],
      };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: e.message }) }], isError: true };
    }
  }
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 12. catalog.images.manage_preset — Create/list/update processing presets
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

mcpRegistry.register(
  "catalog.images.manage_preset",
  "Create, list, or update processing presets that store default settings for the pipeline. Example: create preset 'white-bg-standard' with threshold 245 and gaussian shadow.",
  z.object({
    action: z.string().describe("Action: 'list', 'create', or 'update'"),
    id: z.string().optional().describe("Preset ID (required for update)"),
    name: z.string().optional().describe("Preset name (required for create)"),
    description: z.string().optional().describe("Preset description"),
    bgRemovalMethod: z.string().optional().describe("Default bg removal method: threshold, gemini"),
    bgRemovalParams: z.string().optional().describe("JSON string of bg removal params (e.g. '{\"threshold\":245,\"feather\":3}')"),
    shadowMethod: z.string().optional().describe("Default shadow method: gaussian, silhouette, bottom_edge, none"),
    shadowParams: z.string().optional().describe("JSON string of shadow params"),
    canvasSize: z.number().optional().describe("Default canvas size (default: 2048)"),
    canvasBg: z.string().optional().describe("Default canvas background (default: #F8F9FA)"),
    canvasPadding: z.number().optional().describe("Default padding fraction (default: 0)"),
    outputQuality: z.number().optional().describe("Default JPEG quality (default: 95)"),
  }),
  async (args) => {
    try {
      if (args.action === "list") {
        const presets = sqlite.prepare("SELECT * FROM catalog_processing_presets ORDER BY name").all();
        return { content: [{ type: "text" as const, text: JSON.stringify({ presets }, null, 2) }] };
      }

      if (args.action === "create") {
        if (!args.name) return { content: [{ type: "text" as const, text: JSON.stringify({ error: "name is required for create" }) }], isError: true };

        sqlite.prepare(`
          INSERT INTO catalog_processing_presets
            (id, name, description, bg_removal_method, bg_removal_params, shadow_method, shadow_params, canvas_size, canvas_bg, canvas_padding, output_quality, created_at)
          VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(
          args.name, args.description ?? null,
          args.bgRemovalMethod ?? "threshold", args.bgRemovalParams ?? null,
          args.shadowMethod ?? "gaussian", args.shadowParams ?? null,
          args.canvasSize ?? 2048, args.canvasBg ?? "#F8F9FA",
          args.canvasPadding ?? 0, args.outputQuality ?? 95,
        );

        const preset = sqlite.prepare("SELECT * FROM catalog_processing_presets WHERE name = ?").get(args.name);
        return { content: [{ type: "text" as const, text: JSON.stringify({ created: true, preset }, null, 2) }] };
      }

      if (args.action === "update") {
        if (!args.id) return { content: [{ type: "text" as const, text: JSON.stringify({ error: "id is required for update" }) }], isError: true };

        const fields: string[] = [];
        const values: unknown[] = [];

        if (args.name !== undefined) { fields.push("name = ?"); values.push(args.name); }
        if (args.description !== undefined) { fields.push("description = ?"); values.push(args.description); }
        if (args.bgRemovalMethod !== undefined) { fields.push("bg_removal_method = ?"); values.push(args.bgRemovalMethod); }
        if (args.bgRemovalParams !== undefined) { fields.push("bg_removal_params = ?"); values.push(args.bgRemovalParams); }
        if (args.shadowMethod !== undefined) { fields.push("shadow_method = ?"); values.push(args.shadowMethod); }
        if (args.shadowParams !== undefined) { fields.push("shadow_params = ?"); values.push(args.shadowParams); }
        if (args.canvasSize !== undefined) { fields.push("canvas_size = ?"); values.push(args.canvasSize); }
        if (args.canvasBg !== undefined) { fields.push("canvas_bg = ?"); values.push(args.canvasBg); }
        if (args.canvasPadding !== undefined) { fields.push("canvas_padding = ?"); values.push(args.canvasPadding); }
        if (args.outputQuality !== undefined) { fields.push("output_quality = ?"); values.push(args.outputQuality); }

        if (fields.length === 0) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "No fields to update" }) }], isError: true };
        }

        sqlite.prepare(`UPDATE catalog_processing_presets SET ${fields.join(", ")} WHERE id = ?`).run(...values, args.id);
        const preset = sqlite.prepare("SELECT * FROM catalog_processing_presets WHERE id = ?").get(args.id);
        return { content: [{ type: "text" as const, text: JSON.stringify({ updated: true, preset }, null, 2) }] };
      }

      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "action must be 'list', 'create', or 'update'" }) }], isError: true };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: e.message }) }], isError: true };
    }
  }
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 13. catalog.images.pipeline_status — Get pipeline status overview
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

mcpRegistry.register(
  "catalog.images.pipeline_status",
  "Get an overview of pipeline processing status across the catalog — how many images are unprocessed, processing, completed, or failed. Optionally filter by product or factory. Example: pipeline_status for factory JX3.",
  z.object({
    productId: z.string().optional().describe("Filter by product ID"),
    skuPrefix: z.string().optional().describe("Filter by SKU prefix (e.g. 'JX3')"),
  }),
  async (args) => {
    try {
      const clauses: string[] = [];
      const params: unknown[] = [];

      if (args.productId) { clauses.push("cs.product_id = ?"); params.push(args.productId); }
      if (args.skuPrefix) { clauses.push("cs.sku LIKE ?"); params.push(`${args.skuPrefix}%`); }

      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

      const statusCounts = sqlite.prepare(`
        SELECT ci.pipeline_status, COUNT(*) as count
        FROM catalog_images ci
        LEFT JOIN catalog_skus cs ON ci.sku_id = cs.id
        ${where}
        GROUP BY ci.pipeline_status
        ORDER BY ci.pipeline_status
      `).all(...params);

      const totalImages = sqlite.prepare(`
        SELECT COUNT(*) as count FROM catalog_images ci
        LEFT JOIN catalog_skus cs ON ci.sku_id = cs.id
        ${where}
      `).get(...params) as { count: number };

      // Per-stage completion stats
      const stageWhere = where
        ? `${where} AND cip.status = 'completed'`
        : "WHERE cip.status = 'completed'";
      const stageStats = sqlite.prepare(`
        SELECT cip.stage, COUNT(DISTINCT cip.image_id) as image_count,
          AVG(cip.processing_time_ms) as avg_ms,
          SUM(cip.file_size) as total_size_bytes
        FROM catalog_image_pipelines cip
        JOIN catalog_images ci ON cip.image_id = ci.id
        LEFT JOIN catalog_skus cs ON ci.sku_id = cs.id
        ${stageWhere}
        GROUP BY cip.stage
        ORDER BY cip.stage
      `).all(...params);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            totalImages: totalImages.count,
            byStatus: statusCounts,
            byStage: stageStats,
          }, null, 2),
        }],
      };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: e.message }) }], isError: true };
    }
  }
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 14. catalog.images.assign_to_variants — Save front images to each variant
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

mcpRegistry.register(
  "catalog.images.assign_to_variants",
  "Automatically assign the best processed front image to each SKU variant for a product (or all products). Finds the front-type image for each SKU and marks it as is_best + approved. Also sets image_type_id if not already set. Example: assign front images for all JX3 variants.",
  z.object({
    productId: z.string().optional().describe("Product ID to assign images for (if omitted, processes all products matching skuPrefix)"),
    skuPrefix: z.string().optional().describe("Process all products matching this SKU prefix (e.g. 'JX3')"),
    imageTypeSlug: z.string().optional().describe("Image type to assign as hero (default: 'front')"),
    autoApprove: z.boolean().optional().describe("Automatically set matching images to 'approved' status (default: true)"),
  }),
  async (args) => {
    try {
      const imageTypeSlug = args.imageTypeSlug ?? "front";
      const autoApprove = args.autoApprove !== false;

      // Get the image type ID
      const imageType = sqlite.prepare("SELECT id FROM catalog_image_types WHERE slug = ?").get(imageTypeSlug) as { id: string } | undefined;

      // Find products to process
      let products: Array<{ id: string; sku_prefix: string }>;
      if (args.productId) {
        products = sqlite.prepare("SELECT id, sku_prefix FROM catalog_products WHERE id = ?").all(args.productId) as typeof products;
      } else if (args.skuPrefix) {
        products = sqlite.prepare("SELECT id, sku_prefix FROM catalog_products WHERE sku_prefix LIKE ?").all(`${args.skuPrefix}%`) as typeof products;
      } else {
        products = sqlite.prepare("SELECT id, sku_prefix FROM catalog_products").all() as typeof products;
      }

      const results: Array<{ product: string; skusUpdated: number; skusSkipped: number }> = [];

      for (const product of products) {
        const skus = sqlite.prepare("SELECT id, sku, color_name FROM catalog_skus WHERE product_id = ?").all(product.id) as Array<{ id: string; sku: string; color_name: string }>;
        let updated = 0;
        let skipped = 0;

        for (const sku of skus) {
          // Find the best image for this SKU: prefer pipeline-completed, then by image type, then any with file
          const bestImage = sqlite.prepare(`
            SELECT ci.id, ci.file_path, ci.status, ci.is_best, ci.image_type_id,
              cit.slug as type_slug
            FROM catalog_images ci
            LEFT JOIN catalog_image_types cit ON ci.image_type_id = cit.id
            WHERE ci.sku_id = ? AND ci.file_path IS NOT NULL
            ORDER BY
              CASE WHEN ci.pipeline_status = 'completed' THEN 0 ELSE 1 END,
              CASE WHEN cit.slug = ? THEN 0 ELSE 1 END,
              CASE WHEN ci.is_best = 1 THEN 0 ELSE 1 END,
              ci.position
            LIMIT 1
          `).get(sku.id, imageTypeSlug) as Record<string, unknown> | undefined;

          if (!bestImage) {
            skipped++;
            continue;
          }

          // Clear is_best for all images of this SKU, then set this one
          sqlite.prepare("UPDATE catalog_images SET is_best = 0 WHERE sku_id = ?").run(sku.id);

          const updateFields: string[] = ["is_best = 1"];
          const updateValues: unknown[] = [];

          // Set image type if not already set and we have the type ID
          if (imageType && !bestImage.image_type_id) {
            updateFields.push("image_type_id = ?");
            updateValues.push(imageType.id);
          }

          // Auto-approve if requested
          if (autoApprove && bestImage.status !== "approved") {
            updateFields.push("status = 'approved'");
          }

          updateFields.push("updated_at = datetime('now')");

          sqlite.prepare(
            `UPDATE catalog_images SET ${updateFields.join(", ")} WHERE id = ?`
          ).run(...updateValues, bestImage.id);

          updated++;
        }

        results.push({ product: product.sku_prefix, skusUpdated: updated, skusSkipped: skipped });
      }

      const totalUpdated = results.reduce((sum, r) => sum + r.skusUpdated, 0);
      const totalSkipped = results.reduce((sum, r) => sum + r.skusSkipped, 0);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            productsProcessed: products.length,
            totalSkusUpdated: totalUpdated,
            totalSkusSkipped: totalSkipped,
            imageType: imageTypeSlug,
            autoApproved: autoApprove,
            details: results,
          }, null, 2),
        }],
      };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: e.message }) }], isError: true };
    }
  }
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 15. catalog.images.manage_listing — Select 3-6 images for product listings
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

mcpRegistry.register(
  "catalog.images.manage_listing",
  "Manage which images appear on product listings for Shopify, Faire, Amazon. Select 3-6 curated images per product in specific order. Actions: 'get' to see current listing, 'set' to replace, 'auto' to auto-select best images. Example: auto-select listing images for product JX3-005 on shopify.",
  z.object({
    action: z.string().describe("Action: 'get' (view current), 'set' (replace listing), 'auto' (auto-select best images)"),
    productId: z.string().describe("Product ID"),
    platform: z.string().optional().describe("Platform: 'all', 'shopify', 'faire', 'amazon' (default: 'all')"),
    imageIds: z.string().optional().describe("For 'set' action: comma-separated image IDs in display order"),
    maxImages: z.number().optional().describe("For 'auto' action: max images to select (default: 6, min: 3, max: 10)"),
  }),
  async (args) => {
    try {
      const platform = args.platform ?? "all";

      if (args.action === "get") {
        const listingImages = sqlite.prepare(`
          SELECT pli.position, pli.platform,
            ci.id as image_id, ci.file_path, ci.width, ci.height, ci.status, ci.is_best,
            cs.sku, cs.color_name,
            cit.slug as image_type_slug, cit.label as image_type_label
          FROM catalog_product_listing_images pli
          JOIN catalog_images ci ON pli.image_id = ci.id
          LEFT JOIN catalog_skus cs ON ci.sku_id = cs.id
          LEFT JOIN catalog_image_types cit ON ci.image_type_id = cit.id
          WHERE pli.product_id = ? AND (pli.platform = ? OR pli.platform = 'all')
          ORDER BY pli.position
        `).all(args.productId, platform);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              productId: args.productId,
              platform,
              imageCount: listingImages.length,
              images: listingImages,
            }, null, 2),
          }],
        };
      }

      if (args.action === "set") {
        if (!args.imageIds) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "imageIds required for 'set' action" }) }], isError: true };
        }

        const imageIds = args.imageIds.split(",").map((id) => id.trim());

        // Validate all image IDs exist
        for (const id of imageIds) {
          const exists = sqlite.prepare("SELECT id FROM catalog_images WHERE id = ?").get(id);
          if (!exists) {
            return { content: [{ type: "text" as const, text: JSON.stringify({ error: `Image not found: ${id}` }) }], isError: true };
          }
        }

        // Replace listing for this product+platform
        sqlite.prepare(
          "DELETE FROM catalog_product_listing_images WHERE product_id = ? AND platform = ?"
        ).run(args.productId, platform);

        const insertStmt = sqlite.prepare(`
          INSERT INTO catalog_product_listing_images (id, product_id, image_id, platform, position, created_at)
          VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, datetime('now'))
        `);

        for (let i = 0; i < imageIds.length; i++) {
          insertStmt.run(args.productId, imageIds[i], platform, i);
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              productId: args.productId,
              platform,
              action: "set",
              imageCount: imageIds.length,
              imageIds,
            }, null, 2),
          }],
        };
      }

      if (args.action === "auto") {
        const maxImages = Math.min(10, Math.max(3, args.maxImages ?? 6));

        // Get all SKUs for the product
        const skus = sqlite.prepare(
          "SELECT id, sku FROM catalog_skus WHERE product_id = ? ORDER BY sku"
        ).all(args.productId) as Array<{ id: string; sku: string }>;

        if (skus.length === 0) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "No SKUs found for this product" }) }], isError: true };
        }

        // Strategy: Pick the best front image from each SKU, then fill with other angles
        // Priority: front > side > other-side > back-crossed > crossed > top > inside > name
        const anglePriority = ["front", "side", "other-side", "back-crossed", "crossed", "top", "inside", "name", "closed", "above"];

        const selectedImages: Array<{ id: string; sku: string; angle: string; reason: string }> = [];
        const usedImageIds = new Set<string>();

        // Phase 1: One front image per SKU (up to maxImages)
        for (const sku of skus) {
          if (selectedImages.length >= maxImages) break;

          const frontImg = sqlite.prepare(`
            SELECT ci.id, cit.slug as angle
            FROM catalog_images ci
            LEFT JOIN catalog_image_types cit ON ci.image_type_id = cit.id
            WHERE ci.sku_id = ? AND ci.file_path IS NOT NULL
              AND (ci.status = 'approved' OR ci.status = 'review' OR ci.status = 'draft')
            ORDER BY
              CASE WHEN cit.slug = 'front' THEN 0 ELSE 1 END,
              CASE WHEN ci.is_best = 1 THEN 0 ELSE 1 END,
              CASE WHEN ci.pipeline_status = 'completed' THEN 0 ELSE 1 END,
              ci.position
            LIMIT 1
          `).get(sku.id) as { id: string; angle: string } | undefined;

          if (frontImg && !usedImageIds.has(frontImg.id)) {
            selectedImages.push({ id: frontImg.id, sku: sku.sku, angle: frontImg.angle ?? "unknown", reason: "front per variant" });
            usedImageIds.add(frontImg.id);
          }
        }

        // Phase 2: Fill remaining slots with different angles from first SKU
        if (selectedImages.length < maxImages && skus.length > 0) {
          const firstSku = skus[0];
          for (const angle of anglePriority) {
            if (selectedImages.length >= maxImages) break;
            if (angle === "front") continue; // Already covered

            const angleImg = sqlite.prepare(`
              SELECT ci.id
              FROM catalog_images ci
              LEFT JOIN catalog_image_types cit ON ci.image_type_id = cit.id
              WHERE ci.sku_id = ? AND cit.slug = ? AND ci.file_path IS NOT NULL
                AND (ci.status = 'approved' OR ci.status = 'review' OR ci.status = 'draft')
              LIMIT 1
            `).get(firstSku.id, angle) as { id: string } | undefined;

            if (angleImg && !usedImageIds.has(angleImg.id)) {
              selectedImages.push({ id: angleImg.id, sku: firstSku.sku, angle, reason: "angle variety" });
              usedImageIds.add(angleImg.id);
            }
          }
        }

        // Phase 3: If still under minimum, grab any remaining approved images
        if (selectedImages.length < 3) {
          const skuIds = skus.map((s) => s.id);
          const excludeClause = selectedImages.length > 0
            ? `AND ci.id NOT IN (${selectedImages.map(() => "?").join(",")})`
            : "";
          const remaining = sqlite.prepare(`
            SELECT ci.id, cs.sku, cit.slug as angle
            FROM catalog_images ci
            LEFT JOIN catalog_skus cs ON ci.sku_id = cs.id
            LEFT JOIN catalog_image_types cit ON ci.image_type_id = cit.id
            WHERE ci.sku_id IN (${skuIds.map(() => "?").join(",")})
              AND ci.file_path IS NOT NULL
              ${excludeClause}
            ORDER BY ci.is_best DESC, ci.position
            LIMIT ?
          `).all(...skuIds, ...selectedImages.map((s) => s.id), 3 - selectedImages.length) as Array<{ id: string; sku: string; angle: string }>;

          for (const img of remaining) {
            selectedImages.push({ id: img.id, sku: img.sku, angle: img.angle ?? "unknown", reason: "fill minimum" });
          }
        }

        // Save to listing table
        sqlite.prepare(
          "DELETE FROM catalog_product_listing_images WHERE product_id = ? AND platform = ?"
        ).run(args.productId, platform);

        const insertStmt = sqlite.prepare(`
          INSERT INTO catalog_product_listing_images (id, product_id, image_id, platform, position, created_at)
          VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, datetime('now'))
        `);

        for (let i = 0; i < selectedImages.length; i++) {
          insertStmt.run(args.productId, selectedImages[i].id, platform, i);
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              productId: args.productId,
              platform,
              action: "auto",
              strategy: "front per variant → angle variety → fill minimum",
              imageCount: selectedImages.length,
              maxImages,
              selected: selectedImages,
            }, null, 2),
          }],
        };
      }

      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "action must be 'get', 'set', or 'auto'" }) }], isError: true };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: e.message }) }], isError: true };
    }
  }
);
