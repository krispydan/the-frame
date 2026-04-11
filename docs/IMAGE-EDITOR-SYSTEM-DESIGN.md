# Image Editor System Design — The Frame

## 1. Overview

A comprehensive image processing and editing module for The Frame that replaces the current manual CLI-based pipeline with an integrated, API-driven, MCP-enabled system. Supports raw factory photo ingestion, AI and algorithmic background removal, shadow generation, canvas placement, collection image compositing, Shopify sync, and full lifecycle management.

---

## 2. Architecture

### 2.1 Processing Pipeline

Raw factory photos flow through a multi-stage pipeline. Each stage produces artifacts stored on disk and tracked in the database.

```
RAW UPLOAD → BACKGROUND REMOVAL → CROP → SHADOW → CANVAS → APPROVAL → SHOPIFY PUSH
     ↓              ↓                ↓       ↓         ↓
  01_raw       02_no_bg          03_crop  04_shadow  05_final
```

**Stages:**

| Stage | Slug | Description | Output Format |
|-------|------|-------------|---------------|
| 01 | `raw` | Original factory photo, unmodified | Original format (JPG/PNG) |
| 02 | `no_bg` | Background removed (transparent) | PNG (RGBA) |
| 03 | `crop` | Cropped to content bounding box | PNG (RGBA) |
| 04 | `shadow` | Drop shadow applied | PNG (RGBA) |
| 05 | `final` | Placed on square canvas, ready for Shopify | JPEG (RGB, q95) |

Each stage is **idempotent** — reprocessing from any stage regenerates all downstream stages. Stage artifacts are preserved for history/revert.

### 2.2 Processing Methods

#### Background Removal
| Method | Slug | Use Case |
|--------|------|----------|
| Gemini AI | `gemini` | Non-white backgrounds, complex scenes, shadows/reflections |
| Threshold | `threshold` | White/light solid backgrounds (fast, free) |
| rembg (u2net) | `rembg-u2net` | Fallback AI, runs locally |
| rembg (isnet) | `rembg-isnet` | Tighter edges, may eat lenses |

#### Shadow Types
| Type | Slug | Description |
|------|------|-------------|
| Gemini AI | `gemini` | Most realistic, prompt-based |
| Gaussian drop | `gaussian` | Basic offset + blur shadow |
| Silhouette contact | `silhouette` | Squashed product shape below |
| Bottom edge | `bottom-edge` | Subtle shadow along bottom only |
| None | `none` | No shadow |

#### Canvas Settings
| Setting | Default | Description |
|---------|---------|-------------|
| Size | 2048×2048 | Output dimensions |
| Background | #F8F9FA | Canvas background color |
| Padding | 0% | Edge padding (0% = edge-to-edge) |
| Format | JPEG q95 | Output format and quality |

---

## 3. Database Schema Changes

### 3.1 New Table: `catalog_image_pipelines`

Tracks processing history for each image through the pipeline.

```sql
CREATE TABLE catalog_image_pipelines (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  image_id TEXT NOT NULL REFERENCES catalog_images(id) ON DELETE CASCADE,
  stage TEXT NOT NULL, -- raw, no_bg, crop, shadow, final
  method TEXT, -- gemini, threshold, rembg-u2net, etc.
  method_params TEXT, -- JSON: {threshold: 240, feather: 10} or {prompt: "..."}
  file_path TEXT NOT NULL, -- relative path to stage artifact
  file_size INTEGER,
  width INTEGER,
  height INTEGER,
  checksum TEXT,
  status TEXT DEFAULT 'completed', -- completed, failed, pending
  error_message TEXT,
  processing_time_ms INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(image_id, stage) -- one artifact per stage per image (latest wins)
);
CREATE INDEX idx_pipeline_image ON catalog_image_pipelines(image_id);
CREATE INDEX idx_pipeline_stage ON catalog_image_pipelines(stage);
```

### 3.2 New Table: `catalog_image_variations`

Stores multiple processing variations for A/B comparison (e.g., threshold testing).

```sql
CREATE TABLE catalog_image_variations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  image_id TEXT NOT NULL REFERENCES catalog_images(id) ON DELETE CASCADE,
  stage TEXT NOT NULL, -- which stage this variation is for
  method TEXT NOT NULL,
  method_params TEXT, -- JSON
  file_path TEXT NOT NULL,
  file_size INTEGER,
  width INTEGER,
  height INTEGER,
  label TEXT, -- human-readable label: "thresh240_f10"
  is_selected INTEGER DEFAULT 0, -- 1 = this variation was chosen
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_variation_image ON catalog_image_variations(image_id);
```

### 3.3 New Table: `catalog_collection_images`

Tracks collection (composite) images per parent product.

```sql
CREATE TABLE catalog_collection_images (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  product_id TEXT NOT NULL REFERENCES catalog_products(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  file_size INTEGER,
  width INTEGER,
  height INTEGER,
  layout TEXT, -- single_column, grid_2col
  variant_count INTEGER,
  sku_ids TEXT, -- JSON array of SKU IDs included
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(product_id)
);
```

### 3.4 New Table: `catalog_processing_presets`

Saved processing configurations for reuse.

```sql
CREATE TABLE catalog_processing_presets (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  bg_removal_method TEXT DEFAULT 'gemini',
  bg_removal_params TEXT, -- JSON
  shadow_method TEXT DEFAULT 'none',
  shadow_params TEXT, -- JSON
  canvas_size INTEGER DEFAULT 2048,
  canvas_bg TEXT DEFAULT '#F8F9FA',
  canvas_padding REAL DEFAULT 0.0,
  output_quality INTEGER DEFAULT 95,
  created_at TEXT DEFAULT (datetime('now'))
);
```

### 3.5 Modifications to `catalog_images`

Add columns:

```sql
ALTER TABLE catalog_images ADD COLUMN source TEXT DEFAULT 'upload'; 
  -- upload, ai_generated, factory_raw, reprocessed
ALTER TABLE catalog_images ADD COLUMN pipeline_status TEXT DEFAULT 'none';
  -- none, processing, completed, failed, needs_redo
ALTER TABLE catalog_images ADD COLUMN parent_image_id TEXT REFERENCES catalog_images(id);
  -- links reprocessed images to their source
ALTER TABLE catalog_images ADD COLUMN angle TEXT;
  -- FRONT, SIDE, OTHER-SIDE, TOP, BACK-CROSSED, CROSSED, INSIDE, NAME, etc.
ALTER TABLE catalog_images ADD COLUMN preset_id TEXT REFERENCES catalog_processing_presets(id);
```

### 3.6 Modifications to `catalog_image_types`

Seed with angle-based types matching factory photo conventions:

```
front, side, other-side, top, back-crossed, crossed, inside, name, closed, above
```

---

## 4. File Storage Structure

```
data/images/
  <skuId>/
    raw/                    # Stage 01: original factory photos
      <checksum>.jpg
    no_bg/                  # Stage 02: background removed
      <checksum>.png
    crop/                   # Stage 03: cropped to content
      <checksum>.png
    shadow/                 # Stage 04: shadow applied
      <checksum>.png
    final/                  # Stage 05: square canvas output
      <checksum>.jpg
    variations/             # Threshold/method test variations
      <checksum>_<label>.jpg
  collections/              # Collection images by product
    <productId>/
      <checksum>.jpg
```

---

## 5. API Routes

All routes prefixed with `/api/v1/catalog/images/`.

### 5.1 Pipeline Processing

#### `POST /api/v1/catalog/images/process`
**Full pipeline processing** — takes a raw image through all stages.

```typescript
// Request
{
  imageId: string,             // existing raw image ID
  preset?: string,             // preset name or ID
  bgRemoval: {
    method: "gemini" | "threshold" | "rembg-u2net" | "rembg-isnet",
    params?: {
      threshold?: number,      // for threshold method
      feather?: number,        // for threshold method
      prompt?: string,         // for gemini method (override default)
    }
  },
  shadow?: {
    method: "gemini" | "gaussian" | "silhouette" | "bottom-edge" | "none",
    params?: {
      offset?: [number, number],
      blur?: number,
      opacity?: number,
      prompt?: string,
    }
  },
  canvas?: {
    size?: number,             // default 2048
    bg?: string,               // hex color, default #F8F9FA
    padding?: number,          // 0-0.2, default 0
    quality?: number,          // 1-100, default 95
  }
}

// Response
{
  imageId: string,
  stages: {
    no_bg: { filePath, width, height, processingTimeMs },
    crop: { filePath, width, height },
    shadow: { filePath, width, height },
    final: { filePath, width, height, url },
  }
}
```

#### `POST /api/v1/catalog/images/process/batch`
**Batch processing** — process multiple images with same settings.

```typescript
{
  imageIds: string[],
  preset?: string,
  bgRemoval: { ... },
  shadow?: { ... },
  canvas?: { ... },
}
// Returns job ID for async tracking
{ jobId: string, totalImages: number }
```

#### `POST /api/v1/catalog/images/process/stage`
**Single stage processing** — run one stage only.

```typescript
{
  imageId: string,
  stage: "no_bg" | "crop" | "shadow" | "final",
  method?: string,
  params?: object,
}
```

### 5.2 Variation Testing

#### `POST /api/v1/catalog/images/variations/generate`
**Generate test variations** for comparison.

```typescript
{
  imageId: string,
  stage: "no_bg" | "shadow",
  variations: [
    { method: "threshold", params: { threshold: 230, feather: 0 }, label: "thresh230_f0" },
    { method: "threshold", params: { threshold: 235, feather: 10 }, label: "thresh235_f10" },
    { method: "threshold", params: { threshold: 240, feather: 15 }, label: "thresh240_f15" },
  ]
}
// Response
{
  imageId: string,
  variations: [
    { id, label, filePath, url, width, height },
    ...
  ]
}
```

#### `POST /api/v1/catalog/images/variations/[variationId]/select`
**Select a winning variation** — applies it as the stage output and reprocesses downstream.

```typescript
{ reprocessDownstream: true }
```

#### `GET /api/v1/catalog/images/variations?imageId=xxx`
**List variations** for an image.

### 5.3 Collection Images

#### `POST /api/v1/catalog/images/collections/generate`
**Generate collection image** for a product.

```typescript
{
  productId: string,
  layout?: "auto" | "single_column" | "grid_2col",
  canvasSize?: number,
  canvasBg?: string,     // default #FFFFFF for collections
  sourceStage?: string,  // which stage to pull from (default: "crop")
}
```

#### `POST /api/v1/catalog/images/collections/generate/batch`
**Batch generate** for multiple/all products.

```typescript
{ productIds?: string[] }  // omit for all products
```

#### `GET /api/v1/catalog/images/collections?productId=xxx`
**Get collection image** for a product.

### 5.4 Raw Upload (Factory Photos)

#### `POST /api/v1/catalog/images/upload/raw`
**Upload raw factory photo** — stores as-is without sharp normalization.

```typescript
// Multipart form data
file: File,
skuId: string,
angle?: string,          // FRONT, SIDE, etc. (auto-detected from filename if omitted)
autoProcess?: boolean,   // if true, immediately run full pipeline
preset?: string,         // preset to use for auto-processing
```

#### `POST /api/v1/catalog/images/upload/raw/batch`
**Batch upload** — accepts multiple files, auto-matches SKUs from filenames.

### 5.5 Reprocess / Redo

#### `POST /api/v1/catalog/images/[id]/reprocess`
**Reprocess an image** from a specific stage.

```typescript
{
  fromStage: "raw" | "no_bg" | "crop" | "shadow",
  bgRemoval?: { ... },
  shadow?: { ... },
  canvas?: { ... },
}
```

#### `POST /api/v1/catalog/images/reprocess/batch`
**Batch reprocess** multiple images.

```typescript
{
  imageIds: string[],
  fromStage: string,
  ...settings
}
```

### 5.6 Presets

#### `GET /api/v1/catalog/images/presets`
#### `POST /api/v1/catalog/images/presets`
#### `PATCH /api/v1/catalog/images/presets/[id]`
#### `DELETE /api/v1/catalog/images/presets/[id]`

CRUD for processing presets.

### 5.7 Shopify Sync

#### `POST /api/v1/catalog/images/shopify-push`
**Push images to Shopify** — uploads final stage images for specified SKUs.

```typescript
{
  skuIds: string[],
  stores: ["retail", "wholesale"],  // or both
  replaceExisting: boolean,         // delete old images first
  includeAngles?: string[],         // which angles to push (default: all approved)
}
```

---

## 6. Server-Side Processing Library

### 6.1 Module: `src/modules/catalog/lib/image-editor/`

```
image-editor/
  index.ts                 # Public API exports
  pipeline.ts              # Full pipeline orchestrator
  bg-removal/
    index.ts               # Method router
    gemini.ts              # Gemini API background removal
    threshold.ts           # Threshold-based removal
    rembg.ts               # rembg integration (child process)
  shadow/
    index.ts               # Method router
    gemini.ts              # Gemini AI shadow
    gaussian.ts            # Basic gaussian drop shadow
    silhouette.ts          # Silhouette contact shadow
    bottom-edge.ts         # Bottom edge shadow
  canvas/
    square.ts              # Square canvas placement
    collection.ts          # Collection image compositing
  crop/
    auto-crop.ts           # Crop to alpha/white bounding box
    white-detect.ts        # White background detection
  utils/
    color-sample.ts        # Sample corner pixels for threshold detection
    alpha-ops.ts           # Alpha channel operations
```

### 6.2 Pipeline Orchestrator (`pipeline.ts`)

```typescript
interface PipelineConfig {
  bgRemoval: { method: string; params?: Record<string, any> };
  shadow: { method: string; params?: Record<string, any> };
  canvas: { size: number; bg: string; padding: number; quality: number };
}

interface PipelineResult {
  stages: Record<string, {
    filePath: string;
    width: number;
    height: number;
    fileSize: number;
    checksum: string;
    processingTimeMs: number;
  }>;
}

async function runPipeline(
  rawImagePath: string,
  skuId: string,
  config: PipelineConfig
): Promise<PipelineResult>;

async function runFromStage(
  imageId: string,
  fromStage: string,
  config: Partial<PipelineConfig>
): Promise<PipelineResult>;
```

### 6.3 Background Removal — Gemini (`bg-removal/gemini.ts`)

```typescript
const DEFAULT_PROMPT = 
  "This is a product photo of sunglasses. Remove the background completely. " +
  "Keep the sunglasses fully intact — do not alter or remove any part of the product. " +
  "Replace the background with pure white. Remove all shadows and reflections.";

async function removeBackgroundGemini(
  inputBuffer: Buffer,
  options?: { prompt?: string; model?: string }
): Promise<Buffer>; // Returns PNG RGBA
```

### 6.4 Background Removal — Threshold (`bg-removal/threshold.ts`)

```typescript
interface ThresholdOptions {
  threshold: number;  // 0-255, pixels with min(R,G,B) >= this become transparent
  feather: number;    // 0-50, linear alpha falloff range
}

function removeBackgroundThreshold(
  inputBuffer: Buffer,
  options: ThresholdOptions
): Promise<Buffer>; // Returns PNG RGBA

function autoDetectThreshold(
  inputBuffer: Buffer
): Promise<{ suggestedThreshold: number; cornerSamples: number[] }>;

function generateThresholdVariations(
  inputBuffer: Buffer,
  thresholds: number[],
  feathers: number[]
): Promise<Array<{ label: string; buffer: Buffer; threshold: number; feather: number }>>;
```

### 6.5 Shadow Generation (`shadow/`)

Each shadow module exports:

```typescript
async function applyShadow(
  inputBuffer: Buffer,  // RGBA PNG (cropped product)
  options: ShadowOptions
): Promise<Buffer>; // RGBA PNG with shadow
```

### 6.6 Canvas Placement (`canvas/square.ts`)

```typescript
interface CanvasOptions {
  size?: number;       // default 2048
  bg?: string;         // hex, default #F8F9FA
  padding?: number;    // 0-0.2, default 0
  quality?: number;    // 1-100, default 95
}

async function placeOnCanvas(
  inputBuffer: Buffer,  // RGBA PNG
  options: CanvasOptions
): Promise<Buffer>; // JPEG RGB
```

### 6.7 Collection Compositing (`canvas/collection.ts`)

```typescript
interface CollectionOptions {
  canvasSize?: number;      // default 2048
  canvasBg?: string;        // default #FFFFFF
  layout?: "auto" | "single_column" | "grid_2col";
  // auto: single_column for ≤5, grid_2col for 6+
}

async function generateCollectionImage(
  croppedBuffers: Array<{ color: string; buffer: Buffer }>,
  options: CollectionOptions
): Promise<Buffer>; // JPEG RGB
```

---

## 7. MCP Tools

All tools registered under the `catalog.images` namespace.

### 7.1 Pipeline Tools

| Tool | Description |
|------|-------------|
| `catalog.images.process` | Process a raw image through the full pipeline |
| `catalog.images.process_batch` | Batch process multiple images |
| `catalog.images.reprocess` | Reprocess an image from a specific stage |
| `catalog.images.get_pipeline` | Get pipeline status and stage artifacts for an image |

### 7.2 Background Removal Tools

| Tool | Description |
|------|-------------|
| `catalog.images.remove_bg` | Remove background from an image (specify method) |
| `catalog.images.detect_bg` | Analyze image background (sample corners, suggest method/threshold) |
| `catalog.images.generate_variations` | Generate threshold/method variations for comparison |
| `catalog.images.select_variation` | Select a winning variation and apply it |

### 7.3 Shadow Tools

| Tool | Description |
|------|-------------|
| `catalog.images.add_shadow` | Add a drop shadow to a processed image |
| `catalog.images.preview_shadows` | Generate all shadow type previews for comparison |

### 7.4 Canvas / Output Tools

| Tool | Description |
|------|-------------|
| `catalog.images.place_on_canvas` | Place a processed image on a square canvas |
| `catalog.images.generate_collection` | Generate a collection image for a product |
| `catalog.images.generate_all_collections` | Batch generate collection images for all products |

### 7.5 Upload / Management Tools

| Tool | Description |
|------|-------------|
| `catalog.images.upload_raw` | Upload a raw factory photo (base64 or URL) |
| `catalog.images.list` | List images with filters (skuId, productId, stage, status, angle) |
| `catalog.images.get` | Get a single image with all pipeline stages |
| `catalog.images.update` | Update image metadata (status, angle, position, isBest) |
| `catalog.images.delete` | Delete an image and all its pipeline artifacts |
| `catalog.images.bulk_update` | Bulk update status or reassign SKU |
| `catalog.images.flag_redo` | Flag images that need reprocessing |

### 7.6 Shopify Tools

| Tool | Description |
|------|-------------|
| `catalog.images.shopify_push` | Push final images to Shopify stores |
| `catalog.images.shopify_status` | Check which SKUs have synced vs unsynced images |

### 7.7 Preset Tools

| Tool | Description |
|------|-------------|
| `catalog.images.list_presets` | List all processing presets |
| `catalog.images.create_preset` | Create a new processing preset |
| `catalog.images.apply_preset` | Apply a preset to one or more images |

### MCP Tool Schema Examples

```typescript
// catalog.images.process
registry.register(
  "catalog.images.process",
  "Process a raw image through the full pipeline (bg removal → crop → shadow → canvas)",
  z.object({
    imageId: z.string().describe("Image ID to process"),
    bgRemovalMethod: z.enum(["gemini", "threshold", "rembg-u2net", "rembg-isnet"]).default("gemini"),
    bgRemovalParams: z.object({
      threshold: z.number().optional(),
      feather: z.number().optional(),
      prompt: z.string().optional(),
    }).optional(),
    shadowMethod: z.enum(["gemini", "gaussian", "silhouette", "bottom-edge", "none"]).default("none"),
    shadowParams: z.object({
      offset: z.array(z.number()).optional(),
      blur: z.number().optional(),
      opacity: z.number().optional(),
    }).optional(),
    canvasSize: z.number().default(2048),
    canvasBg: z.string().default("#F8F9FA"),
    canvasPadding: z.number().default(0),
  }),
  handler
);

// catalog.images.remove_bg
registry.register(
  "catalog.images.remove_bg",
  "Remove background from an image using specified method",
  z.object({
    imageId: z.string(),
    method: z.enum(["gemini", "threshold", "rembg-u2net", "rembg-isnet"]),
    threshold: z.number().min(0).max(255).optional(),
    feather: z.number().min(0).max(50).optional(),
    prompt: z.string().optional(),
  }),
  handler
);

// catalog.images.generate_variations
registry.register(
  "catalog.images.generate_variations",
  "Generate multiple processing variations for A/B comparison",
  z.object({
    imageId: z.string(),
    stage: z.enum(["no_bg", "shadow"]),
    variations: z.array(z.object({
      method: z.string(),
      params: z.record(z.any()).optional(),
      label: z.string(),
    })),
  }),
  handler
);

// catalog.images.shopify_push
registry.register(
  "catalog.images.shopify_push",
  "Push processed images to Shopify stores",
  z.object({
    skuIds: z.array(z.string()),
    stores: z.array(z.enum(["retail", "wholesale"])).default(["retail", "wholesale"]),
    replaceExisting: z.boolean().default(true),
    angles: z.array(z.string()).optional(),
  }),
  handler
);
```

---

## 8. UI Components

### 8.1 Image Editor Page (`/catalog/products/[id]/images`)

Enhanced version of the existing image management tab:

- **Pipeline view** — for each image, show all stages as a horizontal strip (raw → no_bg → crop → shadow → final)
- **Bulk actions** — select multiple images, batch process with preset
- **Variation picker** — side-by-side comparison grid when testing thresholds/methods
- **Shadow preview** — toggle between shadow types in real-time
- **Canvas preview** — adjust size/padding/bg with live preview
- **Collection preview** — show generated collection image, regenerate button

### 8.2 Raw Upload Flow

1. Drag-and-drop raw factory photos (multi-file)
2. Auto-detect SKU and angle from filename (`JX3001-BLK-FRONT.jpg`)
3. Review matches, fix any mismatches
4. Choose preset or configure processing settings
5. Process all → review results → approve/redo

### 8.3 Batch Processing Dashboard

- Table of all images with pipeline status
- Filter: unprocessed, needs_redo, processing, completed
- Select all / select by product → apply preset → process
- Progress tracking for batch jobs

---

## 9. Job Queue for Batch Operations

Batch operations (processing 200+ images) should use the existing `jobs` table and async processing.

```typescript
// Create a job
const jobId = await createJob({
  type: "image_batch_process",
  params: { imageIds, preset, bgRemoval, shadow, canvas },
  total: imageIds.length,
});

// Job runner processes images sequentially with progress updates
for (const imageId of imageIds) {
  await processImage(imageId, settings);
  await updateJobProgress(jobId, processed++);
}
```

Jobs are tracked in the `jobs` table (already exists in core schema) and status is queryable via `GET /api/v1/catalog/images/jobs/[jobId]`.

---

## 10. Integration Points

### 10.1 Existing Systems

| System | Integration |
|--------|-------------|
| **Shopify Push** | Extend existing `shopify-push` route to use final-stage images |
| **AI Generation** | Gemini generation route output feeds into pipeline as `raw` stage |
| **Uppy Upload** | Existing upload becomes the `raw` upload path |
| **Image Serving** | `/api/images/` route serves all stage artifacts |
| **Export** | CSV/Shopify exports pull from `final` stage |

### 10.2 New Dependencies

| Package | Purpose |
|---------|---------|
| `@google/genai` | Gemini API client (image editing) |
| `sharp` | Already installed — used for all server-side ops |
| None for rembg | Call as child process (`python3 -m rembg ...`) |

### 10.3 Environment Variables

```env
# Existing
GOOGLE_GEMINI_API_KEY=...     # Already used for image generation

# New
GEMINI_IMAGE_MODEL=gemini-2.5-flash-image   # Model for bg removal/shadow
REMBG_PYTHON_PATH=/usr/bin/python3          # Path to Python with rembg installed
IMAGE_PROCESSING_CONCURRENCY=3              # Max concurrent Gemini API calls
```

---

## 11. Security & Auth

- All image processing routes require authentication (session or API key)
- MCP tools authenticate via API key (existing pattern)
- Raw upload requires `owner` or `warehouse` role
- Shopify push requires `owner` role
- Processing/editing available to all authenticated users
- File paths are validated against path traversal (existing `getFullPath()`)

---

## 12. Migration Strategy

### Phase 1: Core Pipeline Library
Build the processing library (`image-editor/`) with all methods. Unit test each module independently.

### Phase 2: Database & API
Run schema migrations, implement API routes, wire up to processing library.

### Phase 3: MCP Tools
Register all MCP tools, test via Claude Code / Claude Desktop.

### Phase 4: UI
Build the enhanced image management UI with pipeline view, variation picker, batch dashboard.

### Phase 5: Integration
Wire up Shopify push, collection generation, preset system. Migrate existing images.

---

## 13. Performance Considerations

- **Gemini API rate limits**: 10 RPM on free tier, higher on paid. Queue with backoff.
- **Sharp memory**: Processing 2048×2048 images uses ~16MB per image. Limit concurrency to 3-5.
- **Disk space**: Each image × 5 stages × ~500KB = ~2.5MB per image. 500 images = ~1.25GB.
- **Railway volume**: Current persistent volume should be sufficient. Monitor usage.
- **Batch processing**: Use job queue for >10 images. Show progress in UI.
