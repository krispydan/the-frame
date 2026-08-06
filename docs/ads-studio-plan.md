# Ad Studio — plan

Generate Meta ad creatives from assets we already have: clips from the video
library, catalog product imagery, and the product card layout as the first
recipe. Every ad renders in each Meta aspect ratio under a naming convention
that encodes what the ad *is*, so performance in Ads Manager can be sliced by
recipe, product, model, copy and format without any extra tooling on day one.

Status: **scoping — not yet built.** This doc is the agreed shape; phases at
the bottom are the build order.

## What we're building

An **Ad Studio** section under Marketing:

1. **Ad recipes** — code-registered layout templates (same pattern as video
   recipes). Recipe #1, `PCARD` (product card): background media (clip video
   or image) filling the frame, with a white rounded card overlaid near the
   bottom containing the product's front-on catalog image and its name in
   the brand font. More recipes slot in later without schema changes.
2. **Multi-ratio rendering** — one click renders the ad at every enabled
   Meta ratio. The layout adapts per ratio (card scale/position are
   per-ratio parameters, not one absolute layout stretched).
3. **A naming convention** that is the tracking system (below).
4. **Minor edits** — structured controls (card position/scale, swap product
   image, edit/hide the name text, shift the background crop, optional
   headline), each stored as overrides and re-rendered. Not a freeform
   canvas editor.

## Concepts & schema

Recipes live in code (a registry, like `video-recipes`); ads and their
renders live in the DB. One **ad** = recipe + inputs + overrides. One
**render** = ad × aspect ratio = one file in R2.

```
marketing_ads
  id, name              -- generated from the convention, unique, versioned
  recipe                -- 'pcard' (registry slug)
  kind                  -- 'image' | 'video' | 'carousel' (carousel later; code reserved now)
  background_type/_ref  -- 'clip' → marketing_video_clips.id
                        -- 'catalog_image' → catalog_images.id
                        -- 'upload' → R2 key
  sku_id                -- product on the card (FK catalog_skus)
  card_image_id         -- which catalog image sits on the card (default: best front)
  talent                -- denormalized from the clip (or 'none')
  copy_variant          -- 'C00' = no copy, else FK to marketing_ad_copy
  display_name_override -- card text if not the product name
  headline              -- optional text on the media itself
  layout_overrides      -- JSON, per-ratio {cardY, cardScale, bgOffsetX/Y, ...}
  status                -- draft | rendering | ready | published | archived
  version               -- bumps when a published ad is edited

marketing_ad_renders
  ad_id, ratio ('1x1'|'4x5'|'9x16'|'16x9'), r2_key, width, height,
  duration_sec, status, error

marketing_ad_copy      -- copy variants referenced by ads (primary text,
  id ('C01'…), primary_text, headline, description, notes
```

## Naming convention (the tracking key)

Auto-generated, never hand-typed, stamped on the ad and every render file,
and used verbatim as the **ad name in Meta Ads Manager** — that's what makes
performance sliceable later, with or without an API integration.

```
JX_{RECIPE}_{FMT}_{PRODUCT}-{COLOR}_{MODEL}_{COPY}_{vNN}          ← the ad
JX_{RECIPE}_{FMT}_{PRODUCT}-{COLOR}_{MODEL}_{COPY}_{vNN}_{RATIO}  ← each file
```

| Segment | Values | Source |
|---|---|---|
| `RECIPE` | `PCARD`, … | recipe registry |
| `FMT` | `IMG` / `VID` / `CAR` | ad kind |
| `PRODUCT-COLOR` | `SHIPO-TIGYEL` | product handle + colour code from the SKU |
| `MODEL` | `JADE`, `DARIA`, `SHIA`, `NONE` | clip talent (short-code map in registry) |
| `COPY` | `C00` = none, `C01`… | copy variant |
| `vNN` | `v01`… | bumps on edit-after-publish |
| `RATIO` | `1x1`, `4x5`, `9x16` | per render file only |

Example: `JX_PCARD_IMG_SHIPO-TIGYEL_JADE_C00_v01_4x5.jpg`

Link URLs get `utm_content={ad name}` so GA/Shopify attribution keys on the
same string. A pure `ad-naming.ts` lib owns generate + parse (round-trip
tested) — parseability is what makes future reporting free.

## Aspect ratios (Meta set)

| Ratio | Output | Placement | Default |
|---|---|---|---|
| 4:5 | 1080×1350 | FB/IG feed (primary) | on |
| 1:1 | 1080×1080 | feed universal / carousel | on |
| 9:16 | 1080×1920 | Stories / Reels | on |
| 16:9 | 1920×1080 | in-stream / Audience Network | **off** by default |

Cropping from the source uses upper-centre gravity (faces live in the top
half of our verticals) with a per-ad crop-offset override. This is the same
crop engine pending task P4 (Faire/social channel cuts) needs — build it
once, in a shared lib, and P4 becomes mostly free.

## Rendering

**Images** — `sharp` composite, no jobs queue needed (sub-second):
crop background to ratio → white rounded-rect card (SVG) → product front
image (bg-removed variant from the catalog image-editor pipeline when one
exists, else the best approved front shot) → product name text as SVG using
the bundled `HookText-Bold.ttf` (system fonts caused tofu before — same rule
as caption-burn).

**Videos** — build the card as a transparent PNG with the exact same sharp
code, then one ffmpeg pass on the clip: crop/scale to ratio + `overlay` the
card + existing normalize/loudness. Runs as an `ad_render` job per ratio on
the existing jobs queue, same as every other cut. The card is *identical*
pixels between image and video ads because it's one implementation.

Meta specs respected at render: H.264/AAC, ≤4 GB, JPG/PNG ≥1080 shortest
side.

## UI

- **`/marketing/ads`** — library grid: thumbnail, name, status, which ratios
  are rendered; filter by product / model / recipe / kind. Hub card on the
  marketing home.
- **New-ad wizard** — recipe → background (clip picker reusing the library
  search, a catalog lifestyle image, or upload) → SKU (pre-filled from the
  clip's tagged products) → generated name preview → render.
- **Detail page** — all ratios side by side; edit panel (the structured
  controls above; image ads re-render live, video ads preview the edit on
  the poster frame instantly and re-render the video on save); copy editor
  with AI generation reusing the video copy prompts; **Download all** (zip
  named per convention) for upload to Ads Manager; mark-published.

## Success tracking

- **Phase now:** the naming convention + `published` status + versioning.
  Upload to Ads Manager stays manual; the name is the join key.
- **Phase later (optional):** Meta Marketing API sync — cron job (in the
  centralized registry, `*/5`-floor rules apply) pulls spend / CTR / ROAS
  per ad name into `marketing_ad_metrics`, and a report page ranks recipes,
  models, products and copy variants — same shape as the product-coverage
  report. Needs a Meta access token; not required to launch.

## Build phases

| Phase | Scope | Notes |
|---|---|---|
| **A0** | Schema + migration; recipe registry; `ad-naming.ts` | pure libs, fully unit-tested |
| **A1** | Image renderer (sharp card + ratio crops, shared crop lib) + APIs + library page + wizard + download | first usable end-to-end: image ads |
| **A2** | Video renderer (`ad_render` jobs, ffmpeg overlay) | reuses A1's card pixel-for-pixel |
| **A3** | Edit controls + re-render + AI copy + versioning | |
| **A4** | Carousel kind; Meta metrics sync + report | optional / later |

Non-goals for now: freeform drag-and-drop canvas, auto-publishing via the
Meta API, non-Meta channels (the ratio system doesn't preclude them).
