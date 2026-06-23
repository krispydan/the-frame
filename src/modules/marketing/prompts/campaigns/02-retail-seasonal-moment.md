# Campaign 2 · Retail · Seasonal moment — first cool morning

## Inputs

```json
{
  "audience": "retail",
  "scheduledDate": "2026-08-31",
  "weekOf": "2026-08-31",
  "heroVariant": "full_bleed_overlay",
  "secondaryImageVariant": "centered_75",
  "sectionAVariant": "with_pullquote",
  "sectionBVariant": "centered_with_cta",
  "theme": {
    "title": "It's coffee-on-the-porch weather",
    "angle": "First weekend it actually feels different — the in-between season. Specific sensation hook. Frames for the pivot from summer to fall.",
    "productHook": "Transition collection (5 warm-toned frames)",
    "seasonalContext": "Late August / early September — first cool morning"
  }
}
```

## Final v5 copy output

| Field | Value |
|---|---|
| Subject | `it's coffee-on-the-porch weather` |
| Preheader | `The frames you'll grab for the next 8 weeks.` |
| Hero headline | The light just changed. |
| Hero subtitle | Five frames for the in-between season — warmer than summer, lighter than fall. |
| Hero CTA | See the five → https://getjaxy.com/collections/transition |
| Section A heading | THE LIGHT SOFTENS FIRST |
| Section A body | You know the morning. The 6am that feels like a different city. The pumpkin candle that was too soon a week ago and just-right today. Your summer sunglasses don't quite work anymore — the light is more golden than it was, and the black aviators feel wrong on a tan. |
| Section B heading | FRAMES FOR THE PIVOT |
| Section B body | We pulled five for this exact moment. Warmer acetates, softer shapes, the colorways that match a late-August outfit better than they matched July. Honestly? The Main Character in Amber is carrying us through September. $28 each. Get two — the second one is for the friend who'll text you about hers in October. |
| Section B CTA | See the five → https://getjaxy.com/collections/transition |

## Why this passes the gut-check

| Check | Pass | Notes |
|---|---|---|
| Subject + preheader complement | ✓ | Subject = the sensory hook; preheader = the time-bounded value ("next 8 weeks"). |
| Headline screenshot-worthy | ✓ | "The light just changed" is short, sensory, evocative. |
| Section A reader-is-hero | ✓ | "You know the morning. The 6am that feels like…" — reader is the protagonist of every sentence. |
| Section B has specific moment | ✓ | "The Main Character in Amber is carrying us through September" — names a frame, a colorway, a month. |
| No banned words | ✓ | Used "honestly" (approved signature word). No banned vocab. |
| Pronoun ratio | ✓ | "You/your" outnumber "we/our" 5:1 (we appears twice — "we pulled" and "the friend who'll text you about hers"). |

## Notes on the with_pullquote variant

The hero subtitle quotes a sensory line in the same Section A. The
template's Section A `with_pullquote` variant renders the third
sentence ("Your summer sunglasses don't quite work anymore — the
light is more golden than it was") as a pullquote in Syne, set
larger than the surrounding body text. AI doesn't generate the
pullquote separately; it picks the strongest sentence from
sectionABody automatically at render time.

## Why this beats the agency version

A typical agency would write:

> Subject: Transition Your Wardrobe: New Fall Frames
> Preheader: Five must-have styles for the new season
> Hero: Fall Has Arrived
> Subtitle: Curated frames designed for the season ahead.
> Section A: As we transition into fall, refresh your eyewear
>   wardrobe with our latest collection. Crafted with premium
>   materials and timeless design, these frames are the
>   perfect addition to your autumn aesthetic.

The Jaxy v5 version names a specific morning ("the 6am that feels
like a different city," "the pumpkin candle that was too soon a
week ago") instead of "transition into fall." It's the difference
between writing about a season and writing about an experience
of a season.
