# Jaxy Photography Aesthetic

> Snapshot of the visual/photography direction used to brief Higgsfield
> renders for email. Keep in sync with the master in Google Drive via
> `scripts/sync-brand-context.sh`. Referenced by the image-prompt
> generator (`generate-image-prompts`) so every brief is grounded in
> the same look.

## The one-line north star

Warm, lived-in California light on real-feeling moments — eyewear as the
hero, never the cliché. If it looks like a stock ad, it's wrong.

## Film & grade

- Emulate **Kodak Portra 400**: warm skin tones, soft contrast, gentle
  highlight roll-off, fine grain. Slightly lifted blacks (never crushed).
- White balance leans **warm** (golden, not blue). Avoid clinical/cool
  studio white.
- Natural light only in feel — golden hour or bright diffused California
  sun. No hard on-camera flash, no ring-light look.

## Palette in-frame

Lean on the brand neutrals so the product, not the set, carries the
frame: cream/ivory (#FFFDF0), espresso (#39341F), terracotta (#915127),
sage (#D4E3BB), lavender (#DCDCEF). Surfaces: warm linen, sand, weathered
wood, ceramic, brass. Avoid pure white seamless and saturated primaries.

## Composition

- **Shallow depth of field** on the frames; let backgrounds fall soft.
- Generous negative space — the email overlays text, so leave calm areas
  (see per-variant safe zones below).
- Rule-of-thirds, slightly off-center. Candid framing over centered
  catalog symmetry (except the `image_75_solid` product beat).

## Two recurring modes (alternate across the week)

1. **Product still-life / flat-lay (slot 1).** Sunglasses as the subject
   on a warm neutral surface with thoughtful, sparse props (dried flora,
   brass key, ceramic dish). Golden sidelight. No model.
2. **On-model lifestyle (slot 2).** A real, diverse, approachable person
   wearing the frames mid-moment (laughing, walking, in conversation) —
   not posing at camera. Pacific coast / palm / warm urban architecture.
   Eyewear is the visual hero of the shot.

## What to avoid (anti-brief)

- Plastic high-fashion stares, influencer duck-face, over-retouched skin.
- Cold studio seamless, harsh shadows, HDR look, heavy vignettes.
- Busy props that compete with the frames. Logos of other brands.
- Anything that reads "discount" or "stock photo."

## Per-variant safe zones (for text overlay)

- `full_bleed_overlay` (1200×900): keep the **top 30% calm** — that's
  where the headline + subhead + CTA land. Recommend a dark scrim for
  busy/ bright tops, light scrim for dark tops.
- `image_75_solid` (900×900): subject centered with cream room around it;
  text sits in a solid block below, so the image needs no safe zone.
- `split_50_50` (600×900 portrait): subject lives on the **left half**;
  the right half can be soft/empty (text overlays it).
- Secondary `full_bleed` (1200×800), `centered_75` (900×800),
  `grid_2up` (580×580 ×2): no overlaid text — compose for the image alone;
  match lighting + composition between the two grid frames.
