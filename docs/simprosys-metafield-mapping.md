# Simprosys metafield mapping — one-time configuration

Once The Frame's Shopify metafield sync (Phase 4 of the SEO sync brief)
is flowing the new field set into Shopify, Simprosys needs to be
configured to map those metafields onto the corresponding Google
Shopping feed attributes. This is a **one-time human step in the
Simprosys dashboard** — there's no API for it.

Reference docs:
- [How to Map Shopify Metafields to Product Feed Attributes](https://support.simprosys.com/faq/metafields-mapping)
- [Optimizing the Product Title attribute](https://support.simprosys.com/faq/product-title-and-its-options)

## Prerequisites

Before configuring Simprosys, verify the metafields are actually
present on at least one product:

1. Open any Jaxy product in Shopify admin → DTC store
2. Scroll to Metafields → confirm the following appear with values:

| Namespace | Key | Type | Example value |
|---|---|---|---|
| `global` | `title_tag` | text | `Vintage Round Sunglasses — Havana Haze \| Jaxy` |
| `global` | `description_tag` | multi-line text | (150-char description ending in `…by Jaxy — a classic silhouette built for every day.`) |
| `global` | `custom_label_0` | text | `Round` |
| `global` | `custom_label_1` | text | `vintage` |
| `global` | `custom_label_2` | text | `Unisex` |
| `global` | `custom_label_3` | text | `30_50` |
| `global` | `custom_label_4` | text | `SS26` |
| `shopify.eyewear-frame-color` | (taxonomy) | reference | `Tortoise` |
| `shopify.lens-color` | (taxonomy) | reference | `Green` |
| `shopify.eyewear-frame-design` | (taxonomy) | reference | `Round` |
| `shopify.target-gender` | (taxonomy) | reference | `Unisex` |
| `shopify.age-group` | (taxonomy) | reference | `Adults` |
| `shopify.lens-polarization` | (taxonomy) | reference | `Polarized` |
| `custom.lens_width` | number_integer | int | `51` |
| `custom.bridge_width` | number_integer | int | `22` |
| `custom.lens_height` | number_integer | int | `45` |
| `custom.frame_width` | number_integer | int | `144` |
| `custom.frame_height` | number_integer | int | `48` |
| `custom.temple_length` | number_integer | int | `145` |
| `custom.style_era` | text | `vintage,oversized` |
| `custom.collection_batch` | text | `SS26` |

If any are missing → trigger the sync manually before continuing:
```bash
# Per-product:
POST /api/v1/catalog/products/{id}/sync-shopify-metafields-from-tags

# All products, both stores:
POST /api/v1/cron/tick   (runs the nightly cron immediately)
```

If `custom.frame_shape` is still present on the product, run the
deletion script:

```bash
npx tsx scripts/delete-deprecated-shopify-metafields.ts --apply
```

## Simprosys configuration steps

In Simprosys admin → **Settings** → **Metafield Mapping**, configure
each Google Shopping attribute to read from the corresponding Shopify
metafield. Repeat for both shops (DTC + Wholesale).

### Auto-mapped standard taxonomy

These map automatically because they're standard Shopify taxonomy
metafields — Simprosys recognises them without manual config:

| Google attribute | Reads from |
|---|---|
| `color` | `shopify.eyewear-frame-color` |
| `gender` | `shopify.target-gender` |
| `age_group` | `shopify.age-group` |
| `material` | `shopify.material` (if present) |

### Manual mapping needed — custom metafields

| Google attribute | Map from |
|---|---|
| `product_detail[Lens Width]` | `custom.lens_width` |
| `product_detail[Lens Height]` | `custom.lens_height` |
| `product_detail[Bridge Width]` | `custom.bridge_width` |
| `product_detail[Frame Width]` | `custom.frame_width` |
| `product_detail[Frame Height]` | `custom.frame_height` |
| `product_detail[Temple Length]` | `custom.temple_length` |
| `product_detail[Style Era]` | `custom.style_era` (optional, for richer descriptions) |

### Custom Labels (for campaign segmentation in Google Ads)

Custom Labels are PMax / Shopping-campaign segmentation only —
they're not visible to shoppers. Map straight through:

| Custom Label | Reads from |
|---|---|
| Custom Label 0 | `global.custom_label_0` (shape) |
| Custom Label 1 | `global.custom_label_1` (style era) |
| Custom Label 2 | `global.custom_label_2` (gender) |
| Custom Label 3 | `global.custom_label_3` (price tier) |
| Custom Label 4 | `global.custom_label_4` (collection batch) |

### Product Title configuration

In **Settings** → **Product Title and Description** in Simprosys:

- **Product Title source**: select **SEO Title** (not storefront
  title). The SEO Title is the deterministic
  `{StyleModifier} {Shape} Sunglasses[ for {Gender}] — {ProductName} | Jaxy`
  format written by the Frame's nightly sync into
  `global.title_tag`.
- **Append variant title**: enabled. Simprosys will append the
  variant title (`Tortoise Frame / Green Lens`) so the final Google
  Shopping feed title is e.g.
  `Classic Square Sunglasses — Diplomat | Jaxy - Tortoise Frame / Green Lens`.
- **Append brand**: disabled (the brand is already in the SEO title).

### Product Description

- **Product Description source**: **SEO Description** (not Body HTML).
  The SEO description is the 140-160 char snippet from
  `global.description_tag`. Body HTML is the long-form display page
  description, not the feed.

## Verification after configuration

1. In Simprosys → **Products** → pick any product → view its feed
   preview. Confirm:
   - Title matches the SEO Title formula
   - `color`, `gender`, `age_group`, `material` are populated
   - `product_detail` lists all six millimeter measurements
   - Custom Labels 0-4 are all populated
2. In Google Merchant Center → **Diagnostics**: no warnings for
   "Missing color", "Missing gender", "Missing age group" across the
   Jaxy product set.
3. Spot-check the Google Shopping ad preview rendering — frame shape
   in title should match the visually-verified shape (i.e. Havana
   Haze appears as Round, not Square).

## Re-running the sync

The nightly cron at `0 3 * * *` UTC syncs all products to both stores
automatically. To force an immediate sync:

```bash
# Both stores, all products
POST /api/v1/cron/tick

# Single product, both stores (debounced 2s — auto-triggered by tag
# edits in the catalog UI)
POST /api/v1/catalog/products/{id}/sync-shopify-metafields-from-tags
```

Override mechanism for marketing-edited SEO copy is **out of scope
in v1** — the formula always wins. If marketing edits a title or
description in Shopify admin directly, the next nightly sync reverts
it. Mitigation: edit via The Frame's catalog UI (which feeds back into
the source data the formula consumes), not Shopify admin.
