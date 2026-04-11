# Technical Review: Image Editor System Design

**Reviewer:** Staff Engineer
**Date:** 2026-04-11
**Verdict:** Strong design with several issues that need resolution before implementation.

---

## 1. Architecture Concerns

- **Race condition on UNIQUE constraint** in `catalog_image_pipelines` — if two concurrent requests process the same image, you get a race. Need explicit locking via `processing` status check-and-set or `BEGIN IMMEDIATE` transaction.
- **No per-stage progress tracking** — when Gemini takes 15+ seconds, user sees nothing. Add `current_stage` column to `catalog_images`.
- **Sequential batch processing is a bottleneck** — 200+ images at ~10s each = 30+ minutes. Should fan out: one parent job spawns N child jobs respecting `IMAGE_PROCESSING_CONCURRENCY`.
- **rembg via child process is fragile** — cold-starting Python + loading u2net model (~170MB) every time = 10-15s overhead per call. Either run as a persistent FastAPI sidecar or use `@xenova/transformers` for ONNX in Node.js.

## 2. Schema Design

- **Missing `updated_at`** on `catalog_image_pipelines`.
- **UNIQUE(image_id, stage) conflicts with history** — doc says "preserved for history/revert" but unique constraint means only one record per stage. Either drop unique + add `is_current` boolean, or use `catalog_image_variations` for history and keep pipeline as current-state-only.
- **`sku_ids` as JSON text is a query problem** — cannot efficiently query "which collections include SKU X?" Add a junction table instead.
- **`angle` column duplicates `image_type_id`** — should use the FK to seeded image types, remove the separate `angle` column.
- **New tables must be defined in Drizzle format**, not raw SQL DDL.

## 3. API Design

- **Inconsistent URL structure** — mix of nouns and verbs. Standardize verb placement.
- **Missing `GET /api/v1/catalog/images/[id]/pipeline`** endpoint — MCP tool references it but no route defined.
- **Missing job status endpoint** — batch endpoints return `{ jobId }` but no `GET /jobs/[jobId]` in the route table.
- **No error response contract** — codify `{ error: string, detail?: string }` with documented status codes per endpoint.
- **`stores` vs `channel` naming inconsistency** with existing export system.

## 4. MCP Tool Design

- **Tool count too high (25+)** — AI agents perform better with fewer, composable tools. Collapse to ~12: `process`, `reprocess`, `list`, `get`, `update`, `delete`, `generate_variations`, `select_variation`, `generate_collection`, `shopify_push`, `manage_preset`.
- **`catalog.images.detect_bg` is excellent** — keeps it. Lets agent reason about method before committing.
- **BLOCKING: Schema generation is lossy** — current `register()` method strips Zod schemas to just `{ description }` per property, losing types, enums, defaults, min/max. AI agents cannot use tools correctly without proper JSON Schema. Use `zod-to-json-schema`.
- **Tool descriptions need concrete examples** for better AI agent performance.

## 5. Security Gaps

- **`system.query` MCP tool is SQL injection vector** — restrict to SELECT-only or don't register in production.
- **No file size limits on raw upload** — 200MB RAW file would consume all memory. Add 50MB limit.
- **Gemini API key leakage to child processes** — use explicit `{ env: { PATH } }` when spawning Python.
- **Existing generate route writes to `process.cwd()` directly** — should use `local.ts` storage abstraction exclusively.

## 6. Missing Pieces

- **No cleanup/garbage collection** for orphaned stage artifacts after reprocessing.
- **No rollback mechanism** — needs `catalog.images.revert_stage` endpoint/tool.
- **No webhook/event system** for pipeline completion — use existing `activityFeed` table + SSE for UI.
- **No image validation before pipeline entry** — use existing `inspectImage()` as gate.
- **No cost tracking for Gemini calls** — log to existing `reportingLogs` table.

## 7. Compatibility with Existing Codebase

- **Good fit overall** — follows Drizzle, SQLite, MCP registry, job queue, local storage patterns.
- **Conflict: existing `processImage()` force-crops to 2000×2000 q80** — raw uploads must skip this.
- **Canvas size mismatch: 2000 vs 2048** — pick one, document why.
- **Existing generate route path handling diverges from `local.ts`** — refactor as part of this project.

## 8. Sharp vs Pillow — Consolidate on Sharp

**Recommendation: Sharp only. Do not introduce Pillow/Python.**

- Codebase is 100% TypeScript/Node.js. Python adds a second runtime, pip deps, Docker bloat.
- Gemini handles complex bg removal better than rembg anyway.
- Sharp's `raw()` pixel access + `ensureAlpha()` can handle threshold-based removal natively.
- For rembg fallback: evaluate `@xenova/transformers` for ONNX in Node.js post-launch.

## 9. Gemini API Concerns

- **Rate limits are critical** — implement proper semaphore + token bucket pattern with backoff.
- **Cost estimation missing** — document expected cost per image (bg removal + shadow = 2 calls × 500 images = 1000 calls).
- **Unpredictable output dimensions** — Gemini may return different size than input. Pipeline must handle this.
- **No fallback chain** — define: Gemini → threshold (white bg) → manual queue.
- **Prompt injection risk** — validate custom prompts still contain core safety instructions.

## 10. Priority Fixes

### P0 — Must fix before implementation:
1. Fix MCP tool registry to emit proper JSON Schema (types, enums, constraints)
2. Define new tables in Drizzle format
3. Resolve history vs. UNIQUE constraint conflict
4. Add file size validation on raw upload (50MB max)
5. Standardize file path usage through `local.ts`

### P1 — Should fix before launch:
6. Add progress/current_stage fields for real-time UI feedback
7. Implement proper Gemini rate limiting with semaphore
8. Remove `angle` column, use `image_type_id` with seeded types
9. Add junction table for collection image SKU membership
10. Reduce MCP tool count to ~12

### P2 — Post-launch:
11. Disk cleanup job for orphaned artifacts
12. Gemini cost tracking via `reportingLogs`
13. Evaluate `@xenova/transformers` as Node-native rembg replacement
14. Add `catalog.images.revert_stage` for rollback
