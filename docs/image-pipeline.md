# Catalog Image Pipeline

Reference for how catalog images are stored, served, and synced between local
work and production. Written 2026-04-17 after a full DB/volume cleanup.

## TL;DR

- Files live on the Railway persistent volume at **`/data/images`** (env
  `IMAGES_PATH=/data/images` must be set).
- Paths are content-addressed by the first 16 hex chars of sha256:
  `{sku_id}/{source}/{checksum}.{ext}` for SKU images, `collections/{product_id}/{checksum}.{ext}` for composites.
- Pipeline stages run locally, outputs land in `~/Desktop/jaxy-product-images/0X_*/` with SKU-named files; the server stores them with content-addressed names.
- The DB (`catalog_images` table) is the source of truth for *which* files should exist. The volume is only what *does* exist.
- If those ever diverge, run the audit + cleanup + sync flow below.

## The stages

| Stage | Folder (Desktop) | DB `source` | Extension | Purpose |
|---|---|---|---|---|
| 1 | `01_originals` | `raw` | `.jpg`/`.png` | Photos as shot |
| 2 | `02_no_background` | `no_bg` | `.png` | Alpha-masked (Gemini or manual) |
| 3 | `03_white_bg` | `white_bg` | `.jpg` | Flattened onto white |
| 4 | `04_cropped` | `cropped` | `.jpg`/`.png` | Tight crop around product |
| 5 | `05_square_f8f9fa` | `square` | `.jpg` | Centered on 2000×2000 #F8F9FA — what marketplaces see |
| 6 | `06_collection` | `collection` | `.jpg` | Composite of all color variants per product |

Each stage computes sha256 on its output bytes and writes to a content-addressed path. Re-processing produces a new file + new DB row; the old row is **not** automatically retired (see "Pitfalls").

## Environment

Railway env vars the pipeline depends on:

| Var | Value | Why |
|---|---|---|
| `IMAGES_PATH` | `/data/images` | Without this, files write to `/app/data/images` (ephemeral container FS) and are wiped on every deploy. |
| `DATABASE_PATH` | `/data/the-frame.db` | SQLite on the persistent volume. |

The image-serving route at `/api/images/[...path]` sets `Cache-Control: public, max-age=31536000, immutable`. Cloudflare caches 200 responses for a year, which is normally fine because paths are content-addressed — but it means **after a volume fix you MUST purge the CDN**, otherwise 200 hits for files that no longer exist can mask problems.

## Admin endpoints

All require header `x-admin-key: jaxy2026`.

| Route | What it does |
|---|---|
| `GET /api/admin/audit-images` | Reads every approved `catalog_images` row, stats the file on disk, classifies each missing row as `stale_duplicate` / `stale_no_replacement` / `truly_missing`. Read-only. |
| `POST /api/admin/cleanup-images` | For each `(sku_id, source, image_type_id, position)` group with >1 approved row, demotes all but the newest to `status='superseded'`. Body: `{ dryRun?: boolean, sources?: string[] }`. Reversible via a single SQL `UPDATE ... WHERE status='superseded' AND id IN (...)`. |
| `POST /api/admin/upload-image` | Writes a base64 payload to `{IMAGES_PATH}/<filePath>` with optional checksum verify. Body: `{ filePath, data, expectedChecksum?, overwrite? }`. |
| `POST /api/admin/rekey-image` | For a specific `catalog_images` row, writes new bytes at a new checksum-based path and updates the DB row (file_path + checksum + file_size). Body: `{ rowId, data, overwrite? }`. Used when a row points at a file that no longer exists and we have replacement bytes. |

Non-admin image endpoints worth knowing:

- `POST /api/v1/catalog/images/regen-collections` — rebuilds every collection composite from the on-disk cropped sources. Deletes the old DB row + inserts fresh. This is the only historical regen endpoint that handles stale rows correctly.
- `POST /api/v1/catalog/images/upload-raw` — single-image ingestion used by the admin UI.

## Local scripts

| Script | Purpose |
|---|---|
| `scripts/sync-images-to-prod.py` | Read audit output → upload Desktop files whose sha256 matches the DB checksum. Never mutates Desktop. Writes `sync-report.json`. |
| `scripts/rekey-mismatched-images.py` | For each `checksum_mismatch` in `sync-report.json`, picks the best Desktop candidate (prefers `*-FRONT*`) and calls `/api/admin/rekey-image`. Writes `rekey-report.json`. |
| `scripts/upload-db-to-prod.py` | Chunked DB upload via `/api/admin/restore-db`. Unrelated to images but uses the same admin key. |

## The standard "fix production images" runbook

Run these in order when Faire or Shopify reports image 404s (or you suspect the volume and DB have drifted):

```bash
# 0. Sanity: is IMAGES_PATH actually set?
curl -s -H "x-admin-key: jaxy2026" https://theframe.getjaxy.com/api/admin/audit-images | jq '.imagesRoot'
# expect "/data/images" — if it shows "/app/data/images", fix Railway env first!

# 1. Audit
curl -s -H "x-admin-key: jaxy2026" https://theframe.getjaxy.com/api/admin/audit-images | jq '.by_source'

# 2. Demote stale duplicates (dry run first)
curl -s -X POST https://theframe.getjaxy.com/api/admin/cleanup-images \
  -H "x-admin-key: jaxy2026" -H "Content-Type: application/json" \
  -d '{"dryRun": true}' | jq
# then for real:
curl -s -X POST https://theframe.getjaxy.com/api/admin/cleanup-images \
  -H "x-admin-key: jaxy2026" -H "Content-Type: application/json" \
  -d '{"dryRun": false}' | jq

# 3. Upload any truly-missing files from Desktop
python3 scripts/sync-images-to-prod.py

# 4. Regenerate collections from the cropped sources (also clears collection dupes)
curl -s -X POST https://theframe.getjaxy.com/api/v1/catalog/images/regen-collections | jq '.regenerated'

# 5. For each checksum_mismatch in sync-report.json, rekey the DB row to point
#    at the Desktop file's actual bytes (useful when a DB row's checksum was
#    derived from a lost server-side artifact):
python3 scripts/rekey-mismatched-images.py --source square --dry
python3 scripts/rekey-mismatched-images.py --source square

# 6. Re-audit — expect all sources missing: 0 except maybe `raw`
curl -s -H "x-admin-key: jaxy2026" https://theframe.getjaxy.com/api/admin/audit-images | jq '.by_source'

# 7. Purge Cloudflare cache on /api/images/*
#    (CF dashboard → Caching → Configuration → Purge by URL, or purge everything)

# 8. Re-export the Faire/Shopify CSV from the catalog/export page
#    and re-upload. Always Validate first.
```

## Known pitfalls

### 1. Stale approved rows leak into exports
Most image-regen endpoints INSERT a new row without demoting the old one. Until that's fixed everywhere, run `cleanup-images` before any marketplace export. `regen-collections` already handles this correctly; treat it as the reference pattern.

### 2. Cloudflare 200s lie
A URL can return `x-cache: HIT` 200 from the edge even when the origin has no such file. Always include a cache-buster (`?b=$RANDOM`) when verifying via curl, or purge the cache first.

### 3. Exporter must filter `status='approved'`
As of commit `f9371da`, `faire.ts:pickVariantImage` and `amazon.ts:skuImages` correctly filter. If you add a new exporter or helper that queries `ep.images`, make sure it includes `i.status === "approved"`.

### 4. `IMAGES_PATH` env is required
If this is ever unset, the app silently writes to the ephemeral container FS. Every deploy wipes it, and the CDN cache masks the breakage. Railway env changes trigger a redeploy automatically — check the audit endpoint's `imagesRoot` field after any env change.

### 5. Checksum = first 16 hex of sha256
All DB checksums and content-addressed filenames are the **first 16 hex characters** of `sha256(bytes)` — not the full 64. Don't confuse with full hashes.

### 6. Pipeline stages aren't idempotent in bytes
Running the same input through the same pipeline on different machines (or different versions of sharp/PIL) can produce slightly different output bytes. That's why the rekey endpoint exists: when the DB checksum matches a server-side artifact that got lost, a local regeneration will usually produce a *different* checksum. Rekey updates the DB to match the current on-disk bytes rather than forcing the old checksum.

## Validation UX

The `/catalog/export` page's **Validate Products** button hits
`GET /api/v1/catalog/export/<platform>?validate=true`. Since commit `9045bce`
it cross-checks `imageStat(file_path).exists` for every approved image the
platform will emit in its CSV:

- **Faire**: `source IN ('square', 'collection')` — `raw` missing is fine.
- **Shopify, Amazon**: all sources.

Any missing files surface as "blocked" issues per product. Re-run after every
cleanup.
