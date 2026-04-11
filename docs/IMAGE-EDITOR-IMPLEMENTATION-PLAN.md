# Image Editor Implementation Plan

**Date:** 2026-04-11
**Author:** Daniel Seeff (Founder) + Claude Code (Developer)
**Design Doc:** [IMAGE-EDITOR-SYSTEM-DESIGN.md](./IMAGE-EDITOR-SYSTEM-DESIGN.md)

---

## 1. Executive Summary

We are building an integrated image processing pipeline for The Frame that replaces the current manual CLI workflow (Python scripts + Claude Code) with an API-driven, MCP-enabled system. Raw factory photos will flow through a five-stage pipeline (raw, background removal, crop, shadow, canvas) with full database tracking, variation testing, and Shopify sync. The system must work both via MCP (so Claude can process images autonomously) and via the web UI (so Daniel can review, approve, and batch-process visually).

---

## 2. Phased Delivery Plan

### Phase 1: Core Processing Library
**Scope:** Build the server-side image processing functions using Sharp. No database, no API routes — just pure functions that take buffers in and produce buffers out.

| | |
|---|---|
| **Estimated Effort** | 8-10 hours |
| **Dependencies** | None (Sharp already installed) |
| **Shippable Value** | Processing functions callable from Claude Code via MCP or scripts. Can immediately start processing the 228 new factory photos. |

**Milestone:** `runPipeline(buffer, config)` produces a final JPEG from a raw factory photo.

---

### Phase 2: Database Schema + Storage Restructure
**Scope:** New tables (pipelines, variations, collection_images, presets), ALTER catalog_images, new storage directory structure, migration script.

| | |
|---|---|
| **Estimated Effort** | 4-5 hours |
| **Dependencies** | None (can run in parallel with Phase 1) |
| **Shippable Value** | Pipeline tracking in DB. Every processing run is recorded with stage artifacts. |

**Milestone:** Schema migration runs cleanly on Railway. Existing images unaffected.

---

### Phase 3: MCP Tools (Core Pipeline)
**Scope:** Register the essential MCP tools so Claude can process images via conversation. Focus on: `process`, `remove_bg`, `detect_bg`, `place_on_canvas`, `list`, `get`, `update`.

| | |
|---|---|
| **Estimated Effort** | 8-10 hours |
| **Dependencies** | Phase 1 + Phase 2 |
| **Shippable Value** | Claude Code can process images end-to-end via MCP. Daniel can say "process all JX3 front images with threshold removal" and it happens. |

**Milestone:** Successfully process 10 images via MCP conversation and see results in the database.

---

### Phase 4: API Routes + Raw Upload
**Scope:** REST API routes for the pipeline (process, process/batch, process/stage, reprocess). Raw factory photo upload endpoint (bypasses current Sharp normalization). Batch upload with SKU/angle auto-detection from filenames.

| | |
|---|---|
| **Estimated Effort** | 8-10 hours |
| **Dependencies** | Phase 1 + Phase 2 |
| **Shippable Value** | Web UI can trigger processing. Raw factory photos can be uploaded without being mangled by the current 2000x2000 center-crop pipeline. |

**Milestone:** Upload a raw factory photo via API, trigger full pipeline, get back a final JPEG.

---

### Phase 5: Variation Testing + Presets
**Scope:** Variation generation (threshold sweeps, method A/B), variation selection, preset CRUD, preset application to batches.

| | |
|---|---|
| **Estimated Effort** | 6-8 hours |
| **Dependencies** | Phase 3 + Phase 4 |
| **Shippable Value** | Can test 5 threshold settings on one image, pick the winner, and apply it to 200 images. Saves hours of manual tweaking. |

**Milestone:** Generate 5 threshold variations for an image, select one, apply preset to a batch.

---

### Phase 6: Gemini AI Integration (BG Removal + Shadows)
**Scope:** Gemini API client for background removal and shadow generation. Rate limiting, retry logic, async queue for batch Gemini calls.

| | |
|---|---|
| **Estimated Effort** | 6-8 hours |
| **Dependencies** | Phase 1 (core lib), Phase 3 (MCP tools) |
| **Shippable Value** | AI-powered background removal for complex scenes (non-white backgrounds). Realistic AI shadow generation. |

**Milestone:** Process an image with Gemini bg removal + shadow, compare quality to threshold method.

---

### Phase 7: Web UI — Pipeline View + Batch Dashboard
**Scope:** Enhanced image management tab with pipeline stage strip, batch processing dashboard, progress tracking, variation picker, approval flow.

| | |
|---|---|
| **Estimated Effort** | 12-16 hours |
| **Dependencies** | Phase 4 + Phase 5 |
| **Shippable Value** | Daniel can visually review all images, batch-approve, batch-reprocess, compare variations side-by-side. |

**Milestone:** Full pipeline view for a product showing all stages. Batch select + process 50 images with progress bar.

---

### Phase 8: Collection Images + Shopify Push
**Scope:** Collection image compositing (multi-variant product images). Shopify image push (upload final images to both stores). Sync status tracking.

| | |
|---|---|
| **Estimated Effort** | 8-10 hours |
| **Dependencies** | Phase 4 + Phase 6 |
| **Shippable Value** | Auto-generate collection images for all products. Push processed images directly to Shopify without CSV export. |

**Milestone:** Generate collection images for 10 products. Push images for 5 SKUs to Shopify retail store.

---

### Phase 9: Migration of Existing Images
**Scope:** Script to migrate the ~500 existing product images into the new pipeline structure. Backfill pipeline records. Re-organize file storage.

| | |
|---|---|
| **Estimated Effort** | 4-6 hours |
| **Dependencies** | Phase 2 + Phase 4 |
| **Shippable Value** | All existing images tracked in the new system. Consistent storage structure. |

**Milestone:** All 500 existing images have pipeline records and are in the new directory structure.

---

### Total Estimated Effort: 64-83 hours

```
Phase 1: Core Processing Library          8-10h  ████████░░
Phase 2: Database Schema + Storage         4-5h  ████░░░░░░
Phase 3: MCP Tools (Core)                8-10h  ████████░░
Phase 4: API Routes + Raw Upload          8-10h  ████████░░
Phase 5: Variation Testing + Presets       6-8h  ██████░░░░
Phase 6: Gemini AI Integration             6-8h  ██████░░░░
Phase 7: Web UI                          12-16h  ████████████░░░░
Phase 8: Collection Images + Shopify       8-10h  ████████░░
Phase 9: Existing Image Migration          4-6h  ████░░░░░░
```

**Parallelism opportunity:** Phases 1 and 2 can run in parallel. Phases 3 and 4 can start as soon as both are done. Phase 6 can run in parallel with Phase 5.

---

## 3. Detailed Task Breakdown

### Phase 1: Core Processing Library

#### Task 1.1: Pipeline Orchestrator
**Description:** Create the pipeline runner that chains stages together: raw -> no_bg -> crop -> shadow -> final. Each stage takes a buffer and produces a buffer, with timing and metadata.
**Files:**
- `src/modules/catalog/lib/image-editor/index.ts` (create)
- `src/modules/catalog/lib/image-editor/pipeline.ts` (create)

**Effort:** 2h
**Dependencies:** None
**Acceptance Criteria:**
- `runPipeline(buffer, config)` returns a `PipelineResult` with all stage outputs
- `runFromStage(imageId, stage, config)` reprocesses from a specific stage forward
- Each stage records `processingTimeMs`, `width`, `height`, `fileSize`, `checksum`
- Stages are idempotent; re-running overwrites downstream artifacts

#### Task 1.2: Threshold Background Removal
**Description:** Implement threshold-based bg removal for white/light backgrounds. Pixels with `min(R,G,B) >= threshold` become transparent, with optional feather (linear alpha falloff).
**Files:**
- `src/modules/catalog/lib/image-editor/bg-removal/index.ts` (create)
- `src/modules/catalog/lib/image-editor/bg-removal/threshold.ts` (create)

**Effort:** 2h
**Dependencies:** None
**Acceptance Criteria:**
- `removeBackgroundThreshold(buffer, {threshold, feather})` returns PNG RGBA buffer
- `autoDetectThreshold(buffer)` samples corner pixels and suggests a threshold value
- `generateThresholdVariations(buffer, thresholds, feathers)` returns labeled variation buffers
- Works correctly on white-background factory photos

#### Task 1.3: Auto-Crop
**Description:** Crop a transparent PNG to its content bounding box (trim alpha). Add optional minimal padding.
**Files:**
- `src/modules/catalog/lib/image-editor/crop/auto-crop.ts` (create)

**Effort:** 1h
**Dependencies:** None
**Acceptance Criteria:**
- Trims transparent pixels to tight bounding box
- Returns PNG buffer with content dimensions
- Handles edge case of fully-transparent input (returns error, not empty buffer)

#### Task 1.4: Shadow Generation (Gaussian + Silhouette + Bottom-Edge)
**Description:** Implement the three algorithmic shadow types. Gaussian: offset + blur. Silhouette: squashed product shape beneath. Bottom-edge: subtle gradient along bottom.
**Files:**
- `src/modules/catalog/lib/image-editor/shadow/index.ts` (create)
- `src/modules/catalog/lib/image-editor/shadow/gaussian.ts` (create)
- `src/modules/catalog/lib/image-editor/shadow/silhouette.ts` (create)
- `src/modules/catalog/lib/image-editor/shadow/bottom-edge.ts` (create)

**Effort:** 3h
**Dependencies:** None
**Acceptance Criteria:**
- Each shadow function takes an RGBA PNG and returns RGBA PNG with shadow
- `gaussian`: configurable offset `[x,y]`, blur radius, opacity
- `silhouette`: product alpha squashed vertically beneath, blurred
- `bottom-edge`: subtle shadow along bottom 5-10% of product
- Shadow never clips the product; canvas auto-expands if needed

#### Task 1.5: Square Canvas Placement
**Description:** Place a processed RGBA image on a square canvas with configurable size, background color, padding, and JPEG quality.
**Files:**
- `src/modules/catalog/lib/image-editor/canvas/square.ts` (create)

**Effort:** 1h
**Dependencies:** None
**Acceptance Criteria:**
- `placeOnCanvas(buffer, {size, bg, padding, quality})` returns JPEG buffer
- Image centered on canvas, scaled to fit within `(1 - padding*2) * size`
- Default: 2048x2048, #F8F9FA, 0% padding, q95
- Output is RGB JPEG (no alpha channel)

#### Task 1.6: Utility Functions
**Description:** Color sampling (corner pixel analysis for threshold detection), alpha channel operations, white background detection.
**Files:**
- `src/modules/catalog/lib/image-editor/utils/color-sample.ts` (create)
- `src/modules/catalog/lib/image-editor/utils/alpha-ops.ts` (create)

**Effort:** 1h
**Dependencies:** None
**Acceptance Criteria:**
- `sampleCorners(buffer)` returns average RGB of 4 corner regions
- `isWhiteBackground(buffer, tolerance)` returns boolean
- `extractAlpha(buffer)` / `applyAlpha(buffer, alphaMask)` work correctly

---

### Phase 2: Database Schema + Storage Restructure

#### Task 2.1: New Tables Migration
**Description:** Create Drizzle schema definitions and SQL migration for: `catalog_image_pipelines`, `catalog_image_variations`, `catalog_collection_images`, `catalog_processing_presets`.
**Files:**
- `src/modules/catalog/schema/index.ts` (modify — add new table definitions)
- `drizzle/XXXX_image_editor_tables.sql` (create migration)

**Effort:** 2h
**Dependencies:** None
**Acceptance Criteria:**
- All four tables created with correct columns, indexes, and foreign keys
- Migration runs cleanly on a fresh DB and on existing production DB
- Drizzle schema matches SQL exactly

#### Task 2.2: ALTER catalog_images
**Description:** Add new columns to catalog_images: `source`, `pipeline_status`, `parent_image_id`, `angle`, `preset_id`.
**Files:**
- `src/modules/catalog/schema/index.ts` (modify)
- `drizzle/XXXX_image_editor_alter.sql` (create migration)

**Effort:** 1h
**Dependencies:** Task 2.1
**Acceptance Criteria:**
- Existing images get `source='upload'`, `pipeline_status='none'`
- `parent_image_id` is nullable FK to `catalog_images.id`
- `angle` is nullable text
- Migration is backward-compatible (no data loss)

#### Task 2.3: Seed Image Types
**Description:** Seed `catalog_image_types` with angle-based types: front, side, other-side, top, back-crossed, crossed, inside, name, closed, above.
**Files:**
- `drizzle/XXXX_image_editor_seed.sql` (create migration)

**Effort:** 0.5h
**Dependencies:** Task 2.1
**Acceptance Criteria:**
- All 10 angle types exist in `catalog_image_types`
- Existing image types preserved (INSERT OR IGNORE)

#### Task 2.4: Storage Directory Helper
**Description:** Extend the local storage module with helpers for the new directory structure: `<skuId>/raw/`, `<skuId>/no_bg/`, etc. Add a function to resolve stage paths.
**Files:**
- `src/lib/storage/local.ts` (modify — add `getStagePath()`)
- `src/modules/catalog/lib/image-editor/storage.ts` (create)

**Effort:** 1h
**Dependencies:** None
**Acceptance Criteria:**
- `getStagePath(skuId, stage, checksum, ext)` returns correct relative path
- Paths follow the pattern: `<skuId>/<stage>/<checksum>.<ext>`
- `saveStageArtifact(skuId, stage, buffer)` writes to disk and returns metadata
- Variation paths: `<skuId>/variations/<checksum>_<label>.<ext>`

---

### Phase 3: MCP Tools (Core Pipeline)

#### Task 3.1: Process Tool
**Description:** Register `catalog.images.process` MCP tool that runs the full pipeline on a single image.
**Files:**
- `src/modules/catalog/mcp/image-tools.ts` (create)
- `src/modules/core/mcp/server.ts` (modify — add require for image-tools)

**Effort:** 2h
**Dependencies:** Phase 1, Phase 2
**Acceptance Criteria:**
- Accepts `imageId`, bg removal method/params, shadow method/params, canvas options
- Runs full pipeline, stores artifacts on disk, creates pipeline DB records
- Returns stage results with file paths, dimensions, processing times
- Updates `catalog_images.pipeline_status` to `completed` or `failed`

#### Task 3.2: Background Removal Tools
**Description:** Register `catalog.images.remove_bg` and `catalog.images.detect_bg` MCP tools.
**Files:**
- `src/modules/catalog/mcp/image-tools.ts` (modify)

**Effort:** 1.5h
**Dependencies:** Task 1.2
**Acceptance Criteria:**
- `remove_bg`: takes imageId + method + params, runs bg removal only, stores result
- `detect_bg`: analyzes image, returns corner samples, suggested threshold, method recommendation
- Both update pipeline records in DB

#### Task 3.3: Canvas + Output Tools
**Description:** Register `catalog.images.place_on_canvas` MCP tool.
**Files:**
- `src/modules/catalog/mcp/image-tools.ts` (modify)

**Effort:** 1h
**Dependencies:** Task 1.5
**Acceptance Criteria:**
- Takes imageId + canvas options, places on canvas, stores final JPEG
- Returns URL for the generated image

#### Task 3.4: Image List/Get/Update Tools
**Description:** Register `catalog.images.list`, `catalog.images.get`, `catalog.images.update`, `catalog.images.delete`, `catalog.images.bulk_update` MCP tools.
**Files:**
- `src/modules/catalog/mcp/image-tools.ts` (modify)

**Effort:** 2.5h
**Dependencies:** Phase 2
**Acceptance Criteria:**
- `list`: filter by skuId, productId, stage, status, angle. Supports pagination.
- `get`: returns image with all pipeline stages and their artifacts
- `update`: update status, angle, position, isBest
- `delete`: removes image + all pipeline artifacts from disk and DB
- `bulk_update`: update multiple images (status, reassign SKU)

#### Task 3.5: Batch Process Tool
**Description:** Register `catalog.images.process_batch` that uses the job queue for large batches.
**Files:**
- `src/modules/catalog/mcp/image-tools.ts` (modify)
- `src/modules/catalog/lib/image-editor/batch.ts` (create)

**Effort:** 2h
**Dependencies:** Task 3.1, existing job queue
**Acceptance Criteria:**
- Accepts array of imageIds + shared processing config
- Creates a job in the `jobs` table for tracking
- Returns jobId immediately
- Job worker processes images sequentially, updates progress
- `catalog.images.get_pipeline` can check batch job status

---

### Phase 4: API Routes + Raw Upload

#### Task 4.1: Process Route
**Description:** `POST /api/v1/catalog/images/process` — HTTP endpoint for the full pipeline.
**Files:**
- `src/app/api/v1/catalog/images/process/route.ts` (create)

**Effort:** 1.5h
**Dependencies:** Phase 1, Phase 2
**Acceptance Criteria:**
- Request body matches design doc spec
- Returns pipeline result with all stage artifacts
- Authenticated (session or API key)
- Error responses include meaningful messages

#### Task 4.2: Batch Process Route
**Description:** `POST /api/v1/catalog/images/process/batch` — batch processing with job queue.
**Files:**
- `src/app/api/v1/catalog/images/process/batch/route.ts` (create)

**Effort:** 1h
**Dependencies:** Task 3.5
**Acceptance Criteria:**
- Accepts array of imageIds + shared config
- Returns `{ jobId, totalImages }` immediately
- Job status queryable via `GET /api/v1/jobs/[jobId]` (existing)

#### Task 4.3: Single Stage Process Route
**Description:** `POST /api/v1/catalog/images/process/stage` — run one stage only.
**Files:**
- `src/app/api/v1/catalog/images/process/stage/route.ts` (create)

**Effort:** 1h
**Dependencies:** Phase 1
**Acceptance Criteria:**
- Accepts imageId, stage, method, params
- Runs only the specified stage
- Updates pipeline record for that stage

#### Task 4.4: Raw Upload Route
**Description:** `POST /api/v1/catalog/images/upload/raw` — upload factory photos without the current Sharp normalization (center-crop to 2000x2000). Stores original as-is.
**Files:**
- `src/app/api/v1/catalog/images/upload/raw/route.ts` (create)

**Effort:** 2h
**Dependencies:** Phase 2
**Acceptance Criteria:**
- Accepts multipart form data (file + skuId + optional angle)
- Stores original file in `<skuId>/raw/<checksum>.<ext>` without modification
- Auto-detects angle from filename if not provided (e.g., `JX3001-BLK-FRONT.jpg`)
- Creates `catalog_images` record with `source='factory_raw'`
- Optional `autoProcess=true` triggers full pipeline immediately
- Optional `preset` parameter for auto-processing configuration

#### Task 4.5: Batch Raw Upload Route
**Description:** `POST /api/v1/catalog/images/upload/raw/batch` — upload multiple files, auto-match SKUs.
**Files:**
- `src/app/api/v1/catalog/images/upload/raw/batch/route.ts` (create)

**Effort:** 2h
**Dependencies:** Task 4.4
**Acceptance Criteria:**
- Accepts multiple files in single request
- Parses filenames to extract SKU and angle
- Returns match report (matched, unmatched, ambiguous)
- Supports `autoProcess` for all uploaded files

#### Task 4.6: Reprocess Route
**Description:** `POST /api/v1/catalog/images/[id]/reprocess` — reprocess from a specific stage.
**Files:**
- `src/app/api/v1/catalog/images/[id]/reprocess/route.ts` (create)

**Effort:** 1h
**Dependencies:** Phase 1
**Acceptance Criteria:**
- Takes `fromStage` + optional new settings
- Regenerates all downstream stages
- Preserves old artifacts (overwrite pipeline records, not files)

---

### Phase 5: Variation Testing + Presets

#### Task 5.1: Variation Generation
**Description:** MCP tool + API route to generate multiple processing variations for A/B comparison. Focus on threshold sweep and method comparison.
**Files:**
- `src/modules/catalog/mcp/image-tools.ts` (modify — add variation tools)
- `src/app/api/v1/catalog/images/variations/generate/route.ts` (create)

**Effort:** 2.5h
**Dependencies:** Phase 1, Phase 2
**Acceptance Criteria:**
- Takes imageId + array of `{method, params, label}` variations
- Generates all variations, stores in `variations/` directory
- Creates `catalog_image_variations` records
- Returns all variations with file paths and URLs

#### Task 5.2: Variation Selection
**Description:** MCP tool + API route to select a winning variation and apply it as the stage output. Reprocesses downstream stages.
**Files:**
- `src/modules/catalog/mcp/image-tools.ts` (modify)
- `src/app/api/v1/catalog/images/variations/[variationId]/select/route.ts` (create)

**Effort:** 1.5h
**Dependencies:** Task 5.1
**Acceptance Criteria:**
- Marks variation as `is_selected = 1`
- Copies variation artifact to the stage output path
- Triggers downstream reprocessing if `reprocessDownstream: true`

#### Task 5.3: Preset CRUD
**Description:** Full CRUD for processing presets. MCP tools + API routes.
**Files:**
- `src/modules/catalog/mcp/image-tools.ts` (modify — preset tools)
- `src/app/api/v1/catalog/images/presets/route.ts` (create)
- `src/app/api/v1/catalog/images/presets/[id]/route.ts` (create)

**Effort:** 2h
**Dependencies:** Phase 2
**Acceptance Criteria:**
- Create/Read/Update/Delete presets
- Each preset stores: bg removal method + params, shadow method + params, canvas settings
- `catalog.images.apply_preset` applies a preset to one or more images

---

### Phase 6: Gemini AI Integration

#### Task 6.1: Gemini Background Removal
**Description:** Implement Gemini API client for AI background removal. Uses image editing model to remove backgrounds from complex scenes.
**Files:**
- `src/modules/catalog/lib/image-editor/bg-removal/gemini.ts` (create)

**Effort:** 3h
**Dependencies:** None (uses existing `GOOGLE_GEMINI_API_KEY` env var)
**Acceptance Criteria:**
- Sends image to Gemini with default prompt (customizable)
- Receives processed image with background removed
- Handles rate limiting (10 RPM free tier) with exponential backoff
- Returns PNG RGBA buffer
- Error handling for API failures, timeouts, content filtering

#### Task 6.2: Gemini Shadow Generation
**Description:** Use Gemini to generate realistic shadows on processed product images.
**Files:**
- `src/modules/catalog/lib/image-editor/shadow/gemini.ts` (create)

**Effort:** 2h
**Dependencies:** Task 6.1 (reuses Gemini client)
**Acceptance Criteria:**
- Sends cropped product image with shadow prompt
- Returns image with realistic shadow applied
- Configurable prompt override
- Handles rate limiting

#### Task 6.3: Rate Limiter + Queue for Gemini
**Description:** Build a simple rate limiter / concurrency queue for Gemini API calls. Respects `IMAGE_PROCESSING_CONCURRENCY` env var.
**Files:**
- `src/modules/catalog/lib/image-editor/gemini-queue.ts` (create)

**Effort:** 1.5h
**Dependencies:** None
**Acceptance Criteria:**
- Limits concurrent Gemini calls to `IMAGE_PROCESSING_CONCURRENCY` (default 3)
- Queues excess requests and processes in order
- Exponential backoff on 429 (rate limit) errors
- Timeout after 60s per request

---

### Phase 7: Web UI — Pipeline View + Batch Dashboard

#### Task 7.1: Pipeline Stage Strip Component
**Description:** React component showing all 5 pipeline stages for an image as a horizontal strip with thumbnails. Click a stage to see full-size. Shows processing status per stage.
**Files:**
- `src/modules/catalog/components/image-editor/PipelineStrip.tsx` (create)

**Effort:** 3h
**Dependencies:** Phase 4 (API routes for data)
**Acceptance Criteria:**
- Shows raw -> no_bg -> crop -> shadow -> final as thumbnail strip
- Each stage shows: thumbnail, status icon (pending/complete/failed), dimensions
- Click opens full-size preview
- Empty stages show placeholder with "Process" button
- Works on the existing product images tab

#### Task 7.2: Variation Picker Component
**Description:** Side-by-side comparison grid for reviewing threshold/method variations. Support 2-up and 4-up comparison.
**Files:**
- `src/modules/catalog/components/image-editor/VariationPicker.tsx` (create)

**Effort:** 2h
**Dependencies:** Task 5.1
**Acceptance Criteria:**
- Grid of variation thumbnails with labels
- Click to zoom / overlay compare
- "Select" button on each variation
- Shows method + params for each variation

#### Task 7.3: Batch Processing Dashboard
**Description:** Full-page dashboard for batch image management. Table of all images with pipeline status, bulk selection, batch processing trigger, progress tracking.
**Files:**
- `src/modules/catalog/components/image-editor/BatchDashboard.tsx` (create)
- `src/app/(app)/catalog/images/page.tsx` (create)

**Effort:** 4h
**Dependencies:** Phase 4
**Acceptance Criteria:**
- Table with columns: SKU, product, angle, pipeline status, thumbnail, last processed
- Filters: unprocessed, needs_redo, processing, completed, by product, by factory
- Multi-select with "Select All" / "Select Filtered"
- "Process Selected" button with preset picker
- Real-time progress bar for batch jobs (polls job status)

#### Task 7.4: Processing Settings Panel
**Description:** Form panel for configuring processing settings: bg removal method + params, shadow type, canvas options. Used in both single-image and batch contexts.
**Files:**
- `src/modules/catalog/components/image-editor/ProcessingSettings.tsx` (create)

**Effort:** 2h
**Dependencies:** Task 5.3 (presets)
**Acceptance Criteria:**
- Preset selector dropdown
- BG removal: method radio group, threshold slider, feather slider
- Shadow: method radio group, configurable params per method
- Canvas: size, bg color picker, padding slider, quality slider
- "Save as Preset" button
- Live preview (optional, stretch goal)

#### Task 7.5: Enhanced Product Images Tab
**Description:** Wire the new components into the existing product detail page images tab. Replace or enhance the current image management view.
**Files:**
- `src/modules/catalog/components/ProductImages.tsx` (modify or create new version)

**Effort:** 3h
**Dependencies:** Tasks 7.1-7.4
**Acceptance Criteria:**
- Pipeline strip shown for each image
- "Upload Raw" button triggers raw upload flow
- Drag-and-drop raw factory photos
- Process / Reprocess buttons per image and batch
- Variation picker inline
- Collection image preview section

---

### Phase 8: Collection Images + Shopify Push

#### Task 8.1: Collection Image Compositing
**Description:** Generate composite images showing all color variants of a product on a single canvas. Auto-layout based on variant count.
**Files:**
- `src/modules/catalog/lib/image-editor/canvas/collection.ts` (create)

**Effort:** 3h
**Dependencies:** Phase 1
**Acceptance Criteria:**
- Takes array of cropped variant images + layout options
- `auto` layout: single column for 1-5 variants, 2-column grid for 6+
- Each variant labeled with color name
- White background (#FFFFFF) by default
- Output: 2048x2048 JPEG

#### Task 8.2: Collection API + MCP Tools
**Description:** API routes and MCP tools for generating collection images per product or in batch.
**Files:**
- `src/app/api/v1/catalog/images/collections/generate/route.ts` (create)
- `src/modules/catalog/mcp/image-tools.ts` (modify)

**Effort:** 2h
**Dependencies:** Task 8.1
**Acceptance Criteria:**
- `POST /api/v1/catalog/images/collections/generate` for single product
- `POST /api/v1/catalog/images/collections/generate/batch` for all products
- MCP tools: `catalog.images.generate_collection`, `catalog.images.generate_all_collections`
- Stores in `collections/<productId>/` directory
- Creates `catalog_collection_images` records

#### Task 8.3: Shopify Image Push
**Description:** Push final-stage images to Shopify stores via Shopify Admin API. Handles image upload, ordering, alt text, and replacement of existing images.
**Files:**
- `src/modules/catalog/lib/shopify-image-push.ts` (create)
- `src/app/api/v1/catalog/images/shopify-push/route.ts` (create)
- `src/modules/catalog/mcp/image-tools.ts` (modify)

**Effort:** 4h
**Dependencies:** Phase 4, existing Shopify API integration in orders module
**Acceptance Criteria:**
- Accepts SKU IDs + target stores (retail, wholesale, or both)
- Uploads final-stage images to Shopify product via Admin API
- Sets image alt text using existing SEO alt text generator
- `replaceExisting` option to remove old images first
- MCP tools: `catalog.images.shopify_push`, `catalog.images.shopify_status`
- Track sync status per image (last pushed timestamp, store)

---

### Phase 9: Migration of Existing Images

#### Task 9.1: Audit Existing Images
**Description:** Script to scan the current `data/images/` directory and `catalog_images` table. Report: total images, format distribution, which have DB records, orphaned files, duplicate checksums.
**Files:**
- `scripts/audit-images.ts` (create)

**Effort:** 1.5h
**Dependencies:** Phase 2
**Acceptance Criteria:**
- Produces a report showing image counts, formats, orphans
- Identifies images that are already "final" quality vs raw
- Maps current flat structure to proposed SKU-based structure

#### Task 9.2: Migration Script
**Description:** Move existing images into the new directory structure. Create pipeline records marking them as `final` stage (they've already been processed). Update DB paths.
**Files:**
- `scripts/migrate-images.ts` (create)

**Effort:** 2.5h
**Dependencies:** Task 9.1, Phase 2
**Acceptance Criteria:**
- Copies (not moves) files to new structure (rollback-safe)
- Creates `catalog_image_pipelines` records for each image (stage=final)
- Updates `catalog_images.file_path` to new location
- Sets `pipeline_status='completed'` for migrated images
- Dry-run mode that reports changes without making them
- Handles the 228 recently processed factory photos

#### Task 9.3: Cleanup Script
**Description:** After migration is verified, script to remove old file locations and verify integrity.
**Files:**
- `scripts/cleanup-old-images.ts` (create)

**Effort:** 1h
**Dependencies:** Task 9.2
**Acceptance Criteria:**
- Verifies all files exist in new locations before removing old
- Checksum verification (old matches new)
- Reports any discrepancies
- Removes old files only after verification passes

---

## 4. Risk Register

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| R1 | **Gemini API rate limits block batch processing** — Free tier is 10 RPM. Processing 500 images would take 50 minutes minimum. | High | Medium | Use threshold method as default for white-background photos (most factory photos). Reserve Gemini for complex scenes. Implement queue with backoff. Consider upgrading to paid tier ($0.04/image). |
| R2 | **Railway volume disk space** — 5 stages x 500 images x ~500KB = 1.25GB, plus 228 new photos. | Medium | High | Monitor disk usage. Implement cleanup of variation artifacts after selection. Consider compressing intermediate stages. Add disk usage check to system.health MCP tool. |
| R3 | **Sharp memory pressure on Railway** — Processing 2048x2048 images uses ~16MB per image. Concurrent processing could OOM. | Medium | High | Limit concurrency to 3 (env var). Process sequentially within batches. Add memory monitoring. Railway containers have 512MB-8GB RAM depending on plan. |
| R4 | **Existing image migration breaks live references** — Current images may be referenced by Shopify exports, URLs, etc. | Medium | High | Copy-not-move strategy. Keep old paths working via symlinks or redirect. Update DB records in a transaction. Dry-run first. |
| R5 | **Gemini image editing quality inconsistency** — AI bg removal may produce artifacts, cut into product, or leave background remnants. | High | Medium | Always generate variations. Keep threshold as reliable fallback. Human review before Shopify push (approval status). Store all attempts for comparison. |
| R6 | **Filename parsing failures for factory photos** — Not all factory photos follow the `SKU-COLOR-ANGLE.jpg` naming convention. | Medium | Low | Provide manual mapping UI in batch upload. Log unmatched files for review. Support flexible parsing patterns. |
| R7 | **Shopify API rate limits during image push** — Shopify REST API has 40 req/s bucket with 2/s leak rate. | Low | Medium | Queue Shopify calls with rate limiter. Batch by product (one API call per product with multiple images). Use GraphQL API for bulk operations if available. |
| R8 | **Schema migration on production Railway** — ALTER TABLE on SQLite with existing data. | Low | High | Test migration on a copy of production DB first. Backup volume before running. Use `ALTER TABLE ADD COLUMN` which SQLite supports safely. Avoid column renames or type changes. |

---

## 5. Technical Decisions

### Decision 1: Sharp (Node.js) vs Python Scripts for Processing

**Recommendation: Sharp (Node.js) for all algorithmic processing.**

| Factor | Sharp | Python (Pillow/rembg) |
|--------|-------|-----------------------|
| Already installed | Yes (v0.34.2 in package.json) | No Python runtime on Railway |
| Threshold bg removal | Easy (raw pixel access via sharp) | Easy (Pillow) |
| Performance | Fast (libvips C library) | Slower (interpreted), process spawn overhead |
| Deployment | Zero additional config | Need Python, pip, rembg, model downloads (~170MB) |
| Memory | Efficient (streaming) | Higher (full image in Python memory) |
| Integration | Native Node.js, same process | Child process IPC, error handling complexity |

**Decision:** Use Sharp for threshold bg removal, cropping, shadow generation, and canvas placement. Use Gemini API for AI-powered bg removal (instead of rembg). Defer rembg integration to a future phase only if Gemini proves insufficient or too expensive.

**Impact:** Eliminates Python dependency entirely for Phase 1-5. Simplifies Railway deployment. The `rembg-u2net` and `rembg-isnet` methods listed in the design doc become stretch goals, not launch requirements.

---

### Decision 2: Sync vs Async Processing for Gemini API Calls

**Recommendation: Hybrid — sync for single images, async (job queue) for batches.**

- **Single image processing** (via MCP or API): synchronous within the request. Gemini call takes 3-10s. Acceptable for interactive use. MCP callers (Claude) can wait.
- **Batch processing** (>5 images): enqueue as a job. Return jobId immediately. Job worker processes sequentially with progress updates. Job status queryable via existing `/api/v1/jobs/[jobId]`.
- **Concurrency limit**: `IMAGE_PROCESSING_CONCURRENCY=3` controls max parallel Gemini calls within a single batch job.

**Impact:** No additional infrastructure needed. Uses existing `JobQueue` class and `jobs` table. MCP batch tool returns jobId; Claude can poll status.

---

### Decision 3: How to Handle the Existing ~500 Images

**Recommendation: Migrate to new structure, mark as "final" stage.**

The existing ~500 images have already been processed (center-cropped, 2000x2000, JPEG). They don't have raw originals in the system.

**Strategy:**
1. Copy existing images to `<skuId>/final/<checksum>.jpg` in the new structure.
2. Create `catalog_image_pipelines` records with `stage='final'`, `status='completed'`.
3. Set `catalog_images.pipeline_status = 'completed'`, `source = 'upload'`.
4. Do NOT retroactively create `raw`, `no_bg`, `crop`, or `shadow` records (we don't have those artifacts).
5. If an existing image needs reprocessing, it would need a new raw upload.

**For the 228 recently processed factory photos:**
- If raw originals are still available on disk, copy them to `<skuId>/raw/` as well.
- This gives us the ability to reprocess them through the full pipeline later.

**Impact:** Clean migration. No data loss. Existing images work in the new system immediately. Reprocessing requires a raw source (upload new raw if needed).

---

### Decision 4: Storage Structure Changes

**Recommendation: SKU-based directory structure with stage subdirectories.**

**Current structure:**
```
data/images/
  <flat list of checksum>.jpg
```

**New structure:**
```
data/images/
  <skuId>/
    raw/<checksum>.jpg
    no_bg/<checksum>.png
    crop/<checksum>.png
    shadow/<checksum>.png
    final/<checksum>.jpg
    variations/<checksum>_<label>.jpg
  collections/
    <productId>/<checksum>.jpg
```

**Key decisions:**
- **Checksum-based filenames:** Prevents duplicates. Enables cache busting. Matches current pattern.
- **Stage subdirectories:** Clear separation. Easy to find/serve specific stages.
- **SKU as top-level grouping:** Natural boundary. One SKU = one product color = one set of images.
- **Collections separate:** Product-level, not SKU-level. Different lifecycle.
- **Old files coexist:** During migration, old flat files remain until cleanup. No broken references.

**Impact:** Clear organization. Easy to reason about disk usage per SKU. Supports the pipeline model naturally. The `getStagePath()` helper abstracts this from calling code.

---

### Decision 5: rembg Integration (Deferred)

**Recommendation: Defer rembg to post-launch. Remove from Phase 1 scope.**

rembg requires:
- Python 3.8+ installed on Railway
- pip install rembg[gpu] or rembg[cpu]
- u2net model download (~170MB)
- Child process management from Node.js

This is significant deployment complexity for a method that Gemini API likely handles better. If Gemini bg removal proves insufficient for certain image types, rembg can be added as a Phase 10 enhancement.

**Impact:** Reduces Phase 1 scope. Simplifies Railway Dockerfile. Two bg removal methods available at launch: threshold (free, fast) and Gemini (AI, paid).

---

## 6. Priority Order (If We Can Only Build 30%)

30% of 70 hours = ~21 hours. Here is what to build:

### Must-Have (~21 hours)

1. **Task 1.2: Threshold Background Removal** (2h) — The workhorse. Most factory photos have white backgrounds.
2. **Task 1.3: Auto-Crop** (1h) — Required for every processed image.
3. **Task 1.5: Square Canvas Placement** (1h) — Produces the final Shopify-ready JPEG.
4. **Task 1.1: Pipeline Orchestrator** (2h) — Chains the above together.
5. **Task 2.1: New Tables Migration** (2h) — Pipeline tracking is essential.
6. **Task 2.2: ALTER catalog_images** (1h) — Needed for pipeline_status.
7. **Task 2.4: Storage Directory Helper** (1h) — Needed to write artifacts.
8. **Task 3.1: Process MCP Tool** (2h) — The single most valuable deliverable. Claude can process images.
9. **Task 3.2: BG Removal MCP Tools** (1.5h) — Claude can detect and remove backgrounds.
10. **Task 3.4: Image List/Get/Update MCP Tools** (2.5h) — Claude can manage images.
11. **Task 3.5: Batch Process MCP Tool** (2h) — Claude can process all 228 images in one command.
12. **Task 4.4: Raw Upload Route** (2h) — Upload factory photos without mangling them.
13. **Task 1.6: Utility Functions** (1h) — Supporting functions for the above.

**What this gets you:** Claude Code can process all 228 factory photos through the pipeline via MCP. Raw uploads work correctly. All processing is tracked in the database. Daniel can see results via existing image views. This is the 80/20 — most of the daily workflow value with ~30% of the effort.

### What Gets Deferred:
- Gemini AI integration (use threshold for now)
- Shadow generation (ship without shadows initially)
- Web UI enhancements (use MCP via Claude for now)
- Variation testing (manually pick threshold for now)
- Collection images (generate later)
- Shopify push (continue using CSV export)
- Presets (hardcode good defaults)
- Existing image migration (run later)

---

## Appendix A: Dependency Graph

```
Phase 1 (Core Lib) ──────┬──→ Phase 3 (MCP Tools) ──→ Phase 5 (Variations)
                          │                              │
Phase 2 (Schema) ─────┬──┘                              ├──→ Phase 7 (Web UI)
                       │                                 │
                       └──→ Phase 4 (API Routes) ────────┘
                       │
                       └──→ Phase 9 (Migration)

Phase 6 (Gemini) ── standalone, plugs into Phase 1 methods

Phase 8 (Collections + Shopify) ── depends on Phase 4 + Phase 6
```

## Appendix B: Environment Variables

```env
# Existing (no changes needed)
GOOGLE_GEMINI_API_KEY=...           # Already set on Railway
IMAGES_PATH=/data/images            # Already set on Railway

# New (add to Railway)
GEMINI_IMAGE_MODEL=gemini-2.5-flash-image   # Model for bg removal/shadow
IMAGE_PROCESSING_CONCURRENCY=3              # Max concurrent Gemini API calls
```

## Appendix C: Files Created/Modified Summary

**New files (23):**
- `src/modules/catalog/lib/image-editor/index.ts`
- `src/modules/catalog/lib/image-editor/pipeline.ts`
- `src/modules/catalog/lib/image-editor/storage.ts`
- `src/modules/catalog/lib/image-editor/batch.ts`
- `src/modules/catalog/lib/image-editor/gemini-queue.ts`
- `src/modules/catalog/lib/image-editor/bg-removal/index.ts`
- `src/modules/catalog/lib/image-editor/bg-removal/threshold.ts`
- `src/modules/catalog/lib/image-editor/bg-removal/gemini.ts`
- `src/modules/catalog/lib/image-editor/crop/auto-crop.ts`
- `src/modules/catalog/lib/image-editor/shadow/index.ts`
- `src/modules/catalog/lib/image-editor/shadow/gaussian.ts`
- `src/modules/catalog/lib/image-editor/shadow/silhouette.ts`
- `src/modules/catalog/lib/image-editor/shadow/bottom-edge.ts`
- `src/modules/catalog/lib/image-editor/shadow/gemini.ts`
- `src/modules/catalog/lib/image-editor/canvas/square.ts`
- `src/modules/catalog/lib/image-editor/canvas/collection.ts`
- `src/modules/catalog/lib/image-editor/utils/color-sample.ts`
- `src/modules/catalog/lib/image-editor/utils/alpha-ops.ts`
- `src/modules/catalog/mcp/image-tools.ts`
- `src/modules/catalog/lib/shopify-image-push.ts`
- `scripts/audit-images.ts`
- `scripts/migrate-images.ts`
- `scripts/cleanup-old-images.ts`

**New API routes (11):**
- `src/app/api/v1/catalog/images/process/route.ts`
- `src/app/api/v1/catalog/images/process/batch/route.ts`
- `src/app/api/v1/catalog/images/process/stage/route.ts`
- `src/app/api/v1/catalog/images/upload/raw/route.ts`
- `src/app/api/v1/catalog/images/upload/raw/batch/route.ts`
- `src/app/api/v1/catalog/images/[id]/reprocess/route.ts`
- `src/app/api/v1/catalog/images/variations/generate/route.ts`
- `src/app/api/v1/catalog/images/variations/[variationId]/select/route.ts`
- `src/app/api/v1/catalog/images/presets/route.ts`
- `src/app/api/v1/catalog/images/presets/[id]/route.ts`
- `src/app/api/v1/catalog/images/collections/generate/route.ts`
- `src/app/api/v1/catalog/images/shopify-push/route.ts`

**New UI components (5):**
- `src/modules/catalog/components/image-editor/PipelineStrip.tsx`
- `src/modules/catalog/components/image-editor/VariationPicker.tsx`
- `src/modules/catalog/components/image-editor/BatchDashboard.tsx`
- `src/modules/catalog/components/image-editor/ProcessingSettings.tsx`
- `src/app/(app)/catalog/images/page.tsx`

**Modified files (4):**
- `src/modules/catalog/schema/index.ts` — add new table definitions
- `src/modules/core/mcp/server.ts` — register image tools
- `src/lib/storage/local.ts` — add stage path helpers
- `src/modules/catalog/components/ProductImages.tsx` — wire in new components

**Migrations (3):**
- `drizzle/XXXX_image_editor_tables.sql`
- `drizzle/XXXX_image_editor_alter.sql`
- `drizzle/XXXX_image_editor_seed.sql`
