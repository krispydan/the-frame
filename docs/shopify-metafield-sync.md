# Shopify Taxonomy Metafield Sync

**Status:** Deployed to main (commit `726494d`)
**Spec source:** User-provided markdown, April 2026
**Owner:** Daniel (product) / The Frame (implementation)

Automatically populates Shopify's 9 standard taxonomy metafields on every Jaxy
sunglasses product using Gemini to categorize the product from its name,
colorway, description, and (eventually) image. Writes to both the wholesale
and DTC stores in a single run.

---

## Table of contents

1. [What it does](#what-it-does)
2. [Architecture](#architecture)
3. [Data flow](#data-flow)
4. [File map](#file-map)
5. [Configuration & environment](#configuration--environment)
6. [API endpoints](#api-endpoints)
7. [Usage recipes](#usage-recipes)
8. [Data model](#data-model)
9. [The 9 metafields](#the-9-metafields)
10. [AI categorizer](#ai-categorizer)
11. [Color name mapping](#color-name-mapping)
12. [Handle resolution & caching](#handle-resolution--caching)
13. [Idempotency guarantees](#idempotency-guarantees)
14. [Error modes & troubleshooting](#error-modes--troubleshooting)
15. [Testing recipes](#testing-recipes)
16. [Extending it](#extending-it)
17. [Known limitations & TODOs](#known-limitations--todos)

---

## What it does

Every Jaxy product is a sunglass (Shopify taxonomy category
`gid://shopify/TaxonomyCategory/aa-2-27`). Once that category is assigned,
Shopify exposes nine metafields in the admin UI under "Category metafields":

- **SEO title** (`global.title_tag`) — plain string, AI-generated
- **SEO description** (`global.description_tag`) — plain string, AI-generated
- **Color** (`shopify.color-pattern`) — list of color-pattern metaobject refs
- **Eyewear frame color** (`shopify.eyewear-frame-color`) — list of color-pattern refs
- **Lens color** (`shopify.lens-color`) — list of color-pattern refs
- **Age group** (`shopify.age-group`) — single age-group metaobject ref
- **Lens polarization** (`shopify.lens-polarization`) — single polarization ref
- **Target gender** (`shopify.target-gender`) — single gender ref
- **Eyewear frame design** (`shopify.eyewear-frame-design`) — single design ref

This sync does the work of filling them in at scale across both stores.

**The three color fields** all resolve against the same `shopify--color-pattern`
taxonomy metaobject type. They're semantically different (overall product
color vs. frame vs. lens) but share the same vocabulary (black, brown, etc.).

---

## Architecture

```
                    ┌────────────────────────────────────────────┐
                    │                The Frame                   │
                    │                                             │
   Jaxy product ──▶ │  1. AI Categorizer (Gemini 2.5 Flash)       │
   (title, color,   │     → { seo, category_metafields }          │
    frame shape,    │     cached in catalog_products.             │
    gender,         │     ai_categorization                       │
    description,    │                                             │
    image?)         │  2. Sync Orchestrator (per store)           │
                    │     a. setProductCategory (aa-2-27)         │
                    │     b. resolveMetaobjectHandle × N          │
                    │        (cached handle → GID per store)      │
                    │     c. metafieldsSet batch mutation         │
                    │                                             │
                    └────────────────────────────────────────────┘
                                          │
                                          ▼
                    ┌───────────────────────────┐  ┌─────────────────────┐
                    │  jaxy-wholesale.myshopify  │  │  getjaxy.myshopify  │
                    │  (wholesale store)         │  │  (DTC store)        │
                    │  — GIDs resolved here      │  │  — GIDs resolved    │
                    │  — metafields written here │  │    & written here   │
                    └───────────────────────────┘  └─────────────────────┘
```

**Key design point:** the AI output is **store-agnostic** — it emits
*handles* like `"black"` or `"round"` that are universal. Only the handle →
GID resolution varies per store (each store has its own copy of the taxonomy
metaobjects with different GIDs). We run AI once per product and resolve
handles per store from that single output.

---

## Data flow

### Single product, single store (happy path)

1. **Client calls** `POST /api/v1/catalog/shopify-metafields-sync` with
   `{ productIds: ["uuid"], stores: ["wholesale"] }`.
2. **Frame loads** the product via `loadExportProducts()` and checks
   `catalog_products.ai_categorization` for a cached AI result.
3. **If cached** → parse JSON, use it.
   **If not cached** → call Gemini with the product name, colorway,
   description, frame shape, gender, and (future) primary image. Gemini
   returns a schema-constrained JSON blob. Store it back to the DB.
4. **For each store**, Frame:
   a. Calls `findShopifyProductBySku(store, skuPrefix)` to get the
      numeric Shopify product ID. Skip if not found.
   b. Calls `setProductCategory(store, productGid, aa-2-27)` via
      `productUpdate` GraphQL mutation.
   c. For each category metafield, resolves the AI's handle → per-store
      GID via `metaobjectByHandle`, hitting an in-process cache first.
   d. Builds a single `MetafieldsSetInput[]` array with all 9 metafields
      (2 SEO as plain strings, 7 category as JSON-encoded lists of GIDs).
   e. Submits via `metafieldsSet` mutation — one round-trip for all 9.
5. **Aggregates** per-product × per-store results into a report and
   logs to `activityFeed` (`eventType: "product.metafields_synced"`).

### Batch sync (typical production call)

```
productIds = [48 products]
stores = ["wholesale", "dtc"]
```

Work performed:
- Up to **48 Gemini calls** (fewer if some products have cached results)
- **96 `findShopifyProductBySku` calls** (48 × 2 stores) — each fetches up to 250 products per store
- **96 `productUpdate` calls** to set category (idempotent, most are no-ops)
- **Handle resolution:** ~7 unique handles per product × 2 stores, cached
  after first resolve. For 48 products that's maybe ~30–50 unique handles
  per store, resolved once.
- **96 `metafieldsSet` calls** — one per product × store.

Total wall time for full catalog sync: ~3–5 minutes depending on Gemini
latency and Shopify rate limits. Total Gemini cost: ~$0.05.

---

## File map

### New files

```
src/modules/catalog/lib/shopify-metafields/
├── handles.ts          # Enums, field defs, validator
├── color-mapping.ts    # Jaxy color name/code → color-pattern handle
├── ai-categorize.ts    # Gemini call with constrained JSON schema
└── sync.ts             # Orchestrator (category + handles + metafieldsSet)

src/app/api/v1/catalog/shopify-metafields-sync/
└── route.ts            # POST endpoint for the standalone sync
```

### Modified files

| File | Change |
|---|---|
| `src/modules/orders/lib/shopify-api.ts` | Added `setProductCategory`, `resolveMetaobjectHandle`, `metafieldsSet` GraphQL helpers |
| `src/modules/catalog/schema/index.ts` | Added `aiCategorization`, `aiCategorizedAt`, `aiCategorizationModel` columns to `catalog_products` |
| `src/lib/db.ts` | Idempotent `ALTER TABLE catalog_products ADD COLUMN …` for the three new fields |
| `src/app/api/v1/catalog/shopify-push/route.ts` | Added opt-in `syncMetafields: true` flag that runs the full AI + sync pipeline after each create/update |

### Key exports

- `categorizeProduct(input: CategorizerInput): Promise<CategorizerResult>` — run Gemini, return validated AI output
- `syncProductMetafields(params: SyncProductMetafieldsParams): Promise<SyncProductMetafieldsResult>` — orchestrator; supports `dryRun`
- `validateAiCategorization(raw: unknown)` — narrows raw JSON to `AiCategorizationOutput`, fills safe defaults for invalid fields
- `inferColorHandles(colorName: string | null): ColorPatternHandle[]` — deterministic Jaxy → Shopify color mapping
- `CATEGORY_METAFIELDS` — the registry of the 7 category metafields with their namespace/key/type/metaobjectType
- `SUNGLASSES_CATEGORY_GID` — `gid://shopify/TaxonomyCategory/aa-2-27`

---

## Configuration & environment

### Required env vars

| Variable | Set on | Purpose |
|---|---|---|
| `GOOGLE_GEMINI_API_KEY` | Railway (The Frame service) | AI categorization — Gemini 2.5 Flash text + vision |
| `SHOPIFY_WHOLESALE_STORE_DOMAIN` | Railway | e.g. `jaxy-wholesale.myshopify.com` |
| `SHOPIFY_WHOLESALE_ACCESS_TOKEN` | Railway | Admin API token with `write_products` + `write_metaobjects` |
| `SHOPIFY_DTC_STORE_DOMAIN` | Railway | e.g. `getjaxy.myshopify.com` |
| `SHOPIFY_DTC_ACCESS_TOKEN` | Railway | Admin API token with `write_products` + `write_metaobjects` |

### Shopify API scopes required

The access token for each store must have:
- `write_products` (for `productUpdate` to set category)
- `read_metaobjects` (for `metaobjectByHandle`)
- `write_metafields` (for `metafieldsSet`)

If you see `Access denied for field metafieldsSet` in the error response,
the token is missing `write_metafields`. Regenerate it in the Shopify admin
→ Apps → Develop apps → Your private app → Configuration → Admin API scopes.

### Shopify API version

Currently `2024-01` (set in `src/modules/orders/lib/shopify-api.ts:31`).
All GraphQL mutations used here are stable across 2024-01, 2024-04, 2024-07,
2024-10, and 2025-01. Bump the version constant in one place if needed.

---

## API endpoints

### `POST /api/v1/catalog/shopify-metafields-sync`

The standalone sync endpoint. Use this when you want to run categorization
independently of product create/update.

#### Request body

```typescript
{
  productIds: string[];      // Jaxy catalog product UUIDs
  stores: ("dtc" | "wholesale")[];
  dryRun?: boolean;          // Default false. If true, skip all writes.
  force?: boolean;           // Default false. If true, re-run AI even if cached.
}
```

#### Response

```typescript
{
  totalWrites: number;       // Sum of metafields written across all products×stores
  totalErrors: number;       // Number of (product, store) pairs that failed
  aiFreshRuns: number;       // Number of products that needed a fresh AI call
  dryRun: boolean;
  report: Array<{
    productId: string;
    productName: string;
    skuPrefix: string;
    aiUsed: "cached" | "fresh" | "failed";
    aiProblems: string[];    // Non-fatal AI issues (e.g. dropped bad handles)
    stores: Array<{
      store: "dtc" | "wholesale";
      shopifyProductId?: string;
      ok: boolean;
      categorySet: boolean;
      categoryError?: string;
      metafieldsWritten: number;
      metafieldsAttempted: number;
      metafieldErrors: string[];
      problems: string[];    // Non-fatal per-store issues (e.g. unresolved handles)
      dryRunInputs?: MetafieldsSetInput[];  // Only populated when dryRun=true
    }>;
  }>;
}
```

#### Example

```bash
# Dry run against one product on wholesale only
curl -X POST https://theframe.getjaxy.com/api/v1/catalog/shopify-metafields-sync \
  -H "Content-Type: application/json" \
  -d '{
    "productIds": ["abc-123-def"],
    "stores": ["wholesale"],
    "dryRun": true
  }'
```

### `POST /api/v1/catalog/shopify-push` (existing endpoint, extended)

The existing product push endpoint now accepts an opt-in `syncMetafields` flag:

```typescript
{
  productIds: string[];
  stores: ("dtc" | "wholesale")[];
  syncMetafields?: boolean;  // NEW — runs AI + sync after each create/update
  force?: boolean;           // NEW — re-run AI even if cached
}
```

When `syncMetafields: true`, the push route pre-fetches/generates AI
categorization once per product (cached in the DB), then runs the full sync
after each successful create/update. Only pays for AI once regardless of how
many stores.

---

## Usage recipes

### Dry-run a single product

```bash
curl -X POST https://theframe.getjaxy.com/api/v1/catalog/shopify-metafields-sync \
  -H "Content-Type: application/json" \
  -d '{ "productIds": ["<uuid>"], "stores": ["wholesale"], "dryRun": true }'
```

Check the `dryRunInputs` array in each store result — it shows the exact
`MetafieldsSetInput[]` that would be submitted to Shopify.

### Sync one product for real (both stores)

```bash
curl -X POST https://theframe.getjaxy.com/api/v1/catalog/shopify-metafields-sync \
  -H "Content-Type: application/json" \
  -d '{ "productIds": ["<uuid>"], "stores": ["wholesale", "dtc"] }'
```

### Backfill the entire catalog

Pass all product IDs. AI cost: ~$0.001 per product.

### Push product + sync metafields in one call

```bash
curl -X POST https://theframe.getjaxy.com/api/v1/catalog/shopify-push \
  -H "Content-Type: application/json" \
  -d '{ "productIds": ["<uuid>"], "stores": ["wholesale", "dtc"], "syncMetafields": true }'
```

### Force re-categorization (ignore cached AI)

Add `"force": true` to either endpoint's body. Useful if you've changed
product data (name, description, frameShape) and want the AI to re-evaluate.

### Via MCP (from local Claude Code)

Once the MCP server is configured locally, you can also use `system.query` to
inspect categorization results:

```sql
SELECT id, name, sku_prefix, ai_categorized_at, ai_categorization_model
FROM catalog_products WHERE ai_categorization IS NOT NULL
ORDER BY ai_categorized_at DESC
```

---

## Data model

### New columns on `catalog_products`

| Column | Type | Purpose |
|---|---|---|
| `ai_categorization` | TEXT (nullable) | JSON blob matching `AiCategorizationOutput` shape |
| `ai_categorized_at` | TEXT (nullable) | ISO 8601 timestamp of last AI run |
| `ai_categorization_model` | TEXT (nullable) | Model name (e.g. `gemini-2.5-flash`) |

Added via idempotent `ALTER TABLE` in `src/lib/db.ts`. No migration file needed.

### Activity feed event

Every successful sync logs to `activity_feed` with:
```json
{
  "eventType": "product.metafields_synced",
  "module": "catalog",
  "entityType": "product",
  "data": { "stores": [...], "productCount": N, "totalWrites": N, "totalErrors": N, "aiFreshRuns": N }
}
```

---

## The 9 metafields

| # | Display name | Namespace.key | Type | Values come from |
|---|---|---|---|---|
| 1 | SEO title | `global.title_tag` | `single_line_text_field` | AI-generated |
| 2 | SEO description | `global.description_tag` | `multi_line_text_field` | AI-generated |
| 3 | Color | `shopify.color-pattern` | `list.metaobject_reference` | AI + color-mapping |
| 4 | Eyewear frame color | `shopify.eyewear-frame-color` | `list.metaobject_reference` | AI + color-mapping |
| 5 | Lens color | `shopify.lens-color` | `list.metaobject_reference` | AI (default: black) |
| 6 | Age group | `shopify.age-group` | `list.metaobject_reference` | Hardcoded: `adults` |
| 7 | Lens polarization | `shopify.lens-polarization` | `list.metaobject_reference` | AI (default: `non-polarized`) |
| 8 | Target gender | `shopify.target-gender` | `list.metaobject_reference` | AI (default: `unisex`) |
| 9 | Frame design | `shopify.eyewear-frame-design` | `list.metaobject_reference` | AI from product data |

Fields 3–9 are `list.metaobject_reference`, meaning `value` is a **JSON-encoded
string** of GID arrays (e.g. `"[\"gid://shopify/Metaobject/12345\"]"`).

---

## AI categorizer

### Model

Gemini 2.5 Flash via `generativelanguage.googleapis.com`. Text-only for now
(image input is wired but URL is null until the image pipeline is live).

### Prompt strategy

1. **System context:** "You are a Shopify taxonomy categorizer for Jaxy Eyewear"
2. **Product data:** name, colorway, description, frame shape, gender
3. **Color hint:** deterministic `inferColorHandles()` output is passed as a
   "strong prior" — the AI confirms or refines based on product context
4. **Constrained output:** `responseMimeType: "application/json"` with a
   `responseSchema` that specifies exact enums for every field. Gemini cannot
   invent handles outside the enum.
5. **Temperature:** 0.2 (deterministic-ish for categorization)

### Validation layer

Even with constrained output, `validateAiCategorization()` in `handles.ts`
re-checks every field:
- Color handles: filtered to known `COLOR_PATTERN_HANDLES` list
- Scalar fields: fall back to safe defaults if invalid
  (`adults`, `non-polarized`, `unisex`, `square`)
- Problems are logged, not thrown — partial output is still usable

### Cost

~$0.001 per product (text-only). ~$0.003 with image input.
Full 48-product catalog: ~$0.05 text, ~$0.15 with images.

---

## Color name mapping

`color-mapping.ts` provides a deterministic first pass before the AI runs:

| Input pattern | Output handle(s) |
|---|---|
| `"Black"`, `"Matte Black"`, `BLK` | `["black"]` |
| `"Rose Gold"` | `["rose-gold"]` |
| `"Gold/Pink"`, `GLP` | `["gold", "pink"]` |
| `"Tortoise"`, `TOR` | `["brown"]` |
| `"Silver/Blue Mirror"`, `SLB` | `["silver", "blue"]` |
| `"Champagne"`, `CHA` | `["gold"]` |
| `"CHAMPAGNE"` | `["gold"]` (case-insensitive) |

Three-pass resolution:
1. Exact 3-letter code match (e.g. `BRW` → `brown`)
2. Split on `/`, `-`, space and try codes per token
3. Keyword substring match on lowercased full name

The output is passed to Gemini as a "strong prior" in the prompt. The AI can
override it if the product context clearly contradicts (e.g. a "Champagne"
frame with blue lenses — AI would emit blue for lens_color).

---

## Handle resolution & caching

Each store has its own metaobject GIDs. `resolveMetaobjectHandle()` queries
Shopify's `metaobjectByHandle` GraphQL endpoint to look up a handle (like
`"black"` in type `"shopify--color-pattern"`) and returns the per-store GID.

Results are cached **in-process** (a `Map<string, string | null>`) keyed by
`store::type::handle`. The cache lives for the lifetime of the Railway process
(i.e. until the next deploy). Since taxonomy metaobjects are stable (Shopify
rarely changes them), this is safe.

If a handle fails to resolve (e.g. `tortoise` doesn't exist as a metaobject
on a particular store), the sync **logs a warning and skips that specific
value** rather than failing the entire product. The other metafields still get
written.

`clearHandleCache()` is exported for admin/testing purposes.

---

## Idempotency guarantees

- `metafieldsSet` is Shopify's native upsert — submitting the same input twice is a no-op
- `productUpdate { category }` is stable — setting it when already set is a no-op
- AI categorization is cached in `catalog_products.ai_categorization` — re-runs skip Gemini unless `force: true`
- Handle → GID resolution is cached in-process per store

**Safe to re-run the entire sync at any cadence** (daily cron, on every product
edit, manually) without side effects.

---

## Error modes & troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `"GOOGLE_GEMINI_API_KEY not set"` in aiProblems | Missing env var on Railway | Add the key to Railway service variables |
| `"Product not found on wholesale"` in problems | Product hasn't been pushed to that store yet | Run `shopify-push` first, then `metafields-sync` |
| `"handle 'tortoise' did not resolve on wholesale"` | That metaobject doesn't exist on the store | Add it in Shopify admin → Settings → Custom data, or skip it |
| `"Access denied for field metafieldsSet"` | Shopify API token missing `write_metafields` scope | Regenerate the token with the right scopes |
| `aiUsed: "failed"` | Gemini returned an error or unparseable JSON | Check `aiProblems` array; retry with `force: true` |
| All metafields show `metafieldsWritten: 0` | Category not set (metafields only work after category assignment) | Check `categoryError` in the response |

---

## Testing recipes

### Verify the AI categorizer alone (without writing)

```bash
curl -X POST https://theframe.getjaxy.com/api/v1/catalog/shopify-metafields-sync \
  -H "Content-Type: application/json" \
  -d '{ "productIds": ["<uuid>"], "stores": ["wholesale"], "dryRun": true }'
```

Check `report[0].aiUsed` and `report[0].aiProblems`.

### Inspect cached categorization in the DB

```sql
SELECT name, sku_prefix, ai_categorized_at, ai_categorization
FROM catalog_products
WHERE ai_categorization IS NOT NULL
ORDER BY ai_categorized_at DESC;
```

### Clear cached categorization and re-run

Pass `"force": true` in the request body. This re-calls Gemini and overwrites
the cached blob.

### Check what a product looks like on Shopify after sync

Use the existing metafield introspection endpoint:
```bash
curl "https://theframe.getjaxy.com/api/v1/catalog/shopify-metafields?store=wholesale&productId=<shopify-product-id>"
```

---

## Extending it

### Adding a new metafield

1. Add the field definition to `CATEGORY_METAFIELDS` in `handles.ts`
2. If it's a new metaobject type, add the type string to `METAOBJECT_TYPES`
3. Add the valid handles to a new `const X_HANDLES = [...]` array
4. Add the field to the `AiCategorizationOutput` type
5. Update the Gemini response schema in `ai-categorize.ts:buildResponseSchema()`
6. Update the prompt in `ai-categorize.ts:buildPrompt()`
7. Add the handle resolution + `addListMetafield()` call in `sync.ts`
8. Update the validator in `handles.ts:validateAiCategorization()`
9. Deploy + re-run with `force: true` to re-categorize all products

### Adding a new store

1. Add the store config to `shopify-api.ts:getShopifyConfig()`
2. Add the store name to the `ShopifyStore` union type
3. Pass it in the `stores` array when calling the sync endpoint
4. Handle GIDs will be resolved fresh for the new store (cache is per-store)

---

## Known limitations & TODOs

1. **Image input to AI.** The categorizer supports image input (Gemini multimodal)
   but `imageUrl` is hardcoded to `null` because the image pipeline isn't live.
   Frame-shape detection will improve once images are available. See
   `ai-categorize.ts` TODO comment.

2. **Color handle `tortoise`** may not exist as a metaobject on all stores.
   The sync logs and skips it. If you need it, create the metaobject in
   Shopify admin → Settings → Custom data → Color pattern → Add entry.

3. **Lens color for gradients/tinted.** Currently the AI picks the dominant
   lens color. Shopify accepts a list but admin UI may only render the first.

4. **Bridge/temple sizing in SEO.** The AI-generated SEO descriptions don't
   include frame measurements because the schema doesn't have them yet.

5. **Rate limits.** The sync makes ~2 GraphQL calls per metafield resolved +
   1 per product. For 48 products × 2 stores ≈ ~200 calls. Shopify's default
   rate limit is 1000 points/min for GraphQL. Each `metafieldsSet` is ~10
   points. We're well within limits for the current catalog size.

---

*Last updated: April 2026. Created alongside commit `726494d`.*